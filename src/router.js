export function createRouter() {
  const routes = [];
  const add = (method, path, opts, handler) => {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const re = new RegExp('^' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, path, re, keys, opts, handler });
  };
  return {
    get: (p, o, h) => add('GET', p, o, h),
    post: (p, o, h) => add('POST', p, o, h),
    put: (p, o, h) => add('PUT', p, o, h),
    patch: (p, o, h) => add('PATCH', p, o, h),
    delete: (p, o, h) => add('DELETE', p, o, h),
    match(method, pathname) {
      let pathExists = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathExists = true;
        if (r.method === method) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      }
      return pathExists ? { methodNotAllowed: true } : null;
    },
  };
}
