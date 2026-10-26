(() => {
'use strict';

/* =============================== utilities =============================== */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => { const v = Number(n) || 0; return (Number.isInteger(v) ? nf0 : nf2).format(v); };
const fmtDate = (d) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const store = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage disabled */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const svg = (p) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  home: svg('<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>'),
  shop: svg('<path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 01-8 0"/>'),
  cart: svg('<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 002 1.6h9.7a2 2 0 002-1.6L23 6H6"/>'),
  orders: svg('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8"/>'),
  box: svg('<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>'),
  users: svg('<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>'),
  search: svg('<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  trash: svg('<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>'),
  menu: svg('<path d="M3 6h18M3 12h18M3 18h18"/>'),
  refresh: svg('<path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0114.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0020.5 15"/>'),
};

/* =============================== state =============================== */
const S = {
  token: store.get('token', null),
  user: store.get('user', null),
  cart: {},
  byId: {},
  served: null,
  shop: { search: '', category: 'all', sort: 'newest', page: 1, pages: 1, total: 0, items: [], cats: [], req: 0 },
  orders: [],
  ordersFilter: 'all',
  adminPage: 1,
};
let routeToken = 0;

function applyTheme(t) { document.documentElement.dataset.theme = t; store.set('theme', t); }
applyTheme(store.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));

/* =============================== api =============================== */
async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  const t0 = performance.now();
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new Error('Cannot reach the server. Is the gateway running?');
  }
  S.served = { host: res.headers.get('X-Served-By') || '—', cache: res.headers.get('X-Cache') || '—', ms: Math.round(performance.now() - t0), path };
  renderServed();
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
  if (res.status === 401 && S.token) { logout(true); throw new Error('Your session expired. Please sign in again.'); }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

/* =============================== ui helpers =============================== */
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, 3800);
}
function openDialog(html, onMount) {
  const d = $('#dlg');
  d.innerHTML = html;
  d.returnValue = '';
  if (!d.open) d.showModal();
  onMount?.(d);
  return d;
}
function confirmBox(title, text, okLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const d = openDialog(`<form method="dialog" class="dlg-body"><h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>
      <div class="dlg-actions"><button class="btn ghost" value="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" value="yes">${esc(okLabel)}</button></div></form>`);
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true });
  });
}
const empty = (emoji, title, text, action = '') => `<div class="card empty"><div class="big">${emoji}</div><h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>${action}</div>`;
const skeleton = (n = 3) => `<div class="grid">${Array.from({ length: n }, () => '<div class="skeleton"></div>').join('')}</div>`;
const errorState = (msg, retry = false) => empty('⚠️', 'Something went wrong', msg, retry ? '<button class="btn primary" data-action="reload">Try again</button>' : '');
const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

/* =============================== cart =============================== */
const cartKey = () => `cart:${S.user?.id}`;
const loadCart = () => { S.cart = store.get(cartKey(), {}); };
const cartCount = () => Object.values(S.cart).reduce((n, i) => n + i.qty, 0);
const cartTotal = () => Object.values(S.cart).reduce((n, i) => n + i.qty * i.price, 0);
function saveCart() {
  store.set(cartKey(), S.cart);
  const n = cartCount();
  const a = $('#navCart'), b = $('#topCart');
  if (a) a.textContent = n || '';
  if (b) b.textContent = n || '';
}
function changeCart(p, delta) {
  const qty = (S.cart[p.id]?.qty || 0) + delta;
  if (qty <= 0) delete S.cart[p.id];
  else {
    if (qty > p.stock) { toast(`Only ${p.stock} in stock`, 'warn'); return false; }
    if (qty > 99) return false;
    S.cart[p.id] = { id: p.id, name: p.name, price: p.price, emoji: p.emoji, stock: p.stock, qty };
  }
  saveCart();
  return true;
}

/* =============================== shell =============================== */
function renderServed() {
  const el = $('#servedBy');
  if (!el || !S.served) return;
  el.innerHTML = `<b>Last request</b><br>pod <code>${esc(S.served.host)}</code><br>cache <code>${esc(S.served.cache)}</code> · ${S.served.ms} ms`;
}

