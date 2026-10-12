#!/usr/bin/env node
/**
 * server.mjs — 本地服务：静态页面 + /api/* + 行情代理 + 轻量鉴权
 *
 * 启动： node server.mjs          （默认 0.0.0.0:8787）
 * 环境变量： PORT / HOST / STOCK_AUTH=off
 */

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

import { getQuotes, summarize, SYMBOLS } from './lib/quotes.mjs';
import {
  allocate, applyBuy, undoLastBuy, holdingsView, rolloverBaseline, resetBaseline, evenAllocation,
  QuantError, DEFAULT_FEE_RATE, LOT_SIZE, validateFeeRate,
} from './lib/quant.mjs';
import {
  StateStore, statePathIn, DEFAULT_STATE, normalizeState,
  createFileBackend, createRestKvBackend, createDegradedBackend,
  StorageUnavailableError, StorageReadOnlyError,
} from './lib/store.mjs';
import { authorize, loadToken, loginPage, COOKIE_NAME } from './lib/auth.mjs';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUB_DIR = join(HERE, 'pub');
/**
 * 数据目录。本机运行时就是代码目录（和以前完全一样）；
 * 部署到云端时设 DATA_DIR=/data 指向挂载的持久卷，否则容器重启数据就没了。
 */
const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : HERE;
const STATE_FILE = statePathIn(DATA_DIR);
const AUTH_FILE = join(DATA_DIR, '.auth.txt');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const AUTH_DISABLED = String(process.env.STOCK_AUTH || '').toLowerCase() === 'off';

const startedAt = new Date();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------- 存储后端 ------------------------------- */

/** 云缓存文件：和 state.json 放同一个数据目录，容器重建时若无持久卷会丢，故只当降级副本 */
const KV_CACHE_FILE = join(DATA_DIR, 'kv-cache.json');

/**
 * 决定用哪个存储后端：
 *   - 传了 stateFile（测试/本机旧用法）→ 文件后端
 *   - 设了 KV_REST_URL + KV_REST_TOKEN → 云后端（外面包一层只读降级）
 *   - 否则 → DATA_DIR 下的 state.json 文件后端
 */
function makeBackend({ stateFile, kvUrl, kvToken, kvKey, fetchImpl } = {}) {
  if (stateFile) return createFileBackend(stateFile);

  const url = kvUrl ?? process.env.KV_REST_URL;
  const token = kvToken ?? process.env.KV_REST_TOKEN;
  if (url && token) {
    const primary = createRestKvBackend({
      url,
      token,
      key: kvKey || process.env.KV_KEY || 'stock:state',
      fetchImpl,
    });
    return createDegradedBackend({ primary, cachePath: KV_CACHE_FILE });
  }
  return createFileBackend(statePathIn(DATA_DIR));
}

/* ------------------------------- 基础工具 ------------------------------- */

const sendJson = (res, status, body, extraHeaders = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
};

const sendText = (res, status, text, type = 'text/plain; charset=utf-8', extraHeaders = {}) => {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
};

const readBody = (req, limit = 256 * 1024) => new Promise((resolvePromise, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) {
      reject(new QuantError('请求体太大', 'BODY_TOO_LARGE'));
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text) return resolvePromise({});
    try {
      resolvePromise(JSON.parse(text));
    } catch {
      reject(new QuantError('请求体不是合法 JSON', 'BAD_JSON'));
    }
  });
  req.on('error', reject);
});

/** 全部标的的最新行情（每次调用都走 quotes 层自己的 10s 缓存） */
async function currentQuotes({ force = false } = {}) {
  const quotes = await getQuotes(SYMBOLS, { force });
  return { quotes, meta: summarize(quotes) };
}

/** 启动/首次访问时，把「当日基准」补成当前昨收 */
async function ensureBaseline(store) {
  const state = await store.get();
  const needSeed = SYMBOLS.some((s) => !state.positions?.[s]?.baselinePrevClose);
  if (!needSeed) return state;
  const { quotes } = await currentQuotes();
  const { state: rolled } = rolloverBaseline(state, quotes);
  try {
    return await store.write(rolled);
  } catch (err) {
    // 只是补一个基准而已，失败不该让整个页面打不开
    if (err instanceof StorageReadOnlyError || err instanceof StorageUnavailableError) {
      console.warn(`[server] 当日基准未能保存（不影响读取）：${err.message}`);
      return rolled;
    }
    throw err;
  }
}

