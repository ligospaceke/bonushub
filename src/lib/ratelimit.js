import { ApiError } from './http.js';
import { nowDate } from './db.js';

/** Fixed-window rate limit stored in D1. Throws 429 when the limit is exceeded. */
export async function rateLimit(env, key, limit, windowSeconds) {
  const nowSec = Math.floor(nowDate(env).getTime() / 1000);
  const win = Math.floor(nowSec / windowSeconds) * windowSeconds;
  await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
       window_start = excluded.window_start`
  ).bind(key, win).run();
  const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key).first();
  if (row.count > limit) throw new ApiError(429, 'rate_limited', 'Too many attempts. Please wait a few minutes and try again.');
}

export const clientIp = (request) => request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
