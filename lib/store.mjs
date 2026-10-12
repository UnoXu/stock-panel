/**
 * store.mjs — 持仓数据的读写
 *
 * 设计：把「存哪儿」和「怎么排队/怎么校验」分开。
 *
 *   StateStore        ← 对外接口不变：load / get / write / mutate / cleanup
 *      ├─ FileBackend          本机默认：原子写 state.json（原来的实现原样搬进来）
 *      ├─ RestKvBackend        云端：一个 HTTPS REST 调用存整个 JSON（免费键值存储）
 *      └─ DegradedBackend     云存储读不到时：只读本地副本，并禁止写入，避免覆盖丢数据
 *
 * 三个后端都实现同一个契约：
 *   readState(): Promise<object|null>   读不到返回 null（不是抛错）
 *   writeState(obj): Promise<void>      写失败抛 StorageUnavailableError
 *   describe(): string                  给健康检查用的脱敏描述
 */

import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_FEE_RATE, LOT_SIZE, MAX_FEE_RATE, SYMBOLS } from './quant.mjs';

/* ------------------------------- 错误类型 ------------------------------- */

/** 存储暂时不可用（网络、鉴权、额度）。server.mjs 会把它转成 HTTP 503。 */
export class StorageUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageUnavailableError';
    this.code = 'STORAGE_UNAVAILABLE';
    if (cause) this.cause = cause;
  }
}

/** 处于只读降级模式，不能写。server.mjs 会把它转成 HTTP 409。 */
export class StorageReadOnlyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageReadOnlyError';
    this.code = 'STORAGE_READ_ONLY';
  }
}

/* ------------------------------- 默认状态 ------------------------------- */

export const DEFAULT_STATE = {
  version: 1,
  updatedAt: null,
  rules: { lotSize: LOT_SIZE, feeRate: DEFAULT_FEE_RATE },
  targets: {
    totalAmount: 3000,
    // 四只标的的默认配比（合计 100）
    allocation: { VOO: 55, 'BRK.B': 25, AAPL: 12, PDD: 8 },
  },
  positions: Object.fromEntries(SYMBOLS.map((s) => [s, { shares: 0, avgCost: 0, baselinePrevClose: null }])),
  buys: [],
  baselineHistory: [],
};

/** 深度合并：让旧版本文件缺字段时也能平滑升级 */
export function normalizeState(raw) {
  const s = raw && typeof raw === 'object' ? structuredClone(raw) : {};
  const out = structuredClone(DEFAULT_STATE);
  out.version = Number(s.version) || DEFAULT_STATE.version;
  out.updatedAt = s.updatedAt || null;
  const feeRate = Number(s.rules?.feeRate);
  out.rules = {
    lotSize: LOT_SIZE,
    feeRate: Number.isFinite(feeRate) && feeRate >= 0 && feeRate <= MAX_FEE_RATE ? feeRate : DEFAULT_FEE_RATE,
  };
  out.targets = {
    totalAmount: Number.isFinite(Number(s.targets?.totalAmount)) ? Number(s.targets.totalAmount) : DEFAULT_STATE.targets.totalAmount,
    allocation: {},
  };
  for (const sym of SYMBOLS) {
    const v = Number(s.targets?.allocation?.[sym]);
    out.targets.allocation[sym] = Number.isFinite(v) && v >= 0 ? v : DEFAULT_STATE.targets.allocation[sym];
  }
  out.positions = {};
  for (const sym of SYMBOLS) {
    const p = s.positions?.[sym] || {};
    out.positions[sym] = {
      shares: Number(p.shares) || 0,
      avgCost: Number(p.avgCost) || 0,
      baselinePrevClose: Number.isFinite(Number(p.baselinePrevClose)) && Number(p.baselinePrevClose) > 0
        ? Number(p.baselinePrevClose)
        : null,
    };
  }
  out.buys = Array.isArray(s.buys) ? s.buys.slice(0, 500) : [];
  out.baselineHistory = Array.isArray(s.baselineHistory) ? s.baselineHistory.slice(0, 200) : [];
  return out;
}

/* ------------------------------- 文件后端 ------------------------------- */

/**
 * 本机默认后端：原子写 state.json。
 * 写必须串行（在 StateStore 里排队），并且每次写用唯一名字的临时文件——
 * 同名临时文件 + 并发写会出现「A 把 tmp 改名走了，B 再 rename 就 ENOENT」，
 * 导致请求 500、前端整块刷新失败。
 */
