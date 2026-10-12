/**
 * test/smoke.mjs — 单元 + 端到端冒烟测试（零依赖，用 Node 内置 node:test）
 *
 * 跑法： node --test test/   或   node test/smoke.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTencent, parseSina, getQuotes, summarize, marketStateOf, SYMBOLS } from '../lib/quotes.mjs';
import {
  allocate, applyBuy, undoLastBuy, holdingsView, rolloverBaseline, resetBaseline, evenAllocation,
  minAmountFor, roundLot, QuantError, LOT_SIZE, DEFAULT_FEE_RATE,
} from '../lib/quant.mjs';
import { StateStore, normalizeState, DEFAULT_STATE, createFileBackend, createRestKvBackend, createDegradedBackend, StorageUnavailableError, StorageReadOnlyError } from '../lib/store.mjs';
import { startServer } from '../server.mjs';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const STOCK_DIR = resolve(HERE, '..');

/* ---------- 测试用的固定行情（与手算表一致，四只标的） ---------- */
const QUOTES = {
  VOO: { symbol: 'VOO', name: 'Vanguard 标普500 ETF', price: 715.59, prevClose: 711.28, source: 'tencent', quoteTime: '2026-10-12 04:00:01' },
  'BRK.B': { symbol: 'BRK.B', name: '伯克希尔 B 股', price: 515.62, prevClose: 511.05, source: 'tencent', quoteTime: '2026-10-12 04:00:01' },
  AAPL: { symbol: 'AAPL', name: '苹果', price: 336.64, prevClose: 340.42, source: 'tencent', quoteTime: '2026-10-12 04:00:01' },
  PDD: { symbol: 'PDD', name: '拼多多', price: 81.35, prevClose: 78.26, source: 'tencent', quoteTime: '2026-10-12 04:00:01' },
};
const ALLOC4 = { VOO: 50, 'BRK.B': 25, AAPL: 15, PDD: 10 };
const ALLOC3 = { VOO: 60, 'BRK.B': 30, AAPL: 10, PDD: 0 };

const sampleState = () => ({
  ...structuredClone(DEFAULT_STATE),
  rules: { lotSize: LOT_SIZE, feeRate: DEFAULT_FEE_RATE },
  positions: {
    VOO: { shares: 0, avgCost: 0, baselinePrevClose: 711.28 },
    'BRK.B': { shares: 0, avgCost: 0, baselinePrevClose: 511.05 },
    AAPL: { shares: 0, avgCost: 0, baselinePrevClose: 340.42 },
    PDD: { shares: 0, avgCost: 0, baselinePrevClose: 78.26 },
  },
});

/* =========================== 1. 行情解析 =========================== */

test('parseTencent：解析 GBK 文本，字段对齐', () => {
  const text = [
    'v_usVOO="200~标普500 ETF-Vanguard~VOO.AM~715.59~711.28~713.54~4345835~0~0~715.70~40~0~0~0~0~0~0~0~0~716.00~400~0~0~0~0~0~0~0~0~~2026-10-09 16:00:01~4.31~0.61~716.44~712.54~USD~4345835~3106869224~~~~~~0.55~~~Vanguard Index "',
    'v_usAAPL="200~苹果~AAPL.OQ~336.64~340.42~331.70~37881199~0~0~336.02~40~0~0~0~0~0~0~0~0~336.09~280~0~0~0~0~0~0~0~0~~2026-10-09 16:00:01~-3.78~-1.11~338.61~330.70~USD~37881199~12681326971~0.26~38.61~~45.13~~2.32~49099.31053~49129.84755~Apple Inc.~8.72~345.34~242.76~-240~45.69~0.31~49129.84755~24.16~0.88"',
    'v_usBRK.B="200~伯克希尔B~BRK.B.N~515.62~511.05~510.00~4306143~0~0~515.25~40~0~0~0~0~0~0~0~0~515.65~80~0~0~0~0~0~0~0~~2026-10-09 16:04:41~4.57~0.89~516.57~509.71~USD~4306143~2217769471~0.20~12.97~~16.61~~1.34~6432.94325~11037.92784~Berkshire Hathaway Inc. New~39.77~537.74~464.01~-40~1.48~~11037.92784~2"',
  ].join('\n');
  const q = parseTencent(text);
  assert.equal(q.VOO.price, 715.59);
  assert.equal(q.VOO.prevClose, 711.28);
  assert.equal(q.VOO.change, 4.31);
  assert.equal(q.VOO.changePct, 0.61);
  assert.equal(q.VOO.quoteTime, '2026-10-09 16:00:01');
  assert.equal(q.VOO.currency, 'USD');
  assert.equal(q['BRK.B'].price, 515.62, '带点的 BRK.B 必须映射成功');
  assert.equal(q['BRK.B'].name, '伯克希尔B');
  assert.equal(q.AAPL.change, -3.78);
  assert.ok(!/\uFFFD/.test(JSON.stringify(q)), '不应出现替换字符（GBK 解码干净）');
});

test('parseSina：正常行解析、BRK.B 空串跳过', () => {
  const text = [
    // 真实新浪美股格式（36 个字段）：[1] 最新价、[3] 时间、[5] 今开、[6] 最高、[7] 最低、[26] 昨收
    'var hq_str_gb_voo="Vanguard标普500指数ETF,715.5900,0.61,2026-10-12 18:30:20,4.3100,713.5400,716.4350,712.5400,718.4700,576.4980,4345835,6563128,1061294477946,0.00,--,0.00,0.00,0.00,0.00,1483104121,0,716.0484,0.06,0.40,Oct 12 06:30AM EDT,Oct 09 04:00PM EDT,711.2800,23270,1,2026,3106542418.7417,717.9700,715.9387,16683167.2697,717.5062,715.6500";',
    'var hq_str_gb_brk.b="";',
  ].join('\n');
  const q = parseSina(text);
  assert.equal(q.VOO.price, 715.59);
  assert.equal(q.VOO.prevClose, 711.28, '昨收取索引 26');
  assert.equal(q.VOO.source, 'sina');
  assert.equal(q.VOO.change, 4.31);
  // 涨跌幅由 现价/昨收 算出（0.6059），与接口自报的 0.61 相差在四舍五入范围内
  assert.ok(Math.abs(q.VOO.changePct - 0.61) < 0.01, `涨跌幅应约等于 0.61，实际 ${q.VOO.changePct}`);
  assert.equal(q.VOO.quoteTime, '2026-10-12 18:30:20');
  assert.ok(!('BRK.B' in q), '新浪 BRK.B 为空必须跳过，而不是产出价格 0');
});

