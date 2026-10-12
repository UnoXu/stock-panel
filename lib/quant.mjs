/**
 * quant.mjs — 全部业务计算（纯函数，无 IO，方便单测）
 *
 * 交易规则（已与用户确认）：
 *   - 最小交易单位 0.01 股，且【向下取整】（不向上取，避免超出给定金额）
 *   - 买入金额 = 用户输入的金额；手续费 = 金额 × 费率，【另计】
 *     总扣款 = 股票占用 + 手续费
 *   - 手续费率默认 0.1%，可在界面上改
 *   - 手续费【计入成本】（avgCost 含费），这样累计盈亏是含费的真实盈亏
 */

export const SYMBOLS = ['VOO', 'BRK.B', 'AAPL', 'PDD'];
export const LOT_SIZE = 0.01;
export const DEFAULT_FEE_RATE = 0.001;
export const MAX_FEE_RATE = 0.05;

export class QuantError extends Error {
  constructor(message, code = 'QUANT_ERROR') {
    super(message);
    this.name = 'QuantError';
    this.code = code;
  }
}

/* ------------------------------- 数值工具 ------------------------------- */

/** 金额一律四舍五入到分，避免浮点误差（0.1+0.2 类问题） */
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** 向下取整到 0.01 股 */
export const roundLot = (shares) => {
  const n = Number(shares);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n * 100 + 1e-9) / 100;
};

/** 份额显示：去掉无意义的尾随零 */
export const fmtShares = (shares) => {
  const n = Number(shares) || 0;
  return n.toFixed(2).replace(/\.?0+$/, '') || '0';
};

const requirePositive = (n, label) => {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) throw new QuantError(`${label}必须是大于 0 的数字`, 'INVALID_INPUT');
  return v;
};

export function validateFeeRate(rate) {
  const v = Number(rate);
  if (!Number.isFinite(v) || v < 0) throw new QuantError('手续费率不能为负数', 'INVALID_FEE');
  if (v > MAX_FEE_RATE) throw new QuantError(`手续费率看起来不对（${(v * 100).toFixed(2)}%），上限 ${MAX_FEE_RATE * 100}%`, 'INVALID_FEE');
  return v;
}

/** 按 0.01 股下限反推该只标的最小可买金额 */
export function minAmountFor(price, feeRate) {
  const p = requirePositive(price, '价格');
  return round2(LOT_SIZE * p + LOT_SIZE * p * (Number(feeRate) || 0));
}

/** 让一组整数百分比（按所占权重）加起来正好 100，解决「均分」时的四舍五入误差 */
export function evenAllocation(symbols = SYMBOLS) {
  const n = symbols.length || 1;
  const base = Math.floor((100 / n) * 100) / 100;
  const out = {};
  for (const s of symbols) out[s] = base;
  out[symbols[symbols.length - 1]] = Number((100 - base * (n - 1)).toFixed(2));
  return out;
}

/* ------------------------------- 1. 配比计算 ------------------------------- */

/**
 * 计算各标的该买多少。
 * @param {number} total 总金额（= 买入金额合计，手续费另计）
 * @param {Record<string, number>} allocation 百分比，如 { VOO: 60, 'BRK.B': 30, AAPL: 10 }
 * @param {Record<string, {price:number}|null>} quotes 行情（只需 price）
 * @param {{feeRate?: number, tolerance?: number, symbols?: string[]}} [opts]
 */
