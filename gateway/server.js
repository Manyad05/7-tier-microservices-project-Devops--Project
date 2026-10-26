'use strict';
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
const USER_URL = process.env.USER_URL;
const PRODUCT_URL = process.env.PRODUCT_URL;
const ORDER_URL = process.env.ORDER_URL;
const HOST = os.hostname();

if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error('JWT_SECRET is missing or too short (min 16 chars)');
  process.exit(1);
}

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, svc: 'gateway', msg, ...extra }));

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());

/* ---- request id, host header, access log ---- */
app.use((req, res, next) => {
  const id = req.headers['x-request-id'] || crypto.randomUUID();
  req.id = id;
  req.headers['x-request-id'] = id;
  res.setHeader('X-Request-Id', id);
  res.setHeader('X-Served-By', HOST);
  const t0 = Date.now();
  res.on('finish', () => {
    if (req.path === '/health' || req.path === '/ready') return;
    log('info', 'req', { method: req.method, path: req.originalUrl.split('?')[0], status: res.statusCode, ms: Date.now() - t0, user: req.user?.id, id });
  });
  next();
});

/* ---- identity: clients can never spoof internal identity headers ---- */
const IDENTITY_HEADERS = ['x-user-id', 'x-user-role', 'x-user-email', 'x-internal-token'];
app.use((req, res, next) => {
  for (const h of IDENTITY_HEADERS) delete req.headers[h];
  const auth = req.headers.authorization;
  if (!auth) return next();
  const m = /^Bearer (.+)$/i.exec(auth);
  if (!m) return res.status(401).json({ error: 'invalid authorization header' });
  try {
    const p = jwt.verify(m[1], JWT_SECRET, { algorithms: ['HS256'] });
    req.user = { id: String(p.sub), role: p.role || 'user', email: p.email || '' };
    req.headers['x-user-id'] = req.user.id;
    req.headers['x-user-role'] = req.user.role;
    req.headers['x-user-email'] = req.user.email;
    next();
  } catch (e) {
    res.status(401).json({ error: e.name === 'TokenExpiredError' ? 'session expired' : 'invalid token' });
  }
});

const requireAuth = (req, res, next) =>
  req.user ? next() : res.status(401).json({ error: 'authentication required' });

/* ---- rate limiting ---- */
const json429 = (msg) => ({ error: msg });
const limiter = rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false, message: json429('too many requests') });
const authLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: json429('too many attempts, please wait a minute') });
app.use('/api', limiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

/* ---- probes ---- */
app.get('/health', (q, r) => r.json({ status: 'ok' }));
app.get('/ready', (q, r) => r.json({ status: 'ok', host: HOST, deps: {} }));

/* ---- helpers for aggregation endpoints ---- */
const fwd = (req) => ({
  'x-user-id': req.user.id, 'x-user-role': req.user.role, 'x-user-email': req.user.email, 'x-request-id': req.id,
});
async function getJSON(url, headers = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
async function ping(name, lang, base) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + '/ready', { signal: AbortSignal.timeout(2500) });
    const body = await r.json().catch(() => ({}));
    return { name, lang, status: r.ok ? 'up' : 'degraded', latencyMs: Date.now() - t0, host: body.host || r.headers.get('x-served-by') || '', deps: body.deps || {} };
  } catch (e) {
    return { name, lang, status: 'down', latencyMs: Date.now() - t0, host: '', deps: {}, error: e.message };
  }
}

app.get('/api/health/services', requireAuth, async (req, res) => {
  const services = await Promise.all([
    ping('user-service', 'Python', USER_URL),
    ping('product-service', 'Go', PRODUCT_URL),
    ping('order-service', 'Node.js', ORDER_URL),
  ]);
  res.json({ services: [{ name: 'api-gateway', lang: 'Node.js', status: 'up', latencyMs: 0, host: HOST, deps: {} }, ...services] });
});

app.get('/api/stats', requireAuth, async (req, res) => {
  const h = fwd(req);
  const admin = req.user.role === 'admin';
  const [p, o, u] = await Promise.allSettled([
    admin ? getJSON(`${PRODUCT_URL}/products/stats`, h) : getJSON(`${PRODUCT_URL}/products?limit=1`, h).then((d) => ({ total: d.total })),
    getJSON(`${ORDER_URL}/orders/stats`, h),
    admin ? getJSON(`${USER_URL}/users/stats`, h) : Promise.resolve(null),
  ]);
  const val = (x) => (x.status === 'fulfilled' ? x.value : null);
  res.json({ products: val(p), orders: val(o), users: val(u) });
});

/* ---- reverse proxy to services ---- */
const proxy = (prefix, target, rewriteTo) =>
  createProxyMiddleware(prefix, {
    target,
    changeOrigin: true,
    proxyTimeout: 10_000,
    timeout: 12_000,
    pathRewrite: { [`^${prefix}`]: rewriteTo },
    onError: (err, req, res) => {
      log('error', 'proxy error', { target, err: err.message, id: req.id });
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream service unavailable' }));
    },
  });

app.use('/api/auth/me', requireAuth);
app.use('/api/users', requireAuth);
app.use('/api/orders', requireAuth);
app.use('/api/products', (req, res, next) => (['GET', 'HEAD'].includes(req.method) ? next() : requireAuth(req, res, next)));

app.use(proxy('/api/auth', USER_URL, '/auth'));
app.use(proxy('/api/users', USER_URL, '/users'));
app.use(proxy('/api/products', PRODUCT_URL, '/products'));
app.use(proxy('/api/orders', ORDER_URL, '/orders'));

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  log('error', 'unhandled', { err: err.message, id: req.id });
  res.status(500).json({ error: 'internal error' });
});

const server = app.listen(PORT, () => log('info', `gateway listening on ${PORT}`));
const stop = () => { log('info', 'shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('unhandledRejection', (e) => log('error', 'unhandledRejection', { err: String(e) }));