/* ------------------------------- API 路由 ------------------------------- */

const RULES = () => ({ lotSize: LOT_SIZE, feeRate: DEFAULT_FEE_RATE });

async function handleApi(req, res, url, store) {
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  const method = req.method || 'GET';

  if (path === '/api/health') {
    const info = store.storageInfo;
    return sendJson(res, 200, {
      ok: true,
      startedAt: startedAt.toISOString(),
      now: new Date().toISOString(),
      symbols: SYMBOLS,
      rules: RULES(),
      auth: AUTH_DISABLED ? 'off' : 'on',
      storage: info.kind,            // 'file' | 'kv'
      storageTarget: info.target,    // 脱敏后的目标（本地路径 or 云主机名）
      degraded: info.degraded,       // true = 云存储读不到，正在用本地副本且只读
      degradedReason: info.reason,
    });
  }

  if (path === '/api/export' && method === 'GET') {
    const state = await store.get();
    return sendJson(res, 200, {
      ok: true,
      exportedAt: new Date().toISOString(),
      exportedBy: '持仓助手',
      state,                          // 完整结构，可直接当备份文件保存
    });
  }

  if (path === '/api/import' && method === 'POST') {
    const body = await readBody(req);
    const incoming = body?.state ?? body;
    // 只接受「看起来是我们自己的数据」：必须有 targets 或 positions，否则很容易把别的东西灌进来
    if (!incoming || typeof incoming !== 'object'
      || (!incoming.targets && !incoming.positions)) {
      throw new QuantError('导入失败：这不是一份持仓备份（缺少 targets / positions）', 'BAD_IMPORT');
    }
    const normalized = normalizeState(incoming);
    if (!normalized.updatedAt) normalized.updatedAt = new Date().toISOString();
    const saved = await store.write(normalized);
    const { quotes } = await currentQuotes();
    return sendJson(res, 200, {
      ok: true,
      positions: saved.positions,
      targets: saved.targets,
      holdings: holdingsView(saved, quotes),
    });
  }

  if (path === '/api/quotes' && method === 'GET') {
    const force = url.searchParams.get('force') === '1';
    const { quotes, meta } = await currentQuotes({ force });
    return sendJson(res, 200, { quotes, meta, symbols: SYMBOLS, rules: RULES() });
  }

  if (path === '/api/state' && method === 'GET') {
    const state = await store.get();
    return sendJson(res, 200, {
      rules: state.rules,
      targets: state.targets,
      positions: state.positions,
      buys: state.buys.slice(0, 50),
      updatedAt: state.updatedAt,
    });
  }

  if (path === '/api/holdings' && method === 'GET') {
    const state = await store.get();
    const { quotes, meta } = await currentQuotes();
    return sendJson(res, 200, {
      ...holdingsView(state, quotes, { feeRate: state.rules?.feeRate }),
      quotes,
      meta,
      positions: state.positions,
      targets: state.targets,
      buys: state.buys.slice(0, 50),
    });
  }

  if (path === '/api/targets' && method === 'POST') {
    const body = await readBody(req);
    const totalAmount = Number(body.totalAmount);
    const feeRate = body.feeRate == null ? undefined : validateFeeRate(Number(body.feeRate));
    const allocation = {};
    for (const s of SYMBOLS) {
      const v = Number(body.allocation?.[s]);
      allocation[s] = Number.isFinite(v) ? v : 0;
    }
    const sum = SYMBOLS.reduce((a, s) => a + allocation[s], 0);
    if (Math.abs(sum - 100) > 0.01) {
      throw new QuantError(`${SYMBOLS.length} 个百分比之和是 ${Number(sum.toFixed(4))}%，必须等于 100%`, 'PCT_SUM');
    }
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      throw new QuantError('总金额必须是大于 0 的数字', 'INVALID_INPUT');
    }
    const next = await store.mutate((cur) => {
      cur.targets = { totalAmount, allocation };
      cur.rules = { lotSize: LOT_SIZE, feeRate: feeRate ?? cur.rules?.feeRate ?? DEFAULT_FEE_RATE };
      cur.updatedAt = new Date().toISOString();
      return cur;
    });
    return sendJson(res, 200, { ok: true, targets: next.targets, rules: next.rules });
  }

  if (path === '/api/even-allocation' && method === 'GET') {
    return sendJson(res, 200, { ok: true, allocation: evenAllocation(SYMBOLS), symbols: SYMBOLS });
  }

  if (path === '/api/positions' && method === 'POST') {
    const body = await readBody(req);
    const incoming = body.positions || {};
    const next = await store.mutate((cur) => {
      for (const s of SYMBOLS) {
        const p = incoming[s];
        if (!p) continue;
        const shares = Number(p.shares);
        const avgCost = Number(p.avgCost);
        if (!Number.isFinite(shares) || shares < 0) throw new QuantError(`${s} 的份额必须是不小于 0 的数字`, 'INVALID_INPUT');
        if (!Number.isFinite(avgCost) || avgCost < 0) throw new QuantError(`${s} 的成本价必须是不小于 0 的数字`, 'INVALID_INPUT');
        cur.positions[s] = { ...(cur.positions[s] || {}), shares, avgCost };
      }
      cur.updatedAt = new Date().toISOString();
      return cur;
    });
    const { quotes } = await currentQuotes();
    return sendJson(res, 200, { ok: true, positions: next.positions, holdings: holdingsView(next, quotes) });
  }

  if (path === '/api/buy' && method === 'POST') {
    const body = await readBody(req);
    const symbol = body.symbol;
    const amount = Number(body.amount);
    if (!SYMBOLS.includes(symbol)) throw new QuantError(`不支持的标的：${symbol}`, 'UNKNOWN_SYMBOL');
    if (!Number.isFinite(amount) || amount <= 0) throw new QuantError('买入金额必须是大于 0 的数字', 'INVALID_INPUT');

    const state = await store.get();
    const feeRate = body.feeRate == null ? state.rules?.feeRate ?? DEFAULT_FEE_RATE : validateFeeRate(Number(body.feeRate));
    const { quotes } = await currentQuotes();
    const price = quotes?.[symbol]?.price;
    if (!Number.isFinite(price) || price <= 0) {
      throw new QuantError(`暂时拿不到 ${symbol} 的实时价格，无法下单`, 'NO_PRICE');
    }
    const { state: nextState, buy } = applyBuy(state, symbol, amount, price, { feeRate, note: body.note });
    const saved = await store.write(nextState);
    return sendJson(res, 200, {
      ok: true,
      buy,
      positions: saved.positions,
      holdings: holdingsView(saved, quotes),
      quotes,
    });
  }

  if (path === '/api/buy/reset-baseline' && method === 'POST') {
    const body = await readBody(req);
    const symbols = Array.isArray(body.symbols) && body.symbols.length
      ? body.symbols.filter((s) => SYMBOLS.includes(s))
      : SYMBOLS;
    const { quotes } = await currentQuotes({ force: true });
    const next = await store.mutate((cur) => resetBaseline(cur, quotes, symbols).state);
    return sendJson(res, 200, { ok: true, changed: symbols.map((s) => ({ symbol: s, to: quotes?.[s]?.prevClose ?? null })), positions: next.positions });
  }

  if (path === '/api/buys/last' && method === 'DELETE') {
    const state = await store.get();
    const { state: nextState, undone } = undoLastBuy(state);
    const saved = await store.write(nextState);
    const { quotes } = await currentQuotes();
    return sendJson(res, 200, {
      ok: true,
      undone,
      positions: saved.positions,
      holdings: holdingsView(saved, quotes),
    });
  }

  return sendJson(res, 404, { ok: false, error: `未知接口：${method} ${path}` });
}

