'use strict';
const os = require('os');
const express = require('express');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3002);
const HOST = os.hostname();
const PRODUCT_URL = process.env.PRODUCT_URL;
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || '';

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, svc: 'order-service', msg, ...extra }));

const pool = new Pool({
  host: process.env.DB_HOST, database: process.env.DB_NAME,
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5000,
});
pool.on('error', (e) => log('error', 'pg pool error', { err: e.message }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function init() {
  for (let i = 1; i <= 40; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS orders(
          id SERIAL PRIMARY KEY,
          user_id INT NOT NULL,
          user_email TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          total NUMERIC(12,2) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS order_items(
          id SERIAL PRIMARY KEY,
          order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
          product_id TEXT NOT NULL,
          name TEXT NOT NULL,
          emoji TEXT NOT NULL DEFAULT '',
          price NUMERIC(12,2) NOT NULL,
          quantity INT NOT NULL)`);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id)');
      log('info', 'database ready');
      return;
    } catch (e) {
      log('warn', 'waiting for database', { attempt: i, err: e.message });
      await sleep(2000);
    }
  }
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Served-By', HOST);
  const t0 = Date.now();
  res.on('finish', () => {
    if (req.path === '/health' || req.path === '/ready') return;
    log('info', 'req', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - t0, user: req.user?.id, id: req.headers['x-request-id'] });
  });
  next();
});

const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get('/health', (q, r) => r.json({ status: 'ok' }));
app.get('/ready', async (q, r) => {
  try { await pool.query('SELECT 1'); r.json({ status: 'ok', host: HOST, deps: { postgres: 'up' } }); }
  catch { r.status(503).json({ status: 'down', host: HOST, deps: { postgres: 'down' } }); }
});

function identity(req, res, next) {
  const id = parseInt(req.headers['x-user-id'], 10);
  if (!id) return res.status(401).json({ error: 'authentication required' });
  req.user = { id, role: req.headers['x-user-role'] || 'user', email: req.headers['x-user-email'] || '' };
  next();
}

/* ---- product-service calls (internal, token protected) ---- */
async function productCall(path, items) {
  const r = await fetch(PRODUCT_URL + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
    body: JSON.stringify({ items }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

const ORDER_SELECT = `
  SELECT o.id, o.user_id, o.user_email, o.status, o.total, o.created_at, o.updated_at,
         COALESCE(json_agg(json_build_object('product_id', i.product_id, 'name', i.name, 'emoji', i.emoji,
                  'price', i.price, 'quantity', i.quantity) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
  FROM orders o LEFT JOIN order_items i ON i.order_id = o.id`;
const shape = (r) => ({ id: r.id, userId: r.user_id, userEmail: r.user_email, status: r.status, total: Number(r.total), createdAt: r.created_at, updatedAt: r.updated_at, items: r.items });

async function loadOrder(id) {
  const { rows } = await pool.query(`${ORDER_SELECT} WHERE o.id = $1 GROUP BY o.id`, [id]);
  return rows[0] ? shape(rows[0]) : null;
}

/* ---- create order (reserve stock -> persist -> compensate on failure) ---- */
app.post('/orders', identity, ah(async (req, res) => {
  const raw = Array.isArray(req.body?.items) ? req.body.items : [];
  if (raw.length < 1 || raw.length > 20) return res.status(400).json({ error: 'order must contain 1-20 items' });
  const merged = new Map();
  for (const it of raw) {
    const pid = String(it?.product_id || '');
    const q = Number(it?.quantity);
    if (!/^[a-f0-9]{24}$/i.test(pid) || !Number.isInteger(q) || q < 1 || q > 99) {
      return res.status(400).json({ error: 'invalid item in order' });
    }
    merged.set(pid, (merged.get(pid) || 0) + q);
  }
  const items = [...merged].map(([product_id, quantity]) => ({ product_id, quantity }));
  if (items.some((i) => i.quantity > 99)) return res.status(400).json({ error: 'max quantity per product is 99' });

  let reserved;
  try {
    const r = await productCall('/internal/reserve', items);
    if (!r.ok) {
      const code = [404, 409, 400].includes(r.status) ? r.status : 502;
      return res.status(code).json({ error: r.data.error || 'could not reserve stock' });
    }
    reserved = r.data.items;
  } catch (e) {
    log('error', 'product service unreachable', { err: e.message });
    return res.status(503).json({ error: 'product service unavailable, please retry' });
  }

  const total = Math.round(reserved.reduce((s, i) => s + i.price * i.quantity, 0) * 100) / 100;
  const client = await pool.connect();
  let orderId;
  try {
    await client.query('BEGIN');
    const o = await client.query('INSERT INTO orders(user_id, user_email, total) VALUES($1,$2,$3) RETURNING id', [req.user.id, req.user.email, total]);
    orderId = o.rows[0].id;
    for (const i of reserved) {
      await client.query('INSERT INTO order_items(order_id, product_id, name, emoji, price, quantity) VALUES($1,$2,$3,$4,$5,$6)',
        [orderId, i.product_id, i.name, i.emoji || '', i.price, i.quantity]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    productCall('/internal/release', items).catch((err) => log('error', 'release failed', { err: err.message }));
    throw e;
  } finally {
    client.release();
  }
  log('info', 'order created', { orderId, total, user: req.user.id });
  res.status(201).json(await loadOrder(orderId));
}));

/* ---- stats (declared before /orders/:id) ---- */
app.get('/orders/stats', identity, ah(async (req, res) => {
  const all = req.user.role === 'admin';
  const summary = await pool.query(
    `SELECT count(*)::int AS count,
            COALESCE(SUM(total) FILTER (WHERE status <> 'cancelled'), 0) AS revenue,
            status, count(*)::int AS n
     FROM orders WHERE ($1::boolean OR user_id = $2) GROUP BY status`, [all, req.user.id]);
  const byStatus = {}; let count = 0; let revenue = 0;
  for (const r of summary.rows) { byStatus[r.status] = r.n; count += r.n; revenue += Number(r.revenue); }
  const days = await pool.query(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(o.total), 0) AS revenue, COUNT(o.id)::int AS orders
     FROM generate_series(current_date - 6, current_date, interval '1 day') d
     LEFT JOIN orders o ON o.created_at::date = d::date AND o.status <> 'cancelled' AND ($1::boolean OR o.user_id = $2)
     GROUP BY d ORDER BY d`, [all, req.user.id]);
  res.json({ count, revenue, byStatus, byDay: days.rows.map((r) => ({ day: r.day, revenue: Number(r.revenue), orders: r.orders })) });
}));

app.get('/orders', identity, ah(async (req, res) => {
  const all = req.user.role === 'admin' && req.query.all === '1';
  const { rows } = await pool.query(
    `${ORDER_SELECT} WHERE ($1::boolean OR o.user_id = $2) GROUP BY o.id ORDER BY o.id DESC LIMIT 100`, [all, req.user.id]);
  res.json(rows.map(shape));
}));

app.get('/orders/:id', identity, ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid order id' });
  const o = await loadOrder(id);
  if (!o || (req.user.role !== 'admin' && o.userId !== req.user.id)) return res.status(404).json({ error: 'order not found' });
  res.json(o);
}));

/* ---- status transitions ---- */
const NEXT = { pending: ['paid', 'cancelled'], paid: ['shipped', 'cancelled'], shipped: ['delivered'], delivered: [], cancelled: [] };
const USER_ALLOWED = new Set(['pending>paid', 'pending>cancelled']);

app.patch('/orders/:id/status', identity, ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const next = String(req.body?.status || '');
  if (!id) return res.status(400).json({ error: 'invalid order id' });
  if (!(next in NEXT)) return res.status(400).json({ error: 'invalid status' });
  const isAdmin = req.user.role === 'admin';
  const client = await pool.connect();
  let release = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [id]);
    const o = rows[0];
    if (!o || (!isAdmin && o.user_id !== req.user.id)) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'order not found' }); }
    if (!NEXT[o.status].includes(next)) { await client.query('ROLLBACK'); return res.status(409).json({ error: `cannot move order from ${o.status} to ${next}` }); }
    if (!isAdmin && !USER_ALLOWED.has(`${o.status}>${next}`)) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'not allowed' }); }
    await client.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [next, id]);
    if (next === 'cancelled') {
      const it = await client.query('SELECT product_id, quantity FROM order_items WHERE order_id = $1', [id]);
      release = it.rows;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (release) productCall('/internal/release', release).catch((e) => log('error', 'stock release failed', { orderId: id, err: e.message }));
  log('info', 'order status changed', { orderId: id, status: next, by: req.user.id });
  res.json(await loadOrder(id));
}));

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  log('error', 'unhandled', { err: err.message, path: req.path });
  res.status(500).json({ error: 'internal error' });
});

let server;
init().then(() => { server = app.listen(PORT, () => log('info', `order-service listening on ${PORT}`)); });
const stop = () => { log('info', 'shutting down'); (server ? new Promise((r) => server.close(r)) : Promise.resolve()).then(() => pool.end()).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 8000).unref(); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
