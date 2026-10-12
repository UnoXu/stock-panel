/**
 * 云端场景验证：起一个「假的免费键值存储」+ 真实服务，用无头浏览器跑一遍
 * 「云同步」胶囊、导出、导入恢复、以及云存储挂掉后的只读降级。
 *
 * 这个脚本只连本地起的测试端口，不会碰真实服务。
 * 用法：node tools/check-cloud.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';
import { StateStore, createRestKvBackend, createDegradedBackend } from '../lib/store.mjs';

const CHROME = process.env.CHROME
  || 'C:\\Users\\lenovo\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 假 Upstash：内存里存 key；canFail=true 时一律失败（模拟云端挂掉） */
function makeFakeKv({ canFail = false } = {}) {
  const data = new Map();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (canFail) throw new Error('simulated cloud outage');
    const body = init?.body ? JSON.parse(init.body) : null;
    let key = null;
    if (url.includes('/get/')) key = decodeURIComponent(url.split('/get/')[1]);
    if (!key && Array.isArray(body) && body[0] === 'GET') key = body[1];
    if (key) return { ok: true, status: 200, text: async () => JSON.stringify({ result: data.get(key) ?? null }) };
    const [, k, v] = body;
    data.set(k, v);
    return { ok: true, status: 200, text: async () => JSON.stringify({ result: 'OK' }) };
  };
  return { fetchImpl, data, calls };
}

const dir = await mkdtemp(join(tmpdir(), 'stock-cloud-'));
const kv = makeFakeKv();
const primary = createRestKvBackend({ url: 'https://fake.upstash.io', token: 't', key: 'stock:state', fetchImpl: kv.fetchImpl });
const store = new StateStore(createDegradedBackend({ primary, cachePath: join(dir, 'kv-cache.json') }));
const { server, port } = await startServer({
  port: 0, host: '127.0.0.1', store,
  authFile: join(dir, '.auth.txt'), authDisabled: true,
});
const base = `http://127.0.0.1:${port}`;
const call = async (p, init) => {
  const res = await fetch(base + p, init);
  return { status: res.status, body: await res.json() };
};

console.log('=== 云端场景 =========================================');
const health = await call('/api/health');
console.log(`健康检查: storage=${health.body.storage} target=${health.body.storageTarget} degraded=${health.body.degraded}`);

// 写一笔进「云存储」
await call('/api/positions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ positions: { VOO: { shares: 12.5, avgCost: 680.25 }, PDD: { shares: 40, avgCost: 95.5 } } }),
});
const inCloud = JSON.parse(kv.data.get('stock:state'));
console.log(`数据落在云端: PDD=${inCloud.positions.PDD.shares} 股（云调用 ${kv.calls.length} 次）`);

// 导出
const exported = await call('/api/export');
console.log(`导出: 状态 ${exported.status}, VOO=${exported.body.state.positions.VOO.shares} 股`);
const backupPath = join(dir, 'backup.json');
await writeFile(backupPath, JSON.stringify(exported.body.state, null, 2));

// 改坏
await call('/api/positions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ positions: { VOO: { shares: 0, avgCost: 0 }, PDD: { shares: 0, avgCost: 0 } } }),
});
console.log(`改坏后: VOO=${(await call('/api/state')).body.positions.VOO.shares} 股`);

// 导入恢复
const imported = await call('/api/import', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(JSON.parse(await readFile(backupPath, 'utf8'))),
});
console.log(`导入恢复: 状态 ${imported.status}, VOO=${imported.body.positions.VOO.shares} 股, PDD=${imported.body.positions.PDD.shares} 股`);

// 无头浏览器：看顶栏胶囊 + 走一遍导出/导入按钮
const PORT = 9970 + Math.floor(Math.random() * 25);
const prof = await mkdtemp(join(tmpdir(), 'cdp-cloud-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${prof}`,
  `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore' });
let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i += 1) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
  } catch { /* 等启动 */ }
}
const ws = new WebSocket(wsUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let id = 0;
const pending = new Map();
const problems = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') problems.push(`异常: ${(m.params?.exceptionDetails?.exception?.description || '').slice(0, 140)}`);
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') problems.push('console.error');
};
const send = (method, params = {}) => new Promise((ok) => { id += 1; pending.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return `EXC: ${(r.result.exceptionDetails.exception?.description || '').slice(0, 120)}`;
  return r.result?.result?.value;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 391, height: 1400, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: `${base}/?t=${Date.now()}` });
await sleep(3200);

const badge = await ev(`(() => { const b = document.getElementById('storebadge'); return JSON.stringify({ text: b.textContent, hidden: b.classList.contains('hide'), title: b.title }); })()`);
console.log('顶栏胶囊:', badge);
console.log('配比行/成本卡:', await ev(`JSON.stringify({ allocRows: document.querySelectorAll('#allocbody .allocrow').length, costCards: document.querySelectorAll('#costlist .costcard').length })`));

await ev(`document.querySelector('.tab[data-tab="flows"]').click()`);
await sleep(400);
await ev(`document.getElementById('toggleimport').click()`);
await sleep(300);
console.log('备份按钮可见:', await ev(`JSON.stringify({ export: !document.getElementById('exportbtn').classList.contains('hide'), import: !document.getElementById('importbtn').classList.contains('hide'), help: document.getElementById('importhelp').style.display === 'block' })`));
console.log('页面报错:', problems.length ? problems.join(' | ') : '(无)');
ws.close();
chrome.kill();

// 云存储挂掉 → 只读降级
console.log('\n=== 云存储挂掉后 ========================================');
const downDir = await mkdtemp(join(tmpdir(), 'stock-cloud-down-'));
const healthyKv = makeFakeKv();
const healthy = createDegradedBackend({
  primary: createRestKvBackend({ url: 'https://fake.upstash.io', token: 't', fetchImpl: healthyKv.fetchImpl }),
  cachePath: join(downDir, 'cache.json'),
});
await healthy.readState();                                  // 建立本地副本
await healthy.writeState(JSON.parse(await readFile(backupPath, 'utf8')));

const downBackend = createDegradedBackend({
  primary: createRestKvBackend({ url: 'https://fake.upstash.io', token: 't', fetchImpl: makeFakeKv({ canFail: true }).fetchImpl }),
  cachePath: join(downDir, 'cache.json'),
});
const downStore = new StateStore(downBackend);
const down = await startServer({ port: 0, host: '127.0.0.1', store: downStore, authFile: join(downDir, '.auth.txt'), authDisabled: true });
const downBase = `http://127.0.0.1:${down.server.address().port}`;
const dcall = async (p, init) => { const r = await fetch(downBase + p, init); return { status: r.status, body: await r.json() }; };
const dh = await dcall('/api/health');
console.log(`降级健康检查: degraded=${dh.body.degraded} 原因="${dh.body.degradedReason}"`);
console.log('只读仍能读持仓:', (await dcall('/api/state')).body.positions.VOO.shares, '股');
const blocked = await dcall('/api/positions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ positions: { VOO: { shares: 1, avgCost: 1 } } }),
});
console.log(`写入被拒: HTTP ${blocked.status} code=${blocked.body.code} 文案="${blocked.body.error}"`);
await new Promise((ok) => down.server.close(ok));

await new Promise((ok) => server.close(ok));
console.log('\n完成（测试实例已关闭）');
