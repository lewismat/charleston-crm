/**
 * Charleston — Event Inquiry App
 * Zero-dependency Node.js server.
 *
 * Storage: Supabase (if SUPABASE_URL + SUPABASE_KEY env vars set), else local JSON file.
 * Email:   new inquiries are emailed to NOTIFY_EMAIL via formsubmit.co
 *
 * Run:   node server.js
 * Form:      http://localhost:3000
 * Dashboard: http://localhost:3000/dashboard
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
const USE_SB = !!(SB_URL && SB_KEY);
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'hollymahj@outlook.com';

// ---------- local JSON fallback ----------
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { inquiries: [], visits: [] }; }
}
function saveDB(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let localdb = USE_SB ? null : loadDB();

// ---------- Supabase REST helpers ----------
async function sb(method, pathq, body) {
  const r = await fetch(SB_URL + '/rest/v1/' + pathq, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json',
      Prefer: method === 'POST' ? 'return=representation' : 'return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error('supabase ' + r.status + ': ' + (await r.text()));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const camel = (o) => {
  const m = {}; for (const k in o) m[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = o[k]; return m;
};

// ---------- storage layer ----------
const store = {
  async addVisit(v) {
    if (USE_SB) {
      await sb('POST', 'visits', {
        visitor_id: v.visitorId, time: v.time, page: v.page, referrer: v.referrer,
        user_agent: v.userAgent, ip: v.ip, screen: v.screen, owner_id: v.ownerId || null,
      });
    } else { localdb.visits.push(v); saveDB(localdb); }
  },
  async addInquiry(q) {
    if (USE_SB) {
      const rows = await sb('POST', 'inquiries', {
        submitted_at: q.submittedAt, visitor_id: q.visitorId, ip: q.ip,
        first_name: q.firstName, last_name: q.lastName, email: q.email, phone: q.phone,
        event_type: q.eventType, event_date: q.eventDate, start_time: q.startTime,
        location_name: q.locationName, street_address: q.streetAddress,
        city: q.city, state: q.state, zip: q.zip,
        about_event: q.aboutEvent, guest_count: q.guestCount, anything_else: q.anythingElse,
        status: q.status, owner_id: q.ownerId || null,
      });
      return rows && rows[0] ? rows[0].id : q.id;
    }
    localdb.inquiries.unshift(q); saveDB(localdb); return q.id;
  },
  async getAll(oid) {
    if (USE_SB) {
      const f = oid ? '&owner_id=eq.' + encodeURIComponent(oid) : '';
      const [inq, vis] = await Promise.all([
        sb('GET', 'inquiries?select=*' + f + '&order=submitted_at.desc&limit=1000'),
        sb('GET', 'visits?select=*' + f + '&order=time.desc&limit=500'),
      ]);
      return { inquiries: inq.map(camel), visits: vis.map(camel) };
    }
    return { inquiries: localdb.inquiries, visits: localdb.visits.slice(-500).reverse() };
  },
  async setStatus(id, status, oid) {
    if (USE_SB) { await sb('PATCH', 'inquiries?id=eq.' + encodeURIComponent(id) + (oid ? '&owner_id=eq.' + encodeURIComponent(oid) : ''), { status }); return true; }
    const q = localdb.inquiries.find((x) => x.id === id);
    if (!q) return false;
    q.status = status; saveDB(localdb); return true;
  },
};

// ---------- inquiries also become CRM leads ----------
async function createLeadFromInquiry(q) {
  if (!USE_SB) return;
  try {
    const email = (q.email || '').toLowerCase();
    if (email) {
      const ex = await sb('GET', 'students?select=id&email=eq.' + encodeURIComponent(email) + (q.ownerId ? '&owner_id=eq.' + encodeURIComponent(q.ownerId) : '') + '&limit=1');
      if (ex && ex[0]) return; // already known
    }
    await sb('POST', 'students', {
      owner_id: q.ownerId || null,
      first_name: q.firstName, last_name: q.lastName, email, phone: q.phone,
      status: 'lead', tags: 'inquiry form', source: 'website inquiry',
      notes: 'Asked about: ' + (q.eventType || 'a lesson') +
             (q.eventDate ? ' on ' + q.eventDate : '') +
             (q.guestCount ? ' · ' + q.guestCount + ' guests' : '') +
             (q.aboutEvent ? ' — "' + String(q.aboutEvent).slice(0, 300) + '"' : ''),
    });
  } catch (e) {
    // Loud on purpose: a lost lead is a lost customer.
    console.error('[LEAD NOT CREATED] inquiry from', q.email, '->', e.message);
  }
}

// ---------- email notification (fire and forget) ----------
async function ownerNotifyEmail(oid) {
  if (!USE_SB || !oid) return NOTIFY_EMAIL;
  try {
    const rows = await sb('GET', 'settings?owner_id=eq.' + encodeURIComponent(oid) + '&select=notify_email&limit=1');
    if (rows && rows[0] && rows[0].notify_email) return rows[0].notify_email;
    const a = await sb('GET', 'accounts?id=eq.' + encodeURIComponent(oid) + '&select=email&limit=1');
    if (a && a[0] && a[0].email) return a[0].email;
  } catch (e) {}
  return NOTIFY_EMAIL;
}
async function notifyEmail(q) {
  const to = await ownerNotifyEmail(q.ownerId);
  const payload = {
    _subject: 'New Mahj Inquiry: ' + q.firstName + ' ' + q.lastName + ' - ' + q.eventType + ' on ' + q.eventDate,
    _template: 'table',
    Name: q.firstName + ' ' + q.lastName,
    Email: q.email,
    Phone: q.phone,
    'Event Type': q.eventType,
    'Event Date': q.eventDate,
    'Start Time': q.startTime || '-',
    'Guests Expected': q.guestCount || '-',
    Location: q.locationName || '-',
    Address: [q.streetAddress, q.city, q.state, q.zip].filter(Boolean).join(', ') || '-',
    'About The Event': q.aboutEvent || '-',
    'Anything Else': q.anythingElse || '-',
  };
  fetch('https://formsubmit.co/ajax/' + encodeURIComponent(to), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  }).then(async (r) => {
    const t = await r.text();
    console.log('email notify:', r.status, t.slice(0, 200));
  }).catch((e) => console.error('email notify failed:', e.message));
}

// ---------- helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css',
  '.js': 'application/javascript', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
function send(res, status, body, headers = {}) { res.writeHead(status, headers); res.end(body); }
function sendJSON(res, status, obj) { send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' }); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function getIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function clean(v, max = 2000) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

// ---------- dashboard auth ----------
const DASH_PASS = process.env.DASHBOARD_PASSWORD || 'EastWind88';
const AUTH_TOKEN = crypto.createHash('sha256').update('tbm-salt-2026|' + DASH_PASS).digest('hex');
function isAuthed(req) { return parseCookies(req).tbm_auth === AUTH_TOKEN; }

// ---------- Express app ----------
const express = require('express');
const app = express();
const auth = require('./auth');
const billing = require('./billing');

// ---------- tenant scoping ----------
function ownerId(req) { const a = req.account || {}; return a.oid || a.owner_id || a.id || null; }
let _primaryOwner = { at: 0, id: null };
async function primaryOwnerId() {
  if (!USE_SB) return null;
  if (_primaryOwner.id && Date.now() - _primaryOwner.at < 300000) return _primaryOwner.id;
  try {
    const rows = await sb('GET', 'accounts?role=eq.owner&select=id&order=created_at.asc&limit=1');
    const id = (rows && rows[0] && rows[0].id) || null;
    if (id) _primaryOwner = { at: Date.now(), id };
    return id;
  } catch { return null; }
}
async function resolveOwner(req) {
  const u = auth.currentUser(req);
  if (u) return u.oid || u.id;
  const slug = req.query && req.query.studio ? String(req.query.studio).toLowerCase() : '';
  if (slug) {
    try {
      const rows = await sb('GET', 'accounts?role=eq.owner&slug=eq.' + encodeURIComponent(slug) + '&select=id&limit=1');
      if (rows && rows[0]) return rows[0].id;
    } catch {}
  }
  return primaryOwnerId();
}

// Stripe webhook needs the RAW body for signature verification — register it
// before any body parsing or static handling.
app.post('/api/stripe/webhook', express.raw({ type: '*/*' }), billing.handleWebhook);

