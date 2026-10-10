#!/usr/bin/env node
// import-cc-to-dsh.mjs  —  方向① CLI：把 cc-switch 的"统一 OpenAI 兼容 provider"导入 DSH。
// 用法：
//   node import-cc-to-dsh.mjs            # 只预览，不写任何文件（默认）
//   node import-cc-to-dsh.mjs --apply    # 备份后真正写入 DSH 的 cordis.patch.yml
//
// 只「新增」DSH 里还没有的 provider（按 baseURL / apiKeyEnv 去重），绝不删改已有条目。
// 密钥若已存在于 .credentials.yaml 的 refs，则不会重复写入。

import { listCcUniversalProviders, readDsh, planImport, providerBlock, writeDsh, ensureCredsKeys, keyExistsInCreds } from './cc-bridge-lib.mjs';

const APPLY = process.argv.includes('--apply');

const ccProviders = listCcUniversalProviders();
const dsh = readDsh();
const { toAdd, skipped } = planImport(ccProviders, dsh);

console.log('=== cc-switch → DSH 导入预览 ===\n');
console.log(`cc 里的 OpenAI 兼容 provider：${ccProviders.length} 个`);
console.log(`DSH 已有 baseURL：${[...dsh.baseURLs].join(', ') || '(无)'}`);
console.log(`将新增：${toAdd.length} 个；跳过（已存在）：${skipped.length} 个\n`);

for (const p of skipped) console.log(`[跳过] ${p.displayName} (${p.baseURL}) — 已存在`);
if (!toAdd.length) {
  console.log('\n没有需要新增的 provider，不写文件。');
  process.exit(0);
}

for (const p of toAdd) {
  console.log(`\n[新增] ${p.displayName}`);
  console.log(`  baseURL: ${p.baseURL}`);
  console.log(`  apiKeyEnv: ${p.apiKeyEnv}`);
  console.log(`  模型: ${p.models.join(', ') || '(无)'}`);
  console.log(`  密钥: ${keyExistsInCreds(p.apiKeyEnv) ? '已存在于 .credentials.yaml（无需写）' : '需要写入 .credentials.yaml'}`);
  console.log('  预览块:');
  console.log('  ' + providerBlock(p).join('\n  '));
}

if (!APPLY) {
  console.log('\n(当前为 dry-run，未做任何修改。确认无误后用 --apply 落地。)');
  process.exit(0);
}

const { backup } = writeDsh(dsh, toAdd);
console.log(`\n[备份] ${backup}`);
const cred = ensureCredsKeys(toAdd);
if (cred.added.length) console.log(`[密钥写入] ${cred.added.join(', ')}`);
console.log('[写入] ' + '完成');
console.log('写入完成。请重启/刷新 DSH 后到模型列表确认新 provider 是否出现。');