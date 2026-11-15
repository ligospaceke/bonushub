export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message || code);
    this.status = status; this.code = code; this.fields = fields;
  }
}
export const bad = (message, fields) => new ApiError(422, 'validation_failed', message || 'Please check the highlighted fields.', fields);
export const notFound = (what = 'Resource') => new ApiError(404, 'not_found', `${what} not found.`);
export const forbidden = (msg = 'You do not have access to this.') => new ApiError(403, 'forbidden', msg);
export const conflict = (code, msg) => new ApiError(409, code, msg);

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers },
  });
}

export function errorResponse(e) {
  if (e instanceof ApiError) {
    return new Response(JSON.stringify({ ok: false, error: { code: e.code, message: e.message, fields: e.fields } }), {
      status: e.status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS },
    });
  }
  console.error('Unhandled error', e);
  return new Response(JSON.stringify({ ok: false, error: { code: 'server_error', message: 'Something went wrong. Please try again.' } }), {
    status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS },
  });
}

export async function readJson(request, limit = 256 * 1024) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new ApiError(415, 'unsupported_media_type', 'Send JSON.');
  const text = await request.text();
  if (text.length > limit) throw new ApiError(413, 'too_large', 'Request too large.');
  try { return text ? JSON.parse(text) : {}; } catch { throw bad('Invalid JSON.'); }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token, { secure, maxAgeSeconds }) {
  return `bh_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}
export const clearCookie = (secure) => `bh_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