export function createFileBackend(filePath) {
  let tmpSeq = 0;
  return {
    kind: 'file',
    filePath,
    describe: () => `file:${filePath}`,
    async readState() {
      try {
        return JSON.parse(await readFile(filePath, 'utf8'));
      } catch (err) {
        if (err?.code === 'ENOENT') return null;          // 还没有状态文件
        if (err instanceof SyntaxError) {
          // 文件损坏：备份一份再重建，不要假装没事
          try { await rename(filePath, `${filePath}.corrupt-${Date.now()}`); } catch { /* ignore */ }
          console.warn(`[store] state.json 无法解析（${err.message}），已备份并重建初始状态`);
          return null;
        }
        throw new StorageUnavailableError(`读取本地数据失败：${err.message}`, err);
      }
    },
    async writeState(nextState) {
      await mkdir(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.${++tmpSeq}.tmp`;
      try {
        await writeFile(tmp, `${JSON.stringify(nextState, null, 2)}\n`, 'utf8');
        await rename(tmp, filePath);
      } catch (err) {
        try { await unlink(tmp); } catch { /* 尽力清理 */ }
        throw new StorageUnavailableError(`写入本地数据失败：${err.message}`, err);
      }
    },
    async cleanup() {
      const dir = dirname(filePath);
      const base = filePath.slice(dir.length + 1);
      try {
        for (const name of await readdir(dir)) {
          if (name.startsWith(`${base}.`) && name.endsWith('.tmp')) {
            try { await unlink(join(dir, name)); } catch { /* 忽略 */ }
          }
        }
      } catch { /* 目录不存在就算了 */ }
    },
  };
}

/* ------------------------------- 云存储后端 ------------------------------- */

/** 脱敏：只留主机名，不要把 token 或完整 URL 暴露到健康检查里 */
function safeHost(url) {
  try { return new URL(url).host; } catch { return 'invalid-url'; }
}

/**
 * 云存储后端：兼容 Upstash Redis REST 与 Vercel KV（同一套协议）。
 *
 *   POST {url}                      body: [["SET", key, json]]
 *   POST {url}/get/{encodedKey}     或   body: [["GET", key]]
 *   POST {url}/set/{encodedKey}     或   body: [["SET", key, json]]
 *
 * 返回形如 { "result": "..." } 或 { "result": null } / { "error": "..." }。
 */
export function createRestKvBackend({ url, token, key = 'stock:state', retries = 2, fetchImpl } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const base = String(url || '').replace(/\/+$/, '');
  const target = safeHost(base);
  if (!base || !token) throw new Error('createRestKvBackend 需要 url 与 token');

  const post = async (path, body, label) => {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * 3 ** (attempt - 1)));
      try {
        const res = await doFetch(`${base}${path}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        if (!res.ok) {
          // 401/403 是鉴权问题，429 是额度/限流——都不要再重试，直接把原因带出去
          if (res.status === 401 || res.status === 403) {
            throw new StorageUnavailableError(`云存储鉴权失败（HTTP ${res.status}），请检查 KV_REST_TOKEN 是否正确`);
          }
          if (res.status === 429) {
            throw new StorageUnavailableError('云存储返回 429（额度用尽或被限流），请检查免费额度');
          }
          throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
        }
        const parsed = JSON.parse(text);
        if (parsed && parsed.error) throw new Error(String(parsed.error));
        return parsed?.result ?? null;
      } catch (err) {
        if (err instanceof StorageUnavailableError) throw err;   // 鉴权/额度问题不重试
        lastErr = err;
      }
    }
    throw new StorageUnavailableError(`云存储${label}失败（已重试 ${retries} 次）：${lastErr?.message || '未知错误'}`, lastErr);
  };

  return {
    kind: 'kv',
    describe: () => `kv:${target}`,
    async readState() {
      const raw = await post(`/get/${encodeURIComponent(key)}`, ['GET', key], '读取');
      if (raw == null || raw === '') return null;               // 还没写过
      if (typeof raw === 'object') return raw;                  // 少数实现会直接给对象
      try {
        return JSON.parse(String(raw));
      } catch (err) {
        throw new StorageUnavailableError(`云存储里的数据不是合法 JSON：${err.message}`, err);
      }
    },
    async writeState(nextState) {
      await post(`/set/${encodeURIComponent(key)}`, ['SET', key, JSON.stringify(nextState)], '写入');
    },
    async cleanup() { /* 云端没有临时文件要清 */ },
  };
}

/* --------------------------- 只读降级包装后端 --------------------------- */