// Paywall gate: admin CRM pages require sign-in AND an active subscription.
const GATED_PAGES = [
  '/dashboard','/dashboard.html','/students','/students.html','/schedule','/schedule.html',
  '/inquiries','/inquiries.html','/profile','/profile.html','/settings','/settings.html','/card','/card.html','/announce','/announce.html','/invoices','/invoices.html',
];
app.get(GATED_PAGES, async (req, res, next) => {
  const u = auth.currentUser(req);
  if (!u) return res.redirect('/login?next=' + encodeURIComponent(req.path));
  let acct = null;
  try { acct = await billing.accountById(u.id); } catch (e) { req.account = u; return next(); }
  if (!acct) { res.set('Set-Cookie', 'tbm_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax'); return res.redirect('/login'); }
  if (!billing.acctActive(acct)) return res.redirect('/subscribe');
  req.account = u; next();
});

// record a visit
app.post('/api/track', async (req, res) => {
  try {
    const body = JSON.parse((await readBody(req)) || '{}');
    const cookies = parseCookies(req);
    let visitorId = cookies.tbm_vid;
    const isNew = !visitorId;
    if (!visitorId) visitorId = crypto.randomUUID();

    const oid = await resolveOwner(req);
    await store.addVisit({
      id: crypto.randomUUID(),
      ownerId: oid,
      visitorId,
      time: new Date().toISOString(),
      page: clean(body.page, 100) || '/',
      referrer: clean(body.referrer, 300),
      userAgent: clean(req.headers['user-agent'] || '', 300),
      ip: getIP(req),
      screen: clean(body.screen, 30),
    });

    const headers = { 'Content-Type': 'application/json' };
    if (isNew) headers['Set-Cookie'] = 'tbm_vid=' + visitorId + '; Max-Age=31536000; Path=/; SameSite=Lax';
    send(res, 200, JSON.stringify({ ok: true }), headers);
  } catch (e) { console.error('track:', e.message); sendJSON(res, 400, { ok: false }); }
});

