/**
 * quotes.mjs — 实时行情抓取与解析
 *
 * 主源：腾讯 qt.gtimg.cn（GBK 编码，`~` 分隔的定长字段）
 * 备源：新浪 hq.sinajs.cn（需 Referer；注意 BRK.B 在该源上恒为空，只作单只回落）
 *
 * 对外只暴露两件事：
 *   getQuotes(symbols) -> { symbol: quote|null }
 *   SYMBOLS / SYMBOL_META
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

/** 本应用跟踪的标的（顺序即页面顺序） */
export const SYMBOLS = ['VOO', 'BRK.B', 'AAPL', 'PDD'];

export const SYMBOL_META = {
  VOO: { name: 'Vanguard 标普500 ETF', tencent: 'usVOO', sina: 'gb_voo' },
  'BRK.B': { name: '伯克希尔 B 股', tencent: 'usBRK.B', sina: 'gb_brk.b' },
  AAPL: { name: '苹果', tencent: 'usAAPL', sina: 'gb_aapl' },
  PDD: { name: '拼多多', tencent: 'usPDD', sina: 'gb_pdd' },
};

const CACHE_TTL_MS = 10_000;
const FETCH_TIMEOUT_MS = 9_000;

/** @type {{ at: number, data: Record<string, any>|null }|null} */
let upstreamCache = null;
/** 最后一次成功拿到的行情，用于上游失败时兜底显示（绝不假装价格是 0） */
const lastGood = new Map();

/* ------------------------------- 工具 ------------------------------- */

const num = (v) => {
  const n = Number.parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) ? n : null;
};

/** 把 "2026/10/12 09:31:00" 或 "2026-10-12 16:00:01" 解析成墙钟 parts */
function parseQuoteTime(s) {
  const m = String(s ?? '').match(/(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return {
    year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
    hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6]),
    text: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`,
    date: `${m[1]}-${m[2]}-${m[3]}`,
  };
}

/** 该墙钟时刻在 America/New_York 的 epoch 毫秒（自动处理夏令时） */
function etEpochMs(parts) {
  if (!parts) return null;
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  for (const offsetMin of [0, -60, 60, -120, 120, -30, 30]) {
    const cand = guess + offsetMin * 60_000;
    const p = Object.fromEntries(fmt.formatToParts(new Date(cand)).map((x) => [x.type, x.value]));
    if (
      Number(p.year) === parts.year && Number(p.month) === parts.month && Number(p.day) === parts.day &&
      Number(p.hour) % 24 === parts.hour && Number(p.minute) === parts.minute && Number(p.second) === parts.second
    ) {
      return cand;
    }
  }
  return guess;
}

/** 当前的美东日期与分钟数 */
function etNow() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: (Number(p.hour) % 24) * 60 + Number(p.minute),
    weekday: p.weekday,
  };
}

/** 由行情时间判断市场状态（不查节假日日历：休市日行情日期会早于今天，自然归入 closed） */
export function marketStateOf(quoteTime) {
  const q = parseQuoteTime(quoteTime);
  const now = etNow();
  if (!q) return { state: 'unknown', label: '时间未知' };
  if (q.date !== now.date) {
    return { state: 'closed', label: `休市 / 最近收盘 ${q.date}` };
  }
  const o = q.hour * 60 + q.minute;
  const open = 9 * 60 + 30, close = 16 * 60;
  if (o >= open && o < close) return { state: 'open', label: '交易中' };
  if (o >= 4 * 60 && o < open) return { state: 'pre', label: '盘前' };
  if (o >= close && o < 20 * 60) return { state: 'after', label: '盘后' };
  return { state: 'closed', label: '已收盘' };
}

async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...extraHeaders },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf;
}

const decodeGbk = (buf) => new TextDecoder('gbk').decode(buf);

/* ------------------------------- 主源：腾讯 ------------------------------- */

export function parseTencent(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).replace(/^v_/, '').trim();
    const meta = Object.values(SYMBOL_META).find((m) => m.tencent.toLowerCase() === key.toLowerCase());
    const symbol = meta ? Object.keys(SYMBOL_META).find((s) => SYMBOL_META[s] === meta) : key;
    const body = line.slice(eq + 1);
    const q1 = body.indexOf('"'), q2 = body.lastIndexOf('"');
    if (q1 < 0 || q2 <= q1) continue;
    const f = body.slice(q1 + 1, q2).split('~');
    const price = num(f[3]);
    if (!price) continue;
    const prevClose = num(f[4]);
    const change = num(f[31]);
    const changePct = num(f[32]);
    out[symbol] = {
      symbol,
      name: (f[1] || SYMBOL_META[symbol]?.name || symbol).trim(),
      price,
      prevClose,
      open: num(f[5]),
      high: num(f[33]),
      low: num(f[34]),
      currency: (f[35] || 'USD').trim(),
      volume: num(f[6]),
      change: change ?? (prevClose != null ? Number((price - prevClose).toFixed(4)) : null),
      changePct: changePct ?? (prevClose ? Number((((price - prevClose) / prevClose) * 100).toFixed(4)) : null),
      quoteTime: (f[30] || '').trim() || null,
      source: 'tencent',
    };
  }
  return out;
}

/* ------------------------------- 备源：新浪 ------------------------------- */

export function parseSina(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).replace(/^var\s+hq_str_/, '').trim();
    const meta = Object.values(SYMBOL_META).find((m) => m.sina.toLowerCase() === key.toLowerCase());
    if (!meta) continue;
    const symbol = Object.keys(SYMBOL_META).find((s) => SYMBOL_META[s] === meta);
    const body = line.slice(eq + 1);
    const q1 = body.indexOf('"'), q2 = body.lastIndexOf('"');
    if (q1 < 0 || q2 <= q1) continue;
    const f = body.slice(q1 + 1, q2).split(',');
    const price = num(f[1]);
    if (!price) continue; // BRK.B 在新浪为空字符串 -> 直接跳过
    const prevClose = num(f[26]);
    const change = prevClose != null ? Number((price - prevClose).toFixed(4)) : null;
    out[symbol] = {
      symbol,
      name: (f[0] || SYMBOL_META[symbol]?.name || symbol).trim(),
      price,
      prevClose,
      open: num(f[5]),
      high: num(f[6]),
      low: num(f[7]),
      currency: 'USD',
      volume: num(f[10]),
      change,
      changePct: prevClose ? Number((((price - prevClose) / prevClose) * 100).toFixed(4)) : null,
      quoteTime: (f[3] || '').trim() || null,
      source: 'sina',
    };
  }
  return out;
}

/* ------------------------------- 对外接口 ------------------------------- */

/** 直接抓一次上游（不走缓存），腾讯为主、新浪补缺 */
async function fetchFresh(symbols) {
  const result = {};
  let tencentErr = null;

  try {
    const url = `https://qt.gtimg.cn/q=${symbols.map((s) => SYMBOL_META[s]?.tencent || s).join(',')}`;
    const parsed = parseTencent(decodeGbk(await fetchText(url)));
    for (const s of symbols) if (parsed[s]) result[s] = parsed[s];
  } catch (err) {
    tencentErr = err;
  }

  const missing = symbols.filter((s) => !result[s]);
  if (missing.length) {
    try {
      const url = `https://hq.sinajs.cn/list=${missing.map((s) => SYMBOL_META[s]?.sina || s).join(',')}`;
      const parsed = parseSina(decodeGbk(await fetchText(url, { Referer: 'https://finance.sina.com.cn/' })));
      for (const s of missing) if (parsed[s]) result[s] = parsed[s];
    } catch {
      /* 备源失败就用 lastGood 兜底 */
    }
  }

  if (!Object.keys(result).length) {
    throw tencentErr || new Error('所有行情源都无法返回数据');
  }
  return result;
}