test('marketStateOf：用真实时刻自校验（America/New_York）', () => {
  const now = new Date();
  const nyText = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(now).replace(',', '');
  const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts });
  const p = Object.fromEntries(fmt({ hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const hh = Number(p.hour) % 24, mm = Number(p.minute);
  const mins = hh * 60 + mm;
  const weekend = p.weekday === 'Sat' || p.weekday === 'Sun';

  const got = marketStateOf(nyText);
  if (weekend) {
    assert.equal(got.state, 'closed', '周末必须是休市');
  } else if (mins >= 570 && mins < 960) {
    assert.equal(got.state, 'open');
  } else if (mins >= 240 && mins < 570) {
    assert.equal(got.state, 'pre');
  } else if (mins >= 960 && mins < 1200) {
    assert.equal(got.state, 'after');
  } else {
    assert.equal(got.state, 'closed');
  }
  assert.match(got.label, /交易中|盘前|盘后|收盘|休市/);
});

test('getQuotes：真实拉取全部标的（需要联网）', async () => {
  const quotes = await getQuotes(SYMBOLS, { force: true });
  for (const s of SYMBOLS) {
    const q = quotes[s];
    assert.ok(q, `${s} 必须拿到行情`);
    assert.ok(q.price > 0, `${s} 现价必须大于 0`);
    assert.ok(q.prevClose > 0, `${s} 昨收必须大于 0`);
    const expect = Number((((q.price - q.prevClose) / q.prevClose) * 100).toFixed(4));
    assert.ok(Math.abs(q.changePct - expect) < 0.02, `${s} 涨跌幅应与 (现价-昨收)/昨收 一致`);
    assert.ok(!/\uFFFD/.test(q.name || ''), `${s} 名称不应有替换字符`);
    assert.ok(q.quoteTime, `${s} 必须带行情时间（休市要能看出来）`);
  }
  assert.ok(quotes.PDD, '拼多多必须被跟踪到');
  assert.equal(quotes.PDD.name, '拼多多');
  const meta = summarize(quotes);
  assert.ok(meta.asOf, '汇总里要有行情时间');
  assert.equal(meta.anyMissing, false);
});

/* =========================== 2. 配比 + 手续费 =========================== */

test('allocation：4 只标的、0.01 股向下取整 + 0.1% 手续费（逐格核对）', () => {
  const r = allocate(3000, ALLOC4, QUOTES, { feeRate: 0.001 });
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.equal(r.lines.length, 4, '四只标的都要出现，包括 PDD');
  const [v, b, a, p] = r.lines;

  assert.deepEqual([v.symbol, b.symbol, a.symbol, p.symbol], ['VOO', 'BRK.B', 'AAPL', 'PDD']);
  assert.deepEqual([v.amount, b.amount, a.amount, p.amount], [1500, 750, 450, 300]);
  assert.deepEqual([v.shares, b.shares, a.shares, p.shares], [2.09, 1.45, 1.33, 3.68],
    '份额必须向下取整到 0.01');
  assert.deepEqual([v.stockCost, b.stockCost, a.stockCost, p.stockCost], [1495.58, 747.65, 447.73, 299.37]);
  assert.deepEqual([v.fee, b.fee, a.fee, p.fee], [1.5, 0.75, 0.45, 0.3], '手续费 = 申请金额 × 0.1%');
  assert.deepEqual([v.totalCharge, b.totalCharge, a.totalCharge, p.totalCharge],
    [1497.08, 748.4, 448.18, 299.67], '实际扣款 = 股票占用 + 手续费（手续费另计）');
  assert.deepEqual([v.residual, b.residual, a.residual, p.residual], [4.42, 2.35, 2.27, 0.63], '取整零头要明示');

  assert.equal(r.summary.stockTotal, 2990.33);
  assert.equal(r.summary.feeTotal, 3);
  assert.equal(r.summary.actualTotalCharge, 2993.33);
  assert.equal(r.summary.residualTotal, 9.67);

  // 核心不变量：实际扣款永远不会超过「总金额 + 手续费」
  const worstCase = Number((r.total * (1 + r.feeRate)).toFixed(2));
  assert.ok(r.summary.actualTotalCharge <= worstCase, `扣款 ${r.summary.actualTotalCharge} 不应超过 ${worstCase}`);
  assert.ok(r.summary.actualTotalCharge <= r.total + r.summary.feeTotal, '扣款不应超过「买入金额 + 手续费」');
  assert.match(r.summary.chargeNote, /0\.01 股取整/);

  // 单只占比为 0 时该行照常出现、但不计金额，也不报错
  const withZero = allocate(3000, { VOO: 100, 'BRK.B': 0, AAPL: 0, PDD: 0 }, QUOTES, { feeRate: 0.001 });
  assert.equal(withZero.ok, true);
  assert.equal(withZero.lines.length, 4);
  assert.equal(withZero.lines[3].shares, 0);
  assert.equal(withZero.lines[3].amount, 0);
});

test('evenAllocation：四等分也能凑成整数 100', () => {
  const e = evenAllocation(SYMBOLS);
  assert.equal(SYMBOLS.reduce((a, s) => a + e[s], 0), 100);
  assert.deepEqual(Object.values(e), [25, 25, 25, 25]);
  const e3 = evenAllocation(['VOO', 'BRK.B', 'AAPL']);
  assert.equal(100 - (e3.VOO + e3['BRK.B'] + e3.AAPL), 0);
  assert.deepEqual(Object.values(e3), [33.33, 33.33, 33.34]);
});

test('allocation：和不为 100 / 负数 / 坏费率 都要报错', () => {
  assert.throws(() => allocate(3000, { VOO: 50, 'BRK.B': 30, AAPL: 10, PDD: 0 }, QUOTES), /必须等于 100%/);
  assert.throws(() => allocate(3000, { VOO: -1, 'BRK.B': 51, AAPL: 50, PDD: 0 }, QUOTES), /不小于 0/);
  assert.throws(() => allocate(0, ALLOC4, QUOTES), /大于 0/);
  assert.throws(() => allocate(3000, ALLOC4, QUOTES, { feeRate: 0.5 }), /手续费率/);
  // 容差内允许（33.33 × 3 = 99.99）
  assert.equal(allocate(3000, { VOO: 33.33, 'BRK.B': 33.33, AAPL: 33.34, PDD: 0 }, QUOTES).ok, true);
  // 错误文案要说清是几个百分比、并点名拼多多这一类新增标的
  assert.throws(() => allocate(3000, { VOO: 40, 'BRK.B': 20, AAPL: 20, PDD: 10 }, QUOTES), /4 个百分比之和是 90%/);
});

test('allocation：刚好 0.01 股可以买，少一分钱就拒绝并给出最小金额', () => {
  const price = 715.59;
  const min = minAmountFor(price, 0.001);
  assert.equal(min, 7.16);
  const one = { VOO: 100, 'BRK.B': 0, AAPL: 0, PDD: 0 };
  const okCase = allocate(min, one, { VOO: { price } }, { feeRate: 0.001 });
  assert.equal(okCase.ok, true);
  assert.equal(okCase.lines[0].shares, 0.01);

  const bad = allocate(7.15, one, { VOO: { price } }, { feeRate: 0.001 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /不足最小交易单位 0.01 股/);
  assert.match(bad.errors[0], /\$7\.16/);
});

test('allocation：拿不到价格时明确报错，绝不当作 0', () => {
  const r = allocate(3000, ALLOC4, { VOO: QUOTES.VOO, 'BRK.B': null, AAPL: QUOTES.AAPL, PDD: QUOTES.PDD });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /BRK\.B.*拿不到实时价格/);
  assert.equal(r.lines[1].price, null);
  assert.equal(r.lines[1].shares, 0);
  // 其余三只照样算出来
  assert.ok(r.lines[0].shares > 0);
  assert.ok(r.lines[3].shares > 0, 'PDD 不受 BRK.B 缺价影响');
});

test('roundLot：只向下、不向上', () => {
  assert.equal(roundLot(2.519), 2.51);
  assert.equal(roundLot(0.009), 0);
  assert.equal(roundLot(1), 1);
  assert.equal(roundLot(0.01), 0.01);
});

/* =========================== 3. 买入入账 =========================== */

test('applyBuy：份额累加、含费加权成本、流水字段完整', () => {
  let state = sampleState();
  const r1 = applyBuy(state, 'VOO', 1800, 715.59, { feeRate: 0.001, at: '2026-10-12T10:00:00.000Z' });
  assert.equal(r1.buy.shares, 2.51);
  assert.equal(r1.buy.stockCost, 1796.13);
  assert.equal(r1.buy.fee, 1.8);
  assert.equal(r1.buy.totalCharge, 1797.93);
  assert.equal(r1.buy.residual, 3.87);
  assert.equal(r1.state.positions.VOO.shares, 2.51);
  assert.equal(r1.state.positions.VOO.avgCost, 716.306773);
  assert.equal(r1.state.buys.length, 1);

  // 第二次买入：加权成本 = (2.51×716.306773 + 1796.13 + 1.8) / (2.51 + 2.51)
  const r2 = applyBuy(r1.state, 'VOO', 1800, 715.59, { feeRate: 0.001 });
  assert.equal(r2.state.positions.VOO.shares, 5.02);
  const expectCost = Number(((2.51 * 716.306773 + 1796.13 + 1.8) / 5.02).toFixed(6));
  assert.equal(r2.state.positions.VOO.avgCost, expectCost);
  assert.equal(r2.state.buys.length, 2);
  assert.equal(r2.state.buys[0].id, r2.buy.id, '最新一笔在最前面');

  // 原 state 不被改动（纯函数）
  assert.equal(state.positions.VOO.shares, 0);
});

test('applyBuy：不足 0.01 股时报中文错误并给出最小金额', () => {
  const state = sampleState();
  assert.throws(
    () => applyBuy(state, 'VOO', 7.15, 715.59, { feeRate: 0.001 }),
    (err) => err instanceof QuantError && err.code === 'BELOW_MIN_LOT'
      && /不足最小交易单位 0.01 股/.test(err.message) && /\$7\.16/.test(err.message),
  );
  assert.throws(() => applyBuy(state, 'TSLA', 100, 10), /不支持的标的/);
});

test('undoLastBuy：精确回滚份额与成本价', () => {
  const state = sampleState();
  state.positions.VOO = { shares: 10, avgCost: 700, baselinePrevClose: 711.28 };
  const after = applyBuy(state, 'VOO', 1800, 715.59, { feeRate: 0.001 }).state;
  assert.equal(after.positions.VOO.shares, 12.51);
  const { state: back, undone } = undoLastBuy(after);
  assert.equal(undone.symbol, 'VOO');
  assert.equal(back.positions.VOO.shares, 10);
  assert.equal(back.positions.VOO.avgCost, 700);
  assert.equal(back.buys.length, 0);
  assert.throws(() => undoLastBuy(sampleState()), /没有可撤销/);
});

/* =========================== 4. 持仓视图 =========================== */

test('holdingsView：当日盈亏/累计盈亏/比重，成本为 0 时不产生 NaN', () => {
  const state = sampleState();
  state.positions.VOO = { shares: 2.51, avgCost: 718, baselinePrevClose: 711.28 };
  state.positions['BRK.B'] = { shares: 1.74, avgCost: 515.61, baselinePrevClose: 511.05 };
  const view = holdingsView(state, QUOTES);

  const v = view.lines.find((l) => l.symbol === 'VOO');
  assert.equal(v.marketValue, 1796.13);
  assert.equal(v.costValue, 1802.18);            // 2.51 × 718
  assert.equal(v.dayPnl, 10.82);                 // (715.59 − 711.28) × 2.51
  assert.equal(v.totalPnl, -6.05);
  assert.ok(Math.abs(v.weightPct + view.lines.find((l) => l.symbol === 'BRK.B').weightPct
    + view.lines.find((l) => l.symbol === 'AAPL').weightPct - 100) < 0.01, '比重之和应为 100%');

  const zeroCost = holdingsView(sampleState(), QUOTES).lines.find((l) => l.symbol === 'VOO');
  assert.equal(zeroCost.totalPnlPct, null, '没有成本时收益率应为 null 而不是 Infinity');
  assert.equal(zeroCost.totalPnl, 0);
  assert.ok(!JSON.stringify({ lines: view.lines, summary: view.summary }).match(/NaN|Infinity|null,null/));

  const noPrice = holdingsView(state, { VOO: null, 'BRK.B': QUOTES['BRK.B'], AAPL: QUOTES.AAPL, PDD: QUOTES.PDD });
  const v2 = noPrice.lines.find((l) => l.symbol === 'VOO');
  assert.equal(v2.marketValue, null, '没有价格时市值应是 null，而不是 0');
  assert.equal(v2.dayPnl, null);
});

test('rolloverBaseline：昨收变化时滚动基准并留痕', () => {
  const state = sampleState();
  state.positions.VOO = { shares: 10, avgCost: 700, baselinePrevClose: 700 };
  const quotes = { ...QUOTES, VOO: { ...QUOTES.VOO, prevClose: 711.28 } };
  const { state: next, rolled } = rolloverBaseline(state, quotes, { at: '2026-10-13T13:30:00.000Z' });
  assert.equal(rolled.length, 1);
  assert.deepEqual(rolled[0], { symbol: 'VOO', from: 700, to: 711.28 });
  assert.equal(next.positions.VOO.baselinePrevClose, 711.28);
  assert.equal(next.baselineHistory.length, 1);

  // 再跑一次不应重复滚动
  const again = rolloverBaseline(next, quotes);
  assert.equal(again.rolled.length, 0);

  // 滚动后当日盈亏应基于新基准
  const view = holdingsView(next, quotes);
  assert.equal(view.lines.find((l) => l.symbol === 'VOO').dayPnl, Number(((715.59 - 711.28) * 10).toFixed(2)));

  const reset = resetBaseline(state, quotes, ['VOO']);
  assert.equal(reset.state.positions.VOO.baselinePrevClose, 711.28);
});

/* =========================== 5. 存储 =========================== */

test('store：写读往返、原子写、并发写后 JSON 仍合法', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-store-'));
  const file = join(dir, 'state.json');
  try {
    const store = new StateStore(file);
    const initial = await store.load();
    assert.equal(initial.rules.feeRate, DEFAULT_FEE_RATE);
    assert.deepEqual(Object.keys(initial.positions).sort(), ['AAPL', 'BRK.B', 'PDD', 'VOO']);

    await store.mutate((s) => { s.targets.totalAmount = 1234; return s; });
    const reread = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(reread.targets.totalAmount, 1234);

    await Promise.all(Array.from({ length: 20 }, (_, i) => store.mutate((s) => {
      s.targets.allocation.VOO = i;
      s.positions.VOO = { shares: i, avgCost: i, baselinePrevClose: 700 };
      return s;
    })));
    const final = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(typeof final.targets.allocation.VOO, 'number');
    assert.equal(final.positions.VOO.shares, 19, '20 次并发写必须串行收尾，最后一次生效');

    // 损坏文件要能自我修复（先备份再重建）
    await writeFile(file, '{ this is not json', 'utf8');
    const fresh = new StateStore(file);
    const recovered = await fresh.load();
    assert.equal(recovered.targets.totalAmount, DEFAULT_STATE.targets.totalAmount);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('store：write 与 mutate 并发混跑不会互相踩（回归：曾经 rename ENOENT 导致接口 500）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-race-'));
  const file = join(dir, 'state.json');
  try {
    const store = new StateStore(file);
    await store.load();
    const current = await store.get();

    // 线上就是这么触发的：直接 write（/api/positions、/api/buy）与 mutate 混着来
    const jobs = [];
    for (let i = 0; i < 30; i += 1) {
      if (i % 2 === 0) {
        jobs.push(store.write({ ...structuredClone(current), targets: { ...current.targets, totalAmount: 1000 + i } }));
      } else {
        jobs.push(store.mutate((s) => { s.positions.VOO = { shares: i, avgCost: i, baselinePrevClose: 1 }; return s; }));
      }
    }
    const settled = await Promise.allSettled(jobs);
    const failed = settled.filter((r) => r.status === 'rejected');
    assert.equal(failed.length, 0, `并发写不应失败，实际失败 ${failed.length} 次：${failed[0]?.reason?.message}`);

    const onDisk = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(Number.isFinite(onDisk.targets.totalAmount));
    assert.ok(Number.isFinite(onDisk.positions.VOO.shares));
    // 临时文件必须都清干净
    const leftovers = (await readdir(dir)).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], `不应残留临时文件：${leftovers.join(',')}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('normalizeState：缺字段/非法值都能补成合法状态', () => {
  const s = normalizeState({ targets: { totalAmount: 'abc', allocation: { VOO: -5 } }, rules: { feeRate: 99 }, positions: { VOO: { shares: '2.5' } } });
  assert.equal(s.targets.totalAmount, DEFAULT_STATE.targets.totalAmount);
  assert.equal(s.targets.allocation.VOO, DEFAULT_STATE.targets.allocation.VOO);
  assert.equal(s.targets.allocation.PDD, DEFAULT_STATE.targets.allocation.PDD, '旧文件缺 PDD 时要自动补上默认配比');
  assert.equal(s.rules.feeRate, 0.001, '非法的 99 费率要被换回默认值');
  assert.equal(s.positions.VOO.shares, 2.5);
  assert.equal(s.positions.VOO.baselinePrevClose, null);
  assert.equal(s.positions.PDD.shares, 0, '旧文件缺 PDD 持仓时要补 0');
  // 合法费率要原样保留
  assert.equal(normalizeState({ rules: { feeRate: 0.0025 } }).rules.feeRate, 0.0025);
});

/* =========================== 6. 端到端 =========================== */

test('端到端：起服务跑一遍 quotes → targets → buy → holdings → undo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-e2e-'));
  const stateFile = join(dir, 'state.json');
  const { server, port } = await startServer({ port: 0, host: '127.0.0.1', stateFile, authDisabled: true });
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, init) => {
    const res = await fetch(base + path, init);
    const body = await res.json();
    return { status: res.status, body };
  };

  try {
    const health = await call('/api/health');
    assert.equal(health.status, 200);
    assert.match(health.body.auth, /^(on|off)$/);

    const quotes = await call('/api/quotes');
    assert.equal(quotes.status, 200);
    assert.ok(quotes.body.quotes.VOO.price > 0);

    // 总金额必须为正
    const bad = await call('/api/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ totalAmount: 0, allocation: ALLOC4 }) });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /大于 0/);

    // 配比没配平要 400
    const badPct = await call('/api/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ totalAmount: 3000, allocation: { VOO: 50, 'BRK.B': 25, AAPL: 10, PDD: 10 } }) });
    assert.equal(badPct.status, 400);
    assert.match(badPct.body.error, /4 个百分比之和是 95%/);

    const pct = await call('/api/targets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ totalAmount: 3000, allocation: ALLOC4, feeRate: 0.001 }) });
    assert.equal(pct.status, 200);
    assert.equal(pct.body.targets.allocation.PDD, 10, 'PDD 的配比要能存下');

    // 四只标的都要在行情和持仓视图里出现
    assert.equal(quotes.body.symbols.length, 4);
    assert.deepEqual(quotes.body.symbols, ['VOO', 'BRK.B', 'AAPL', 'PDD']);

    const before = await call('/api/holdings');
    assert.equal(before.body.lines.length, 4);
    const beforeShares = before.body.lines.find((l) => l.symbol === 'VOO').shares;

    // 录入现有持仓
    const posRes = await call('/api/positions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions: { PDD: { shares: 40, avgCost: 95.5 } } }),
    });
    assert.equal(posRes.status, 200);
    const pdd = posRes.body.holdings.lines.find((l) => l.symbol === 'PDD');
    assert.equal(pdd.shares, 40);
    assert.equal(pdd.avgCost, 95.5);
    assert.ok(pdd.marketValue > 0);
    assert.ok(pdd.totalPnl < 0, '成本 95.5 高于现价，累计盈亏应为负');

    const buy = await call('/api/buy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: 'VOO', amount: 1800 }) });
    assert.equal(buy.status, 200, JSON.stringify(buy.body));
    assert.equal(buy.body.buy.shares, 2.51);
    assert.equal(buy.body.buy.fee, 1.8);
    assert.equal(buy.body.buy.totalCharge, 1797.93);
    // 用真实成交价核对：股票占用 = 0.01 股向下取整 × 现价
    const realPrice = quotes.body.quotes.VOO.price;
    assert.equal(buy.body.buy.price, realPrice);
    assert.equal(buy.body.buy.stockCost, Number((2.51 * realPrice).toFixed(2)));
    assert.equal(buy.body.holdings.lines.find((l) => l.symbol === 'VOO').shares, beforeShares + 2.51);

    // PDD 也能一键买入
    const buyPdd = await call('/api/buy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: 'PDD', amount: 300 }) });
    assert.equal(buyPdd.status, 200, JSON.stringify(buyPdd.body));
    assert.equal(buyPdd.body.buy.shares, 3.68);
    assert.equal(buyPdd.body.buy.fee, 0.3);
    assert.equal(buyPdd.body.holdings.lines.find((l) => l.symbol === 'PDD').shares, 43.68);

    // 金额太小要 400 而不是 500
    const tooSmall = await call('/api/buy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: 'AAPL', amount: 0.5 }) });
    assert.equal(tooSmall.status, 400);
    assert.match(tooSmall.body.error, /不足最小交易单位/);

    // 状态确实落盘
    const onDisk = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(onDisk.positions.VOO.shares, beforeShares + 2.51);
    assert.equal(onDisk.positions.PDD.shares, 43.68);

    const undo = await call('/api/buys/last', { method: 'DELETE' });
    assert.equal(undo.status, 200);
    assert.equal(undo.body.holdings.lines.find((l) => l.symbol === 'PDD').shares, 40, '撤销应回滚到录入的 40 股');

    const reset = await call('/api/buy/reset-baseline', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(reset.status, 200);

    const even = await call('/api/even-allocation');
    assert.equal(even.status, 200);
    assert.equal(Object.values(even.body.allocation).reduce((a, b) => a + b, 0), 100);

    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /持仓助手/);
    assert.match(html, /一键买入|按配比全部买入/);
  } finally {
    await new Promise((ok) => server.close(ok));
    await rm(dir, { recursive: true, force: true });
  }
});

test('前端：配比区在百分比不合法时不能清空表格（回归：曾导致输入框消失、永远凑不到 100%）', async () => {
  const html = await readFile(join(STOCK_DIR, 'pub', 'index.html'), 'utf8');

  // 1) computeAllocation 必须无条件返回每只一行，不因为「和不等于 100」而返回空数组
  const fn = html.match(/function computeAllocation\(\)[\s\S]*?\n\}/);
  assert.ok(fn, '必须能找到 computeAllocation');
  const body = fn[0];
  assert.ok(!/if \(Math\.abs\(sum - 100\)[^)]*\) \{ *out\.lines\.push[\s\S]*?return out;/.test(body),
    '不得在百分比不合法时提前 return');
  assert.ok(body.includes('sumRaw'), 'computeAllocation 必须给出 sumRaw（还差多少）');
  // 每一个 return out 之前，lines 都要被填满（这里检查循环是覆盖全部标的的）
  assert.match(body, /for \(const s of SYMBOLS\) \{[\s\S]*?out\.lines\.push\(line\)/, '每只标的都必须 push 一行');

  // 2) 返回对象必须真的带上 sumRaw（曾经漏了，导致前端显示 "还差 NaN%"）
  const outLiteral = body.match(/const out = \{[^}]*\}/);
  assert.ok(outLiteral, '必须能找到 out 对象字面量');
  for (const key of ['total', 'feeRate', 'alloc', 'sum', 'sumRaw', 'sumOk', 'lines', 'errors']) {
    assert.ok(new RegExp(`\\b${key}\\b`).test(outLiteral[0]), `out 对象必须包含 ${key}`);
  }

  // 3) 渲染必须区分「建一次结构」和「就地更新数字」，不能在每次输入时重建输入框
  assert.match(html, /data-cell="\$\{esc\(s\)\}-calc"/, '列表结构只在 built 分支里建一次');
  assert.match(html, /const built = document\.querySelectorAll\('#allocbody \.allocrow'\)\.length === N/,
    'built 判定必须只数 .allocrow（每只标的还带一条隐藏错误行）');
  assert.match(html, /const setCell = \(id, html\)/, '就地更新用 setCell');

  // 4) 没有任何地方把配比列表写空
  assert.ok(!/allocbody'\)\.innerHTML = ''/.test(html), '不允许把配比列表清空');

  // 5) 必须有个一键补齐的入口
  assert.ok(html.includes('id="fillsum"'), '必须提供「补齐到 100%」按钮');
  assert.match(html, /function fillRemainder\(\)/);
});

test('前端：百分比只能是整数，且输入时不重建表格（回归：输入 45 只剩 4、焦点丢失）', async () => {
  const html = await readFile(join(STOCK_DIR, 'pub', 'index.html'), 'utf8');

  // 1) 从页面里取出 sanitizePct 的真实实现来断言行为（不靠复制粘贴的副本）
  const src = html.match(/function sanitizePct\(raw\) \{[\s\S]*?\n\}/);
  assert.ok(src, '必须能找到 sanitizePct');
  const { sanitizePct } = await import(`data:text/javascript,${encodeURIComponent(`${src[0]}\nexport { sanitizePct };`)}`);
  assert.equal(sanitizePct(''), '', '空着就是空着，不要变成 0');
  assert.equal(sanitizePct('4'), '4');
  assert.equal(sanitizePct('45'), '45');
  assert.equal(sanitizePct('4.5'), '4', '小数点之后的内容丢掉（用户要整数百分比）');
  assert.equal(sanitizePct('45.9'), '45');
  assert.equal(sanitizePct('1.5'), '1');
  assert.equal(sanitizePct('-10'), '10', '负号必须被吃掉');
  assert.equal(sanitizePct('abc'), '', '非数字要清空');
  assert.equal(sanitizePct('007'), '7', '去掉前导零');
  assert.equal(sanitizePct('100'), '100');
  assert.equal(sanitizePct('999'), '100', '超上限要夹到 100');
  assert.equal(sanitizePct('1234'), '100');
  // 关键：逐字符输入的过程值必须单调、不跳变
  const typing = ['', '4', '45', '45'];
  for (const step of ['', '4', '45']) {
    const v = Number(sanitizePct(step) || 0);
    assert.ok(v >= 0 && v <= 100, `${JSON.stringify(step)} 处理后必须在 0~100`);
  }
  for (const v of [0, 1, 7, 25, 50, 99, 100]) {
    assert.equal(sanitizePct(String(v)), String(v), `${v} 必须原样保留`);
  }

  // 2) 「结构是否已建好」的判定必须排除隐藏的错误行，否则每个字符都会重建整个列表
  assert.match(html, /const built = document\.querySelectorAll\('#allocbody \.allocrow'\)\.length === N/,
    'built 判定必须只数 .allocrow（历史 bug：数了全部行导致判定永false，每次输入都重建 → 输入 45 只剩 4）');
  assert.ok(!/const built = document\.querySelectorAll\('#allocbody tr'\)\.length === N/.test(html),
    '不允许再用全部 tr 判定');
  assert.ok(!/const built = document\.querySelectorAll\('#allocbody tr:not/.test(html),
    '旧的表格判定方式已废弃');

  // 3) 事件绑定必须是幂等的，重建也不能重复绑
  assert.match(html, /el\.dataset\.bound !== '1'/, '输入框事件绑定必须幂等');

  // 4) 百分比输入框必须是整数键盘 + 无 spinner
  assert.match(html, /data-pct="\$\{esc\(s\)\}" value="\$\{Math\.round\(a\.alloc\[s\]\)\}"/, '初始值也要取整');
  assert.match(html, /inputmode="numeric" step="1" min="0" max="100" data-pct/, '应该是整数输入');
  assert.match(html, /\.pctinput::-webkit-inner-spin-button/, '要去掉数字框的上下箭头');

  // 5) 均分按钮也必须产出整数且加起来正好 100
  assert.match(html, /const base = Math\.floor\(100 \/ n\)/, '均分要用整数分配');

  // 6) 没配平/总金额非法时绝不能落库（否则下次打开总金额会变成坏值）
  const saveFn = html.match(/async function saveTargets\(\{ quiet = false \} = \{\}\) \{[\s\S]*?\n\}/);
  assert.ok(saveFn, '必须能找到 saveTargets');
  assert.match(saveFn[0], /Math\.abs\(sum - 100\) > 0\.01/, '要校验配比之和');
  assert.match(saveFn[0], /totalAmount <= 0/, '要校验总金额');
  assert.match(saveFn[0], /return; \}/, '不合法时必须提前 return，不能继续 POST');
  assert.ok(saveFn[0].indexOf('Math.abs(sum - 100)') < saveFn[0].indexOf('/api/targets'),
    '校验必须发生在 POST 之前');
});

test('云端部署：DATA_DIR 决定数据落盘位置（回归：云端目录只读时不能写到代码目录）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-data-'));
  const dataDir = join(dir, 'volume');
  await (await import('node:fs/promises')).mkdir(dataDir, { recursive: true });

  // 模拟容器：DATA_DIR 指向挂载卷、STOCK_TOKEN 由 secrets 提供、端口随机
  const { server, port } = await startServer({
    port: 0, host: '127.0.0.1',
    stateFile: join(dataDir, 'state.json'),
    authFile: join(dataDir, '.auth.txt'),
    authDisabled: true,
  });
  try {
    // 写一笔，确认落在 volume 目录里而不是代码目录
    const res = await fetch(`http://127.0.0.1:${port}/api/positions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions: { VOO: { shares: 3, avgCost: 700 } } }),
    });
    assert.equal(res.status, 200);
    const onVolume = JSON.parse(await readFile(join(dataDir, 'state.json'), 'utf8'));
    assert.equal(onVolume.positions.VOO.shares, 3, 'state.json 必须写在 DATA_DIR 里');
  } finally {
    await new Promise((ok) => server.close(ok));
    await rm(dir, { recursive: true, force: true });
  }

  // STOCK_TOKEN 环境变量优先于文件（云端 secrets 用这个）
  const { loadToken } = await import('../lib/auth.mjs');
  const dir2 = await mkdtemp(join(tmpdir(), 'stock-token-'));
  const prev = process.env.STOCK_TOKEN;
  try {
    process.env.STOCK_TOKEN = 'token-from-secret';
    assert.equal(await loadToken(join(dir2, '.auth.txt')), 'token-from-secret', '环境变量必须优先');
    delete process.env.STOCK_TOKEN;
    const generated = await loadToken(join(dir2, '.auth.txt'));
    assert.ok(generated.length >= 10, '没有环境变量时回落到自动生成');
  } finally {
    if (prev === undefined) delete process.env.STOCK_TOKEN; else process.env.STOCK_TOKEN = prev;
    await rm(dir2, { recursive: true, force: true });
  }
});