// submit inquiry
app.post('/api/inquiries', async (req, res) => {
  try {
    const b = JSON.parse((await readBody(req)) || '{}');
    const required = ['firstName', 'lastName', 'email', 'phone', 'eventType', 'eventDate'];
    for (const f of required) {
      if (!clean(b[f])) return sendJSON(res, 400, { ok: false, error: 'Missing field: ' + f });
    }
    const cookies = parseCookies(req);
    const inquiry = {
      id: crypto.randomUUID(),
      submittedAt: new Date().toISOString(),
      visitorId: cookies.tbm_vid || null,
      ip: getIP(req),
      firstName: clean(b.firstName, 100),
      lastName: clean(b.lastName, 100),
      email: clean(b.email, 200),
      phone: clean(b.phone, 50),
      eventType: clean(b.eventType, 100),
      eventDate: clean(b.eventDate, 30),
      startTime: clean(b.startTime, 30),
      locationName: clean(b.locationName, 200),
      streetAddress: clean(b.streetAddress, 300),
      city: clean(b.city, 100),
      state: clean(b.state, 50),
      zip: clean(b.zip, 20),
      aboutEvent: clean(b.aboutEvent, 3000),
      guestCount: clean(b.guestCount, 20),
      anythingElse: clean(b.anythingElse, 3000),
      status: 'new',
    };
    inquiry.ownerId = await resolveOwner(req);
    const id = await store.addInquiry(inquiry);
    notifyEmail(inquiry);
    // Every inquiry is a lead. This was defined but never called, so eight
    // inquiries produced zero leads before anyone noticed.
    await createLeadFromInquiry(inquiry);
    sendJSON(res, 200, { ok: true, id });
  } catch (e) { console.error('inquiry:', e.message); sendJSON(res, 400, { ok: false, error: 'Invalid submission' }); }
});

// login for dashboard
app.post('/api/login', async (req, res) => {
  try {
    const b = JSON.parse((await readBody(req)) || '{}');
    if (typeof b.password === 'string' && b.password === DASH_PASS) {
      send(res, 200, JSON.stringify({ ok: true }), {
        'Content-Type': 'application/json',
        'Set-Cookie': 'tbm_auth=' + AUTH_TOKEN + '; Max-Age=1209600; Path=/; HttpOnly; SameSite=Lax',
      });
    } else {
      sendJSON(res, 401, { ok: false, error: 'Wrong password' });
    }
  } catch { sendJSON(res, 400, { ok: false }); }
});

// dashboard data
app.get('/api/dashboard', auth.requireAuth, async (req, res) => {
  try {
    const { inquiries, visits } = await store.getAll(ownerId(req));
    const uniqueVisitors = new Set(visits.map((v) => v.visitorId)).size;
    const formVisits = visits.filter((v) => v.page === '/' || v.page === '/index.html');
    sendJSON(res, 200, {
      inquiries, visits,
      stats: {
        totalVisits: formVisits.length,
        uniqueVisitors,
        totalInquiries: inquiries.length,
        conversionRate: uniqueVisitors ? Math.round((inquiries.length / uniqueVisitors) * 100) : 0,
      },
    });
  } catch (e) { console.error('dashboard:', e.message); sendJSON(res, 500, { ok: false, error: 'storage error' }); }
});

// update inquiry status
app.patch('/api/inquiries/:id', auth.requireAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const b = JSON.parse((await readBody(req)) || '{}');
    const allowed = ['new', 'contacted', 'booked', 'archived'];
    if (!allowed.includes(b.status)) return sendJSON(res, 400, { ok: false });
    const ok = await store.setStatus(id, b.status, ownerId(req));
    sendJSON(res, ok ? 200 : 404, { ok });
  } catch (e) { console.error('status:', e.message); sendJSON(res, 400, { ok: false }); }
});

// /dashboard alias -> dashboard.html (already gated above)
app.get('/dashboard', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));
app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'home.html')));
app.get('/signup',    (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'signup.html')));
app.get('/subscribe', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'subscribe.html')));
app.get('/account',   (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'account.html')));
app.get('/announce',  (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'announce.html')));

// static files (serves / -> index.html, and everything in public/)
app.use(express.static(PUBLIC_DIR));

// accounts, profile card, student CRM
app.use(require('./accounts'));

// text-to-invoice + payment tracking
app.use(require('./invoices'));

// billing / subscriptions
app.use(billing.router);

// booking + waitlist routes
app.use(require('./booking'));

app.listen(PORT, () => {
  console.log('');
  console.log('  Charleston is up!');
  console.log('  Storage: ' + (USE_SB ? 'Supabase' : 'local JSON file'));
  console.log('  Email notifications -> ' + NOTIFY_EMAIL);
  console.log('  Inquiry form:  http://localhost:' + PORT);
  console.log('  Dashboard:     http://localhost:' + PORT + '/dashboard');
  console.log('  Booking:       http://localhost:' + PORT + '/book');
  console.log('');
});