function renderShell() {
  const admin = S.user.role === 'admin';
  $('#app').innerHTML = `
  <div class="shell" id="shell">
    <div class="scrim" data-action="close-nav"></div>
    <aside class="sidebar">
      <div class="brand">🛍️ <span>Nimbus</span></div>
      <nav>
        <a href="#/dashboard" data-route="dashboard">${I.home}<span>Dashboard</span></a>
        <a href="#/shop" data-route="shop">${I.shop}<span>Shop</span></a>
        <a href="#/cart" data-route="cart">${I.cart}<span>Cart</span><b class="pill" id="navCart"></b></a>
        <a href="#/orders" data-route="orders">${I.orders}<span>${admin ? 'All orders' : 'My orders'}</span></a>
        ${admin ? `<div class="nav-label">Admin</div>
        <a href="#/admin/products" data-route="admin/products">${I.box}<span>Products</span></a>
        <a href="#/admin/users" data-route="admin/users">${I.users}<span>Users</span></a>` : ''}
      </nav>
      <div class="side-foot" id="servedBy">Waiting for first request…</div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="icon-btn menu-btn" data-action="open-nav" aria-label="Open menu">${I.menu}</button>
        <h2 id="pageTitle"></h2>
        <div class="spacer"></div>
        <button class="icon-btn" data-action="theme" aria-label="Toggle theme" title="Toggle theme">${document.documentElement.dataset.theme === 'dark' ? I.sun : I.moon}</button>
        <a class="icon-btn" href="#/cart" aria-label="Cart">${I.cart}<b class="badge-dot" id="topCart"></b></a>
        <div class="user-chip"><span class="avatar">${esc(S.user.name.trim()[0]?.toUpperCase() || '?')}</span><div><strong>${esc(S.user.name)}</strong><small>${esc(S.user.role)}</small></div></div>
        <button class="icon-btn" data-action="logout" aria-label="Sign out" title="Sign out">${I.logout}</button>
      </header>
      <main id="view" class="view"></main>
    </div>
  </div>`;
  saveCart();
  renderServed();
}

/* =============================== auth =============================== */
function renderAuth(mode = 'login') {
  $('#app').innerHTML = `
  <div class="auth">
    <aside class="auth-brand">
      <div class="logo">🛍️ Nimbus</div>
      <h1>Shop on a real microservices stack.</h1>
      <p>A demo storefront backed by Python, Go and Node.js services with PostgreSQL, MongoDB and Redis — running on Docker and Kubernetes.</p>
      <ul class="brand-points">
        <li>JWT authentication with roles</li>
        <li>Atomic stock reservation across services</li>
        <li>Redis caching, health probes, autoscaling</li>
      </ul>
    </aside>
    <main class="auth-panel">
      <div class="auth-card">
        <div class="tabs" role="tablist">
          <button data-action="auth-tab" data-mode="login" class="${mode === 'login' ? 'active' : ''}">Sign in</button>
          <button data-action="auth-tab" data-mode="register" class="${mode === 'register' ? 'active' : ''}">Create account</button>
        </div>
        <form id="authForm" novalidate>
          ${mode === 'register' ? '<div class="field"><label for="a-name">Full name</label><input class="input" id="a-name" autocomplete="name" required></div>' : ''}
          <div class="field"><label for="a-email">Email</label><input class="input" id="a-email" type="email" autocomplete="email" required></div>
          <div class="field"><label for="a-pass">Password</label><input class="input" id="a-pass" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" ${mode === 'register' ? 'minlength="8"' : ''} required></div>
          <div class="form-error" id="authErr" role="alert"></div>
          <button class="btn primary block" type="submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        ${mode === 'login' ? '<div class="demo-note">Trying it out? <a href="#" data-action="demo">Use the demo admin account</a></div>' : '<div class="demo-note">Password must be at least 8 characters.</div>'}
      </div>
    </main>
  </div>`;
  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', e.target);
    const err = $('#authErr');
    err.textContent = '';
    const body = { email: $('#a-email').value.trim(), password: $('#a-pass').value };
    if (mode === 'register') body.name = $('#a-name').value.trim();
    btn.disabled = true; const label = btn.textContent; btn.textContent = 'Please wait…';
    try {
      const r = await api(mode === 'login' ? '/auth/login' : '/auth/register', { method: 'POST', body });
      S.token = r.token; S.user = r.user;
      store.set('token', r.token); store.set('user', r.user);
      location.hash = '#/dashboard';
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false; btn.textContent = label;
    }
  });
  $('#a-email')?.focus();
}

