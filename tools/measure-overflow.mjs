// 诊断用：用 CDP 量出宽度超标的元素（不属于交付物，可随时删）
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME
  || 'C:\\Users\\lenovo\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
const URL_TO_CHECK = process.argv[2] || 'http://127.0.0.1:8787/';
const WIDTH = Number(process.argv[3] || 390);
const PORT = 9333 + Math.floor(Math.random() * 200);

// 安全闸：这个脚本会真的点击下单/保存。曾经的教训是测试打到了用户正在用的 8787，
// 把演示数据写进了真实 state.json。默认只允许连测试实例（跑 tools/e2e-server.mjs 起的那个），
// 要动真实数据必须显式 ALLOW_REAL=1。
const isReal = /:(8787)(\/|$)/.test(URL_TO_CHECK);
if (isReal && process.env.ALLOW_REAL !== '1') {
  console.error(`\n拒绝执行：${URL_TO_CHECK} 看起来是用户正在使用的服务。`);
  console.error('请先另起一个隔离实例：  node tools/e2e-server.mjs "%TEMP%\\stock-e2e-live" 8899');
  console.error('然后跑：                node tools/measure-overflow.mjs http://127.0.0.1:8899/ 391');
  console.error('确实要动真实数据时才加：ALLOW_REAL=1\n');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = await mkdtemp(join(tmpdir(), 'cdp-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  `--window-size=${WIDTH},1500`, 'about:blank',
], { stdio: 'ignore' });

let wsUrl = null;
for (let i = 0; i < 40 && !wsUrl; i += 1) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
  } catch { /* 还没起来 */ }
}
if (!wsUrl) { chrome.kill(); throw new Error('Chrome 没起来'); }

