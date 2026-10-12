/**
 * auth.mjs — 轻量访问控制
 *
 * 免密来源：
 *   - 本机回环（含 `tailscale serve` 反代，它从 127.0.0.1 连过来；该路径本身已被 Tailscale 加密+鉴权）
 *   - Tailscale 网段 100.64.0.0/10 与 fd7a:115c:a1e0::/48（直连 100.x 时）
 * 其他来源（典型就是同一 WiFi 下的明文 HTTP）需要口令。
 * 这样即使同网段被人蹭到，也不会泄露持仓数据。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';

export const COOKIE_NAME = 'dsh_stock_auth';

export function normalizeIp(ip) {
  if (!ip) return '';
  let v = String(ip).trim();
  if (v.startsWith('::ffff:')) v = v.slice(7);
  if (v === '::1') return '127.0.0.1';
  const pct = v.indexOf('%');           // IPv6 的 scope id，如 fe80::1%eth0
  if (pct >= 0) v = v.slice(0, pct);
  return v;
}

export function isLoopback(ip) {
  const v = normalizeIp(ip);
  return v === '127.0.0.1' || v.startsWith('127.') || v === '::1';
}

/** 100.64.0.0/10 */
export function isTailscaleV4(ip) {
  const v = normalizeIp(ip);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) return false;
  const [a, b] = v.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

/** fd7a:115c:a1e0::/48 */
export function isTailscaleV6(ip) {
  const v = normalizeIp(ip).toLowerCase();
  return v.startsWith('fd7a:115c:a1e0:');
}

export const isTrustedSource = (ip) => isLoopback(ip) || isTailscaleV4(ip) || isTailscaleV6(ip);

export function describeSource(ip) {
  if (isLoopback(ip)) return '本机/隧道';
  if (isTailscaleV4(ip) || isTailscaleV6(ip)) return 'Tailscale';
  return '局域网';
}

/** 令牌比较用固定长度安全比较，避免时序侧信道（本地工具，聊胜于无） */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 从 ?token= / Authorization / Cookie 里取口令 */
export function extractToken(req, url) {
  const q = url?.searchParams?.get('token');
  if (q) return q;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const x = req.headers['x-stock-token'];
  if (x) return String(x);
  const cookies = parseCookies(req.headers.cookie);
  return cookies[COOKIE_NAME] || null;
}

export async function loadToken(filePath) {
  // 云端：优先用环境变量给的口令（容器文件系统可能是临时的，不能依赖生成的文件）
  const fromEnv = String(process.env.STOCK_TOKEN || '').trim();
  if (fromEnv) return fromEnv;

  try {
    const t = (await readFile(filePath, 'utf8')).trim();
    if (t) return t;
  } catch { /* 首次运行 */ }
  const token = randomBytes(9).toString('base64url');
  await writeFile(filePath, `${token}\n`, 'utf8');
  try { await chmod(filePath, 0o600); } catch { /* Windows 上基本无效，忽略 */ }
  return token;
}

/**
 * @returns {{ok:true, mode:'trusted'|'token'|'disabled', source:string}
 *          |{ok:false, source:string}}
 */
export function authorize({ req, url, clientIp, token, disabled }) {
  const source = describeSource(clientIp);
  if (disabled) return { ok: true, mode: 'disabled', source };
  if (isTrustedSource(clientIp)) return { ok: true, mode: 'trusted', source };
  const supplied = extractToken(req, url);
  if (supplied && safeEqual(supplied, token)) return { ok: true, mode: 'token', source };
  return { ok: false, source };
}

/** 口令页：一个极简表单，浏览器会把 token 提交到 ?token= */
export function loginPage({ source, wrong }) {
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>持仓助手 · 需要口令</title>
<style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  background:#0f1216;color:#e8eaed;padding:24px}
.card{width:100%;max-width:360px;background:#171b21;border:1px solid #262c35;border-radius:16px;padding:24px}
h1{font-size:18px;margin:0 0 6px}
p{color:#9aa4b2;font-size:13px;margin:0 0 16px}
input{width:100%;box-sizing:border-box;font-size:17px;padding:12px;border-radius:10px;
  border:1px solid #333b46;background:#0f1216;color:#e8eaed;margin-bottom:12px}
button{width:100%;font-size:17px;padding:12px;border-radius:10px;border:0;background:#3b82f6;color:#fff;font-weight:600}
.err{color:#f87171;font-size:13px;margin:0 0 12px}
.hint{color:#6b7280;font-size:12px;margin-top:14px}
</style></head>
<body><form class="card" method="get" action="/">
  <h1>持仓助手</h1>
  <p>来自「${source}」的访问需要口令。口令在电脑上运行服务的那个窗口里，也会写进 stock/.auth.txt。</p>
  ${wrong ? '<p class="err">口令不对，再试一次。</p>' : ''}
  <input name="token" type="password" inputmode="text" placeholder="访问口令" autocomplete="current-password" autofocus>
  <button type="submit">进入</button>
  <p class="hint">提示：在 Tailscale 下打开（https://&lt;机器名&gt;.&lt;tailnet&gt;.ts.net）不需要口令。</p>
</form></body></html>`;
}
