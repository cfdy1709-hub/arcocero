const path = require('path'), crypto = require('crypto'), fs = require('fs');
const express = require('express'), compression = require('compression');
const cfg = require('./lib/config');
const { openStore, StockError } = require('./lib/db');
const { makeWompi } = require('./lib/wompi');

function createApp(options = {}) {
  const config = { ...cfg, ...options };
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'catalog.json'), 'utf8'));
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  // Copia del catálogo como script: permite ver la tienda aunque el HTML se abra sin servidor.
  try { fs.writeFileSync(path.join(__dirname, 'public', 'catalog.js'), 'window.CATALOG_FALLBACK = ' + JSON.stringify(catalog) + ';\n'); } catch (e) { /* hosting de solo lectura */ }
  const store = openStore(config.dbPath, catalog, config.reservationMinutes);
  const wompi = makeWompi(config.wompi);
  const mock = options.mock !== undefined ? options.mock : !config.wompi.publicKey;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);                       // detrás de Render/Railway/nginx: IP real del cliente
  app.use(compression());
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' });
    next();
  });
  app.use(express.json({ limit: '20kb' }));

  // ---------- límite de peticiones (en memoria, por IP) ----------
  const hits = new Map();
  const limit = (name, max, windowMs) => (req, res, next) => {
    const k = name + ':' + req.ip, now = Date.now();
    const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta en un momento.' });
    arr.push(now); hits.set(k, arr); next();
  };
  const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 600000)) hits.delete(k); }, 300000);
  sweep.unref();

  // ---------- catálogo + stock disponible ----------
  app.get('/api/products', (req, res) => {
    const av = store.availability();
    res.set('Cache-Control', 'no-store');
    res.json(catalog.map(p => ({ ...p, stock: av[p.id] || {} })));
  });

  app.get('/api/config', (req, res) => {
    res.json({ mock, wompiPublicKey: mock ? null : config.wompi.publicKey, currency: 'COP', reservationMinutes: config.reservationMinutes });
  });

  // ---------- crear pedido: valida, reserva stock, firma ----------
  const phoneOk = v => /^3\d{9}$/.test(v);
  const emailOk = v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) && v.length <= 120;
  const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max;

  app.post('/api/orders', limit('orders', 15, 60000), (req, res) => {
    const b = req.body || {}, c = b.customer || {};
    const customer = {
      name: String(c.name || '').trim(), email: String(c.email || '').trim().toLowerCase(), phone: String(c.phone || '').replace(/\D/g, ''),
      city: String(c.city || '').trim(), region: String(c.region || '').trim(), addr: String(c.addr || '').trim(), notes: String(c.notes || '').trim(),
    };
    if (!str(customer.name, 3, 120) || !emailOk(customer.email) || !phoneOk(customer.phone) || !str(customer.city, 2, 80) ||
        !str(customer.region, 2, 80) || !str(customer.addr, 5, 200) || customer.notes.length > 300)
      return res.status(400).json({ error: 'Revisa los datos de envío: hay campos vacíos o inválidos.' });
    if (b.acceptedTerms !== true) return res.status(400).json({ error: 'Debes aceptar las condiciones de envíos y cambios.' });

    // Se agrupan líneas repetidas y se validan contra el catálogo (el precio SIEMPRE sale del servidor).
    if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 40) return res.status(400).json({ error: 'El carrito está vacío o es inválido.' });
    const merged = new Map();
    for (const it of b.items) {
      const p = store.byId.get(it && it.id);
      const size = it && typeof it.size === 'string' ? it.size : 'Única';
      const qty = it && it.qty;
      if (!p || !store.sizesOf(p).includes(size) || !Number.isInteger(qty) || qty < 1 || qty > 20)
        return res.status(400).json({ error: 'Un producto del carrito no es válido.' });
      const key = p.id + '::' + size;
      const prev = merged.get(key);
      merged.set(key, { id: p.id, size, qty: (prev ? prev.qty : 0) + qty });
    }
    const lines = [...merged.values()];
    if (lines.some(l => l.qty > 20)) return res.status(400).json({ error: 'Cantidad máxima por producto: 20.' });

    const reference = 'ARCO-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    try {
      const order = store.createOrder(reference, customer, lines, req.ip);
      const out = { reference, total: order.total, expiresAt: order.expiresAt, mock };
      if (!mock) {
        const amountInCents = order.total * 100;
        out.checkout = {
          publicKey: config.wompi.publicKey, currency: 'COP', amountInCents, reference,
          signatureIntegrity: wompi.integritySignature(reference, amountInCents, 'COP'),
          redirectUrl: `${config.publicUrl}/?pedido=${reference}`,
        };
      }
      res.status(201).json(out);
    } catch (e) {
      if (e instanceof StockError) {
        const p = store.byId.get(e.line.id);
        return res.status(409).json({ error: `No hay suficiente stock de "${p.name}"${e.line.size !== 'Única' ? ' (' + e.line.size + ')' : ''}. Disponible: ${Math.max(e.available, 0)}.`,
          productId: e.line.id, size: e.line.size, available: Math.max(e.available, 0) });
      }
      if (e.code === 'TOO_MANY_PENDING') return res.status(429).json({ error: 'Tienes varios pedidos pendientes. Completa o espera a que venzan antes de crear otro.' });
      console.error('createOrder', e); res.status(500).json({ error: 'No pudimos crear el pedido.' });
    }
  });

  // ---------- aplicar el resultado de una transacción (webhook, consulta o simulación) ----------
  function applyTransaction(tx) {
    const order = store.getOrder(tx.reference);
    if (!order) return { ok: false, reason: 'pedido desconocido' };
    if (tx.amount_in_cents !== order.total * 100 || (tx.currency && tx.currency !== 'COP')) {
      console.warn('Monto/moneda no coinciden', tx.reference, tx.amount_in_cents, order.total * 100);
      return { ok: false, reason: 'monto no coincide' };
    }
    if (tx.status === 'APPROVED') return { ok: true, status: store.markPaid(tx.reference, tx.id) };
    if (['DECLINED', 'VOIDED', 'ERROR'].includes(tx.status)) {
      store.releaseOrder(tx.reference, 'FAILED', tx.id, 'Pago ' + tx.status);
      return { ok: true, status: store.getOrder(tx.reference).status };
    }
    return { ok: true, status: order.status };      // PENDING: seguimos esperando
  }

  // Webhook de Wompi (configurar en el panel: <PUBLIC_URL>/api/wompi/webhook)
  app.post('/api/wompi/webhook', (req, res) => {
    if (mock) return res.status(404).end();
    if (!wompi.verifyEvent(req.body)) return res.status(401).json({ error: 'firma inválida' });
    if (req.body.event === 'transaction.updated') {
      try { applyTransaction(req.body.data.transaction); } catch (e) { console.error('webhook', e); return res.status(500).end(); }
    }
    res.status(200).json({ ok: true });
  });

  // Estado del pedido. Si Wompi devolvió ?id=<transacción> se consulta directamente a Wompi (no se confía en el navegador).
  app.get('/api/orders/:reference', limit('status', 120, 60000), async (req, res) => {
    const ref = String(req.params.reference);
    let order = store.getOrder(ref);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (order.status === 'PENDING' && !mock && req.query.id) {
      try {
        const tx = await wompi.fetchTransaction(String(req.query.id));
        if (tx && tx.reference === ref) { applyTransaction(tx); order = store.getOrder(ref); }
      } catch (e) { /* se reintentará; el webhook también lo resolverá */ }
    }
    res.set('Cache-Control', 'no-store');
    res.json({ reference: order.reference, status: order.status, total: order.total });
  });

  // El cliente cerró el pago sin completarlo: se libera la reserva para que pueda reintentar.
  // (La referencia es aleatoria de 64 bits. Si el pago estaba en curso y luego se aprueba, el webhook lo reactiva.)
  app.post('/api/orders/:reference/cancel', limit('cancel', 30, 60000), (req, res) => {
    const ref = String(req.params.reference);
    if (!store.getOrder(ref)) return res.status(404).json({ error: 'Pedido no encontrado' });
    store.releaseOrder(ref, 'FAILED', null, 'Cancelado por el cliente');
    res.json({ status: store.getOrder(ref).status });
  });

  // ---------- simulador de pago (solo modo simulado) ----------
  app.post('/api/dev/pay', (req, res) => {
    if (!mock) return res.status(404).end();
    const { reference, result } = req.body || {};
    const order = store.getOrder(reference);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    const r = applyTransaction({ id: 'MOCK-' + Date.now(), reference, amount_in_cents: order.total * 100, currency: 'COP', status: result === 'APPROVED' ? 'APPROVED' : 'DECLINED' });
    res.json(r);
  });

  // ---------- administración (Authorization: Bearer <ADMIN_TOKEN>) ----------
  const admin = (req, res, next) => {
    if (!config.adminToken) return res.status(403).json({ error: 'Admin deshabilitado: define ADMIN_TOKEN' });
    const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(t), b = Buffer.from(config.adminToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'No autorizado' });
    next();
  };
  app.get('/api/admin/orders', admin, (req, res) => res.json(store.listOrders(req.query.status)));
  app.get('/api/admin/stock', admin, (req, res) => res.json(store.db.prepare('SELECT product_id,size,on_hand,reserved FROM stock ORDER BY product_id,size').all()));
  app.post('/api/admin/stock', admin, (req, res) => {
    const { productId, size, onHand } = req.body || {};
    if (!Number.isInteger(onHand) || onHand < 0) return res.status(400).json({ error: 'onHand inválido' });
    try { return store.setStock(productId, size || 'Única', onHand) ? res.json({ ok: true }) : res.status(404).json({ error: 'No existe' }); }
    catch (e) { return res.status(409).json({ error: 'No puedes dejar el stock por debajo de lo reservado' }); }
  });

  // ---------- liberar reservas vencidas ----------
  const timer = setInterval(() => { try { store.expireStale(); } catch (e) { console.error(e); } }, 60000);
  timer.unref();

  // ---------- archivos estáticos ----------
  app.use('/img', express.static(path.join(__dirname, 'public', 'img'), { maxAge: '365d', immutable: true }));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado' }));

  return { app, store, close: () => { clearInterval(timer); store.close(); }, mock };
}

if (require.main === module) {
  const { app, mock } = createApp();
  app.listen(cfg.port, () => {
    console.log(`ArcoCero en ${cfg.publicUrl}  |  pagos: ${mock ? 'MODO SIMULADO (sin cobro)' : 'Wompi ' + cfg.wompi.env}`);
    if (!mock && (!cfg.wompi.integritySecret || !cfg.wompi.eventsSecret)) console.warn('⚠ Falta WOMPI_INTEGRITY_SECRET o WOMPI_EVENTS_SECRET');
    if (!cfg.adminToken) console.warn('ℹ ADMIN_TOKEN no definido: el panel /api/admin está deshabilitado');
  });
}
module.exports = { createApp };