export function allocate(total, allocation, quotes, opts = {}) {
  const symbols = opts.symbols || SYMBOLS;
  const feeRate = validateFeeRate(opts.feeRate ?? DEFAULT_FEE_RATE);
  const tolerance = opts.tolerance ?? 0.01;
  const amountTotal = requirePositive(total, '总金额');

  const pct = {};
  let sum = 0;
  for (const s of symbols) {
    const v = Number(allocation?.[s] ?? 0);
    if (!Number.isFinite(v) || v < 0) throw new QuantError(`${s} 的百分比必须是不小于 0 的数字`, 'INVALID_PCT');
    pct[s] = v;
    sum += v;
  }
  if (Math.abs(sum - 100) > tolerance) {
    throw new QuantError(`${symbols.length} 个百分比之和是 ${Number(sum.toFixed(4))}%，必须等于 100%`, 'PCT_SUM');
  }

  const lines = [];
  const errors = [];
  let actualTotalCharge = 0;
  let stockTotal = 0;
  let feeTotal = 0;
  let residualTotal = 0;

  for (const s of symbols) {
    const price = Number(quotes?.[s]?.price);
    const amount = round2((amountTotal * pct[s]) / 100);
    const line = {
      symbol: s,
      pct: pct[s],
      amount,
      price: Number.isFinite(price) && price > 0 ? price : null,
      shares: 0,
      stockCost: 0,
      fee: 0,
      totalCharge: 0,
      residual: amount,
      minAmount: null,
      ok: false,
      error: null,
    };

    if (pct[s] === 0) {
      line.ok = true;
      line.error = null;
      lines.push(line);
      continue;
    }
    if (line.price == null) {
      line.error = '拿不到实时价格，暂时无法计算';
      errors.push(`${s}: ${line.error}`);
      lines.push(line);
      continue;
    }

    const fee = round2(amount * feeRate);
    const shares = roundLot(amount / line.price);
    line.minAmount = minAmountFor(line.price, feeRate);

    if (shares <= 0) {
      line.error = `金额不足最小交易单位 0.01 股（现价 $${line.price}，该只最少需要 $${line.minAmount}）`;
      errors.push(`${s}: ${line.error}`);
      lines.push(line);
      continue;
    }

    line.shares = shares;
    line.stockCost = round2(shares * line.price);
    line.fee = fee;
    line.totalCharge = round2(line.stockCost + fee);
    line.residual = round2(amount - line.stockCost);
    line.ok = true;

    actualTotalCharge = round2(actualTotalCharge + line.totalCharge);
    stockTotal = round2(stockTotal + line.stockCost);
    feeTotal = round2(feeTotal + fee);
    residualTotal = round2(residualTotal + line.residual);
    lines.push(line);
  }

  return {
    total: amountTotal,
    feeRate,
    lotSize: LOT_SIZE,
    lines,
    errors,
    ok: errors.length === 0,
    summary: {
      amountTotal,
      stockTotal,
      feeTotal,
      actualTotalCharge,
      residualTotal,
      extraVsTotal: round2(actualTotalCharge - amountTotal),
      /** 一句话说明「实际扣款」与「总金额」的关系，避免口径被误读 */
      chargeNote: (() => {
        const diff = round2(actualTotalCharge - amountTotal);
        if (diff > 0.004) return `实际扣款比总金额多 $${diff.toFixed(2)}（手续费）`;
        if (diff < -0.004) return `实际扣款 $${actualTotalCharge.toFixed(2)}，其中 $${Math.abs(diff).toFixed(2)} 因 0.01 股取整未花出，手续费 $${feeTotal.toFixed(2)} 已含在内`;
        return `实际扣款 $${actualTotalCharge.toFixed(2)}，与总金额一致（手续费 $${feeTotal.toFixed(2)} 已含在内）`;
      })(),
      pctSum: Number(sum.toFixed(4)),
    },
  };
}

/* ------------------------------- 2. 买入入账 ------------------------------- */

/**
 * 把一笔买入并入持仓（返回新对象，不改传入的 state）。
 * 成本口径：新成本 = (原份额×原含费成本 + 本次股票占用 + 本次手续费) / (原份额 + 新份额)
 */
