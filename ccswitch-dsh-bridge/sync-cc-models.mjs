#!/usr/bin/env node
// Sync model IDs from CC Switch into DSH cc-proxy.models.
// Default is dry-run. Use --apply to back up and write the DSH profile.
// Only adds missing models. Never removes or rewrites existing models.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const CC_DB = process.env.CC_BRIDGE_CC_DB || 'C:/Users/22818/.cc-switch/cc-switch.db';
const DSH_PATCH = process.env.CC_BRIDGE_DSH_PATCH || 'C:/Users/22818/.dsh/profiles/desktop/cordis.patch.yml';
const BACKUP_DIR = process.env.CC_BRIDGE_BACKUP || 'D:/DSH Working Backup/dsh-profile';
const APPLY = process.argv.includes('--apply');
const MODEL_KEYS = new Set([
  'model',
  'anthropic_model',
  'gemini_model',
  'defaultmodel',
  'default_model',
  'haikumodel',
  'sonnetmodel',
  'opusmodel',
]);

function addModel(out, value) {
  if (typeof value !== 'string') return;
  const model = value.trim();
  if (!model || /[\r\n]/.test(model)) return;
  out.add(model);
}

function collectFromValue(value, key, out) {
  if (Array.isArray(value)) {
    for (const item of value) collectFromValue(item, key, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectFromValue(childValue, childKey, out);
    }
    return;
  }
  if (typeof value !== 'string') return;

  if (MODEL_KEYS.has(String(key).toLowerCase())) addModel(out, value);

  // Codex and Grokbuild store their settings as TOML text in a config field.
  if (String(key).toLowerCase() === 'config') {
    const regex = /^\s*model\s*=\s*["']([^"']+)["']/gim;
    let match;
    while ((match = regex.exec(value))) addModel(out, match[1]);
  }
}

function readCcModels() {
  const db = new DatabaseSync(CC_DB, { readOnly: true });
  const models = new Set();
  try {
    const universal = db.prepare("SELECT value FROM settings WHERE key='universal_providers'").get();
    if (universal?.value) {
      try { collectFromValue(JSON.parse(universal.value), '', models); } catch {}
    }

    for (const row of db.prepare('SELECT settings_config FROM providers').all()) {
      if (!row.settings_config) continue;
      try { collectFromValue(JSON.parse(row.settings_config), '', models); } catch {}
    }
  } finally {
    db.close();
  }
  return [...models].sort((a, b) => a.localeCompare(b, 'en'));
}

function unquoteYamlScalar(value) {
  const text = value.trim();
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  return text;
}

function quoteYamlScalar(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function locateCcProxy(lines) {
  const providerStart = lines.findIndex((line) => /^\s{6}cc-proxy:\s*$/.test(line));
  if (providerStart < 0) throw new Error('DSH config has no cc-proxy provider. Run add-cc-proxy.mjs first.');

  let providerEnd = lines.length;
  for (let i = providerStart + 1; i < lines.length; i++) {
    if (lines[i].trim() && /^(\s*)/.exec(lines[i])[1].length <= 6) {
      providerEnd = i;
      break;
    }
  }

  const modelsStart = lines.findIndex((line, i) => i > providerStart && i < providerEnd && /^\s{8}models:\s*$/.test(line));
  if (modelsStart < 0) throw new Error('cc-proxy has no models block.');

  const existing = new Set();
  let lastContent = modelsStart;
  for (let i = modelsStart + 1; i < providerEnd; i++) {
    const line = lines[i];
    const match = line.match(/^\s{10}- id:\s*(.+?)\s*$/);
    if (match) existing.add(unquoteYamlScalar(match[1]));
    if (line.trim()) lastContent = i;
  }

  return { providerStart, providerEnd, modelsStart, insertAt: lastContent + 1, existing };
}

function makeModelLines(model) {
  const value = quoteYamlScalar(model);
  return [`          - id: ${value}`, `            name: ${value}`];
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function pruneBackups() {
  const backups = fs.readdirSync(BACKUP_DIR)
    .filter((name) => /^cordis\.patch\.yml\.bak-/.test(name))
    .map((name) => ({ name, full: path.join(BACKUP_DIR, name), time: fs.statSync(path.join(BACKUP_DIR, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const backup of backups.slice(3)) fs.unlinkSync(backup.full);
}

const ccModels = readCcModels();
const original = fs.readFileSync(DSH_PATCH, 'utf8');
const newline = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.split(/\r?\n/);
const location = locateCcProxy(lines);
const missing = ccModels.filter((model) => !location.existing.has(model));

console.log(`CC models: ${ccModels.length}`);
console.log(`DSH cc-proxy models: ${location.existing.size}`);
console.log(`Missing: ${missing.length}`);
for (const model of missing) console.log(`  + ${model}`);

if (!missing.length) {
  console.log('Already synchronized. No files changed.');
  process.exit(0);
}

if (!APPLY) {
  console.log('Dry-run only. Run with --apply to write changes.');
  process.exit(0);
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const backup = path.join(BACKUP_DIR, `cordis.patch.yml.bak-modelsync-${timestamp()}`);
fs.copyFileSync(DSH_PATCH, backup);

const addedLines = missing.flatMap(makeModelLines);
const updatedLines = [
  ...lines.slice(0, location.insertAt),
  ...addedLines,
  ...lines.slice(location.insertAt),
];
fs.writeFileSync(DSH_PATCH, updatedLines.join(newline), 'utf8');

// Verify every old and new model is still present in cc-proxy before pruning backups.
const verifyLines = fs.readFileSync(DSH_PATCH, 'utf8').split(/\r?\n/);
const verified = locateCcProxy(verifyLines).existing;
for (const model of [...location.existing, ...missing]) {
  if (!verified.has(model)) throw new Error(`Verification failed for model: ${model}`);
}

pruneBackups();
console.log(`Backup: ${backup}`);
console.log(`Added ${missing.length} model(s). Restart DSH to refresh the model list.`);
