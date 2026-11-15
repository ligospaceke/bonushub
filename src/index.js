import { createRouter } from './router.js';
import { ApiError, errorResponse, forbidden, SECURITY_HEADERS } from './lib/http.js';
import { loadUser } from './lib/session.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes, sellerProductRoutes } from './routes/catalog.js';
import { buyerRoutes } from './routes/buyer.js';
import { quoteRoutes } from './routes/quotes.js';
import { sellerRoutes } from './routes/seller.js';
import { adminRoutes } from './routes/admin.js';
import { runJobs } from './services/jobs.js';

const router = createRouter();
authRoutes(router); catalogRoutes(router); sellerProductRoutes(router); buyerRoutes(router); quoteRoutes(router); sellerRoutes(router); adminRoutes(router);

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Browser-origin check for cookie-authenticated writes. Webhooks are authenticated by signature instead. */
function sameOrigin(request, url) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser clients (tests, curl, provider callbacks)
  try { return new URL(origin).host === url.host; } catch { return false; }
}

export async function handleApi(request, env) {
  const url = new URL(request.url);
  try {
    const m = router.match(request.method, url.pathname);
    if (!m) throw new ApiError(404, 'not_found', 'Not found.');
    if (m.methodNotAllowed) throw new ApiError(405, 'method_not_allowed', 'Method not allowed.');
    const { route, params } = m;
    if (MUTATING.has(request.method) && !route.path.startsWith('/api/payments/webhook/') && !sameOrigin(request, url)) throw forbidden('Cross-site request blocked.');
    const user = await loadUser(env, request);
    if (!route.opts.public && !user) throw new ApiError(401, 'unauthenticated', 'Please sign in.');
    return await route.handler({ env, request, url, params, user });
  } catch (e) {
    return errorResponse(e);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, env);
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (k !== 'Cache-Control') h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(runJobs(env)); },
};
