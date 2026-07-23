/**
 * accounts.js — Tampa Bay Mahj: staff logins, Holly's profile card, student CRM.
 * Mounted from server.js with:  app.use(require('./accounts'));
 * No npm packages beyond express. Passwords hashed with Node's built-in scrypt.
 *
 * Env: SUPABASE_URL, SUPABASE_KEY (as elsewhere). Optional SESSION_SECRET.
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const router = express.Router();
const mail = require('./email');
const sms = require('./sms');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD || 'tbm-session-fallback-2026';
const COOKIE = 'tbm_session';
const SESSION_DAYS = 14;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[accounts] SUPABASE_URL / SUPABASE_KEY not set — account routes will error.');
}

router.use(express.json({ limit: '5mb' }));

/* ---------------- Supabase REST ---------------- */
async function sb(pathname, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(typeof data === 'string' ? data : (data && data.message) || `Supabase ${res.status}`);
  return data;
}
const enc = (v) => encodeURIComponent(v);
const clean = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'hollymahj@outlook.com';

// Fire-and-forget note to Holly (same FormSubmit path the booking side uses).
async function tellHolly(subject, fields, oid) {
  let to = NOTIFY_EMAIL;
  try { if (oid) { const rows = await sb(`settings?owner_id=eq.${enc(oid)}&select=notify_email&limit=1`); if (rows && rows[0] && rows[0].notify_email) to = rows[0].notify_email;
    else { const a = await sb(`accounts?id=eq.${enc(oid)}&select=email&limit=1`); if (a && a[0] && a[0].email) to = a[0].email; } } } catch (e) {}
  try { const r = await mail.ownerAlert(to, subject, fields); if (r && r.ok) return; } catch (e) {}
  fetch(`https://formsubmit.co/ajax/${encodeURIComponent(to)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ _subject: subject, ...fields }),
  }).catch((e) => console.error('[accounts] owner notify failed:', e.message));
}

/* ---------------- password hashing (scrypt) ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- signed session cookie ---------------- */
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verifyToken(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!p.exp || Date.now() > p.exp) return null;
  return p;
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('='); if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSession(res, account) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const oid = account.owner_id || account.id;
  const token = signToken({ id: account.id, oid, role: account.role, name: account.name, exp });
  res.set('Set-Cookie', `${COOKIE}=${enc(token)}; Max-Age=${SESSION_DAYS * 86400}; Path=/; HttpOnly; SameSite=Lax`);
}
function currentUser(req) { return verifyToken(parseCookies(req)[COOKIE]); }
function requireAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ ok: false, error: 'Please sign in.' });
  req.account = u; next();
}
function requireOwner(req, res, next) {
  if (!req.account || req.account.role !== 'owner') return res.status(403).json({ ok: false, error: 'Owner only.' });
  next();
}
async function accountCount() {
  const rows = await sb('accounts?select=id');
  return Array.isArray(rows) ? rows.length : 0;
}

/* ---------------- tenant scoping ---------------- */
// The studio (owner account) that a request belongs to. Owners map to
// themselves; staff carry their owner's id in the session token.
function ownerId(req) {
  const a = req.account || {};
  return a.oid || a.owner_id || a.id || null;
}
let _primaryOwner = { at: 0, id: null };
async function primaryOwnerId() {
  if (_primaryOwner.id && Date.now() - _primaryOwner.at < 300000) return _primaryOwner.id;
  const rows = await sb('accounts?role=eq.owner&select=id&order=created_at.asc&limit=1').catch(() => []);
  const id = (rows && rows[0] && rows[0].id) || null;
  if (id) _primaryOwner = { at: Date.now(), id };
  return id;
}
// For public routes with no session: a signed-in studio wins, else ?studio=slug,
// else the primary (first) studio so single-studio installs keep working.
async function resolveOwner(req) {
  const u = currentUser(req);
  if (u) return u.oid || u.id;
  const slug = (req.query && req.query.studio) ? String(req.query.studio).toLowerCase() : '';
  if (slug) {
    const rows = await sb(`accounts?slug=eq.${enc(slug)}&role=eq.owner&select=id&limit=1`).catch(() => []);
    if (rows && rows[0]) return rows[0].id;
  }
  return primaryOwnerId();
}
const oidF = (oid) => `owner_id=eq.${enc(oid)}`;
const _snCache = {};
async function studioName(oid) {
  if (!oid) return 'Charleston';
  if (_snCache[oid] && Date.now() - _snCache[oid].at < 300000) return _snCache[oid].v;
  try { const r = await sb(`settings?${oidF(oid)}&select=business_name&limit=1`); const v = (r && r[0] && r[0].business_name) || 'Charleston'; _snCache[oid] = { at: Date.now(), v }; return v; }
  catch (e) { return 'Charleston'; }
}
async function saveSettings(oid, patch) {
  const row = Object.assign({}, patch, { id: oid, owner_id: oid });
  await sb('settings?on_conflict=owner_id', { method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
}

/* ================= AUTH ================= */
router.get('/api/auth/state', async (req, res) => {
  try {
    const u = currentUser(req);
    let sub = 'none', active = false, exists = true;
    if (u) {
      try { const rows = await sb(`accounts?id=eq.${enc(u.id)}&select=subscription_status,slug,created_at,stripe_customer_id&limit=1`);
        if (rows && rows[0]) {
          const st = rows[0].subscription_status || 'none';
          const trial = (st === 'none') && rows[0].created_at
            && Date.now() < new Date(rows[0].created_at).getTime() + 14 * 86400000;
          active = st === 'active' || st === 'trialing' || !!trial;
          sub = (st === 'active' || st === 'trialing') ? st : (trial ? 'trialing' : st);
          u.slug = rows[0].slug || null;
        } else { exists = false; }
      } catch (e) {}
    }
    const authed = !!u && exists;
    res.json({ ok: true, authed, subscription: sub, subscribed: active,
      user: authed ? { id: u.id, role: u.role, name: u.name, slug: u.slug || null } : null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// First-run: create the first owner account (only allowed while zero accounts exist).
router.post('/api/auth/setup', async (req, res) => {
  try {
    if ((await accountCount()) > 0) return res.status(403).json({ ok: false, error: 'Setup already complete. Please sign in.' });
    const name = clean(req.body.name, 120), email = clean(req.body.email, 200).toLowerCase();
    const username = clean(req.body.username, 60).toLowerCase(), password = String(req.body.password || '');
    if (!name || !isEmail(email) || !username || password.length < 8)
      return res.status(400).json({ ok: false, error: 'Name, valid email, username, and an 8+ character password are required.' });
    const rows = await sb('accounts', { method: 'POST', body: JSON.stringify({
      name, email, username, role: 'owner', password_hash: hashPassword(password) }) });
    const acct = rows[0];
    if (!acct.owner_id) { await sb(`accounts?id=eq.${enc(acct.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ owner_id: acct.id }) }).catch(() => {}); acct.owner_id = acct.id; }
    setSession(res, acct);
    res.json({ ok: true, user: { id: acct.id, role: acct.role, name: acct.name } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/api/auth/login', async (req, res) => {
  try {
    const id = clean(req.body.identifier, 200).toLowerCase(), password = String(req.body.password || '');
    if (!id || !password) return res.status(400).json({ ok: false, error: 'Enter your login and password.' });
    const rows = await sb(`accounts?or=(email.eq.${enc(id)},username.eq.${enc(id)})&limit=1`);
    const acct = rows && rows[0];
    if (!acct || !acct.active || !verifyPassword(password, acct.password_hash))
      return res.status(401).json({ ok: false, error: 'Wrong login or password.' });
    setSession(res, acct);
    sb(`accounts?id=eq.${acct.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_login: new Date().toISOString() }) }).catch(() => {});
    res.json({ ok: true, user: { id: acct.id, role: acct.role, name: acct.name } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Change the signed-in user's password.
router.post('/api/auth/password', requireAuth, async (req, res) => {
  try {
    const cur = String(req.body.current || ''), nw = String(req.body.new || '');
    if (nw.length < 8) return res.status(400).json({ ok: false, error: 'New password must be at least 8 characters.' });
    const rows = await sb(`accounts?id=eq.${enc(req.account.id)}&limit=1`);
    const acct = rows && rows[0];
    if (!acct || !verifyPassword(cur, acct.password_hash)) return res.status(401).json({ ok: false, error: 'Current password is incorrect.' });
    await sb(`accounts?id=eq.${enc(acct.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ password_hash: hashPassword(nw) }) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Open self-serve sign-up: anyone can create their own studio account.
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'studio';
}
async function uniqueSlug(base) {
  let slug = slugify(base), n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rows = await sb(`accounts?slug=eq.${enc(slug)}&select=id&limit=1`).catch(() => []);
    if (!rows || !rows.length) return slug;
    slug = slugify(base) + '-' + (++n);
  }
}
router.post('/api/auth/register', async (req, res) => {
  try {
    const name = clean(req.body.name, 120), email = clean(req.body.email, 200).toLowerCase();
    const username = clean(req.body.username, 60).toLowerCase() || email.split('@')[0];
    const password = String(req.body.password || '');
    if (!name || !isEmail(email) || password.length < 8)
      return res.status(400).json({ ok: false, error: 'Your name, a valid email, and an 8+ character password are required.' });

    // email/username must be unused
    const dupe = await sb(`accounts?or=(email.eq.${enc(email)},username.eq.${enc(username)})&select=id&limit=1`);
    if (dupe && dupe.length) return res.status(409).json({ ok: false, error: 'An account with that email or username already exists. Try signing in.' });

    const slug = await uniqueSlug(name || username);
    const created = await sb('accounts', { method: 'POST', body: JSON.stringify({
      name, email, username, slug, role: 'owner',
      subscription_status: 'none', password_hash: hashPassword(password) }) });
    const acct = created[0];
    if (!acct.owner_id) { await sb(`accounts?id=eq.${enc(acct.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ owner_id: acct.id }) }).catch(() => {}); acct.owner_id = acct.id; }
    const refSlug = clean(req.body.ref, 60).toLowerCase();
    if (refSlug) { try { const rr = await sb(`accounts?slug=eq.${enc(refSlug)}&role=eq.owner&select=id&limit=1`); if (rr && rr[0] && rr[0].id !== acct.id) await sb(`accounts?id=eq.${enc(acct.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ referred_by: rr[0].id }) }); } catch (e) {} }
    setSession(res, acct);
    res.json({ ok: true, user: { id: acct.id, role: acct.role, name: acct.name }, next: '/dashboard?welcome=1' });
  } catch (e) {
    console.error('[accounts] register:', e.message);
    res.status(400).json({ ok: false, error: 'Could not create that account. Please try again.' });
  }
});

