/**
 * invoices.js — Charleston: text-to-invoice + payment tracking.
 * Invoices are stored as JSON in the existing app_config table (owner-scoped by
 * key prefix), so no schema migration is required. Card payments use the studio's
 * own Stripe key (settings.stripe_secret_key) when connected — so funds go to the
 * teacher — falling back to the platform key in test mode.
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const auth = require('./auth');
const router = express.Router();
router.use(express.json({ limit: '12mb' }));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const PLATFORM_STRIPE = process.env.STRIPE_SECRET_KEY || '';
const SITE_URL = (process.env.SITE_URL || 'https://charlestoncrm.com').replace(/\/$/, '');

async function sb(pathname, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, { ...opts, headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) } });
  const t = await res.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!res.ok) throw new Error((d && d.message) || `Supabase ${res.status}`);
  return d;
}
async function stripe(key, p, params, method = 'POST') {
  const res = await fetch('https://api.stripe.com/v1/' + p, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params ? new URLSearchParams(params).toString() : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && j.error.message) || `Stripe ${res.status}`);
  return j;
}
const enc = encodeURIComponent;
const clean = (v, max = 800) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const money = (v) => Math.max(0, Math.round(parseFloat(v || 0) * 100) || 0);
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
function ownerId(req) { const a = req.account || {}; return a.oid || a.owner_id || a.id || null; }

async function cfgGet(key) { const r = await sb(`app_config?key=eq.${enc(key)}&select=value&limit=1`).catch(() => []); return r && r[0] ? r[0].value : null; }
async function cfgSet(key, value) { await sb('app_config?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) }); }
async function cfgDel(key) { await sb(`app_config?key=eq.${enc(key)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }).catch(() => {}); }
async function cfgList(prefix) { const r = await sb(`app_config?key=like.${prefix}*&select=key,value`).catch(() => []); return r || []; }

async function loadInv(owner, id) { const v = await cfgGet(`inv:${owner}:${id}`); return v ? JSON.parse(v) : null; }
async function saveInv(inv) { await cfgSet(`inv:${inv.owner}:${inv.id}`, JSON.stringify(inv)); }
async function resolveToken(token) { const v = await cfgGet(`invref:${token}`); if (!v) return null; const i = v.indexOf(':'); return { owner: v.slice(0, i), id: v.slice(i + 1) }; }
async function ownerStripeKey(owner) { try { const s = await sb(`settings?owner_id=eq.${enc(owner)}&select=stripe_secret_key&limit=1`); if (s && s[0] && s[0].stripe_secret_key) return s[0].stripe_secret_key; } catch (e) {} return PLATFORM_STRIPE; }

function recompute(inv) {
  const paid = (inv.payments || []).reduce((s, p) => s + (p.amount || 0), 0);
  inv.paidTotal = paid;
  inv.status = paid >= inv.amount ? 'paid' : (paid > 0 ? 'partial' : 'unpaid');
  inv.paidAt = inv.status === 'paid' ? (inv.paidAt || new Date().toISOString()) : null;
}
function adminView(inv) {
  return { id: inv.id, number: inv.number, createdAt: inv.createdAt, customer: inv.customer, items: inv.items,
    amount: inv.amount, currency: inv.currency, dueDate: inv.dueDate, notes: inv.notes, status: inv.status,
    paidTotal: inv.paidTotal || 0, paidAt: inv.paidAt || null, link: `${SITE_URL}/i/${inv.token}`,
    payments: (inv.payments || []).map((p) => ({ id: p.id, method: p.method, amount: p.amount, date: p.date, note: p.note, stripeRef: p.stripeRef, hasImage: !!p.image, proofUrl: p.image ? `/api/invoices/${inv.id}/proof/${p.id}` : '' })) };
}

/* ---------------- admin API ---------------- */
router.post('/api/invoices', auth.requireAuth, async (req, res) => {
  try {
    const owner = ownerId(req); if (!owner) return res.status(401).json({ ok: false });
    const b = req.body || {};
    let items = (Array.isArray(b.items) ? b.items : []).map((it) => ({ desc: clean(it.desc, 200), amount: money(it.amount) })).filter((it) => it.desc || it.amount);
    if (!items.length) { const d = clean(b.description, 200), a = money(b.amount); if (a || d) items.push({ desc: d || 'Services', amount: a }); }
    const amount = items.reduce((s, it) => s + it.amount, 0);
    if (!amount) return res.status(400).json({ ok: false, error: 'Add at least one line item with an amount.' });
    const id = rid(5), token = rid(16);
    const inv = { id, token, owner, createdAt: new Date().toISOString(), number: 'INV-' + id.toUpperCase().slice(0, 6),
      customer: { name: clean(b.customerName || b.name, 120), email: clean(b.email, 160), phone: clean(b.phone, 40) },
      items, amount, currency: 'usd', dueDate: clean(b.dueDate, 20), notes: clean(b.notes, 1000), status: 'unpaid', payments: [] };
    await saveInv(inv);
    await cfgSet(`invref:${token}`, `${owner}:${id}`);
    res.json({ ok: true, invoice: adminView(inv), link: `${SITE_URL}/i/${token}` });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/api/invoices', auth.requireAuth, async (req, res) => {
  try {
    const owner = ownerId(req);
    const rows = await cfgList(`inv:${owner}:`);
    const invoices = rows.map((r) => { try { return JSON.parse(r.value); } catch { return null; } }).filter(Boolean)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).map(adminView);
    const totals = invoices.reduce((t, i) => { t.outstanding += (i.amount - i.paidTotal); t.collected += i.paidTotal; return t; }, { outstanding: 0, collected: 0 });
    res.json({ ok: true, invoices, totals });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/api/invoices/:id/pay', auth.requireAuth, async (req, res) => {
  try {
    const owner = ownerId(req); const inv = await loadInv(owner, req.params.id);
    if (!inv) return res.status(404).json({ ok: false });
    const b = req.body || {};
    const method = ['check', 'cash', 'stripe', 'zelle', 'venmo', 'other'].includes(b.method) ? b.method : 'other';
    let image = ''; if (typeof b.image === 'string' && b.image.startsWith('data:image')) image = b.image.slice(0, 6000000);
    const p = { id: rid(4), method, amount: money(b.amount != null && b.amount !== '' ? b.amount : inv.amount / 100), date: clean(b.date, 20) || new Date().toISOString().slice(0, 10), note: clean(b.note, 400), stripeRef: clean(b.stripeRef, 200), image };
    inv.payments = inv.payments || []; inv.payments.push(p);
    recompute(inv); await saveInv(inv);
    res.json({ ok: true, invoice: adminView(inv) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.delete('/api/invoices/:id/payment/:pid', auth.requireAuth, async (req, res) => {
  try {
    const owner = ownerId(req); const inv = await loadInv(owner, req.params.id);
    if (!inv) return res.status(404).json({ ok: false });
    inv.payments = (inv.payments || []).filter((p) => p.id !== req.params.pid);
    recompute(inv); await saveInv(inv);
    res.json({ ok: true, invoice: adminView(inv) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/api/invoices/:id/proof/:pid', auth.requireAuth, async (req, res) => {
  try {
    const owner = ownerId(req); const inv = await loadInv(owner, req.params.id);
    const p = inv && (inv.payments || []).find((x) => x.id === req.params.pid);
    const m = p && p.image && /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(p.image);
    if (!m) return res.status(404).send('');
    res.set('Content-Type', m[1]); res.set('Cache-Control', 'private, max-age=300');
    res.send(Buffer.from(m[2], 'base64'));
  } catch (e) { res.status(404).send(''); }
});

router.delete('/api/invoices/:id', auth.requireAuth, async (req, res) => {
  try { const owner = ownerId(req); const inv = await loadInv(owner, req.params.id); if (inv) { await cfgDel(`inv:${owner}:${inv.id}`); await cfgDel(`invref:${inv.token}`); } res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

/* ---------------- public invoice ---------------- */
router.get('/api/pi/:token', async (req, res) => {
  try {
    const ref = await resolveToken(req.params.token); if (!ref) return res.status(404).json({ ok: false });
    const inv = await loadInv(ref.owner, ref.id); if (!inv) return res.status(404).json({ ok: false });
    let studio = { name: '', logo: '' }, hasStripe = false;
    try { const s = await sb(`settings?owner_id=eq.${enc(ref.owner)}&select=business_name,business_logo,stripe_secret_key&limit=1`); const row = (s && s[0]) || {}; studio = { name: row.business_name || '', logo: row.business_logo || '' }; hasStripe = !!(row.stripe_secret_key || PLATFORM_STRIPE); } catch (e) {}
    res.json({ ok: true, number: inv.number, customer: { name: inv.customer.name }, items: inv.items, amount: inv.amount, currency: inv.currency, dueDate: inv.dueDate, notes: inv.notes, status: inv.status, paidTotal: inv.paidTotal || 0, paidAt: inv.paidAt || null, createdAt: inv.createdAt, studio, canPay: hasStripe && inv.status !== 'paid' });
  } catch (e) { res.status(500).json({ ok: false }); }
});

router.post('/api/pi/:token/checkout', async (req, res) => {
  try {
    const ref = await resolveToken(req.params.token); if (!ref) return res.status(404).json({ ok: false });
    const inv = await loadInv(ref.owner, ref.id); if (!inv) return res.status(404).json({ ok: false });
    if (inv.status === 'paid') return res.status(400).json({ ok: false, error: 'This invoice is already paid.' });
    const key = await ownerStripeKey(ref.owner);
    if (!key) return res.status(503).json({ ok: false, error: 'Card payments are not set up for this studio yet.' });
    const due = inv.amount - (inv.paidTotal || 0);
    const session = await stripe(key, 'checkout/sessions', {
      mode: 'payment',
      'line_items[0][price_data][currency]': inv.currency || 'usd',
      'line_items[0][price_data][product_data][name]': inv.number + (inv.customer.name ? (' · ' + inv.customer.name) : ''),
      'line_items[0][price_data][unit_amount]': String(due > 0 ? due : inv.amount),
      'line_items[0][quantity]': '1',
      'metadata[token]': inv.token,
      ...(inv.customer.email ? { customer_email: inv.customer.email } : {}),
      success_url: `${SITE_URL}/api/pi/${inv.token}/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/i/${inv.token}`,
    });
    res.json({ ok: true, url: session.url });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/api/pi/:token/return', async (req, res) => {
  try {
    const ref = await resolveToken(req.params.token); if (!ref) return res.redirect('/i/' + req.params.token);
    const inv = await loadInv(ref.owner, ref.id);
    const sid = String(req.query.session_id || '');
    if (inv && sid) {
      const key = await ownerStripeKey(ref.owner);
      try {
        const session = await stripe(key, 'checkout/sessions/' + enc(sid), null, 'GET');
        const payref = session.payment_intent || sid;
        if (session && session.payment_status === 'paid' && !(inv.payments || []).some((p) => p.stripeRef === payref)) {
          inv.payments = inv.payments || [];
          inv.payments.push({ id: rid(4), method: 'stripe', amount: session.amount_total || inv.amount, date: new Date().toISOString().slice(0, 10), note: 'Paid online by card', stripeRef: payref, image: '' });
          recompute(inv); await saveInv(inv);
        }
      } catch (e) {}
    }
    res.redirect('/i/' + req.params.token + '?paid=1');
  } catch (e) { res.redirect('/i/' + req.params.token); }
});

/* page routes */
router.get('/invoices', (req, res) => res.sendFile(path.join(__dirname, 'public', 'invoices.html')));
router.get('/i/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'invoice.html')));

module.exports = router;