/* ------------------------------- 静态文件 ------------------------------- */

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const target = join(PUB_DIR, safe);
  if (!target.startsWith(PUB_DIR)) return sendText(res, 403, 'Forbidden');
  try {
    const info = await stat(target);
    if (info.isDirectory()) return sendText(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store, must-revalidate',
    });
    createReadStream(target).pipe(res);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

/* ------------------------------- 服务器 ------------------------------- */

/** 构造一个 StateStore；可以不传自定义 store（测试用），否则按环境变量选后端 */
export function makeStore(opts = {}) {
  return opts.store || new StateStore(makeBackend(opts));
}

export function createServer({
  token,
  store,
  stateFile,
  kvUrl,
  kvToken,
  kvKey,
  fetchImpl,
  authFile = AUTH_FILE,
  authDisabled = AUTH_DISABLED,
} = {}) {
  // 注意：stateFile 不给默认值。给了默认值会在配了云存储时把它误判成「用本地文件」。
  const theStore = store || makeStore({ stateFile, kvUrl, kvToken, kvKey, fetchImpl });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const clientIp = req.socket.remoteAddress;

    try {
      const auth = authorize({ req, url, clientIp, token, disabled: authDisabled });
      if (!auth.ok) {
        if (url.pathname.startsWith('/api/')) {
          return sendJson(res, 401, { ok: false, error: '需要访问口令', code: 'UNAUTHORIZED' });
        }
        const wrong = url.searchParams.has('token');
        return sendText(res, 401, loginPage({ source: auth.source, wrong }), 'text/html; charset=utf-8');
      }

      // 口令正确时种一个 cookie，之后同一浏览器不必再带 token
      if (auth.mode === 'token') {
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
      }

      if (url.pathname.startsWith('/api/')) {
        await ensureBaseline(theStore);
        await handleApi(req, res, url, theStore);
      } else {
        await serveStatic(req, res, url);
      }
    } catch (err) {
      // 存储类错误要有明确的 HTTP 语义：云存储挂了 → 503；只读降级 → 409（不是 500，也不静默丢数据）
      let status = 500;
      if (err instanceof QuantError) status = 400;
      else if (err instanceof StorageUnavailableError) status = 503;
      else if (err instanceof StorageReadOnlyError) status = 409;
      if (!res.headersSent) {
        sendJson(res, status, {
          ok: false,
          error: err?.message || '服务器内部错误',
          code: err?.code || 'INTERNAL',
        });
      } else {
        res.end();
      }
      if (status === 500) console.error('[api] 未预期错误:', err);
      else if (status !== 400) console.warn(`[api] ${status} ${err?.code || ''}: ${err?.message}`);
    }
  });
}