// Invite codes (owner generates; team can view).
router.get('/api/invites', requireAuth, async (req, res) => {
  try { res.json({ ok: true, invites: await sb(`invites?${oidF(ownerId(req))}&select=*&order=created_at.desc&limit=100`) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/invites', requireAuth, requireOwner, async (req, res) => {
  try {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const rows = await sb('invites', { method: 'POST', body: JSON.stringify({
      code, created_by: req.account.id, owner_id: ownerId(req), note: clean(req.body.note, 120) || null }) });
    res.json({ ok: true, invite: rows[0] });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

router.post('/api/auth/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
  res.json({ ok: true });
});

router.get('/api/referrals', requireAuth, async (req, res) => {
  try {
    const rows = await sb(`accounts?id=eq.${enc(req.account.id)}&select=slug&limit=1`);
    const slug = rows && rows[0] && rows[0].slug;
    const refs = await sb(`accounts?referred_by=eq.${enc(req.account.id)}&select=id`).catch(() => []);
    res.json({ ok: true, slug, count: (refs || []).length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/* ================= GOOGLE SIGN-IN =================
   One-click sign-in. When someone signs up with Google we also capture their
   Gmail as the studio's notification address, so event signups and inquiries
   go straight to their inbox. Needs GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET;
   until those are set the button stays hidden. */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT = (process.env.SITE_URL || 'https://charlestoncrm.com').replace(/\/$/, '') + '/api/auth/google/callback';
const googleConfigured = () => !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);

router.get('/api/auth/google/config', (req, res) => res.json({ enabled: googleConfigured() }));

router.get('/api/auth/google', (req, res) => {
  if (!googleConfigured()) return res.redirect('/login?error=google_unconfigured');
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT, response_type: 'code',
    scope: 'openid email profile', access_type: 'online', prompt: 'select_account',
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

router.get('/api/auth/google/callback', async (req, res) => {
  try {
    if (!googleConfigured()) return res.redirect('/login');
    const code = String(req.query.code || '');
    if (!code) return res.redirect('/login?error=google');
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_REDIRECT, grant_type: 'authorization_code' }),
    }).then((r) => r.json());
    if (!tok.access_token) return res.redirect('/login?error=google');
    const prof = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } }).then((r) => r.json());
    const email = (prof.email || '').toLowerCase();
    if (!email) return res.redirect('/login?error=google');
    let rows = await sb(`accounts?email=eq.${enc(email)}&limit=1`);
    let acct = rows && rows[0];
    let isNew = false;
    if (!acct) {
      isNew = true;
      const name = clean(prof.name, 120) || email.split('@')[0];
      const uname = (email.split('@')[0] || 'studio').toLowerCase();
      const slug = await uniqueSlug(name || uname);
      const created = await sb('accounts', { method: 'POST', body: JSON.stringify({
        name, email, username: uname, slug, role: 'owner', subscription_status: 'none',
        password_hash: 'google:' + crypto.randomBytes(18).toString('hex') }) });
      acct = created[0];
      if (!acct.owner_id) { await sb(`accounts?id=eq.${enc(acct.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ owner_id: acct.id }) }).catch(() => {}); acct.owner_id = acct.id; }
      // auto-route their studio's alerts to this Gmail
      await saveSettings(acct.id, { notify_email: email }).catch(() => {});
    }
    setSession(res, acct);
    const trialing = (!acct.subscription_status || acct.subscription_status === 'none')
      && acct.created_at && Date.now() < new Date(acct.created_at).getTime() + 14 * 86400000;
    const active = acct.subscription_status === 'active' || acct.subscription_status === 'trialing' || trialing;
    res.redirect(active ? '/dashboard?welcome=1' : '/subscribe');
  } catch (e) {
    console.error('[auth] google:', e.message);
    res.redirect('/login?error=google');
  }
});

/* ================= STAFF (owner manages) ================= */
router.get('/api/staff', requireAuth, async (req, res) => {
  try {
    const rows = await sb(`accounts?${oidF(ownerId(req))}&select=id,name,email,username,role,active,last_login,created_at&order=created_at.asc`);
    res.json({ ok: true, staff: rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/api/staff', requireAuth, requireOwner, async (req, res) => {
  try {
    const name = clean(req.body.name, 120), email = clean(req.body.email, 200).toLowerCase();
    const username = clean(req.body.username, 60).toLowerCase(), password = String(req.body.password || '');
    const role = req.body.role === 'owner' ? 'owner' : 'staff';
    if (!name || !isEmail(email) || !username || password.length < 8)
      return res.status(400).json({ ok: false, error: 'Name, valid email, username, and an 8+ character password are required.' });
    const rows = await sb('accounts', { method: 'POST', body: JSON.stringify({
      name, email, username, role, owner_id: ownerId(req), password_hash: hashPassword(password) }) });
    const a = rows[0];
    res.json({ ok: true, staff: { id: a.id, name: a.name, email: a.email, username: a.username, role: a.role } });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ================= PROFILE CARD ================= */
const PROFILE_FIELDS = ['display_name','tagline','bio','credentials','offerings','photo_url','email','phone','instagram','shopmy','website'];
router.get('/api/profile', async (req, res) => {
  try {
    const oid = await resolveOwner(req);
    const rows = await sb(`profile?${oidF(oid)}&limit=1`);
    res.json({ ok: true, profile: (rows && rows[0]) || { id: oid } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/api/profile', requireAuth, async (req, res) => {
  try {
    const patch = { updated_at: new Date().toISOString() };
    for (const f of PROFILE_FIELDS) if (f in req.body) patch[f] = clean(req.body[f], f === 'photo_url' ? 4000000 : 4000);
    if (Array.isArray(req.body.links)) patch.links = req.body.links.slice(0, 24)
      .map((l) => ({ label: clean(l && l.label, 60), icon: clean(l && l.icon, 24), url: clean(l && l.url, 600) }))
      .filter((l) => l.label && l.url);
    if (Array.isArray(req.body.details)) patch.details = req.body.details.slice(0, 24)
      .map((d) => ({ label: clean(d && d.label, 60), icon: clean(d && d.icon, 24), value: clean(d && d.value, 600) }))
      .filter((d) => d.label || d.value);
    const oid = ownerId(req); patch.id = oid; patch.owner_id = oid;
    await sb('profile?on_conflict=owner_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(patch) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ================= STUDENT CRM ================= */
const STU_FIELDS = ['first_name','last_name','email','phone','skill_level','tags','notes','birthday','source','status'];
function stuBody(b) {
  const o = {};
  for (const f of STU_FIELDS) if (f in b) o[f] = f === 'birthday' ? (clean(b[f], 20) || null) : clean(b[f], 4000);
  if (o.email) o.email = o.email.toLowerCase();
  return o;
}
router.get('/api/students', requireAuth, async (req, res) => {
  try {
    const q = clean(req.query.q, 100);
    const status = ['lead', 'student'].includes(req.query.status) ? req.query.status : '';
    let filters = 'select=*';
    if (q) {
      const like = `*${q}*`;
      filters += `&or=(first_name.ilike.${enc(like)},last_name.ilike.${enc(like)},email.ilike.${enc(like)},tags.ilike.${enc(like)})`;
    }
    if (status) filters += `&status=eq.${status}`;
    filters += `&${oidF(ownerId(req))}&archived=eq.false&order=updated_at.desc&limit=500`;
    res.json({ ok: true, students: await sb('students?' + filters) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// One-click CSV export of this studio's students + leads.
router.get('/api/students/export.csv', requireAuth, async (req, res) => {
  try {
    const rows = await sb(`students?select=first_name,last_name,email,phone,status,skill_level,tags,source,notes,birthday,created_at&${oidF(ownerId(req))}&archived=eq.false&order=created_at.desc&limit=5000`);
    const cols = ['first_name','last_name','email','phone','status','skill_level','tags','source','notes','birthday','created_at'];
    const esc = (v) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    let out = cols.join(',') + '\r\n';
    for (const r of (rows || [])) out += cols.map((c) => esc(r[c])).join(',') + '\r\n';
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="charleston-students.csv"');
    res.send(out);
  } catch (e) { res.status(500).send('Could not export.'); }
});
router.post('/api/students', requireAuth, async (req, res) => {
  try {
    const body = stuBody(req.body);
    if (!body.first_name) return res.status(400).json({ ok: false, error: 'First name is required.' });
    body.owner_id = ownerId(req);
    const rows = await sb('students', { method: 'POST', body: JSON.stringify(body) });
    res.json({ ok: true, student: rows[0] });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
router.get('/api/students/:id', requireAuth, async (req, res) => {
  try {
    const oid = ownerId(req);
    const rows = await sb(`students?id=eq.${enc(req.params.id)}&${oidF(oid)}&limit=1`);
    const student = rows && rows[0];
    if (!student) return res.status(404).json({ ok: false, error: 'Not found.' });
    let bookings = [], inquiries = [];
    if (student.email) {
      const em = enc(student.email);
      [bookings, inquiries] = await Promise.all([
        sb(`bookings?select=id,created_at,seats,status,slot_id&email=eq.${em}&${oidF(oid)}&order=created_at.desc`).catch(() => []),
        sb(`inquiries?select=id,submitted_at,event_type,event_date,status&email=eq.${em}&${oidF(oid)}&order=submitted_at.desc`).catch(() => []),
      ]);
    }
    res.json({ ok: true, student, history: { bookings, inquiries } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/api/students/:id', requireAuth, async (req, res) => {
  try {
    const body = stuBody(req.body); body.updated_at = new Date().toISOString();
    await sb(`students?id=eq.${enc(req.params.id)}&${oidF(ownerId(req))}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ================= STRIPE / SETTINGS ================= */
async function stripeGet(key, pathq) {
  const r = await fetch('https://api.stripe.com/v1/' + pathq, { headers: { Authorization: 'Bearer ' + key } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Stripe ' + r.status));
  return j;
}
async function getStripeKey(oid) {
  const rows = await sb(`settings?${oidF(oid)}&select=stripe_secret_key&limit=1`).catch(() => []);
  return (rows && rows[0] && rows[0].stripe_secret_key) || '';
}
// Any lead who shows up as a paid Stripe customer becomes a student. Lazy — runs on revenue fetch.
async function convertPaidLeads(emails, oid) {
  for (const em of emails) {
    if (!em) continue;
    try {
      await sb(`students?status=eq.lead&email=eq.${enc(em)}&${oidF(oid)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'student', updated_at: new Date().toISOString() }) });
    } catch (e) {}
  }
}

// Settings never leak the key back to the browser — only whether it's connected + a masked hint.
// One honest answer to "is this thing actually working?" — used by the dashboard checklist.
router.get('/api/health', requireAuth, async (req, res) => {
  try {
    const oid = ownerId(req);
    const rows = await sb(`settings?${oidF(oid)}&limit=1`).catch(() => []);
    const s = (rows && rows[0]) || {};
    const emailOn = await mail.configured();
    const stripeKey = s.stripe_secret_key || '';
    const twilioOn = !!(s.twilio_account_sid && s.twilio_auth_token && s.twilio_from);

    let events = 0;
    try {
      const up = await sb(`slots?select=id&published=eq.true&${oidF(oid)}&starts_at=gte.${new Date().toISOString()}`);
      events = (up || []).length;
    } catch (e) { /* non-fatal */ }

    res.json({ ok: true, checks: [
      { key: 'email', label: 'Email confirmations',
        state: emailOn ? 'on' : 'off',
        good: 'Guests get a confirmation the moment they book.',
        bad: 'Nobody is being emailed — not guests, not you. Nothing tells them their seat is real.',
        fix: '/settings', fixLabel: 'Set up email' },
      { key: 'stripe', label: 'Taking payments',
        state: stripeKey ? 'on' : 'off',
        good: 'Paid events can charge before the seat is held.',
        bad: 'Paid events cannot take money yet, so nobody can register for one.',
        fix: '/settings', fixLabel: 'Connect Stripe' },
      { key: 'texts', label: 'Text messages',
        state: twilioOn ? 'on' : 'idle',
        good: 'Guests get a text alongside their email.',
        bad: 'Optional — email still works on its own. Add Twilio when you want texts.',
        fix: '/settings', fixLabel: 'Set up texts' },
      { key: 'events', label: 'Something on the calendar',
        state: events > 0 ? 'on' : 'off',
        good: `${events} date${events === 1 ? '' : 's'} open for booking.`,
        bad: 'Your booking page is empty, so there is nothing for anyone to sign up for.',
        fix: '/schedule', fixLabel: 'Open a date' },
    ] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Public: the studio's own logo + name, shown on every page. No auth — it's
// the same branding a visitor sees on the booking page anyway.
let _brandCache = {};
router.get('/api/branding', async (req, res) => {
  try {
    const oid = await resolveOwner(req);
    const hit = _brandCache[oid];
    if (hit && Date.now() - hit.at < 20000) return res.json(hit.val);
    const rows = await sb(`settings?${oidF(oid)}&select=business_logo,business_name&limit=1`).catch(() => []);
    const s = (rows && rows[0]) || {};
    const val = { logo: s.business_logo || '', name: s.business_name || '' };
    _brandCache[oid] = { at: Date.now(), val };
    res.json(val);
  } catch (e) { res.json({ logo: '', name: '' }); }
});

router.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const rows = await sb(`settings?${oidF(ownerId(req))}&limit=1`);
    const s = (rows && rows[0]) || {};
    const k = s.stripe_secret_key || '';
    const proto = req.get('x-forwarded-proto') || 'https';
    const base = proto + '://' + req.get('host');
    res.json({ ok: true,
      businessName: s.business_name || '',
      businessLogo: s.business_logo || '',
      remindersEnabled: s.reminders_enabled !== false,
      reminderHours: s.reminder_hours || 24,
      notifyEmail: s.notify_email || '',
      notifyDefault: process.env.NOTIFY_EMAIL || 'hollymahj@outlook.com',
      emailConfigured: await mail.configured(),
      resendHint: s.resend_api_key ? ('•••• ' + String(s.resend_api_key).slice(-4)) : '',
      emailFrom: process.env.FROM_EMAIL || s.from_email || '',
      stripeConnected: !!k, stripeHint: k ? ('•••• ' + k.slice(-4)) : '', mode: k.startsWith('rk_') ? 'restricted' : (k.startsWith('sk_') ? 'secret' : ''),
      twilioConnected: !!(s.twilio_account_sid && s.twilio_auth_token && s.twilio_from), twilioFrom: s.twilio_from || '',
      twilioSidHint: s.twilio_account_sid ? ('•••• ' + String(s.twilio_account_sid).slice(-4)) : '',
      calendarUrl: s.calendar_token ? (base + '/api/cal/' + s.calendar_token + '.ics') : '',
      googleConnected: !!(s.google_client_id && s.google_client_secret), googleClientId: s.google_client_id || '',
      msConnected: !!(s.ms_client_id && s.ms_client_secret), msClientId: s.ms_client_id || '', msTenant: s.ms_tenant || '' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/api/settings', requireAuth, requireOwner, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = { updated_at: new Date().toISOString() };
    if ('business_name' in b) patch.business_name = clean(b.business_name, 120) || null;
    if ('business_logo' in b) {
      const v = String(b.business_logo || '');
      if (v && v.length > 4000000) return res.status(400).json({ error: 'That image is too large — try a smaller one.' });
      if (v && !/^data:image\//.test(v)) return res.status(400).json({ error: 'That does not look like an image.' });
      patch.business_logo = v || null;
    }
    if ('resend_api_key' in b) {
      const key = clean(b.resend_api_key, 220);
      if (key && !/^re_/.test(key)) return res.status(400).json({ error: 'A Resend API key starts with re_' });
      patch.resend_api_key = key || null;
    }
    if ('from_email' in b) {
      const v = clean(b.from_email, 200);
      if (v && !/<[^\s@]+@[^\s@]+\.[^\s@]+>|^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        return res.status(400).json({ error: 'Use an address like you@yourdomain.com, or Name <you@yourdomain.com>' });
      }
      patch.from_email = v || null;
    }
    if ('notify_email' in b) {
      const v = clean(b.notify_email, 160);
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
        return res.status(400).json({ error: 'That email address does not look right.' });
      }
      patch.notify_email = v || null;
    }
    if ('stripe_secret_key' in b) {
      const key = clean(b.stripe_secret_key, 220);
      if (key && !/^(sk|rk)_/.test(key)) return res.status(400).json({ ok: false, error: 'Stripe key should start with sk_ or rk_.' });
      patch.stripe_secret_key = key || null;
    }
    ['twilio_account_sid','twilio_auth_token','twilio_from','google_client_id','google_client_secret','ms_client_id','ms_client_secret','ms_tenant'].forEach(function(f){
      if (f in b) patch[f] = clean(b[f], 300) || null;
    });
    if ('reminder_hours' in b) { const h = parseInt(b.reminder_hours, 10); patch.reminder_hours = (h > 0 ? Math.min(168, h) : 24); }
    if ('reminders_enabled' in b) patch.reminders_enabled = !!b.reminders_enabled;
    await saveSettings(ownerId(req), patch);
    mail.clearCache(); _brandCache = {};
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Validate Twilio creds (no message sent).
router.post('/api/settings/twilio/test', requireAuth, async (req, res) => {
  try {
    const rows = await sb(`settings?${oidF(ownerId(req))}&select=twilio_account_sid,twilio_auth_token&limit=1`);
    const s = rows && rows[0];
    if (!s || !s.twilio_account_sid || !s.twilio_auth_token) return res.json({ ok: false, error: 'Twilio not saved yet.' });
    const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + s.twilio_account_sid + '.json',
      { headers: { Authorization: 'Basic ' + Buffer.from(s.twilio_account_sid + ':' + s.twilio_auth_token).toString('base64') } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.json({ ok: false, error: j.message || ('Twilio ' + r.status) });
    res.json({ ok: true, status: j.status });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Public, token-gated ICS calendar feed — subscribe in Google/Apple/Outlook.
router.get('/api/cal/:file', async (req, res) => {
  try {
    const token = String(req.params.file || '').replace(/\.ics$/, '');
    const rows = await sb(`settings?calendar_token=eq.${enc(token)}&select=owner_id&limit=1`);
    const owner = rows && rows[0] && rows[0].owner_id;
    if (!owner) return res.status(404).send('Not found');
    const slots = await sb(`slots?select=*&published=eq.true&${oidF(owner)}&order=starts_at.asc&limit=800`).catch(() => []);
    const LBL = { private_lesson: 'Private lesson', group_class: 'Group class', private_party: 'Private party' };
    const pad = (n) => String(n).padStart(2, '0');
    const z = (d) => { const x = new Date(d); return x.getUTCFullYear() + pad(x.getUTCMonth()+1) + pad(x.getUTCDate()) + 'T' + pad(x.getUTCHours()) + pad(x.getUTCMinutes()) + '00Z'; };
    const esc = (v) => String(v || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
    let ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Charleston//EN\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:Charleston\r\n';
    (slots || []).forEach((sl) => {
      const end = new Date(new Date(sl.starts_at).getTime() + (sl.duration_minutes || 120) * 60000);
      ics += 'BEGIN:VEVENT\r\nUID:' + sl.id + '@tampabaymahj\r\nDTSTAMP:' + z(new Date()) + '\r\nDTSTART:' + z(sl.starts_at) + '\r\nDTEND:' + z(end) + '\r\n';
      ics += 'SUMMARY:' + esc((sl.title || LBL[sl.slot_type] || 'Mahjong') + ' (' + (sl.seats_taken||0) + '/' + (sl.seats_total||0) + ')') + '\r\n';
      if (sl.location) ics += 'LOCATION:' + esc(sl.location) + '\r\n';
      if (sl.notes) ics += 'DESCRIPTION:' + esc(sl.notes) + '\r\n';
      ics += 'END:VEVENT\r\n';
    });
    ics += 'END:VCALENDAR\r\n';
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.send(ics);
  } catch (e) { res.status(500).send('error'); }
});
// Sends a real email to the alert address so Holly can confirm delivery end to end.
router.post('/api/settings/email/test', requireAuth, async (req, res) => {
  try {
    const rows = await sb(`settings?${oidF(ownerId(req))}&select=notify_email&limit=1`).catch(() => []);
    const to = (rows && rows[0] && rows[0].notify_email) || process.env.NOTIFY_EMAIL || 'hollymahj@outlook.com';
    const out = await mail.ownerAlert(to, 'Test email from Charleston', {
      Status: 'Email delivery is working.',
      'Sent to': to,
      When: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }),
    });
    if (out && out.ok) return res.json({ ok: true, to });
    if (out && out.skipped) return res.status(400).json({ ok: false, error: out.reason });
    return res.status(400).json({ ok: false, error: (out && out.error) || 'Could not send.' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/api/settings/stripe/test', requireAuth, async (req, res) => {
  try {
    const key = await getStripeKey(ownerId(req));
    if (!key) return res.json({ ok: false, error: 'No key saved yet.' });
    const bal = await stripeGet(key, 'balance');
    res.json({ ok: true, livemode: !!bal.livemode });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Revenue for the dashboard, computed from Stripe charges (best-effort, recent pages).
router.get('/api/revenue', requireAuth, async (req, res) => {
  try {
    const oid = ownerId(req);
    const key = await getStripeKey(oid);
    if (!key) return res.json({ ok: true, connected: false });
    let charges = [], after = null, pages = 0, more = true;
    while (more && pages < 4) {
      const j = await stripeGet(key, 'charges?limit=100' + (after ? '&starting_after=' + after : ''));
      const data = j.data || [];
      charges = charges.concat(data);
      more = !!j.has_more && data.length > 0;
      after = data.length ? data[data.length - 1].id : null;
      pages++;
    }
    const now = new Date();
    const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
    let all = 0, month = 0, count = 0, cur = 'usd';
    const emails = new Set();
    charges.forEach((c) => {
      if (c.paid && !c.refunded) {
        all += c.amount; count++;
        if (c.created >= monthStart) month += c.amount;
        cur = c.currency || cur;
        const em = (c.receipt_email || (c.billing_details && c.billing_details.email) || '').toLowerCase();
        if (em) emails.add(em);
      }
    });
    convertPaidLeads(Array.from(emails), oid).catch(() => {});
    res.json({ ok: true, connected: true, currency: cur, month: month / 100, all: all / 100, count, truncated: more });
  } catch (e) { res.json({ ok: true, connected: true, error: e.message }); }
});

/* ================= LEAD CAPTURE (public) ================= */
// A prospect asks for a lesson from Holly's card. Lands in the CRM as a lead.
router.post('/api/lead', async (req, res) => {
  try {
    const oid = await resolveOwner(req);
    const brandName = await studioName(oid); mail.setBrand(brandName);
    const first = clean(req.body.first_name, 120);
    const last = clean(req.body.last_name, 120);
    const email = clean(req.body.email, 200).toLowerCase();
    const phone = clean(req.body.phone, 50);
    const message = clean(req.body.message, 2000);
    if (!first || (!email && !phone)) {
      return res.status(400).json({ ok: false, error: 'Please share your name and a way to reach you.' });
    }
    // Don't duplicate someone we already know.
    let existing = [];
    if (email) existing = await sb(`students?select=id&email=eq.${enc(email)}&${oidF(oid)}&limit=1`).catch(() => []);
    if (existing && existing[0]) {
      await sb(`students?id=eq.${existing[0].id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ updated_at: new Date().toISOString() }) }).catch(() => {});
      tellHolly(`Lesson request (returning): ${first} ${last}`.trim(), { Name: `${first} ${last}`.trim(), Email: email || '-', Phone: phone || '-', Message: message || '-' }, oid);
      return res.json({ ok: true, existing: true });
    }
    await sb('students', { method: 'POST', body: JSON.stringify({
      first_name: first, last_name: last, email, phone, owner_id: oid,
      status: 'lead', tags: 'lead', source: 'lesson request',
      notes: message ? ('Lesson request: ' + message) : 'Lesson request',
    }) });
    tellHolly(`New lesson request: ${first} ${last}`.trim(), { Name: `${first} ${last}`.trim(), Email: email || '-', Phone: phone || '-', Message: message || '-' }, oid);
    if (email) mail.send({ to: email, subject: 'Thanks for reaching out — ' + brandName,
      html: '<div style="font-family:Georgia,serif;color:#2C3327;max-width:460px"><h2 style="color:#3B4832">Thank you, ' + (first || 'friend') + '!</h2><p>We have your mahjong lesson request and will be in touch soon to set up your first game.</p><p style="color:#8A6D14">— ' + brandName + '</p></div>' }).catch(() => {});
    if (phone) sms.sendSMS(phone, 'Hi ' + (first || '') + '! Thanks for your ' + brandName + ' lesson request — we will reach out soon. \u2014 ' + brandName + '').catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Archive (soft-remove) or restore a student/lead.
router.post('/api/students/:id/archive', requireAuth, async (req, res) => {
  try {
    const archived = req.body.archived !== false;
    await sb(`students?id=eq.${enc(req.params.id)}&${oidF(ownerId(req))}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ archived, updated_at: new Date().toISOString() }) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Turn a lead into a student. Called manually now; the Stripe payment
// handler will call this automatically once a lesson is actually paid.
router.post('/api/students/:id/convert', requireAuth, async (req, res) => {
  try {
    await sb(`students?id=eq.${enc(req.params.id)}&${oidF(ownerId(req))}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'student', updated_at: new Date().toISOString() }) });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

// Public inquiry-form config (homepage reads this).
// Holly can paste CSS (e.g. generated by Claude) to restyle her inquiry page.
// Only signed-in admins can set it, but strip anything executable anyway — this
// lands on a public page, so a stolen session shouldn't become stored XSS.
function sanitizeCSS(raw) {
  let c = String(raw || '').slice(0, 20000);
  c = c.replace(/<\s*\/?\s*(style|script)[^>]*>/gi, '');  // no breaking out of the tag
  c = c.replace(/javascript\s*:/gi, '').replace(/expression\s*\(/gi, '');
  c = c.replace(/@import[^;]*;?/gi, '');                   // no remote stylesheets
  c = c.replace(/behavior\s*:/gi, '');
  return c;
}

router.get('/api/inquiry-config', async (req, res) => {
  try { const oid = await resolveOwner(req); const rows = await sb(`settings?${oidF(oid)}&select=inquiry_config&limit=1`);
    res.json({ ok: true, config: (rows && rows[0] && rows[0].inquiry_config) || {} });
  } catch (e) { res.json({ ok: true, config: {} }); }
});
router.put('/api/inquiry-config', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const cfg = {
      heading: clean(b.heading, 120), script: clean(b.script, 120), tagline: clean(b.tagline, 200),
      submit_label: clean(b.submit_label, 60), submit_note: clean(b.submit_note, 300),
      event_types: Array.isArray(b.event_types) ? b.event_types.slice(0, 40).map((t) => clean(t, 80)).filter(Boolean) : [],
      custom_css: sanitizeCSS(b.custom_css),
      presets: Array.isArray(b.presets) ? b.presets.slice(0, 24).map((p) => ({
        id: clean(p && p.id, 40) || String(Date.now()) + Math.random().toString(36).slice(2, 6),
        name: clean(p && p.name, 60) || 'Untitled look',
        css: sanitizeCSS(p && p.css),
      })) : [],
    };
    await saveSettings(ownerId(req), { inquiry_config: cfg, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

/* ================= PAGES ================= */
const page = (f) => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
router.get('/login',    page('login.html'));
router.get('/profile',  page('profile.html'));
router.get('/students', page('students.html'));
router.get('/inquiries', page('inquiries.html'));
router.get('/card',     page('card.html'));
router.get('/settings', page('settings.html'));
// Forgot password. Tokens are signed rather than stored, so no migration is needed:
// the account's current password hash is part of the signature, which makes a token
// self-invalidating the moment the password changes.
function resetToken(acct) {
  const exp = Date.now() + 3600000;
  const body = `${acct.id}.${exp}`;
  const sig = crypto.createHmac('sha256', SECRET + String(acct.password_hash || '')).update(body).digest('hex');
  return `${body}.${sig}`;
}
function checkResetToken(token, acct) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  const [id, exp, sig] = parts;
  if (id !== acct.id) return false;
  if (Date.now() > Number(exp)) return false;
  const want = crypto.createHmac('sha256', SECRET + String(acct.password_hash || '')).update(`${id}.${exp}`).digest('hex');
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

router.post('/api/auth/forgot', async (req, res) => {
  const email = clean((req.body || {}).email, 160).toLowerCase();
  // Always the same answer, so this cannot be used to discover who has an account.
  const same = { ok: true, message: 'If that address has an account, a reset link is on its way.' };
  try {
    if (!email) return res.json(same);
    const rows = await sb(`accounts?select=*&email=eq.${encodeURIComponent(email)}&limit=1`);
    const acct = rows && rows[0];
    if (!acct) return res.json(same);
    const link = `${SITE_URL}/login?reset=${encodeURIComponent(resetToken(acct))}&who=${encodeURIComponent(acct.id)}`;
    const out = await mail.ownerAlert(acct.email, 'Reset your Charleston password', {
      'Reset link': link,
      'Good for': 'One hour, once.',
      'Not you?': 'Ignore this and nothing changes.',
    });
    if (!out || !out.ok) console.error('[auth] reset email not sent to', email, out && (out.reason || out.error));
    return res.json(same);
  } catch (e) { console.error('[auth] forgot:', e.message); return res.json(same); }
});

router.post('/api/auth/reset', async (req, res) => {
  const stale = { ok: false, error: 'That reset link has expired or already been used. Ask for a new one.' };
  try {
    const b = req.body || {};
    const who = clean(b.who, 60);
    // Never let a malformed id reach the database — it answers with its own error text.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(who)) {
      return res.status(400).json(stale);
    }
    const rows = await sb(`accounts?select=*&id=eq.${encodeURIComponent(who)}&limit=1`).catch(() => []);
    const acct = rows && rows[0];
    if (!acct || !checkResetToken(b.token, acct)) return res.status(400).json(stale);
    if (!b.password || String(b.password).length < 8) {
      return res.status(400).json({ ok: false, error: 'Pick a password of at least 8 characters.' });
    }
    await sb(`accounts?id=eq.${acct.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ password_hash: hashPassword(String(b.password)) }),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth] reset:', e.message);
    res.status(400).json(stale);
  }
});

/* ================= OWNER / SUPER-ADMIN CONSOLE =================
   Private to the SaaS operator (is_superadmin). Shows every studio, MRR,
   trials and churn. Distinct from the per-studio /api/admin/* scheduling
   routes, which are for individual studio owners. */
async function isSuperadmin(req) {
  if (!req.account) return false;
  try {
    const rows = await sb(`accounts?id=eq.${enc(req.account.id)}&select=is_superadmin&limit=1`);
    return !!(rows && rows[0] && rows[0].is_superadmin);
  } catch (e) { return false; }
}
async function requireSuperadmin(req, res, next) {
  const wantsHtml = (req.headers.accept || '').includes('text/html');
  const u = currentUser(req);
  if (!u) return wantsHtml ? res.redirect('/login?next=/hq') : res.status(401).json({ ok: false, error: 'Please sign in.' });
  req.account = u;
  if (!(await isSuperadmin(req))) return wantsHtml ? res.status(403).send('Not authorized.') : res.status(403).json({ ok: false, error: 'Not authorized.' });
  next();
}

router.get('/hq', requireSuperadmin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'hq.html')));

// Public: the testimonial photo (stored in app_config), if imported.
router.get('/api/testimonial-photo', async (req, res) => {
  try {
    const rows = await sb(`app_config?key=eq.testimonial_photo&select=value&limit=1`).catch(() => []);
    res.json({ photo: (rows && rows[0] && rows[0].value) || '' });
  } catch (e) { res.json({ photo: '' }); }
});

// Superadmin: pull Holly's headshot from her Tampa Bay Mahj profile (server-side,
// so no CORS and no need to move the image bytes by hand) and cache it.
router.post('/api/hq/import-holly-photo', requireSuperadmin, async (req, res) => {
  try {
    const r = await fetch('https://tampa-bay-mahj.onrender.com/api/profile').then((x) => x.json());
    const photo = (r && (r.profile || r) && (r.profile || r).photo_url) || '';
    if (!photo || photo.indexOf('data:image') !== 0) return res.status(404).json({ ok: false, error: 'No photo found on the source profile.' });
    await sb('app_config?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: 'testimonial_photo', value: photo, updated_at: new Date().toISOString() }) });
    res.json({ ok: true, bytes: photo.length });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/api/hq/overview', requireSuperadmin, async (req, res) => {
  try {
    const PRICE = 9.99;
    const owners = await sb('accounts?role=eq.owner&select=id,name,email,slug,subscription_status,subscription_period_end,created_at&order=created_at.desc');
    const [students, slots] = await Promise.all([
      sb('students?select=owner_id').catch(() => []),
      sb('slots?select=owner_id').catch(() => []),
    ]);
    const tally = (arr) => { const m = {}; (arr || []).forEach((x) => { if (x.owner_id) m[x.owner_id] = (m[x.owner_id] || 0) + 1; }); return m; };
    const stu = tally(students), slt = tally(slots);
    let active = 0, trialing = 0, past_due = 0, canceled = 0, none = 0, new30 = 0;
    const d30 = Date.now() - 30 * 864e5;
    const studios = (owners || []).map((o) => {
      const st = o.subscription_status || 'none';
      if (st === 'active') active++; else if (st === 'trialing') trialing++;
      else if (st === 'past_due') past_due++; else if (st === 'canceled' || st === 'cancelled') canceled++; else none++;
      if (o.created_at && new Date(o.created_at).getTime() >= d30) new30++;
      return { name: o.name, email: o.email, slug: o.slug, status: st, since: o.created_at,
        renews: o.subscription_period_end, students: stu[o.id] || 0, events: slt[o.id] || 0 };
    });
    res.json({ ok: true, metrics: {
      studios: (owners || []).length, active, trialing, past_due, canceled, none,
      mrr: +(active * PRICE).toFixed(2), arr: +(active * PRICE * 12).toFixed(2),
      trialPipeline: +(trialing * PRICE).toFixed(2), newLast30: new30, price: PRICE,
    }, studios });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/request',  (req, res) => res.redirect('/'));

module.exports = router;
