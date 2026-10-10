// cc-bridge-lib.mjs  —  cc-switch ↔ DSH 桥接公共库（方向①：cc → DSH）
// 所有路径都可用环境变量覆盖（用于无副作用的测试/演练）：
//   CC_BRIDGE_CC_DB       覆盖 cc-switch 数据库路径
//   CC_BRIDGE_DSH_PATCH   覆盖 DSH cordis.patch.yml 路径
//   CC_BRIDGE_DSH_CRED    覆盖 DSH .credentials.yaml 路径
//   CC_BRIDGE_BACKUP      覆盖备份目录
// 只增不改：只会往 DSH 里「新增」DSH 还没有的 provider，绝不删改已有条目。

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const PATHS = {
  ccDb:   process.env.CC_BRIDGE_CC_DB     || 'C:/Users/22818/.cc-switch/cc-switch.db',
  dshPatch: process.env.CC_BRIDGE_DSH_PATCH || 'C:/Users/22818/.dsh/profiles/desktop/cordis.patch.yml',
  dshCred:  process.env.CC_BRIDGE_DSH_CRED  || 'C:/Users/22818/.dsh/.credentials.yaml',
  backup:   process.env.CC_BRIDGE_BACKUP    || 'D:/DSH Working Backup/dsh-profile',
};

// ---------- 1. 读 cc-switch 的统一 provider（只读） ----------
export function listCcUniversalProviders() {
  const db = new DatabaseSync(PATHS.ccDb, { readOnly: true });
  let row;
  try { row = db.prepare("SELECT value FROM settings WHERE key='universal_providers'").get(); }
  finally { db.close(); }
  if (!row || !row.value) return [];
  let u;
  try { u = JSON.parse(row.value); } catch { return []; }

  const out = [];
  for (const p of Object.values(u)) {
    if (!p || p.providerType !== 'newapi') continue; // 只处理 OpenAI 兼容的 newapi 类型
    const host = hostname(p.baseUrl || '');
    if (!host) continue;
    const models = [];
    const seen = new Set();
    const pick = ['model', 'haikuModel', 'sonnetModel', 'opusModel'];
    for (const appVal of Object.values(p.models || {})) {
      for (const k of pick) {
        const v = appVal?.[k];
        if (typeof v === 'string' && v && !seen.has(v)) { seen.add(v); models.push(v); }
      }
    }
    out.push({
      id: hostToId(host),
      displayName: hostToDisplay(host),
      baseURL: normalizeBaseURL(p.baseUrl || ''),
      apiKeyEnv: hostToKeyEnv(host),
      apiKey: p.apiKey || '',
      models,
      host,
    });
  }
  return out;
}

// ---------- 2. 读 DSH 现状 ----------
export function readDsh() {
  const text = fs.readFileSync(PATHS.dshPatch, 'utf8');
  const lines = text.split(/\r?\n/);
  const llmIdx = lines.findIndex((l) => /^- id:\s*llm-pi-ai\s*$/.test(l));
  if (llmIdx < 0) throw new Error(`找不到 - id: llm-pi-ai（${PATHS.dshPatch} 结构异常，已中止，未做任何修改）`);
  let insertBefore = lines.length;
  for (let i = llmIdx + 1; i < lines.length; i++) {
    if (/^-/.test(lines[i])) { insertBefore = i; break; }
  }
  const baseURLs = new Set(); // 标准化后的 baseURL
  const keyEnvs  = new Set();
  for (const l of lines) {
    let m = l.match(/^\s+baseURL:\s*(\S+)/);
    if (m) baseURLs.add(normalizeBaseURL(m[1]));
    m = l.match(/^\s+apiKeyEnv:\s*(\S+)/);
    if (m) keyEnvs.add(m[1]);
  }
  return { text, lines, insertBefore, baseURLs, keyEnvs };
}

// ---------- 3. 计划：哪些要新增、哪些跳过（幂等：baseURL 或 keyEnv 已存在于 DSH 即跳过） ----------
export function planImport(ccList, dsh) {
  const toAdd = [], skipped = [];
  for (const p of ccList) {
    if (dsh.baseURLs.has(p.baseURL) || dsh.keyEnvs.has(p.apiKeyEnv)) skipped.push(p);
    else toAdd.push(p);
  }
  return { toAdd, skipped };
}