function logout(expired = false) {
  S.token = null; S.user = null; S.cart = {};
  store.del('token'); store.del('user');
  location.hash = '';
  renderAuth();
  if (expired) toast('Your session expired. Please sign in again.', 'warn');
}

/* =============================== router =============================== */
const routes = {
  'dashboard': { title: 'Dashboard', view: viewDashboard },
  'shop': { title: 'Shop', view: viewShop },
  'cart': { title: 'Your cart', view: viewCart },
  'orders': { title: 'Orders', view: viewOrders },
  'admin/products': { title: 'Manage products', view: viewAdminProducts, admin: true },
  'admin/users': { title: 'Manage users', view: viewAdminUsers, admin: true },
};

async function route() {
  if (!S.token || !S.user) return;
  if (!$('#view')) renderShell();
  const key = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  const r = routes[key] || routes.dashboard;
  if (r.admin && S.user.role !== 'admin') { location.hash = '#/dashboard'; return; }
  $$('.sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (routes[key] ? key : 'dashboard')));
  $('#pageTitle').textContent = r.title;
  $('#shell').classList.remove('nav-open');
  const view = $('#view');
  view.innerHTML = skeleton();
  const my = ++routeToken;
  const live = () => my === routeToken;
  try { await r.view(view, live); } catch (e) { if (live()) view.innerHTML = errorState(e.message); }
}

/* =============================== views: dashboard =============================== */
const LANG = { Python: 'py', Go: 'go', 'Node.js': 'js', Nginx: 'ng' };

function healthTile(s) {
  const deps = Object.entries(s.deps || {}).map(([k, v]) => `<span class="chip-s ${/^up/.test(v) ? 'ok' : 'bad'}">${esc(k)}</span>`).join('');
  return `<div class="tile"><div class="t-head"><span class="dot ${esc(s.status)}"></span><strong>${esc(s.name)}</strong><span class="tag ${LANG[s.lang] || ''}">${esc(s.lang)}</span></div>
    <div class="t-meta">${s.status === 'down' ? 'unreachable' : `${s.latencyMs} ms${s.host ? ' · ' + esc(s.host) : ''}`}</div><div class="t-deps">${deps}</div></div>`;
}

async function viewDashboard(view, live) {
  const admin = S.user.role === 'admin';
  const [stats, health, orders] = await Promise.all([
    api('/stats').catch(() => null),
    api('/health/services').catch(() => null),
    api('/orders' + (admin ? '?all=1' : '')).catch(() => []),
  ]);
  if (!live()) return;
  const o = stats?.orders || { count: 0, revenue: 0, byDay: [] };
  const p = stats?.products || { total: 0 };
  const u = stats?.users;
  const cards = admin ? [
    ['💰', 'Revenue', money(o.revenue), 'excluding cancelled'],
    ['🧾', 'Orders', o.count, `${o.byStatus?.pending || 0} pending`],
    ['📦', 'Products', p.total, `${p.lowStock || 0} low · ${p.outOfStock || 0} out of stock`],
    ['👥', 'Users', u?.total ?? '—', `${u?.admins ?? 0} admin`],
  ] : [
    ['💳', 'Total spent', money(o.revenue), 'excluding cancelled'],
    ['🧾', 'My orders', o.count, `${o.byStatus?.pending || 0} pending`],
    ['🛍️', 'Products', p.total, 'in the catalogue'],
    ['🛒', 'In cart', cartCount(), money(cartTotal())],
  ];
  const max = Math.max(1, ...o.byDay.map((d) => d.revenue));
  const chart = o.byDay.map((d) => {
    const pct = Math.round((d.revenue / max) * 100);
    const day = new Date(d.day + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' });
    return `<div class="col" title="${esc(d.day)}: ${money(d.revenue)} · ${d.orders} orders"><span class="amt">${d.revenue ? money(d.revenue) : ''}</span><div class="bar ${d.revenue ? '' : 'zero'}" style="height:${Math.max(pct, 3)}%"></div><span class="lbl">${esc(day)}</span></div>`;
  }).join('');
  const recent = orders.slice(0, 5).map((x) => `<div class="row-item"><div class="grow"><strong>Order #${x.id}</strong><br><small>${fmtDate(x.createdAt)}${admin ? ' · ' + esc(x.userEmail) : ''}</small></div><span class="badge ${esc(x.status)}">${esc(x.status)}</span><strong>${money(x.total)}</strong></div>`).join('');
  const tiles = [...(health?.services || [])];
  tiles.push({ name: 'frontend', lang: 'Nginx', status: 'up', latencyMs: 0, host: location.host, deps: {} });

  view.innerHTML = `
    <div class="page-head"><div><h1>Welcome back, ${esc(S.user.name.split(' ')[0])} 👋</h1><p>${admin ? 'Here is how the store is performing.' : 'Here is a snapshot of your account.'}</p></div>
      <a class="btn primary" href="#/shop">${I.shop} Browse products</a></div>
    <div class="grid stats">${cards.map(([ic, l, v, s]) => `<div class="card stat"><div class="ic">${ic}</div><div><div class="label">${l}</div><div class="value">${v}</div><div class="sub">${s}</div></div></div>`).join('')}</div>
    <div class="two-col">
      <div class="card chart-card"><div class="card-head"><h3>${admin ? 'Revenue' : 'Spending'} — last 7 days</h3></div><div class="chart">${chart}</div></div>
      <div class="card"><div class="card-head"><h3>Recent orders</h3><a href="#/orders" class="btn sm ghost">View all</a></div>
        <div class="list">${recent || '<p class="muted">No orders yet.</p>'}</div></div>
    </div>
    <div class="card"><div class="card-head"><h3>Live architecture</h3><button class="btn sm" data-action="reload">${I.refresh} Refresh</button></div>
      <div class="health-grid">${tiles.map(healthTile).join('')}</div>
      <p class="muted" style="margin:12px 0 0;font-size:13px">Each tile is a separate container/pod. The service names, hostnames and latencies come from live health checks through the gateway.</p></div>`;
}

/* =============================== views: shop =============================== */
function stockInfo(p) {
  if (p.stock <= 0) return ['out', 'Out of stock'];
  if (p.stock <= 5) return ['low', `Only ${p.stock} left`];
  return ['ok', 'In stock'];
}
function productCard(p) {
  const [cls, label] = stockInfo(p);
  const inCart = S.cart[p.id]?.qty || 0;
  const action = p.stock <= 0 ? '<button class="btn sm" disabled>Sold out</button>'
    : inCart ? `<div class="stepper"><button data-action="dec" data-id="${p.id}" aria-label="Decrease quantity">−</button><span>${inCart}</span><button data-action="inc" data-id="${p.id}" aria-label="Increase quantity">+</button></div>`
      : `<button class="btn primary sm" data-action="inc" data-id="${p.id}">${I.plus} Add</button>`;
  return `<article class="product" data-card="${p.id}">
    <div class="p-media" style="--h:${hue(p.category)}"><span class="emoji">${esc(p.emoji || '📦')}</span><span class="p-cat">${esc(p.category)}</span></div>
    <div class="p-body"><h3 class="p-name">${esc(p.name)}</h3><p class="p-desc">${esc(p.description)}</p>
      <div class="p-foot"><div><div class="price">${money(p.price)}</div><div class="stock ${cls}">${label}</div></div>${action}</div></div></article>`;
}
function remember(items) { items.forEach((p) => { S.byId[p.id] = p; }); }

async function viewShop(view, live) {
  const sh = S.shop;
  view.innerHTML = `
    <div class="toolbar">
      <div class="search">${I.search}<input class="input" id="q" type="search" placeholder="Search products…" aria-label="Search products" value="${esc(sh.search)}"></div>
      <select class="select" id="sort" aria-label="Sort products">
        <option value="newest">Newest first</option><option value="price_asc">Price: low to high</option>
        <option value="price_desc">Price: high to low</option><option value="name">Name A–Z</option>
      </select>
    </div>
    <div class="chips" id="chips"></div>
    <div class="grid products" id="grid">${skeleton(4)}</div>
    <div class="more" id="more"></div>`;
  $('#sort').value = sh.sort;
  $('#q').addEventListener('input', debounce((e) => { sh.search = e.target.value.trim(); loadProducts(true); }, 350));
  $('#sort').addEventListener('change', (e) => { sh.sort = e.target.value; loadProducts(true); });
  try { sh.cats = await api('/products/categories'); } catch { sh.cats = []; }
  if (!live()) return;
  renderChips();
  await loadProducts(true);
}
function renderChips() {
  const el = $('#chips'); if (!el) return;
  el.innerHTML = ['all', ...S.shop.cats].map((c) => `<button class="chip ${S.shop.category === c ? 'active' : ''}" data-action="chip" data-cat="${esc(c)}">${c === 'all' ? 'All' : esc(c)}</button>`).join('');
}
async function loadProducts(reset) {
  const sh = S.shop;
  if (reset) { sh.page = 1; sh.items = []; }
  const my = ++sh.req;
  const grid = $('#grid'); if (!grid) return;
  if (reset) grid.innerHTML = skeleton(4);
  const qs = new URLSearchParams({ page: sh.page, limit: 12, sort: sh.sort });
  if (sh.search) qs.set('search', sh.search);
  if (sh.category !== 'all') qs.set('category', sh.category);
  try {
    const d = await api('/products?' + qs);
    if (my !== sh.req || !$('#grid')) return;
    remember(d.items);
    sh.items = sh.items.concat(d.items); sh.pages = d.pages; sh.total = d.total;
    $('#grid').innerHTML = sh.items.length ? sh.items.map(productCard).join('') : '';
    if (!sh.items.length) $('#grid').innerHTML = `<div style="grid-column:1/-1">${empty('🔍', 'No products found', 'Try a different search or category.')}</div>`;
    $('#more').innerHTML = sh.page < sh.pages ? `<button class="btn" data-action="more">Load more (${sh.total - sh.items.length} left)</button>` : '';
  } catch (e) { if (my === sh.req && $('#grid')) $('#grid').innerHTML = `<div style="grid-column:1/-1">${errorState(e.message, true)}</div>`; }
}
function refreshCard(id) {
  const p = S.byId[id]; const el = $(`[data-card="${id}"]`);
  if (p && el) el.outerHTML = productCard(p);
}

/* =============================== views: cart =============================== */
function viewCart(view) {
  const lines = Object.values(S.cart);
  if (!lines.length) { view.innerHTML = empty('🛒', 'Your cart is empty', 'Browse the catalogue and add something you like.', '<a class="btn primary" href="#/shop">Start shopping</a>'); return; }
  view.innerHTML = `
    <div class="cart-layout">
      <section class="card">${lines.map((i) => `
        <div class="cart-line">
          <div class="c-emoji">${esc(i.emoji)}</div>
          <div class="c-info"><strong>${esc(i.name)}</strong><span class="muted">${money(i.price)} each</span></div>
          <div class="stepper"><button data-action="dec" data-id="${i.id}" aria-label="Decrease">−</button><span>${i.qty}</span><button data-action="inc" data-id="${i.id}" aria-label="Increase">+</button></div>
          <div class="c-total">${money(i.price * i.qty)}</div>
          <button class="icon-btn" data-action="remove" data-id="${i.id}" aria-label="Remove ${esc(i.name)}">${I.trash}</button>
        </div>`).join('')}</section>
      <aside class="card summary">
        <h3>Order summary</h3>
        <div class="sum-row"><span class="muted">Items</span><span>${cartCount()}</span></div>
        <div class="sum-row"><span class="muted">Delivery</span><span>Free</span></div>
        <div class="sum-row total"><span>Total</span><span>${money(cartTotal())}</span></div>
        <button class="btn primary block" data-action="checkout">Place order</button>
        <button class="btn ghost block" data-action="clear-cart">Clear cart</button>
        <small>Stock is reserved when you place the order and restored if it is cancelled.</small>
      </aside>
    </div>`;
}
async function checkout(btn) {
  btn.disabled = true; btn.textContent = 'Placing order…';
  try {
    const order = await api('/orders', { method: 'POST', body: { items: Object.values(S.cart).map((i) => ({ product_id: i.id, quantity: i.qty })) } });
    S.cart = {}; saveCart();
    toast(`Order #${order.id} placed — ${money(order.total)}`, 'ok');
    location.hash = '#/orders';
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Place order'; }
}

/* =============================== views: orders =============================== */
const STEPS = ['pending', 'paid', 'shipped', 'delivered'];
const NEXT = { pending: ['paid', 'cancelled'], paid: ['shipped', 'cancelled'], shipped: ['delivered'], delivered: [], cancelled: [] };
const LABEL = { paid: (a) => (a ? 'Mark as paid' : 'Pay now'), shipped: () => 'Mark as shipped', delivered: () => 'Mark as delivered', cancelled: () => 'Cancel order' };

async function viewOrders(view, live) {
  const admin = S.user.role === 'admin';
  S.orders = await api('/orders' + (admin ? '?all=1' : ''));
  if (!live()) return;
  renderOrders(view);
}
function renderOrders(view = $('#view')) {
  const admin = S.user.role === 'admin';
  const f = S.ordersFilter;
  const count = (s) => (s === 'all' ? S.orders.length : S.orders.filter((o) => o.status === s).length);
  const list = S.orders.filter((o) => f === 'all' || o.status === f);
  const tabs = ['all', ...STEPS, 'cancelled'].map((s) => `<button class="chip ${f === s ? 'active' : ''}" data-action="filter-orders" data-status="${s}">${s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)} (${count(s)})</button>`).join('');
  const cards = list.map((o) => {
    const idx = STEPS.indexOf(o.status);
    const track = o.status === 'cancelled' ? '' : `<ol class="track">${STEPS.map((s, i) => `<li class="${i <= idx ? 'done' : ''}"><i></i>${s}</li>`).join('')}</ol>`;
    const allowed = admin ? NEXT[o.status] : (o.status === 'pending' ? NEXT.pending : []);
    const actions = allowed.map((s) => `<button class="btn sm ${s === 'cancelled' ? 'danger' : 'primary'}" data-action="order-status" data-id="${o.id}" data-status="${s}">${LABEL[s](admin)}</button>`).join('');
    return `<article class="card order">
      <div class="o-head"><div class="o-title"><strong>Order #${o.id}</strong><span class="badge ${esc(o.status)}">${esc(o.status)}</span><small>${fmtDate(o.createdAt)}${admin ? ' · ' + esc(o.userEmail) : ''}</small></div><div class="o-total">${money(o.total)}</div></div>
      <div class="o-emojis">${o.items.map((i) => `<span title="${esc(i.name)}">${esc(i.emoji)}</span>`).join('')}</div>
      ${track}
      <details><summary>${o.items.length} item${o.items.length > 1 ? 's' : ''} — view details</summary>
        <div class="list">${o.items.map((i) => `<div class="row-item"><span class="e">${esc(i.emoji)}</span><div class="grow"><strong>${esc(i.name)}</strong><br><small>${money(i.price)} × ${i.quantity}</small></div><strong>${money(i.price * i.quantity)}</strong></div>`).join('')}</div></details>
      ${actions ? `<div class="o-actions">${actions}</div>` : ''}</article>`;
  }).join('');
  view.innerHTML = `<div class="page-head"><div><h1>${admin ? 'All orders' : 'My orders'}</h1><p>${admin ? 'Move orders through fulfilment.' : 'Track and manage your purchases.'}</p></div></div>
    <div class="tabs-lite">${tabs}</div>
    <div class="orders">${cards || empty('🧾', 'No orders here', f === 'all' ? 'Place your first order from the shop.' : 'Nothing with this status.', f === 'all' ? '<a class="btn primary" href="#/shop">Go to shop</a>' : '')}</div>`;
}
async function changeStatus(id, status, btn) {
  if (status === 'cancelled' && !(await confirmBox('Cancel this order?', 'The reserved stock will be returned to the store.', 'Cancel order', true))) return;
  btn.disabled = true;
  try {
    const o = await api(`/orders/${id}/status`, { method: 'PATCH', body: { status } });
    S.orders = S.orders.map((x) => (x.id === o.id ? o : x));
    toast(`Order #${o.id} is now ${o.status}`, 'ok');
    renderOrders();
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
}

/* =============================== views: admin products =============================== */
async function viewAdminProducts(view, live) {
  const [d, cats] = await Promise.all([api(`/products?limit=8&page=${S.adminPage}&sort=newest`), api('/products/categories').catch(() => [])]);
  if (!live()) return;
  S.cats = cats; remember(d.items);
  if (!d.items.length && S.adminPage > 1) { S.adminPage = Math.max(1, d.pages); return viewAdminProducts(view, live); }
  view.innerHTML = `
    <div class="page-head"><div><h1>Products</h1><p>${d.total} in catalogue</p></div><button class="btn primary" data-action="product-new">${I.plus} New product</button></div>
    <div class="card table-wrap"><table>
      <thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th></th></tr></thead>
      <tbody>${d.items.map((p) => { const [cls, label] = stockInfo(p); return `<tr>
        <td><span class="e">${esc(p.emoji)}</span><strong>${esc(p.name)}</strong></td><td>${esc(p.category)}</td><td>${money(p.price)}</td>
        <td><span class="stock ${cls}">${p.stock} · ${label}</span></td>
        <td><div class="actions"><button class="icon-btn" data-action="product-edit" data-id="${p.id}" aria-label="Edit ${esc(p.name)}">${I.edit}</button>
        <button class="icon-btn" data-action="product-delete" data-id="${p.id}" aria-label="Delete ${esc(p.name)}">${I.trash}</button></div></td></tr>`; }).join('')}</tbody></table></div>
    <div class="pager"><span class="muted">Page ${d.page} of ${d.pages}</span>
      <button class="btn sm" data-action="page-prev" ${d.page <= 1 ? 'disabled' : ''}>Previous</button>
      <button class="btn sm" data-action="page-next" ${d.page >= d.pages ? 'disabled' : ''}>Next</button></div>`;
}
function productForm(p) {
  const d = openDialog(`<form id="pform" class="dlg-body" novalidate>
    <h3>${p ? 'Edit product' : 'New product'}</h3>
    <div class="form-grid">
      <div class="field full"><label for="f-name">Name</label><input class="input" id="f-name" maxlength="120" required value="${esc(p?.name)}"></div>
      <div class="field full"><label for="f-desc">Description</label><textarea class="input" id="f-desc" rows="3" maxlength="500">${esc(p?.description)}</textarea></div>
      <div class="field"><label for="f-cat">Category</label><input class="input" id="f-cat" list="cats" value="${esc(p?.category || '')}" placeholder="e.g. Electronics"><datalist id="cats">${(S.cats || []).map((c) => `<option value="${esc(c)}">`).join('')}</datalist></div>
      <div class="field"><label for="f-emoji">Emoji</label><input class="input" id="f-emoji" maxlength="4" value="${esc(p?.emoji || '📦')}"></div>
      <div class="field"><label for="f-price">Price (₹)</label><input class="input" id="f-price" type="number" min="0" step="0.01" required value="${p ? p.price : ''}"></div>
      <div class="field"><label for="f-stock">Stock</label><input class="input" id="f-stock" type="number" min="0" step="1" required value="${p ? p.stock : 10}"></div>
    </div>
    <div class="form-error" id="pErr" role="alert"></div>
    <div class="dlg-actions"><button type="button" class="btn ghost" data-action="close-dlg">Cancel</button><button class="btn primary" type="submit">${p ? 'Save changes' : 'Create product'}</button></div></form>`);
  $('#pform', d).addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: $('#f-name').value, description: $('#f-desc').value, category: $('#f-cat').value, emoji: $('#f-emoji').value,
      price: parseFloat($('#f-price').value), stock: parseInt($('#f-stock').value, 10) };
    if (Number.isNaN(body.price) || Number.isNaN(body.stock)) { $('#pErr').textContent = 'Price and stock must be numbers.'; return; }
    const btn = $('button[type=submit]', d); btn.disabled = true;
    try {
      await api('/products' + (p ? `/${p.id}` : ''), { method: p ? 'PUT' : 'POST', body });
      d.close(); toast(p ? 'Product updated' : 'Product created', 'ok'); route();
    } catch (ex) { $('#pErr').textContent = ex.message; btn.disabled = false; }
  });
  $('#f-name').focus();
}

/* =============================== views: admin users =============================== */
async function viewAdminUsers(view, live) {
  const users = await api('/users');
  if (!live()) return;
  view.innerHTML = `<div class="page-head"><div><h1>Users</h1><p>${users.length} registered accounts</p></div></div>
    <div class="card table-wrap"><table><thead><tr><th>User</th><th>Email</th><th>Joined</th><th>Role</th></tr></thead>
    <tbody>${users.map((u) => `<tr><td><strong>${esc(u.name)}</strong>${u.id === S.user.id ? ' <small>(you)</small>' : ''}</td><td>${esc(u.email)}</td><td>${fmtDate(u.createdAt)}</td>
      <td>${u.id === S.user.id ? `<span class="badge admin">${esc(u.role)}</span>` : `<select class="select" style="width:auto" data-role-user="${u.id}" aria-label="Role for ${esc(u.name)}"><option value="user" ${u.role === 'user' ? 'selected' : ''}>user</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option></select>`}</td></tr>`).join('')}</tbody></table></div>`;
}

/* =============================== events =============================== */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action, id = el.dataset.id;
  const onCart = (location.hash.replace(/^#\/?/, '') || '').startsWith('cart');
  switch (a) {
    case 'theme': applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); el.innerHTML = document.documentElement.dataset.theme === 'dark' ? I.sun : I.moon; break;
    case 'logout': logout(); break;
    case 'open-nav': $('#shell')?.classList.add('nav-open'); break;
    case 'close-nav': $('#shell')?.classList.remove('nav-open'); break;
    case 'close-dlg': $('#dlg').close(); break;
    case 'reload': route(); break;
    case 'hard-reload': location.reload(); break;
    case 'auth-tab': renderAuth(el.dataset.mode); break;
    case 'demo': e.preventDefault(); $('#a-email').value = 'admin@shop.local'; $('#a-pass').value = 'Admin@123'; $('#authForm').requestSubmit(); break;
    case 'chip': S.shop.category = el.dataset.cat; renderChips(); loadProducts(true); break;
    case 'more': S.shop.page += 1; el.disabled = true; loadProducts(false); break;
    case 'inc': case 'dec': {
      const p = S.byId[id] || S.cart[id]; if (!p) break;
      if (changeCart(p, a === 'inc' ? 1 : -1)) { if (onCart) viewCart($('#view')); else refreshCard(id); }
      break;
    }
    case 'remove': delete S.cart[id]; saveCart(); viewCart($('#view')); break;
    case 'clear-cart': S.cart = {}; saveCart(); viewCart($('#view')); break;
    case 'checkout': checkout(el); break;
    case 'filter-orders': S.ordersFilter = el.dataset.status; renderOrders(); break;
    case 'order-status': changeStatus(Number(id), el.dataset.status, el); break;
    case 'product-new': productForm(null); break;
    case 'product-edit': productForm(S.byId[id]); break;
    case 'product-delete': {
      const p = S.byId[id];
      if (await confirmBox('Delete product?', `“${p.name}” will be removed from the catalogue.`, 'Delete', true)) {
        try { await api(`/products/${id}`, { method: 'DELETE' }); toast('Product deleted', 'ok'); route(); } catch (ex) { toast(ex.message, 'err'); }
      }
      break;
    }
    case 'page-prev': S.adminPage = Math.max(1, S.adminPage - 1); route(); break;
    case 'page-next': S.adminPage += 1; route(); break;
    default: break;
  }
});
document.addEventListener('change', async (e) => {
  const sel = e.target.closest('[data-role-user]');
  if (!sel) return;
  try { await api(`/users/${sel.dataset.roleUser}/role`, { method: 'PATCH', body: { role: sel.value } }); toast('Role updated', 'ok'); }
  catch (ex) { toast(ex.message, 'err'); route(); }
});
$('#dlg').addEventListener('click', (e) => { if (e.target === $('#dlg')) $('#dlg').close(); });
window.addEventListener('hashchange', route);

/* =============================== boot =============================== */
async function boot() {
  if (!S.token) { renderAuth(); return; }
  try {
    const me = await api('/auth/me');
    S.user = me; store.set('user', me);
  } catch (e) {
    if (S.token) $('#app').innerHTML = errorState(e.message, true).replace('data-action="reload"', 'data-action="hard-reload"');
    return;
  }
  loadCart();
  renderShell();
  await route();
}
boot();
})();