const ws = new WebSocket(wsUrl);
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
const send = (method, params = {}) => new Promise((ok) => {
  id += 1;
  pending.set(id, ok);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
const problems = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled' && /error|warning/i.test(m.params?.type || '')) {
    problems.push(`console.${m.params.type}: ${(m.params.args || []).map((a) => a.value ?? a.description).join(' ')}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    problems.push(`exception: ${m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text}`);
  }
});
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: 1500, deviceScaleFactor: Number(process.env.DPR || 2), mobile: true,
});
await send('Page.navigate', { url: URL_TO_CHECK });
await sleep(3500);

// 可选：按 "VOO=12.5x680.25,PDD=40x95.5" 的形式自动填②的份额/成本价，用来验证实时计算
if (process.env.FILL) {
  const fill = process.env.FILL.split(',').map((pair) => {
    const [sym, rest] = pair.split('=');
    const [sh, cost] = String(rest).split('x');
    return { sym: sym.trim(), sh: Number(sh), cost: Number(cost) };
  });
  const expr = `(() => {
    const rows = ${JSON.stringify(fill)};
    for (const { sym, sh, cost } of rows) {
      for (const [k, v] of [['shares', sh], ['cost', cost]]) {
        const el = document.querySelector('[data-pos="' + sym + '-' + k + '"]');
        if (!el) return 'missing ' + sym + '-' + k;
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    return 'filled';
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('填充结果:', r.result?.result?.value);
  await sleep(600);
}

const expr = `(() => {
  const vw = document.documentElement.clientWidth;
  const over = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 1) {
      const own = [...el.children].reduce((m, c) => Math.max(m, c.getBoundingClientRect().right), 0);
      if (r.right > own + 1) {
        over.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className && el.className.toString().slice(0, 40)) || '',
          id: el.id || '',
          text: (el.textContent || '').trim().slice(0, 24),
          left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
          scrollW: el.scrollWidth, clientW: el.clientWidth,
        });
      }
    }
  }
  return JSON.stringify({
    vw,
    docScrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
    pctInputs: [...document.querySelectorAll('[data-pct]')].map((e) => e.getAttribute('data-pct') + '=' + e.value),
    posRows: [...document.querySelectorAll('#posbody tr')].map((tr) => tr.querySelector('.sym')?.textContent),
    posInputs: [...document.querySelectorAll('[data-pos]')].length,
    allocRowSymbols: [...document.querySelectorAll('#allocbody .sym')].map((e) => e.textContent),
    holdCardSymbols: [...document.querySelectorAll('#holdcards .prow1 .l b')].map((e) => e.textContent),
    cardOrder: [...document.querySelectorAll('.card h2')].map((e) => e.textContent),
    posLive: [...document.querySelectorAll('#posbody tr')].map((tr) => ({
      sym: tr.querySelector('.sym')?.textContent,
      price: tr.children[1]?.textContent.trim(),
      mv: tr.children[2]?.textContent.trim(),
      pnl: tr.children[3]?.textContent.replace(/\s+/g, ' ').trim(),
      w: tr.children[4]?.textContent.trim(),
    })),
    posNote: document.getElementById('posnote')?.textContent,
    totalInput: document.getElementById('total')?.value,
    feeInput: document.getElementById('feerate')?.value,
    allocRows: document.querySelectorAll('#allocbody tr').length,
    holders: document.querySelectorAll('#holdcards .pitem').length,
    offenders: over.slice(0, 14),
  }, null, 1);
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log('--- 诊断结果 ---');
console.log(res.result?.result?.value || JSON.stringify(res, null, 1));

// 可选：跑一遍「填持仓 → 点保存 → 点一键买入 → 点撤销」的真实交互
if (process.env.E2E === '1') {
  const run = async (label, expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) {
      console.log(`  ${label}: 抛异常 ${r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text}`);
    } else {
      console.log(`  ${label}: ${JSON.stringify(r.result?.result?.value)}`);
    }
    await sleep(900);
    return r.result?.result?.value;
  };
  const snapshot = `(() => ({
    bigsMarket: document.querySelector('#bigs .bignum b')?.textContent,
    donutPct: document.getElementById('donutpct')?.textContent,
    legend: [...document.querySelectorAll('#legend .vl')].map(e => e.textContent),
    rowVOO: (() => { const tr = document.querySelectorAll('#posbody tr')[0]; return tr ? { shares: tr.querySelector('[data-pos="VOO-shares"]').value, mv: tr.children[2].textContent.trim(), w: tr.children[4].textContent.trim() } : null; })(),
    posNote: document.getElementById('posnote')?.textContent,
    toast: document.getElementById('toasttext')?.textContent,
    err: document.getElementById('errbar')?.classList.contains('on') ? document.getElementById('errbar').textContent : null,
    flowCount: document.querySelectorAll('#flows .flow').length,
    flowSum: document.getElementById('flowsum')?.textContent,
    flowsBody: document.getElementById('flows')?.textContent?.trim(),
  }))()`;

  console.log('--- 交互流程 ---');
  await run('填 VOO=10 × 700', `(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('[data-pos="VOO-shares"]', 10); set('[data-pos="VOO-cost"]', 700);
    return 'ok';
  })()`);
  console.log('  填完:', JSON.stringify(await run('快照', snapshot)));

  await run('点保存持仓', `document.getElementById('savepos').click(), 'clicked'`);
  console.log('  保存后:', JSON.stringify(await run('快照', snapshot)));

  await run('点 VOO 一键买入(1650)', `document.querySelector('[data-buy="VOO"]').click(), 'clicked'`);
  await run('确认弹层', `document.getElementById('sheetok').click(), 'confirmed'`);
  console.log('  买入后:', JSON.stringify(await run('快照', snapshot)));

  await run('点撤销', `document.getElementById('toastundo').click(), 'undo'`);
  console.log('  撤销后:', JSON.stringify(await run('快照', snapshot)));
}

console.log('--- 页面错误 ---');
console.log(problems.length ? problems.join('\n') : '(无)');

// 顺便按真实手机视口存一张整页截图，便于人工核对排版
const shotPath = process.env.SHOT;
if (shotPath) {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(shotPath, Buffer.from(shot.result.data, 'base64'));
  console.log(`截图已写入 ${shotPath}`);
}

ws.close();
chrome.kill();