test('云端部署：镜像配置里不能带本地数据，且必须要求口令', async () => {
  const dockerfile = await readFile(join(STOCK_DIR, 'Dockerfile'), 'utf8');
  const dockerignore = await readFile(join(STOCK_DIR, '.dockerignore'), 'utf8');
  const flyToml = await readFile(join(STOCK_DIR, 'fly.toml'), 'utf8');

  // 1) 数据目录必须是可配置的持久卷
  assert.match(dockerfile, /DATA_DIR=\/data/, 'Dockerfile 必须把 DATA_DIR 指到挂载卷');
  assert.match(flyToml, /destination = "\/data"/, 'fly.toml 必须把卷挂到 /data');
  assert.match(flyToml, /source = "stock_data"/);

  // 2) 绝不能把本地持仓/口令打进镜像
  for (const secret of ['state.json', '.auth.txt', 'state-snapshots/']) {
    assert.ok(dockerignore.includes(secret), `.dockerignore 必须排除 ${secret}`);
  }

  // 3) 云上是公网，口令不能写在明文配置里，要走 secrets
  assert.ok(!/^\s*STOCK_TOKEN\s*=/m.test(flyToml), 'fly.toml 里不能明文写 STOCK_TOKEN');
  assert.match(flyToml, /force_https = true/, '云端必须强制 HTTPS');

  // 4) 规格要克制，别开大机器白花钱
  assert.match(flyToml, /memory = "256mb"/, '这种应用 256MB 足够');
  assert.match(flyToml, /auto_start_machines = true/, '没人访问时应能自动停以省钱');
});

