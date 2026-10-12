/**
 * 诊断工具：用真实键盘事件（CDP Input.dispatchKeyEvent）逐键输入百分比，
 * 每一步记录「总金额 / 焦点 / 百分比 / 是否已建结构」，用来验证输入是否丝滑。
 *
 * 用法（对隔离实例跑，不要对正在使用的 8787 跑）：
 *   node tools/e2e-server.mjs "%TEMP%\stock-diag" 8899
 *   node tools/diag-keys.mjs http://127.0.0.1:8899/ 391
 */
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME
  || 'C:\\Users\\lenovo\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const URL_TO_CHECK = process.argv[2] || 'http://127.0.0.1:8899/';
const WIDTH = Number(process.argv[3] || 391);
const PORT = 9700 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = await mkdtemp(join(tmpdir(), 'cdp-key-'));

// 安全闸：这个脚本会改配比并落到服务端，默认不许碰真实端口 8787
if (/:8787(\/|$)/.test(URL_TO_CHECK) && process.env.ALLOW_REAL !== '1') {
  console.error(`拒绝执行：${URL_TO_CHECK} 是用户正在使用的服务。`);
  console.error('先起隔离实例：  node tools/e2e-server.mjs "%TEMP%\\stock-diag" 8899');
  console.error('再跑：          node tools/check-pct-input.mjs http://127.0.0.1:8899/ 391');
  process.exit(2);
}

if (/:8787(\/|$)/.test(URL_TO_CHECK) && process.env.ALLOW_REAL !== '1') {
  console.error(`拒绝执行：${URL_TO_CHECK} 是用户正在使用的服务，请用隔离实例（8899）。`);
  process.exit(2);
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  `--window-size=${WIDTH},1400`, 'about:blank',
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
if (!wsUrl) { chrome.kill(); throw new Error('Chrome 没起来'); }

const ws = new WebSocket(wsUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let id = 0;
const pending = new Map();
const pageProblems = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    pageProblems.push(`exception: ${m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text}`);
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    pageProblems.push(`console.error: ${(m.params.args || []).map((a) => a.value ?? a.description).join(' ')}`);
  }
  if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error'
    && !/favicon|404/.test(m.params.entry.text || '')) {
    pageProblems.push(`log: ${m.params.entry.text}`);
  }
};
const send = (method, params = {}) => new Promise((ok) => {
  id += 1; pending.set(id, ok);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return `EXC: ${r.result.exceptionDetails.exception?.description}`;
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 1400, deviceScaleFactor: 2, mobile: true });
await send('Page.navigate', { url: URL_TO_CHECK + '?k=' + Date.now() });
await sleep(3200);
console.log('页面报错:', pageProblems.length ? pageProblems.join(' | ') : '(无)');

const state = `(() => {
  const t = document.getElementById('total');
  const a = document.activeElement;
  const rows = document.querySelectorAll('#allocbody tr:not(.err-row)').length;
  const bound = ['VOO','BRK.B','AAPL','PDD'].every(s => {
    const el = document.querySelector('[data-pct="' + s + '"]');
    return el && el.dataset.bound === '1';
  });
  return JSON.stringify({
    总金额: t ? t.value : null,
    焦点: a ? (a.getAttribute('data-pct') || a.id || a.tagName) : null,
    百分比: [...document.querySelectorAll('[data-pct]')].map(e => e.getAttribute('data-pct') + '=' + e.value).join(','),
    行数: rows, 已绑定: bound,
    提示: (document.getElementById('allocnote')?.textContent || '').slice(0, 46),
  });
})()`;

async function centerOf(selector) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  })()`);
}
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
/** 真正把输入框清空：focus + 全选 + 退格（headless 下只按退格不会清空） */
async function clearField(selector) {
  await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select(); return 'ok'; })()`);
  await sleep(120);
  await key('Backspace');
}
async function key(k) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k });
  await sleep(110);
}
async function typeText(text) {
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
    await send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch, key: ch });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(120);
  }
}

console.log('初始:', await evaluate(state));

// 先把 sanitizePct 自身的返回值打出来，确认边界逻辑
console.log('sanitizePct 边界:', await evaluate(`JSON.stringify(
  ['', '4', '45', '4.5', '45.9', '999', '-10', 'abc', '007', '100', '1234'].map(v => v + '->' + sanitizePct(v))
)`));

// 确定性用例：直接把输入框设成某个「用户可能输入的样子」，触发 input，看页面怎么处理。
// 比模拟键盘可靠（headless 的按键语义不稳），而且能固化成自动化测试。
const cases = [
  ['清空', ''],
  ['输入 4', '4'],
  ['输入 45', '45'],
  ['输入 4.5（应被吃成 45）', '4.5'],
  ['输入 45.9（应被吃成 459→夹到 100？不，应为 459 超 3 位被截成 45）', '45.9'],
  ['输入 999（应夹到 100）', '999'],
  ['输入 -10（负号应被吃掉）', '-10'],
  ['输入 abc（非数字应清空）', 'abc'],
  ['输入 0', '0'],
  ['输入 100', '100'],
  ['输入 007（应变成 7）', '007'],
];

for (const [label, raw] of cases) {
  const got = await evaluate(`(() => {
    const el = document.querySelector('[data-pct="VOO"]');
    el.scrollIntoView({ block: 'center' });      // 移动仿真下不滚动就 focus 不了，事件也不会派发
    el.focus();
    el.value = ${JSON.stringify(raw)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({
      输入: ${JSON.stringify(raw)},
      框里: el.value,
      焦点还在这只: document.activeElement === el,
      提示: (document.getElementById('allocnote')?.textContent || '').slice(0, 34),
    });
  })()`);
  await sleep(150);
  console.log(`  ${label.padEnd(30)} -> ${got}`);
}

// 模糊测试：自动配平
console.log('\n--- 离开输入框时的自动配平 ---');
for (const raw of ['45', '70', '5']) {
  const got = await evaluate(`(() => {
    const el = document.querySelector('[data-pct="VOO"]');
    el.value = ${JSON.stringify(raw)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({
      我填VOO: el.value,
      结果: [...document.querySelectorAll('[data-pct]')].map(e => e.getAttribute('data-pct') + '=' + e.value).join(','),
      合计: [...document.querySelectorAll('[data-pct]')].reduce((a, e) => a + (Number(e.value) || 0), 0),
    });
  })()`);
  await sleep(400);
  console.log(`  ${String(raw).padEnd(6)} -> ${got}`);
}

console.log('\n最终页面报错:', pageProblems.length ? pageProblems.join(' | ') : '(无)');

ws.close();
chrome.kill();