/**
 * 取行情。任何一只拿不到就返回 null（配合 lastGood 标记 stale），
 * 绝不把缺失价格当作 0。
 */
export async function getQuotes(symbols = SYMBOLS, { force = false } = {}) {
  const now = Date.now();
  if (!force && upstreamCache && now - upstreamCache.at < CACHE_TTL_MS) {
    return hydrate(symbols, upstreamCache.data);
  }
  let fresh;
  try {
    fresh = await fetchFresh(symbols);
    for (const [s, q] of Object.entries(fresh)) lastGood.set(s, { ...q, cachedAt: now });
    upstreamCache = { at: now, data: fresh };
  } catch (err) {
    fresh = null;
    if (!upstreamCache) upstreamCache = { at: now, data: {} };
    upstreamCache.at = now;
  }
  const data = fresh || upstreamCache.data || {};
  const out = hydrate(symbols, data);
  for (const s of symbols) {
    if (!out[s] && lastGood.has(s)) {
      out[s] = { ...lastGood.get(s), stale: true, staleReason: '上游行情暂时不可用，显示上次成功价格' };
    }
  }
  return out;
}

function hydrate(symbols, data) {
  const out = {};
  for (const s of symbols) {
    const q = data[s];
    if (!q) { out[s] = null; continue; }
    const ms = etEpochMs(parseQuoteTime(q.quoteTime));
    const ageMin = ms == null ? null : Math.round((Date.now() - ms) / 60_000);
    const ms2 = marketStateOf(q.quoteTime);
    out[s] = {
      ...q,
      quoteEpochMs: ms,
      ageMinutes: ageMin,
      marketState: ms2.state,
      marketStateLabel: ms2.label,
    };
  }
  return out;
}

/** 汇总一组报价的整体状态，供 /api/quotes 使用 */
export function summarize(quotes) {
  const list = Object.values(quotes).filter(Boolean);
  const asOf = list.map((q) => q.quoteTime).filter(Boolean).sort().at(-1) || null;
  const states = new Set(list.map((q) => q.marketState));
  const state = states.size === 1 ? [...states][0] : 'mixed';
  const label = list.length === 1 ? list[0].marketStateLabel : (state === 'mixed' ? '状态不一致' : list[0]?.marketStateLabel || '未知');
  return {
    asOf,
    marketState: state,
    marketStateLabel: label,
    stale: list.some((q) => q.stale) || list.length === 0,
    anyMissing: Object.values(quotes).some((q) => !q),
    sources: [...new Set(list.map((q) => q.source))],
  };
}