export function applyBuy(state, symbol, amount, price, opts = {}) {
  if (!SYMBOLS.includes(symbol)) throw new QuantError(`不支持的标的：${symbol}`, 'UNKNOWN_SYMBOL');
  const feeRate = validateFeeRate(opts.feeRate ?? state?.rules?.feeRate ?? DEFAULT_FEE_RATE);
  const amountIn = requirePositive(amount, '买入金额');
  const px = requirePositive(price, '买入价格');
  const at = opts.at || new Date().toISOString();

  const prev = state.positions?.[symbol] || { shares: 0, avgCost: 0 };
  const prevShares = Number(prev.shares) || 0;
  const prevAvgCost = Number(prev.avgCost) || 0;

  const shares = roundLot(amountIn / px);
  const fee = round2(amountIn * feeRate);
  const minAmount = minAmountFor(px, feeRate);
  if (shares <= 0) {
    throw new QuantError(
      `买入金额不足最小交易单位 0.01 股：现价 $${px}，该只最少需要 $${minAmount}`,
      'BELOW_MIN_LOT',
    );
  }

  const stockCost = round2(shares * px);
  const totalCharge = round2(stockCost + fee);
  const residual = round2(amountIn - stockCost);
  const newShares = Number((prevShares + shares).toFixed(2));
  const newAvgCost = Number(((prevShares * prevAvgCost + stockCost + fee) / newShares).toFixed(6));

  const buy = {
    id: `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    at,
    symbol,
    amount: round2(amountIn),
    price: px,
    shares,
    stockCost,
    fee,
    totalCharge,
    residual,
    feeRate,
    prevShares,
    prevAvgCost,
    newShares,
    newAvgCost,
    note: opts.note || '配比买入',
  };

  const next = structuredClone(state);
  next.positions = next.positions || {};
  next.positions[symbol] = { ...(next.positions[symbol] || {}), shares: newShares, avgCost: newAvgCost };
  next.buys = [buy, ...(next.buys || [])].slice(0, 500);
  next.updatedAt = at;
  return { state: next, buy };
}

/** 撤销最近一条买入（回滚份额与成本） */
export function undoLastBuy(state) {
  const [last, ...rest] = state.buys || [];
  if (!last) throw new QuantError('没有可撤销的买入记录', 'NOTHING_TO_UNDO');
  const next = structuredClone(state);
  const pos = next.positions?.[last.symbol] || { shares: 0, avgCost: 0 };
  next.positions[last.symbol] = {
    ...pos,
    shares: Number((Number(pos.shares || 0) - last.shares).toFixed(2)),
    avgCost: Number(last.prevAvgCost || 0),
  };
  next.buys = rest;
  next.updatedAt = new Date().toISOString();
  return { state: next, undone: last };
}

/* ------------------------------- 3. 持仓视图 ------------------------------- */

/**
 * 持仓与收益视图。
 * 当日盈亏 = (现价 − 昨收基准) × 份额
 * 累计浮动盈亏 = 市值 − 含费成本（份额 × 含费成本价）
 */
export function holdingsView(state, quotes, opts = {}) {
  const positions = state?.positions || {};
  const lines = SYMBOLS.map((s) => {
    const pos = positions[s] || {};
    const shares = Number(pos.shares) || 0;
    const avgCost = Number(pos.avgCost) || 0;
    const q = quotes?.[s] || null;
    const price = q && Number.isFinite(q.price) ? q.price : null;
    const base = Number(pos.baselinePrevClose) || (q?.prevClose ?? null);

    const marketValue = price != null ? round2(shares * price) : null;
    const costValue = round2(shares * avgCost);
    const dayPnl = price != null && base != null ? round2((price - base) * shares) : null;
    const dayPnlPct = price != null && base ? Number((((price - base) / base) * 100).toFixed(4)) : null;
    const totalPnl = marketValue != null ? round2(marketValue - costValue) : null;
    const totalPnlPct = marketValue != null && costValue > 0
      ? Number(((totalPnl / costValue) * 100).toFixed(4))
      : null;

    return {
      symbol: s,
      name: q?.name || s,
      price,
      prevClose: q?.prevClose ?? null,
      baselinePrevClose: base,
      shares,
      avgCost,
      marketValue,
      costValue,
      dayPnl,
      dayPnlPct,
      totalPnl,
      totalPnlPct,
      quoteTime: q?.quoteTime || null,
      source: q?.source || null,
      stale: Boolean(q?.stale),
      marketState: q?.marketState || null,
      marketStateLabel: q?.marketStateLabel || null,
      hasPosition: shares > 0,
    };
  });

  const marketTotal = round2(lines.reduce((a, l) => a + (l.marketValue || 0), 0));
  const costTotal = round2(lines.reduce((a, l) => a + l.costValue, 0));
  const dayTotal = round2(lines.reduce((a, l) => a + (l.dayPnl || 0), 0));
  const totalPnl = round2(marketTotal - costTotal);
  const invested = round2((state?.buys || []).reduce((a, b) => a + (Number(b.totalCharge) || 0), 0));
  const feesPaid = round2((state?.buys || []).reduce((a, b) => a + (Number(b.fee) || 0), 0));

  for (const l of lines) {
    l.weightPct = marketTotal > 0 && l.marketValue != null
      ? Number(((l.marketValue / marketTotal) * 100).toFixed(4))
      : 0;
  }

  return {
    lines,
    summary: {
      marketTotal,
      costTotal,
      dayPnl: dayTotal,
      dayPnlPct: costTotal > 0 && dayTotal != null ? Number(((dayTotal / costTotal) * 100).toFixed(4)) : null,
      totalPnl,
      totalPnlPct: costTotal > 0 ? Number(((totalPnl / costTotal) * 100).toFixed(4)) : null,
      weightSum: Number(lines.reduce((a, l) => a + l.weightPct, 0).toFixed(2)),
      investedTotalCharge: invested,
      feesPaid,
    },
    rule: { lotSize: LOT_SIZE, feeRate: validateFeeRate(opts.feeRate ?? state?.rules?.feeRate ?? DEFAULT_FEE_RATE) },
  };
}

/* ------------------------------- 4. 基线滚动 ------------------------------- */

/**
 * 跨交易日时把「当日盈亏」基准滚到最新昨收，避免把上一交易日的盈亏重复算进今天。
 * 只在行情确实带了新的昨收、且与当前基准不同时才动，返回 {state, rolled}.
 */
export function rolloverBaseline(state, quotes, opts = {}) {
  const at = opts.at || new Date().toISOString();
  const next = structuredClone(state);
  next.positions = next.positions || {};
  const rolled = [];
  const history = (next.baselineHistory ||= []);

  for (const s of SYMBOLS) {
    const q = quotes?.[s];
    const pos = next.positions[s] || (next.positions[s] = { shares: 0, avgCost: 0 });
    const prevClose = q?.prevClose;
    if (!Number.isFinite(prevClose) || prevClose <= 0) continue;
    const current = Number(pos.baselinePrevClose);
    if (current === prevClose) continue;
    if (!Number.isFinite(current) || current <= 0) {
      pos.baselinePrevClose = prevClose;
      continue; // 首次记录基准，不算「滚动」
    }
    // 只有当基准已经落后于新的昨收时才滚（换手/数据修正导致的轻微抖动也一并覆盖）
    history.unshift({
      at, symbol: s, from: current, to: prevClose,
      quoteTime: q?.quoteTime || null, note: '跨交易日自动滚动当日基准',
    });
    pos.baselinePrevClose = prevClose;
    rolled.push({ symbol: s, from: current, to: prevClose });
  }
  if (history.length > 200) next.baselineHistory = history.slice(0, 200);
  if (rolled.length) next.updatedAt = at;
  return { state: next, rolled };
}

/** 手动把某只（或全部）的当日基准设为当前昨收 */
export function resetBaseline(state, quotes, symbols = SYMBOLS, opts = {}) {
  const at = opts.at || new Date().toISOString();
  const next = structuredClone(state);
  const changed = [];
  for (const s of symbols) {
    const q = quotes?.[s];
    const prevClose = q?.prevClose;
    if (!Number.isFinite(prevClose) || prevClose <= 0) continue;
    next.positions[s] = { ...(next.positions[s] || { shares: 0, avgCost: 0 }), baselinePrevClose: prevClose };
    changed.push({ symbol: s, to: prevClose });
  }
  next.updatedAt = at;
  return { state: next, changed };
}