// ---------- 4. 生成 provider YAML 块（6/8/10/12 缩进） ----------
export function providerBlock(p) {
  const lines = [];
  lines.push(`      ${safeId(p.id)}:`);
  lines.push(`        displayName: ${p.displayName}`);
  lines.push(`        apiKeyEnv: ${p.apiKeyEnv}`);
  lines.push(`        api: openai-completions`);
  lines.push(`        baseURL: ${p.baseURL}`);
  lines.push(`        models:`);
  if (!p.models.length) lines.push(`          []`);
  else for (const m of p.models) { lines.push(`          - id: ${m}`); lines.push(`            name: ${m}`); }
  return lines;
}

// ---------- 5. 写入 DSH（备份 → 插入 → 写回） ----------
export function writeDsh(dsh, toAdd) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(PATHS.backup, { recursive: true });
  const bak = path.join(PATHS.backup, `cordis.patch.yml.bak-ccbridge-${ts}`);
  fs.copyFileSync(PATHS.dshPatch, bak);
  const blockLines = toAdd.flatMap((p) => [...providerBlock(p), '']);
  const newLines = [
    ...dsh.lines.slice(0, dsh.insertBefore),
    ...blockLines,
    ...dsh.lines.slice(dsh.insertBefore),
  ];
  const joined = newLines.join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(PATHS.dshPatch, joined, 'utf8');
  return { backup: bak };
}

// ---------- 6. 密钥同步到 .credentials.yaml（幂等；只追加 refs 块，不碰其它内容） ----------
export function ensureCredsKeys(toAdd) {
  const existing = toAdd.filter((p) => keyExistsInCreds(p.apiKeyEnv)).map((p) => p.apiKeyEnv);
  const need = toAdd.filter((p) => p.apiKey && !existing.includes(p.apiKeyEnv));
  if (!need.length) return { added: [], existing };
  let text = fs.existsSync(PATHS.dshCred) ? fs.readFileSync(PATHS.dshCred, 'utf8') : '';
  if (text && !text.endsWith('\n')) text += '\n';
  const lines = text ? text.split(/\r?\n/) : [];
  const refsIdx = lines.findIndex((l) => /^refs:\s*$/.test(l));
  const appended = [];
  for (const p of need) {
    appended.push(p.apiKeyEnv);
    if (refsIdx < 0) {
      // 没有 refs 键：建一个
      lines.push('refs:');
      lines.push(`  ${p.apiKeyEnv}: ${p.apiKey}`);
    } else {
      // 找 refs 块末尾（下一个非缩进行之前）
      let end = lines.length;
      for (let i = refsIdx + 1; i < lines.length; i++) {
        if (lines[i].length && !/^\s/.test(lines[i])) { end = i; break; }
      }
      lines.splice(end, 0, `  ${p.apiKeyEnv}: ${p.apiKey}`);
    }
  }
  fs.writeFileSync(PATHS.dshCred, lines.join('\n'), 'utf8');
  return { added: appended, existing };
}

// ---------- 工具函数 ----------
function hostname(url) { try { return new URL(url).hostname; } catch { return ''; } }
function hostToId(host) {
  const first = host.split('.')[0];
  return first === 'www' ? host.split('.')[1] : first;
}
function hostToDisplay(host) {
  const id = hostToId(host);
  const known = { openrouter: 'OpenRouter', openai: 'OpenAI', totokens: 'totokens', intern: 'Intern' };
  return known[id] || id.charAt(0).toUpperCase() + id.slice(1);
}
function hostToKeyEnv(host) {
  return hostToId(host).toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_API_KEY';
}
function normalizeBaseURL(base) {
  let b = (base || '').replace(/\/+$/, '');
  if (!/\/v\d+$/.test(b)) b += '/v1';
  return b;
}
function safeId(id) { return String(id).replace(/[^A-Za-z0-9_.-]/g, '-'); }
export function keyExistsInCreds(envName) {
  if (!fs.existsSync(PATHS.dshCred)) return false;
  return new RegExp(`^\\s*${envName}\\s*:`, 'm').test(fs.readFileSync(PATHS.dshCred, 'utf8'));
}