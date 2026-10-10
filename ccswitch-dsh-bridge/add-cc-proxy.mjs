#!/usr/bin/env node
// add-cc-proxy.mjs — 往 DSH 加 cc-proxy provider（指向 cc-switch 本地代理 127.0.0.1:15721/v1）
// 只新增，不删改。已存在则跳过。写前自动备份。用法：node add-cc-proxy.mjs
import { readDsh, providerBlock, writeDsh, ensureCredsKeys } from './cc-bridge-lib.mjs';

const BASE = 'http://127.0.0.1:15721/v1';
const KEY = 'CC_PROXY_API_KEY';

const dsh = readDsh();
if (dsh.baseURLs.has(BASE) || dsh.keyEnvs.has(KEY)) {
  console.log('cc-proxy 已存在，跳过。');
  process.exit(0);
}

const ccProxy = {
  id: 'cc-proxy',
  displayName: 'CC Switch 代理',
  baseURL: BASE,
  apiKeyEnv: KEY,
  apiKey: 'cc-proxy-placeholder', // 代理不校验 key，占位即可
  models: ['gpt-5.6-sol', 'gpt-5.6-luna', 'claude-sonnet-5', 'claude-opus-5', 'gemini-3.6-flash'],
  host: '127.0.0.1',
};

const { backup } = writeDsh(dsh, [ccProxy]);
console.log(`[备份] ${backup}`);
console.log('[写入] cc-proxy provider');
console.log('--- 插入的块 ---');
console.log(providerBlock(ccProxy).join('\n'));

const cred = ensureCredsKeys([ccProxy]);
console.log(`[密钥] ${cred.added.length ? '已写入: ' + cred.added.join(', ') : '已存在'}`);
console.log('完成。重启 DSH 后可用。');