/* =========================== 6.5 云存储后端 =========================== */

/** 造一个假的 Upstash/Redis REST 端点：内存里存一个 key，可指定第几次调用开始失败 */
function makeFakeKv({ failFrom = Infinity, status = 500, body = '' } = {}) {
  const store = new Map();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init?.body });
    const n = calls.length;
    if (n >= failFrom) {
      return {
        ok: false,
        status,
        text: async () => body || `fake failure #${n}`,
      };
    }
    const u = new URL(url);
    // GET：/get/:key 或 body ["GET", key]
    let key = null;
    if (u.pathname.includes('/get/')) key = decodeURIComponent(u.pathname.split('/get/')[1]);
    if (!key && init?.body) {
      const parsed = JSON.parse(init.body);
      if (Array.isArray(parsed) && parsed[0] === 'GET') key = parsed[1];
    }
    if (key) {
      const value = store.has(key) ? store.get(key) : null;
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: value }) };
    }
    // SET：[ "SET", key, value ]
    const [, k, v] = JSON.parse(init.body);
    store.set(k, v);
    return { ok: true, status: 200, text: async () => JSON.stringify({ result: 'OK' }) };
  };
  return { fetchImpl, store, calls };
}

test('云存储后端：读写往返、key 正确、写入的是完整 JSON', async () => {
  const kv = makeFakeKv();
  const backend = createRestKvBackend({ url: 'https://fake.upstash.io', token: 't', key: 'stock:state', fetchImpl: kv.fetchImpl });
  assert.equal(backend.kind, 'kv');
  assert.equal(backend.describe(), 'kv:fake.upstash.io', '健康检查里只暴露主机名，不泄露 token');

  // 首次读取：没有数据 → null（不是抛错）
  assert.equal(await backend.readState(), null);

  const sample = normalizeState({ targets: { totalAmount: 1234, allocation: { VOO: 100 } } });
  await backend.writeState(sample);
  assert.ok(kv.store.has('stock:state'), '必须写到约定的 key');
  const roundTrip = JSON.parse(kv.store.get('stock:state'));
  assert.equal(roundTrip.targets.totalAmount, 1234);

  const back = await backend.readState();
  assert.equal(back.targets.totalAmount, 1234);
});