/* ------------------------------- 启动 ------------------------------- */

export async function startServer({
  port = PORT,
  host = HOST,
  token: providedToken,
  store: injectedStore,
  stateFile,
  kvUrl,
  kvToken,
  kvKey,
  fetchImpl,
  authFile = AUTH_FILE,
  authDisabled = AUTH_DISABLED,
} = {}) {
  const token = providedToken ?? (authDisabled ? null : await loadToken(authFile));
  const store = makeStore({ store: injectedStore, stateFile, kvUrl, kvToken, kvKey, fetchImpl });
  await store.cleanup();
  await store.load();
  const server = createServer({ token, store, authFile, authDisabled });
  await new Promise((ok, bad) => {
    server.once('error', (err) => {
      if (err?.code === 'EADDRINUSE') {
        bad(new Error(
          `端口 ${port} 已被占用（很可能已经有一个持仓助手在跑了）。\n`
          + '  想停掉它：双击 stop.bat\n'
          + '  想换个端口：设置环境变量 PORT 后再启动，例如  set PORT=9000 && node server.mjs',
        ));
        return;
      }
      bad(err);
    });
    server.listen(port, host, () => ok());
  });
  return { server, port: server.address().port, token, store };
}

function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const { port, token } = await startServer({});
  const lan = lanAddresses();
  const line = '─'.repeat(62);
  console.log(`\n${line}\n  持仓助手已启动\n${line}`);
  console.log(`  本机：      http://127.0.0.1:${port}`);
  for (const a of lan) console.log(`  局域网：    http://${a.address}:${port}   (${a.name})`);
  console.log('  外网：      https://<机器名>.<tailnet>.ts.net   （需先跑一次 tailscale serve --bg ' + port + '）');
  if (AUTH_DISABLED) {
    console.log('\n  访问口令：  已关闭（STOCK_AUTH=off）');
  } else {
    console.log(`\n  访问口令：  ${token}`);
    console.log(`              已写入 ${AUTH_FILE}`);
    console.log('              局域网打开时输入一次即可；Tailscale 路径免口令。');
  }
  console.log(`  数据文件：  ${STATE_FILE}`);
  console.log(`  手续费规则：最小 ${LOT_SIZE} 股，费率 ${(DEFAULT_FEE_RATE * 100).toFixed(2)}%（页面可改）`);
  console.log(`${line}\n  按 Ctrl+C 停止\n`);
}
