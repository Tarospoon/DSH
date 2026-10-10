#!/usr/bin/env node
// watch-cc-to-dsh.mjs  —  常驻监听：cc-switch 里新增"统一 OpenAI 兼容 provider"时，自动导入 DSH。
// 用法：
//   node watch-cc-to-dsh.mjs              # 常驻监听（写 .watcher.pid 锁文件）
//   node watch-cc-to-dsh.mjs --once       # 只扫描一次就退出（测试/手动触发用）
//   node watch-cc-to-dsh.mjs --status     # 查看运行状态（不扫描）
//
// 行为：每 8 秒对比一次；发现 DSH 还没有的 provider 就自动【备份 → 写入 cordis.patch.yml → 同步密钥】。
//       只增不改不删；幂等；所有事件写 logs/watch.log。写 DSH 配置需要系统权限，本进程由
//       cc-switch-launcher.bat 或计划任务以普通用户权限拉起（不经 DSH 沙盒），因此可直接写入。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listCcUniversalProviders, readDsh, planImport, writeDsh, ensureCredsKeys } from './cc-bridge-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCK = path.join(__dirname, '.watcher.pid');
const LOG_DIR = path.join(__dirname, 'logs');
const LOG = path.join(LOG_DIR, 'watch.log');
const INTERVAL_MS = 8000;
const HEARTBEAT_EVERY = 20;
const CC_GONE_TICKS = 3; // cc 连续 3 轮(约 24s)测不到 → watcher 退出

function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}`;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch {}
  console.log(line);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock() {
  try {
    if (fs.existsSync(LOCK)) {
      const pid = Number(String(fs.readFileSync(LOCK, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
        log(`已有 watcher 在运行 (PID ${pid})，本进程退出。`);
        process.exit(0);
      }
      log(`旧锁文件 (PID ${pid}) 已失效，接管。`);
    }
    fs.writeFileSync(LOCK, String(process.pid), 'utf8');
  } catch (e) { log(`锁文件写入失败: ${e.message}`); }
}

function releaseLock() {
  try {
    const pid = Number(String(fs.readFileSync(LOCK, 'utf8')).trim());
    if (pid === process.pid) fs.unlinkSync(LOCK);
  } catch {}
}

// 检测 cc-switch 进程是否在跑。出错时保守返回 true（避免误判导致退出）。
function ccSwitchAlive() {
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq cc-switch.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
    return !!(r.stdout && /cc-switch\.exe/i.test(r.stdout));
  } catch { return true; }
}

function scan() {
  let ccList, dsh;
  try {
    ccList = listCcUniversalProviders();
    dsh = readDsh();
  } catch (e) {
    log(`扫描失败（跳过本轮，不修改任何文件）: ${e.message}`);
    return;
  }
  const { toAdd, skipped } = planImport(ccList, dsh);
  if (!toAdd.length) return;
  try {
    const { backup } = writeDsh(dsh, toAdd);
    const cred = ensureCredsKeys(toAdd);
    const names = toAdd.map((p) => `${p.displayName}(${p.apiKeyEnv})`).join(', ');
    const credMsg = cred.added.length ? `；密钥已同步: ${cred.added.join(', ')}` : '';
    log(`自动导入 ${toAdd.length} 个 provider: ${names}${credMsg}（备份: ${backup}）`);
  } catch (e) {
    log(`导入失败（已备份原文件? 见备份目录）: ${e.message}`);
  }
}

// ---- 子命令 ----
if (process.argv.includes('--status')) {
  console.log(`锁文件: ${LOCK}`);
  const pid = fs.existsSync(LOCK) ? Number(String(fs.readFileSync(LOCK, 'utf8')).trim()) : 0;
  console.log(`PID: ${pid}，状态: ${pid && pidAlive(pid) ? '运行中' : '未运行'}`);
  console.log(`日志: ${LOG}`);
  if (fs.existsSync(LOG)) {
    const tail = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-10);
    console.log('最近日志:');
    for (const l of tail) console.log('  ' + l);
  }
  process.exit(0);
}

// ---- 常驻 ----
acquireLock();
log('watcher 启动，开始监听 cc-switch 统一 provider（每 8 秒扫描一次）。');
process.on('SIGINT', () => { log('收到 SIGINT，退出。'); releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { log('收到 SIGTERM，退出。'); releaseLock(); process.exit(0); });

if (process.argv.includes('--once')) {
  scan();
  releaseLock();
  log('--once 模式扫描完成，退出。');
  process.exit(0);
}

let count = 0;
let sawCc = false;
let goneTicks = 0;
setInterval(() => {
  count++;
  // 联动：cc-switch 曾运行、现在已关闭 → watcher 顺便退出（连续 CC_GONE_TICKS 轮都测不到才算，防瞬态误判）
  const ccAlive = ccSwitchAlive();
  if (ccAlive) { sawCc = true; goneTicks = 0; }
  else if (sawCc && ++goneTicks >= CC_GONE_TICKS) {
    log('检测到 cc-switch 已关闭，watcher 随之退出。');
    releaseLock();
    process.exit(0);
  }
  if (count % HEARTBEAT_EVERY === 0) log(`心跳：已连续运行 ${count * INTERVAL_MS / 1000}s，上次事件后无新增。`);
  scan();
}, INTERVAL_MS);