/**
 * 云存储读不到时用它兜底：
 *   - 读：优先云存储；失败则读本地缓存副本（上次成功的数据），进入只读模式
 *   - 写：只读模式下直接拒绝，绝不把本地旧数据盖回云端
 * 每次成功读到云端数据，都会顺手写一份本地缓存，供下次降级时使用。
 */
export function createDegradedBackend({ primary, cachePath, onDegrade } = {}) {
  let degraded = false;
  let reason = null;

  const readCache = async () => {
    if (!cachePath) return null;
    try { return JSON.parse(await readFile(cachePath, 'utf8')); } catch { return null; }
  };
  const writeCache = async (obj) => {
    if (!cachePath) return;
    try {
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(obj), 'utf8');
    } catch { /* 缓存写不上不影响主流程 */ }
  };

  return {
    kind: primary.kind,
    describe: () => primary.describe(),
    get degraded() { return degraded; },
    get reason() { return reason; },
    async readState() {
      try {
        const obj = await primary.readState();
        degraded = false;
        reason = null;
        if (obj) await writeCache(obj);
        return obj;
      } catch (err) {
        const cached = await readCache();
        if (!cached) throw err;                                  // 没有本地副本就没得救，交给上层报 503
        degraded = true;
        reason = err?.message || '云存储不可用';
        onDegrade?.(reason);
        console.warn(`[store] 云存储不可用，改用本地副本（只读）：${reason}`);
        return cached;
      }
    },
    async writeState(nextState) {
      if (degraded) {
        throw new StorageReadOnlyError('云存储当前不可用，为避免覆盖，本次改动没有保存');
      }
      await primary.writeState(nextState);
      await writeCache(nextState);
    },
    async cleanup() { await primary.cleanup?.(); },
  };
}

/* ------------------------------- StateStore ------------------------------- */

/**
 * 对外的存储门面。方法签名与行为保持向后兼容：
 * load / get / write / mutate / cleanup，以及 statePathIn()。
 */
export class StateStore {
  /**
   * @param {string|object} target state.json 的绝对路径（兼容旧用法），或一个后端对象
   */
  constructor(target) {
    if (typeof target === 'string') {
      this.backend = createFileBackend(target);
      this.filePath = target;
    } else {
      this.backend = target;
      this.filePath = target?.filePath || null;
    }
    /** @type {Promise<any>} 串行队列：所有读-改-写与直接写都排在同一条队上 */
    this.queue = Promise.resolve();
    this.cache = null;
  }

  /** 当前后端（供健康检查读取 kind / degraded 状态） */
  get storageInfo() {
    const b = this.backend;
    return {
      kind: b.kind || 'unknown',
      target: b.describe?.() || 'unknown',
      degraded: Boolean(b.degraded),
      reason: b.reason || null,
    };
  }

  async load() {
    if (this.cache) return this.cache;
    const raw = await this.backend.readState();
    if (raw) {
      this.cache = normalizeState(raw);
      return this.cache;
    }
    // 首次运行：初始化一份默认状态并落盘；落盘失败不致命（只读介质/云存储异常时仍能用）
    this.cache = structuredClone(DEFAULT_STATE);
    try {
      await this.write(this.cache);
    } catch (err) {
      console.warn(`[store] 初始化写入失败（继续用内存里的默认状态）：${err.message}`);
    }
    return this.cache;
  }

  /** 只读快照（返回副本，避免调用方意外改到缓存） */
  async get() {
    return structuredClone(await this.load());
  }

  /** 所有写都排队，且单次失败不会打断整条队列 */
  write(nextState) {
    return this.#enqueue(async () => {
      const normalized = normalizeState(nextState);
      await this.backend.writeState(normalized);
      this.cache = normalized;
      return structuredClone(normalized);
    });
  }

  /**
   * 串行的读-改-写。mutator 收到当前状态的副本，返回新状态。
   * @param {(current: any) => any | Promise<any>} mutator
   */
  mutate(mutator) {
    return this.#enqueue(async () => {
      const current = await this.load();
      const next = await mutator(structuredClone(current));
      if (!next) return structuredClone(current);
      const normalized = normalizeState(next);
      await this.backend.writeState(normalized);
      this.cache = normalized;
      return structuredClone(normalized);
    });
  }

  /** 把任务排到队尾 */
  #enqueue(task) {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  /** 清理可能残留的临时文件（启动时调用一次；只有文件后端有） */
  async cleanup() {
    await this.backend.cleanup?.();
  }
}

export const statePathIn = (dir) => join(dir, 'state.json');
