/**
 * billing.js — Charleston CRM subscriptions ($9.99/mo) via Stripe.
 * No stripe npm dep: uses Stripe's REST API + manual webhook signature check,
 * matching the app's existing fetch-based Stripe usage.
 *
 * Env: STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET, SITE_URL,
 *      SUPABASE_URL, SUPABASE_KEY
 */
const express = require('express');
const crypto = require('crypto');
const auth = require('./auth');

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const SITE_URL = (process.env.SITE_URL || 'https://charlestoncrm.com').replace(/\/$/, '');

const ACTIVE = new Set(['active', 'trialing']);

/* ---------------- tiny supabase + stripe REST helpers ---------------- */
async function sb(pathname, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...opts,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
  });
  const t = await res.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!res.ok) throw new Error((d && d.message) || `Supabase ${res.status}`);
  return d;
}
async function stripe(path, params, method = 'POST') {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method,
    headers: { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j.error && j.error.message) || `Stripe ${res.status}`);
  return j;
}
const enc = encodeURIComponent;
async function accountById(id) {
  const rows = await sb(`accounts?id=eq.${enc(id)}&limit=1`);
  return rows && rows[0];
}
async function patchAccount(id, patch) {
  await sb(`accounts?id=eq.${enc(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
}

async function appConfig(key) { try { const r = await sb(`app_config?key=eq.${enc(key)}&select=value&limit=1`); return (r && r[0] && r[0].value) || ''; } catch (e) { return ''; } }
async function setAppConfig(key, value) { try { await sb('app_config?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) }); } catch (e) {} }
async function annualPriceId() { return process.env.STRIPE_PRICE_ID_ANNUAL || (await appConfig('stripe_price_annual')) || ''; }
// Create the annual price (10x monthly = 2 months free) on first use, server-side.
async function ensureAnnualPrice() {
  let pid = await annualPriceId(); if (pid) return pid;
  if (!STRIPE_KEY || !PRICE_ID) return '';
  try {
    const monthly = await stripe('prices/' + encodeURIComponent(PRICE_ID), null, 'GET');
    const product = typeof monthly.product === 'string' ? monthly.product : (monthly.product && monthly.product.id);
    const amount = (monthly.unit_amount || 999) * 10;
    const price = await stripe('prices', { product, currency: monthly.currency || 'usd', 'recurring[interval]': 'year', unit_amount: String(amount) });
    await setAppConfig('stripe_price_annual', price.id);
    return price.id;
  } catch (e) { console.error('[billing] ensureAnnualPrice:', e.message); return ''; }
}
router.get('/api/billing/plans', async (req, res) => {
  res.json({ monthly: { amount: 9.99 }, annual: { amount: 99.90, available: true } });
});

/* ---------------- subscription gate ----------------
   CRM pages/APIs require an account whose subscription is active/trialing. */
const TRIAL_DAYS = 14;
// Every brand-new studio gets a 14-day free trial from the moment it signs up —
// no card required. Window derived from accounts.created_at (existing column), so
// no migration. Status 'none' means they never completed a subscription, so a
// leftover Stripe customer object (from an abandoned checkout) shouldn't block the
// trial. Once they subscribe & cancel, status becomes 'canceled' and the trial ends.
function trialEnd(a) { return a && a.created_at ? new Date(a.created_at).getTime() + TRIAL_DAYS * 86400000 : 0; }
function inTrial(a) { return !!(a && (!a.subscription_status || a.subscription_status === 'none') && Date.now() < trialEnd(a)); }
function acctActive(a) { return !!(a && (ACTIVE.has(a.subscription_status) || inTrial(a))); }
async function subscriptionActive(accountId) {
  try { const a = await accountById(accountId); return acctActive(a); }
  catch { return false; }
}
async function requireSubscription(req, res, next) {
  if (!req.account) return res.status(401).json({ ok: false, error: 'Please sign in.' });
  if (await subscriptionActive(req.account.id)) return next();
  // page requests get redirected to the paywall; API requests get 402
  if ((req.headers.accept || '').includes('text/html')) return res.redirect('/subscribe');
  return res.status(402).json({ ok: false, error: 'A subscription is required.', needsSubscription: true });
}

/* ---------------- checkout: start a $9.99/mo subscription ---------------- */
router.post('/api/billing/checkout', auth.requireAuth, async (req, res) => {
  try {
    if (!STRIPE_KEY || !PRICE_ID) return res.status(503).json({ ok: false, error: 'Billing is not configured yet.' });
    const acct = await accountById(req.account.id);
    if (!acct) return res.status(404).json({ ok: false, error: 'Account not found.' });

    // reuse or create the Stripe customer
    let customer = acct.stripe_customer_id;
    if (!customer) {
      const c = await stripe('customers', { email: acct.email || '', name: acct.name || '', 'metadata[account_id]': acct.id });
      customer = c.id;
      await patchAccount(acct.id, { stripe_customer_id: customer });
    }

    const plan = (req.body && req.body.plan) === 'annual' ? 'annual' : 'monthly';
    let priceId = PRICE_ID;
    if (plan === 'annual') { const ap = await ensureAnnualPrice(); if (ap) priceId = ap; }
    const session = await stripe('checkout/sessions', {
      mode: 'subscription',
      customer,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'subscription_data[metadata][account_id]': acct.id,
      'subscription_data[trial_period_days]': '14',
      client_reference_id: acct.id,
      allow_promotion_codes: 'true',
      success_url: `${SITE_URL}/api/billing/return?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/subscribe?cancelled=1`,
    });
    res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error('[billing] checkout:', e.message);
    res.status(500).json({ ok: false, error: 'Could not start checkout. Please try again.' });
  }
});

/* ---------------- billing portal: manage / cancel ---------------- */
router.post('/api/billing/portal', auth.requireAuth, async (req, res) => {
  try {
    const acct = await accountById(req.account.id);
    if (!acct || !acct.stripe_customer_id) return res.status(400).json({ ok: false, error: 'No billing account yet.' });
    const p = await stripe('billing_portal/sessions', { customer: acct.stripe_customer_id, return_url: `${SITE_URL}/account` });
    res.json({ ok: true, url: p.url });
  } catch (e) {
    console.error('[billing] portal:', e.message);
    res.status(500).json({ ok: false, error: 'Could not open billing.' });
  }
});

/* ---------------- status ---------------- */
router.get('/api/billing/status', auth.requireAuth, async (req, res) => {
  try {
    const a = await accountById(req.account.id);
    const trial = inTrial(a);
    res.json({ ok: true, status: (a && ACTIVE.has(a.subscription_status)) ? a.subscription_status : (trial ? 'trialing' : ((a && a.subscription_status) || 'none')),
      active: acctActive(a), trial,
      trialEndsAt: inTrial(a) ? new Date(trialEnd(a)).toISOString() : null,
      periodEnd: (a && a.subscription_period_end) || null,
      hasCustomer: !!(a && a.stripe_customer_id) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------------- verify-on-return + manual reconcile ----------------
   Belt-and-suspenders for activation: rather than trust the webhook alone,
   confirm the payment directly with Stripe the moment the buyer returns, and
   flip the account active immediately. A slow or missing webhook can then
   never lock a paying customer out. */
async function syncByCustomer(customerId) {
  const subs = await stripe('subscriptions?customer=' + enc(customerId) + '&status=all&limit=1', null, 'GET');
  const sub = subs && subs.data && subs.data[0];
  if (sub) await syncFromSubscription(sub);
  return sub;
}

router.get('/api/billing/return', async (req, res) => {
  const go = (p) => res.redirect(p);
  try {
    const u = auth.currentUser(req);
    const sid = String(req.query.session_id || '');
    if (!u) return go('/login?next=/dashboard');
    if (!sid || !STRIPE_KEY) return go('/dashboard?welcome=1');
    const session = await stripe('checkout/sessions/' + enc(sid), null, 'GET');
    const belongs = session && (session.client_reference_id === u.id || (session.metadata && session.metadata.account_id === u.id));
    if (session && session.customer && belongs) {
      await patchAccount(u.id, { stripe_customer_id: session.customer });
      if (session.subscription) {
        const sub = await stripe('subscriptions/' + session.subscription, null, 'GET');
        if (!(sub.metadata && sub.metadata.account_id)) sub.metadata = { account_id: u.id };
        await syncFromSubscription(sub);
      } else {
        await syncByCustomer(session.customer);
      }
    }
    if (await subscriptionActive(u.id)) return go('/dashboard?welcome=1');
    return go('/subscribe?pending=1');
  } catch (e) {
    console.error('[billing] return:', e.message);
    return go('/dashboard?welcome=1');
  }
});

// The subscribe page can call this to self-heal if the webhook is late.
router.post('/api/billing/sync', auth.requireAuth, async (req, res) => {
  try {
    const a = await accountById(req.account.id);
    if (a && a.stripe_customer_id) await syncByCustomer(a.stripe_customer_id);
    const b = await accountById(req.account.id);
    res.json({ ok: true, active: !!(b && ACTIVE.has(b.subscription_status)), status: (b && b.subscription_status) || 'none' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ---------------- webhook: keep Stripe → Supabase in sync ----------------
   Mounted with express.raw() in server.js so the raw body is available. */
function verifyStripeSig(rawBody, sigHeader) {
  if (!WEBHOOK_SECRET) return true; // dev fallback if not set
  const parts = Object.fromEntries(String(sigHeader || '').split(',').map((kv) => kv.split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(v1), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function syncFromSubscription(sub) {
  // find the account: metadata.account_id, else by customer id
  let acctId = sub.metadata && sub.metadata.account_id;
  if (!acctId && sub.customer) {
    const rows = await sb(`accounts?stripe_customer_id=eq.${enc(sub.customer)}&select=id&limit=1`);
    acctId = rows && rows[0] && rows[0].id;
  }
  if (!acctId) return;
  await patchAccount(acctId, {
    stripe_subscription_id: sub.id,
    subscription_status: sub.status,
    subscription_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
  });
}

async function handleWebhook(req, res) {
  const raw = req.body; // Buffer (from express.raw)
  if (!verifyStripeSig(raw, req.headers['stripe-signature'])) {
    return res.status(400).send('bad signature');
  }
  let event; try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).send('bad json'); }
  try {
    const o = event.data && event.data.object;
    switch (event.type) {
      case 'checkout.session.completed':
        if (o.mode === 'subscription' && o.subscription) {
          const sub = await stripe('subscriptions/' + o.subscription, null, 'GET');
          if (o.client_reference_id && !(sub.metadata && sub.metadata.account_id)) sub.metadata = { account_id: o.client_reference_id };
          await syncFromSubscription(sub);
        }
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await syncFromSubscription(o);
        break;
      case 'invoice.payment_failed':
        if (o.subscription) { const sub = await stripe('subscriptions/' + o.subscription, null, 'GET'); await syncFromSubscription(sub); }
        break;
      default: break;
    }
    res.json({ received: true });
  } catch (e) {
    console.error('[billing] webhook', event.type, e.message);
    res.status(500).send('handler error');
  }
}

router.inTrial = inTrial; router.acctActive = acctActive;
module.exports = { router, requireSubscription, subscriptionActive, accountById, handleWebhook, ACTIVE };