test('云存储后端：网络抖动会重试并最终成功', async () => {
  // 前两次失败、第三次恢复，验证重试真的生效（用一个干净的计数器，避免测试自身的 mock 干扰）
  let calls = 0;
  const backend = createRestKvBackend({
    url: 'https://fake.upstash.io',
    token: 't',
    retries: 2,
    fetchImpl: async (url, init) => {
      calls += 1;
      if (calls <= 2) return { ok: false, status: 500, text: async () => `boom#${calls}` };
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: 'OK' }) };
    },
  });
  await backend.writeState(normalizeState({ targets: { totalAmount: 5 } }));
  assert.equal(calls, 3, `应重试到第 3 次才成功，实际调用 ${calls} 次`);

  // 一直失败时，最终抛 StorageUnavailableError 并带上重试次数
  let alwaysFailCalls = 0;
  const dead = createRestKvBackend({
    url: 'https://fake.upstash.io', token: 't', retries: 2,
    fetchImpl: async () => { alwaysFailCalls += 1; return { ok: false, status: 500, text: async () => 'down' }; },
  });
  await assert.rejects(
    () => dead.readState(),
    (err) => err instanceof StorageUnavailableError && /已重试 2 次/.test(err.message),
  );
  assert.equal(alwaysFailCalls, 3, '重试次数 = 1 + retries');
});

test('云存储后端：鉴权失败不重试，且报错文案指向 token', async () => {
  const kv = makeFakeKv({ failFrom: 1, status: 401 });
  const backend = createRestKvBackend({ url: 'https://fake.upstash.io', token: 'wrong', fetchImpl: kv.fetchImpl });
  await assert.rejects(
    () => backend.readState(),
    (err) => err instanceof StorageUnavailableError && /鉴权失败/.test(err.message) && /KV_REST_TOKEN/.test(err.message),
  );
  assert.equal(kv.calls.length, 1, '401 不应该重试');

  const kv429 = makeFakeKv({ failFrom: 1, status: 429 });
  const backend429 = createRestKvBackend({ url: 'https://fake.upstash.io', token: 't', fetchImpl: kv429.fetchImpl });
  await assert.rejects(() => backend429.readState(), /额度/);
});

test('降级：云存储挂了就用本地副本且只读，写入返回 409 语义、绝不覆盖云端', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-degrade-'));
  const cachePath = join(dir, 'kv-cache.json');
  try {
    const kv = makeFakeKv();
    const primary = createRestKvBackend({ url: 'https://fake.upstash.io', token: 't', fetchImpl: kv.fetchImpl });
    const backend = createDegradedBackend({ primary, cachePath });

    // 第一次成功读到云端数据 → 顺手写本地缓存
    const seed = normalizeState({ targets: { totalAmount: 999 } });
    await primary.writeState(seed);
    assert.equal((await backend.readState()).targets.totalAmount, 999);
    assert.equal(backend.degraded, false);
    assert.ok(await readFile(cachePath, 'utf8'), '应写下了本地副本');

    // 现在让云端不可用
    const down = createDegradedBackend({
      primary: createRestKvBackend({ url: 'https://fake.upstash.io', token: 't', fetchImpl: async () => { throw new Error('network down'); } }),
      cachePath,
    });
    const cached = await down.readState();
    assert.equal(cached.targets.totalAmount, 999, '应回落到本地副本');
    assert.equal(down.degraded, true, '必须标记为降级');
    assert.match(down.reason || '', /network down/);

    // 关键：降级后写入必须被拒绝，不能把旧副本盖回云端
    await assert.rejects(
      () => down.writeState(normalizeState({ targets: { totalAmount: 1 } })),
      (err) => err instanceof StorageReadOnlyError,
    );

    // 云端恢复后应自动解除降级
    const recovered = createDegradedBackend({ primary, cachePath });
    await recovered.readState();
    assert.equal(recovered.degraded, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('降级：完全没有本地副本时如实抛 503 语义，而不是给一份空数据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-degrade2-'));
  try {
    const backend = createDegradedBackend({
      primary: createRestKvBackend({ url: 'https://fake.upstash.io', token: 't', fetchImpl: async () => { throw new Error('down'); } }),
      cachePath: join(dir, 'none.json'),
    });
    await assert.rejects(() => backend.readState(), (err) => err instanceof StorageUnavailableError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('文件后端与云后端满足同一套契约（可互换）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-contract-'));
  const kv = makeFakeKv();
  try {
    const backends = [
      ['file', createFileBackend(join(dir, 'state.json'))],
      ['kv', createRestKvBackend({ url: 'https://fake.upstash.io', token: 't', fetchImpl: kv.fetchImpl })],
    ];
    for (const [name, backend] of backends) {
      // 空 → null
      assert.equal(await backend.readState(), null, `${name}: 空存储应返回 null`);
      // 写入后可读回
      const s = normalizeState({ targets: { totalAmount: 777, allocation: { VOO: 100 } } });
      await backend.writeState(s);
      const back = await backend.readState();
      assert.equal(back.targets.totalAmount, 777, `${name}: 读写往返`);
      // 都支持 cleanup（文件后端清临时文件，云后端是空操作）
      await backend.cleanup();
      // 都提供脱敏描述
      assert.ok(typeof backend.describe() === 'string' && backend.describe().length > 0, `${name}: 要有 describe()`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('端到端（云存储）：无持久磁盘也能持久化，且健康检查如实报告后端', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-e2e-kv-'));
  const kv = makeFakeKv();
  const store = new StateStore(createRestKvBackend({
    url: 'https://fake.upstash.io', token: 't', key: 'stock:state', fetchImpl: kv.fetchImpl,
  }));
  const { server, port } = await startServer({
    port: 0, host: '127.0.0.1', store,
    authFile: join(dir, '.auth.txt'), authDisabled: true,
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, init) => {
    const res = await fetch(base + p, init);
    return { status: res.status, body: await res.json() };
  };
  try {
    const health = await call('/api/health');
    assert.equal(health.body.storage, 'kv', '健康检查必须报告用的是云存储');
    assert.equal(health.body.storageTarget, 'kv:fake.upstash.io');
    assert.equal(health.body.degraded, false);

    const pos = await call('/api/positions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions: { PDD: { shares: 40, avgCost: 95.5 } } }),
    });
    assert.equal(pos.status, 200);
    assert.equal(pos.body.holdings.lines.find((l) => l.symbol === 'PDD').shares, 40);
    // 数据必须真的进了云存储，而不是本地磁盘
    assert.match(kv.store.get('stock:state'), /"PDD"/);

    // 导出 → 改数据 → 导入 → 回到导出时
    const exported = await call('/api/export');
    assert.equal(exported.status, 200);
    assert.equal(exported.body.state.positions.PDD.shares, 40);
    await call('/api/positions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ positions: { PDD: { shares: 1, avgCost: 1 } } }),
    });
    const imported = await call('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exported.body.state),
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.positions.PDD.shares, 40, '导入后应等于导出时的快照');

    // 垃圾数据不能把持仓冲掉
    const bad = await call('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.equal(bad.status, 400);
    assert.equal((await call('/api/state')).body.positions.PDD.shares, 40, '非法导入不得改动数据');
  } finally {
    await new Promise((ok) => server.close(ok));
    await rm(dir, { recursive: true, force: true });
  }
});

test('端到端（云存储不可用）：健康检查标记降级，写入被拒（409）且数据未变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-e2e-down-'));
  const kv = makeFakeKv();
  const cacheDir = join(dir, 'cache');
  await (await import('node:fs/promises')).mkdir(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, 'kv-cache.json');

  const primary = createRestKvBackend({ url: 'https://fake.upstash.io', token: 't', fetchImpl: kv.fetchImpl });
  await primary.writeState(normalizeState({ targets: { totalAmount: 4321 }, positions: { VOO: { shares: 9, avgCost: 100 } } }));

  // 换成一个永远失败的 primary，但沿用刚才那份本地缓存
  const degradedBackend = createDegradedBackend({
    primary: createRestKvBackend({ url: 'https://fake.upstash.io', token: 't', fetchImpl: async () => { throw new Error('down'); } }),
    cachePath,
  });
  // 先正常读一次把缓存写下来
  const healthy = createDegradedBackend({ primary, cachePath });
  await healthy.readState();

  const store = new StateStore(degradedBackend);
  const { server, port } = await startServer({
    port: 0, host: '127.0.0.1', store,
    authFile: join(dir, '.auth.txt'), authDisabled: true,
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, init) => {
    const res = await fetch(base + p, init);
    return { status: res.status, body: await res.json() };
  };
  try {
    const health = await call('/api/health');
    assert.equal(health.body.degraded, true, '必须如实报告降级');
    assert.match(health.body.degradedReason || '', /down/);

    // 读：用本地副本，仍能看到数据
    const state = await call('/api/state');
    assert.equal(state.body.targets.totalAmount, 4321);

    // 写：必须被拒绝，且是 409（不是 500，更不是静默成功）
    const write = await call('/api/targets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalAmount: 1, allocation: { VOO: 100, 'BRK.B': 0, AAPL: 0, PDD: 0 } }),
    });
    assert.equal(write.status, 409, JSON.stringify(write.body));
    assert.equal(write.body.code, 'STORAGE_READ_ONLY');
    assert.match(write.body.error, /没有保存/);

    // 云端那份数据一个字节都没被改
    assert.equal((await primary.readState()).targets.totalAmount, 4321);
  } finally {
    await new Promise((ok) => server.close(ok));
    await rm(dir, { recursive: true, force: true });
  }
});

test('前端：存储状态胶囊不能被行情文本抹掉（回归：曾把胶囊放进被 textContent 覆盖的容器里）', async () => {
  const html = await readFile(join(STOCK_DIR, 'pub', 'index.html'), 'utf8');

  // 1) 胶囊必须是独立元素，不能是 #marketline 的子节点
  assert.ok(html.includes('id="storebadge"'), '必须有存储状态胶囊');
  const marketlineTag = html.match(/<div class="marketline">[\s\S]*?<\/div>/);
  assert.ok(marketlineTag, '必须能找到 marketline 容器');
  assert.match(marketlineTag[0], /<span id="marketline">[\s\S]*?<\/span><span class="badge hide" id="storebadge">/,
    'marketline 文本与胶囊必须是同级 span（否则 textContent 会把胶囊一起抹掉）');

  // 2) 更新行情时间只能改 #marketline 的 textContent，绝不能改父容器
  assert.match(html, /\$\('marketline'\)\.textContent =/, '应只更新 #marketline 自己的文本');
  assert.ok(!/\$\('marketline'\)\.innerHTML =/.test(html), '不允许用 innerHTML 覆盖行情行');

  // 3) 三种状态都要有对应文案
  for (const label of ['云同步', '本机文件', '云存储异常 · 只读']) {
    assert.ok(html.includes(label), `胶囊必须有「${label}」状态`);
  }

  // 4) 导出/导入入口齐全，且导入要走确认弹层（不能静默覆盖）
  for (const id of ['exportbtn', 'importbtn', 'importfile', 'toggleimport', 'importhelp']) {
    assert.ok(html.includes(`id="${id}"`), `缺少元素 ${id}`);
  }
  assert.match(html, /if \(S\.pendingImport\) \{/, '导入必须走独立确认分支');
  assert.match(html, /renderImportSheet/, '导入前要展示将被覆盖的内容摘要');
  assert.match(html, /URL\.createObjectURL/, '导出要能下载文件');
});

/* =========================== 7. 鉴权 =========================== */

test('鉴权：局域网来源要口令、Tailscale/本机免密', async () => {
  const { authorize, isTrustedSource, normalizeIp, loadToken } = await import('../lib/auth.mjs');
  assert.equal(isTrustedSource('127.0.0.1'), true);
  assert.equal(isTrustedSource('::ffff:127.0.0.1'), true);
  assert.equal(isTrustedSource('100.101.102.103'), true);
  assert.equal(isTrustedSource('100.63.0.1'), false, '100.63 不在 100.64/10 内');
  assert.equal(isTrustedSource('100.128.0.1'), false, '100.128 超出 100.64/10');
  assert.equal(isTrustedSource('fd7a:115c:a1e0::1'), true);
  assert.equal(isTrustedSource('192.168.2.50'), false);
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');

  const req = { headers: {} };
  assert.equal(authorize({ req, url: new URL('http://x/'), clientIp: '192.168.2.50', token: 'abc' }).ok, false);
  assert.equal(authorize({ req, url: new URL('http://x/?token=abc'), clientIp: '192.168.2.50', token: 'abc' }).ok, true);
  assert.equal(authorize({ req, url: new URL('http://x/?token=bad'), clientIp: '192.168.2.50', token: 'abc' }).ok, false);
  assert.equal(authorize({ req, url: new URL('http://x/'), clientIp: '100.80.1.2', token: 'abc' }).ok, true);
  assert.equal(authorize({ req, url: new URL('http://x/'), clientIp: '192.168.2.50', token: 'abc', disabled: true }).ok, true);

  const dir = await mkdtemp(join(tmpdir(), 'stock-auth-'));
  try {
    const t = await loadToken(join(dir, '.auth.txt'));
    assert.ok(t.length >= 10);
    assert.equal(await loadToken(join(dir, '.auth.txt')), t, '口令要持久化，重启不变');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('仓库里不该出现真实口令或隐藏数据文件', async () => {
  const gitignore = await readFile(join(STOCK_DIR, '.gitignore'), 'utf8');
  assert.match(gitignore, /state\.json/);
  assert.match(gitignore, /\.auth\.txt/);
});
