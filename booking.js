async function ownerEmail() {
  try {
    const rows = await sb('settings?id=eq.app&select=notify_email&limit=1');
    const v = rows && rows[0] && rows[0].notify_email;
    if (v) return v;
  } catch (e) { /* fall through to the env default */ }
  return NOTIFY_EMAIL;
}

async function tellHolly(subject, fields) {
  const to = await ownerEmail();
  // Resend first: it is already verified for guest confirmations.
  try {
    const r = await mail.ownerAlert(to, subject, fields);
    if (r && r.ok) return;
  } catch (e) { console.error('[booking] owner alert via Resend:', e.message); }
  // Fallback: formsubmit (needs a one-time activation click from the recipient).
  try {
    await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(to)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ _subject: subject, ...fields }),
    });
  } catch (e) {
    console.error('[booking] Holly notification failed:', e.message);
  }
}

/**
 * booking.js — Tampa Bay Mahj booking + waitlist
 *
 * Mount from server.js with ONE line:
 *     app.use(require('./booking'));
 *
 * No npm packages. Uses built-in fetch (Node 18+).
 *
 * Required env (already in Render): SUPABASE_URL, SUPABASE_KEY, DASHBOARD_PASSWORD
 * Optional: NOTIFY_EMAIL, SITE_URL, RESEND_API_KEY, FROM_EMAIL, OFFER_HOURS
 */

const express = require('express');
const path = require('path');
const mail = require('./email');
const sms = require('./sms');
const auth = require('./auth');
const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY;
const DASH_PASS = process.env.DASHBOARD_PASSWORD;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'hollymahj@outlook.com';
const SITE_URL = (process.env.SITE_URL || 'https://tampa-bay-mahj.onrender.com').replace(/\/$/, '');
const OFFER_HOURS = parseInt(process.env.OFFER_HOURS, 10) || 24;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn('[booking] SUPABASE_URL / SUPABASE_KEY not found — booking routes will error.');
}
mail.configured().then((ok) => {
  if (!ok) console.warn('[booking] Email not configured — clients will not be emailed. Set it up in Settings.');
}).catch(() => {});

router.use(express.json());

/* ---------------------------------------------------------------- helpers */

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
  if (!res.ok) throw new Error(typeof data === 'string' ? data : data?.message || `Supabase ${res.status}`);
  return data;
}

function requireHolly(req, res, next) {
  if (!DASH_PASS) return res.status(500).send('DASHBOARD_PASSWORD is not set on the server.');
  const [type, creds] = (req.headers.authorization || '').split(' ');
  if (type === 'Basic' && creds) {
    const pass = Buffer.from(creds, 'base64').toString().split(':').slice(1).join(':');
    if (pass === DASH_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Tampa Bay Mahj scheduling"');
  res.status(401).send('Password required.');
}

const TYPE_LABEL = {
  private_lesson: 'Private lesson',
  group_class: 'Group class',
  private_party: 'Private party',
};

const clean = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const free = (s) => s.seats_total - s.seats_taken - (s.seats_held || 0);
const endsAt = (s) => new Date(new Date(s.starts_at).getTime() + s.duration_minutes * 60000);
const fmt = (d) => new Date(d).toLocaleString('en-US', {
  timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short',
});

// Holly's notifications keep going through FormSubmit — already working, already activated.
/* ---------------- Stripe (paid bookings) ---------------- */
async function getStripeKey() {
  try {
    const rows = await sb('settings?id=eq.app&select=stripe_secret_key&limit=1');
    return (rows && rows[0] && rows[0].stripe_secret_key) || '';
  } catch (e) { return ''; }
}
async function stripePost(key, pathq, params) {
  const r = await fetch('https://api.stripe.com/v1/' + pathq, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Stripe ' + r.status));
  return j;
}
async function stripeGetJSON(key, pathq) {
  const r = await fetch('https://api.stripe.com/v1/' + pathq, { headers: { Authorization: 'Bearer ' + key } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Stripe ' + r.status));
  return j;
}
// Release seats held by checkouts that were never paid. Lazy — runs when the calendar loads.
async function sweepPendingHolds() {
  try {
    const stale = await sb(`pending_bookings?select=*&status=eq.pending&expires_at=lt.${new Date().toISOString()}`);
    for (const p of (stale || [])) {
      await sb(`pending_bookings?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'expired' }) }).catch(() => {});
      const [sl] = await sb(`slots?select=seats_held&id=eq.${p.slot_id}`).catch(() => []);
      if (sl) await sb(`slots?id=eq.${p.slot_id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ seats_held: Math.max(0, (sl.seats_held || 0) - p.seats) }) }).catch(() => {});
    }
  } catch (e) { console.error('[booking] sweepPendingHolds:', e.message); }
}

// A booking (or claimed waitlist seat) makes them a real student, tagged with the event.
async function upsertStudentFromBooking(person, slot) {
  try {
    const email = (person.email || '').toLowerCase();
    const when = slot && slot.starts_at
      ? new Date(slot.starts_at).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }) : '';
    const label = (TYPE_LABEL[slot.slot_type] || slot.slot_type || 'event') + (when ? ' \u00b7 ' + when : '');
    const tag = 'booked: ' + label;
    let ex = [];
    if (email) ex = await sb(`students?select=id,tags&email=eq.${encodeURIComponent(email)}&limit=1`).catch(() => []);
    if (ex && ex[0]) {
      const tags = (ex[0].tags || '').split(',').map((t) => t.trim()).filter(Boolean);
      if (!tags.includes(tag)) tags.push(tag);
      await sb(`students?id=eq.${ex[0].id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'student', source: 'event booking', tags: tags.join(', '), updated_at: new Date().toISOString() }) });
    } else {
      await sb('students', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({
        first_name: person.first_name, last_name: person.last_name, email, phone: person.phone,
        status: 'student', source: 'event booking', tags: tag, notes: 'Booked ' + label }) });
    }
  } catch (e) { console.error('[booking] student upsert:', e.message); }
}

async function tellHolly(subject, fields) {
  try {
    await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(NOTIFY_EMAIL)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ _subject: subject, ...fields }),
    });
  } catch (e) {
    console.error('[booking] Holly notification failed:', e.message);
  }
}

/* ------------------------------------------------------------ the sweep */
/* Render's free tier has no cron, so expiry is lazy: any time the calendar
   is touched we expire dead offers and roll freed seats down the line.
   Throttled so a busy page does not hammer the database. */

let lastSweep = 0;
let sweeping = null;

async function doSweep() {
  if (sweeping) return sweeping;
  sweeping = (async () => {
    try {
      const out = await sb('rpc/sweep_waitlist', {
        method: 'POST',
        body: JSON.stringify({ p_hours: OFFER_HOURS }),
      });
      lastSweep = Date.now();
      const offers = out?.offers || [];
      for (const o of offers) {
        const sent = await mail.waitlistOffer(o);
        // If the client could not be emailed, Holly gets the claim link to pass on
        // by text — the seat stays held either way, so the offer still means something.
        if (!sent?.ok) {
          await tellHolly(`Seat opened — text ${o.first_name} the link`, {
            Who: `${o.first_name} ${o.last_name}`,
            Phone: o.phone || '—',
            Email: o.email,
            Session: `${TYPE_LABEL[o.slot_type]} — ${fmt(o.starts_at)}`,
            Seats: o.seats,
            'Claim link': `${SITE_URL}/waitlist/${o.token}`,
            'Held until': fmt(o.expires_at),
            Why: sent?.reason || sent?.error || 'client email not sent',
          });
        }
      }
      return offers;
    } catch (e) {
      console.error('[booking] sweep failed:', e.message);
      return [];
    } finally {
      sweeping = null;
    }
  })();
  return sweeping;
}

function maybeSweep() {
  if (Date.now() - lastSweep > 60000) doSweep().catch(() => {});
}

/* ------------------------------------------------------------ public API */

// Open sessions. Full ones stay listed so people can join the waitlist.
router.get('/api/slots', async (req, res) => {
  try {
    maybeSweep();
    sweepPendingHolds();
    const rows = await sb(
      `slots?select=id,slot_type,starts_at,duration_minutes,location,seats_total,seats_taken,seats_held,price_note,price_cents,title,notes,waitlist(status)` +
      `&published=eq.true&starts_at=gte.${new Date().toISOString()}&order=starts_at.asc`
    );
    res.json(rows.map((s) => {
      const line = (s.waitlist || []).filter((w) => w.status === 'waiting' || w.status === 'offered').length;
      const { waitlist, seats_held, seats_taken, ...rest } = s;
      return { ...rest, seats_left: Math.max(0, free(s)), waiting: line };
    }));
  } catch (e) {
    console.error('[booking] /api/slots', e.message);
    res.status(500).json({ error: 'Could not load the calendar. Please refresh.' });
  }
});

function person(b) {
  return {
    first_name: clean(b.first_name, 60),
    last_name: clean(b.last_name, 60),
    email: clean(b.email, 120),
    phone: clean(b.phone, 40),
    notes: clean(b.notes, 2000),
  };
}

function validate(p, slot_id) {
  if (!p.first_name || !p.last_name) return 'Add your first and last name.';
  if (!isEmail(p.email)) return 'That email address does not look right.';
  if (!p.phone || p.phone.replace(/[^0-9]/g, '').length < 10) return 'Add a phone number so Holly can reach you.';
  if (!slot_id) return 'Pick a time first.';
  return null;
}

// "$75 per person" typed into the note with the price left blank makes a free event
// that looks priced. Catch it rather than silently losing the money.
function priceTrap(note, cents) {
  if (cents > 0) return null;
  const m = String(note || '').match(/\$\s?(\d[\d,]*(?:\.\d{2})?)/);
  if (!m) return null;
  return {
    error: `Your note says $${m[1]} but the price per seat is blank, so this event would be free. ` +
           `Set the price to ${m[1]}, or clear the amount from the note if it really is free.`,
    suggested_cents: Math.round(parseFloat(m[1].replace(/,/g, '')) * 100),
  };
}

// Turn an approved (free or paid) request into a real seat + notifications.
async function finalizeBooking(slot_id, seats, payload, paidCents) {
  const result = await sb('rpc/book_slot', {
    method: 'POST',
    body: JSON.stringify({ p_slot_id: slot_id, p_seats: seats, p_booking: payload }),
  });
  if (!result?.ok) return { ok: false, error: result?.error || 'That time just filled up.' };

  const [slot] = await sb(`slots?select=*&id=eq.${slot_id}`);
  upsertStudentFromBooking(payload, slot);

  mail.bookingConfirmed({ ...payload, seats }, slot, result.manage_token);
  if (payload.phone) sms.sendSMS(payload.phone, `You're booked with Tampa Bay Mahj \u2014 ${slot.title || TYPE_LABEL[slot.slot_type]} on ${fmt(slot.starts_at)}. Manage: ${SITE_URL}/booking/${result.manage_token}`).catch(() => {});
  tellHolly(`New booking — ${slot.title || TYPE_LABEL[slot.slot_type]} — ${fmt(slot.starts_at)}`, {
    Name: `${payload.first_name} ${payload.last_name}`,
    Email: payload.email,
    Phone: payload.phone || '—',
    When: fmt(slot.starts_at),
    Seats: seats,
    Paid: paidCents ? '$' + (paidCents / 100).toFixed(2) : 'Free event',
    Where: slot.location || payload.street_address || '—',
    Address: [payload.street_address, payload.city, payload.state, payload.zip].filter(Boolean).join(', ') || '—',
    Expecting: payload.headcount || '—',
    Notes: payload.notes || '—',
    Schedule: `${SITE_URL}/schedule`,
  });
  return { ok: true, manage_token: result.manage_token };
}

// Book a seat. Paid events detour through Stripe Checkout before the seat is real.
router.post('/api/book', async (req, res) => {
  try {
    const b = req.body || {};
    const p = person(b);
    const seats = Math.max(1, parseInt(b.seats, 10) || 1);
    const bad = validate(p, b.slot_id);
    if (bad) return res.status(400).json({ error: bad });

    const payload = {
      ...p,
      street_address: clean(b.street_address, 200),
      city: clean(b.city, 80),
      state: clean(b.state, 40),
      zip: clean(b.zip, 20),
      headcount: clean(String(b.headcount ?? ''), 10),
    };

    const [slot] = await sb(`slots?select=*&id=eq.${b.slot_id}`);
    if (!slot) return res.status(404).json({ error: 'That event is no longer on the calendar.' });

    const price = Math.max(0, parseInt(slot.price_cents, 10) || 0);

    /* ---- Free event: book straight away ---- */
    if (!price) {
      const out = await finalizeBooking(b.slot_id, seats, payload, 0);
      if (!out.ok) return res.status(409).json({ error: out.error });
      return res.json({ ok: true, manage_url: `${SITE_URL}/booking/${out.manage_token}` });
    }

    /* ---- Paid event: hold the seat, send them to Stripe ---- */
    const key = await getStripeKey();
    if (!key) return res.status(503).json({ error: 'Payment is not set up yet for this event. Please text Holly to reserve.' });
    if (seats > free(slot)) return res.status(409).json({ error: 'That time just filled up.' });

    // Hold the seat(s) so nobody else takes them while this person checks out.
    await sb(`slots?id=eq.${slot.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ seats_held: (slot.seats_held || 0) + seats }),
    });

    let pend;
    try {
      const rows = await sb('pending_bookings', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ slot_id: slot.id, seats, payload }),
      });
      pend = rows[0];

      const label = slot.title || TYPE_LABEL[slot.slot_type] || 'Mahjong with Tampa Bay Mahj';
      const session = await stripePost(key, 'checkout/sessions', {
        mode: 'payment',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(price),
        'line_items[0][price_data][product_data][name]': `${label} — ${fmt(slot.starts_at)}`,
        'line_items[0][quantity]': String(seats),
        customer_email: payload.email,
        client_reference_id: pend.id,
        'metadata[pending_id]': pend.id,
        success_url: `${SITE_URL}/api/book/complete?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/book?payment=cancelled`,
      });

      await sb(`pending_bookings?id=eq.${pend.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ session_id: session.id }),
      });
      return res.json({ ok: true, checkout_url: session.url });
    } catch (err) {
      // Checkout never opened — give the seat back immediately.
      const [cur] = await sb(`slots?select=seats_held&id=eq.${slot.id}`).catch(() => []);
      if (cur) await sb(`slots?id=eq.${slot.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ seats_held: Math.max(0, (cur.seats_held || 0) - seats) }),
      }).catch(() => {});
      if (pend) await sb(`pending_bookings?id=eq.${pend.id}`, {
        method: 'PATCH', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'expired' }),
      }).catch(() => {});
      console.error('[booking] checkout:', err.message);
      return res.status(502).json({ error: 'We could not open the payment page. Please try again in a moment.' });
    }
  } catch (e) {
    console.error('[booking] /api/book', e.message);
    res.status(500).json({ error: 'Something went wrong saving that. Please try again.' });
  }
});

// Stripe sends them back here after paying. Verify with Stripe, then make the seat real.
router.get('/api/book/complete', async (req, res) => {
  const back = (msg) => res.redirect('/book?payment=' + encodeURIComponent(msg));
  try {
    const sid = String(req.query.session_id || '');
    if (!sid) return back('missing');

    const key = await getStripeKey();
    if (!key) return back('unconfigured');

    const session = await stripeGetJSON(key, 'checkout/sessions/' + encodeURIComponent(sid));
    if (session.payment_status !== 'paid') return back('unpaid');

    const rows = await sb(`pending_bookings?select=*&session_id=eq.${encodeURIComponent(sid)}&limit=1`);
    const pend = rows && rows[0];
    if (!pend) return back('missing');

    // Already finished (e.g. they refreshed the receipt page) — don't double-book.
    if (pend.status === 'paid') {
      return res.redirect(pend.manage_token ? `/booking/${pend.manage_token}?paid=1` : '/book?payment=done');
    }

    // Release the hold first so book_slot sees the seat as available.
    const [cur] = await sb(`slots?select=seats_held&id=eq.${pend.slot_id}`).catch(() => []);
    if (cur) await sb(`slots?id=eq.${pend.slot_id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ seats_held: Math.max(0, (cur.seats_held || 0) - pend.seats) }),
    }).catch(() => {});

    const paidCents = session.amount_total || 0;
    const out = await finalizeBooking(pend.slot_id, pend.seats, pend.payload, paidCents);

    await sb(`pending_bookings?id=eq.${pend.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'paid', manage_token: out.manage_token || null }),
    }).catch(() => {});

    if (!out.ok) {
      // Paid, but the seat vanished. Never silently swallow this.
      tellHolly('ACTION NEEDED — paid but no seat', {
        Name: `${pend.payload.first_name} ${pend.payload.last_name}`,
        Email: pend.payload.email,
        Phone: pend.payload.phone || '—',
        Paid: '$' + (paidCents / 100).toFixed(2),
        Problem: out.error,
        'Stripe session': sid,
        'What to do': 'Refund in Stripe or fit them in, then reply to them directly.',
      });
      return back('oversold');
    }
    return res.redirect(`/booking/${out.manage_token}?paid=1`);
  } catch (e) {
    console.error('[booking] /api/book/complete', e.message);
    return back('error');
  }
});

/* ------------------------------------------------------------- waitlist */

router.post('/api/waitlist', async (req, res) => {
  try {
    const b = req.body || {};
    const p = person(b);
    const seats = Math.max(1, parseInt(b.seats, 10) || 1);
    const bad = validate(p, b.slot_id);
    if (bad) return res.status(400).json({ error: bad });

    const result = await sb('rpc/join_waitlist', {
      method: 'POST',
      body: JSON.stringify({ p_slot_id: b.slot_id, p_seats: seats, p_person: p }),
    });
    if (!result?.ok) return res.status(409).json({ error: result.error });

    const [slot] = await sb(`slots?select=*&id=eq.${b.slot_id}`);

    if (!result.already) {
      mail.waitlistJoined(p, slot, result.token, result.position);
      tellHolly(`Waitlist — ${p.first_name} ${p.last_name} is #${result.position} for ${fmt(slot.starts_at)}`, {
        Name: `${p.first_name} ${p.last_name}`,
        Email: p.email,
        Phone: p.phone || '—',
        Session: `${TYPE_LABEL[slot.slot_type]} — ${fmt(slot.starts_at)}`,
        Seats: seats,
        Position: `#${result.position}`,
        Notes: p.notes || '—',
      });
    }

    res.json({
      ok: true,
      already: !!result.already,
      position: result.position,
      status_url: `${SITE_URL}/waitlist/${result.token}`,
    });
  } catch (e) {
    console.error('[booking] /api/waitlist', e.message);
    res.status(500).json({ error: 'Could not add you to the list. Please try again.' });
  }
});

router.get('/waitlist/:token', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'waitlist.html'))
);

router.get('/api/waitlist/:token', async (req, res) => {
  try {
    await doSweep(); // this page is exactly where a stale offer must not be shown as live
    const [w] = await sb(
      `waitlist?select=*,slots(*)&token=eq.${encodeURIComponent(req.params.token)}`
    );
    if (!w) return res.status(404).json({ error: 'We could not find that.' });

    let position = null;
    if (w.status === 'waiting' || w.status === 'offered') {
      const line = await sb(
        `waitlist?select=created_at&slot_id=eq.${w.slot_id}&status=in.(waiting,offered)&created_at=lte.${encodeURIComponent(w.created_at)}`
      );
      position = line.length;
    }
    let manage_url = null;
    if (w.status === 'claimed' && w.booking_id) {
      const [bk] = await sb(`bookings?select=manage_token&id=eq.${w.booking_id}`);
      if (bk) manage_url = `${SITE_URL}/booking/${bk.manage_token}`;
    }
    delete w.token;
    delete w.booking_id;
    res.json({ ...w, position, manage_url });
  } catch (e) {
    console.error('[booking] /api/waitlist/:token', e.message);
    res.status(500).json({ error: 'Could not load that.' });
  }
});

router.post('/api/waitlist/:token/claim', async (req, res) => {
  try {
    const result = await sb('rpc/claim_offer', {
      method: 'POST',
      body: JSON.stringify({ p_token: req.params.token }),
    });
    if (!result?.ok) return res.status(409).json({ error: result?.error || 'Could not claim that seat.' });

    const [w] = await sb(`waitlist?select=*,slots(*)&token=eq.${encodeURIComponent(req.params.token)}`);
    if (!result.already && w) {
      upsertStudentFromBooking(w, w.slots);
      mail.offerClaimed({ ...w, starts_at: w.slots.starts_at, location: w.slots.location }, result.manage_token);
      if (w.phone) sms.sendSMS(w.phone, `Your seat is confirmed with Tampa Bay Mahj \u2014 ${TYPE_LABEL[w.slots.slot_type]} on ${fmt(w.slots.starts_at)}. Manage: ${SITE_URL}/booking/${result.manage_token}`).catch(() => {});
      tellHolly(`Waitlist claimed — ${w.first_name} ${w.last_name} — ${fmt(w.slots.starts_at)}`, {
        Name: `${w.first_name} ${w.last_name}`,
        Email: w.email,
        Phone: w.phone || '—',
        Session: `${TYPE_LABEL[w.slots.slot_type]} — ${fmt(w.slots.starts_at)}`,
        Seats: w.seats,
        Schedule: `${SITE_URL}/schedule`,
      });
    }
    res.json({ ok: true, manage_url: `${SITE_URL}/booking/${result.manage_token}` });
  } catch (e) {
    console.error('[booking] claim', e.message);
    res.status(500).json({ error: 'Could not claim that seat. Please text Holly.' });
  }
});

router.post('/api/waitlist/:token/leave', async (req, res) => {
  try {
    const result = await sb('rpc/leave_waitlist', {
      method: 'POST',
      body: JSON.stringify({ p_token: req.params.token }),
    });
    if (!result?.ok) return res.status(400).json({ error: result?.error || 'Could not do that.' });
    doSweep().catch(() => {}); // passing on a held seat should reach the next person now
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not do that.' });
  }
});

/* ------------------------------------------------ client booking pages */

router.get('/booking/:token', async (req, res) => {
  try {
    const [bk] = await sb(`bookings?select=id&manage_token=eq.${encodeURIComponent(req.params.token)}`);
    if (!bk) return res.status(404).send('We could not find that booking.');
    res.sendFile(path.join(__dirname, 'public', 'booking-manage.html'));
  } catch {
    res.status(500).send('Something went wrong loading that booking.');
  }
});

router.get('/api/booking/:token', async (req, res) => {
  try {
    const [bk] = await sb(`bookings?select=*,slots(*)&manage_token=eq.${encodeURIComponent(req.params.token)}`);
    if (!bk) return res.status(404).json({ error: 'We could not find that booking.' });
    delete bk.manage_token;
    res.json(bk);
  } catch {
    res.status(500).json({ error: 'Could not load that booking.' });
  }
});

router.post('/api/booking/:token/cancel', async (req, res) => {
  try {
    const result = await sb('rpc/cancel_booking', {
      method: 'POST',
      body: JSON.stringify({ p_token: req.params.token }),
    });
    if (!result?.ok) return res.status(400).json({ error: result?.error || 'Could not cancel that.' });
    // A cancellation is the whole point of the waitlist — offer the seat immediately.
    doSweep().catch(() => {});
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not cancel that. Please text Holly.' });
  }
});

router.get('/booking/:token/calendar.ics', async (req, res) => {
  try {
    const [bk] = await sb(`bookings?select=*,slots(*)&manage_token=eq.${encodeURIComponent(req.params.token)}`);
    if (!bk) return res.status(404).send('Not found.');
    const s = bk.slots;
    const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tampa Bay Mahj//EN', 'BEGIN:VEVENT',
      `UID:${bk.id}@tampabaymahj`,
      `DTSTAMP:${stamp(bk.created_at)}`,
      `DTSTART:${stamp(s.starts_at)}`,
      `DTEND:${stamp(endsAt(s))}`,
      `SUMMARY:${s.title || TYPE_LABEL[s.slot_type] + ' with Holly'} — Tampa Bay Mahj`,
      `LOCATION:${(s.location || [bk.street_address, bk.city, bk.state].filter(Boolean).join(', ') || 'TBD').replace(/,/g, '\\,')}`,
      `DESCRIPTION:Manage this booking: ${SITE_URL}/booking/${req.params.token}`,
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    res.set('Content-Type', 'text/calendar');
    res.set('Content-Disposition', 'attachment; filename="mahjong.ics"');
    res.send(ics);
  } catch {
    res.status(500).send('Could not build that calendar file.');
  }
});

// Google Calendar cannot import a downloaded .ics, so hand Gmail users a prefilled event instead.
router.get('/booking/:token/google', async (req, res) => {
  try {
    const [bk] = await sb(`bookings?select=*,slots(*)&manage_token=eq.${encodeURIComponent(req.params.token)}`);
    if (!bk) return res.status(404).send('Not found.');
    const s = bk.slots;
    const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const url = 'https://calendar.google.com/calendar/render?' + new URLSearchParams({
      action: 'TEMPLATE',
      text: `${s.title || TYPE_LABEL[s.slot_type] + ' with Holly'} — Tampa Bay Mahj`,
      dates: `${stamp(s.starts_at)}/${stamp(endsAt(s))}`,
      location: s.location || [bk.street_address, bk.city, bk.state, bk.zip].filter(Boolean).join(', ') || '',
      details: `Manage or cancel this booking: ${SITE_URL}/booking/${req.params.token}`,
    }).toString();
    res.redirect(url);
  } catch {
    res.status(500).send('Could not build that calendar link.');
  }
});

// Copy an event to a new date, without its guests.
router.post('/api/admin/slots/:id/duplicate', auth.requireAuth, async (req, res) => {
  try {
    const [src] = await sb(`slots?select=*&id=eq.${encodeURIComponent(req.params.id)}`);
    if (!src) return res.status(404).json({ error: 'That event is no longer here.' });
    const when = req.body && req.body.starts_at ? new Date(req.body.starts_at) : new Date(new Date(src.starts_at).getTime() + 7 * 864e5);
    if (isNaN(when)) return res.status(400).json({ error: 'That date did not make sense.' });
    const [copy] = await sb('slots', {
      method: 'POST',
      body: JSON.stringify({
        slot_type: src.slot_type, title: src.title, price_cents: src.price_cents,
        starts_at: when.toISOString(), duration_minutes: src.duration_minutes,
        location: src.location, seats_total: src.seats_total,
        price_note: src.price_note, notes: src.notes, published: true,
      }),
    });
    res.json(copy);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Holly adds someone who paid cash, Venmo'd her, or just texted.
router.post('/api/admin/slots/:id/attendee', auth.requireAuth, async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);
    const b = req.body || {};
    const p = person(b);
    if (!p.first_name || !p.last_name) return res.status(400).json({ error: 'Add a first and last name.' });
    const seats = Math.max(1, parseInt(b.seats, 10) || 1);

    const [slot] = await sb(`slots?select=*&id=eq.${id}`);
    if (!slot) return res.status(404).json({ error: 'That event is no longer here.' });
    if (seats > free(slot)) {
      return res.status(409).json({ error: `Only ${Math.max(0, free(slot))} seat(s) left. Add seats to the event first.` });
    }

    // bookings has no paid_how column, so record it where it will actually survive and show.
    const how = clean(b.paid_how, 40) || 'not recorded';
    const stamp = `Added by Holly · paid: ${how}`;
    const payload = { ...p, notes: p.notes ? `${p.notes} — ${stamp}` : stamp };
    const result = await sb('rpc/book_slot', {
      method: 'POST',
      body: JSON.stringify({ p_slot_id: req.params.id, p_seats: seats, p_booking: payload }),
    });
    if (!result?.ok) return res.status(409).json({ error: result?.error || 'That event just filled up.' });

    upsertStudentFromBooking(payload, slot);
    let emailed = false;
    if (b.send_confirmation && p.email) {
      try {
        const out = await mail.bookingConfirmed({ ...payload, seats }, slot, result.manage_token);
        emailed = !!(out && out.ok);
      } catch (e) { console.error('[booking] manual confirm failed:', e.message); }
    }
    res.json({ ok: true, emailed, manage_url: `${SITE_URL}/booking/${result.manage_token}` });
  } catch (e) {
    console.error('[booking] add attendee:', e.message);
    res.status(500).json({ error: 'Could not add them. Please try again.' });
  }
});

// Holly cancels a seat from her end — someone called, or could not make it.
router.post('/api/admin/bookings/:id/cancel', auth.requireAuth, async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);
    const [bk] = await sb(`bookings?select=*,slots(*)&id=eq.${id}`);
    if (!bk) return res.status(404).json({ error: 'That booking is no longer here.' });
    if (bk.status !== 'confirmed') return res.status(409).json({ error: 'That seat is already cancelled.' });

    const result = await sb('rpc/cancel_booking', {
      method: 'POST', body: JSON.stringify({ p_token: bk.manage_token }),
    });
    if (!result?.ok) return res.status(400).json({ error: result?.error || 'Could not cancel that seat.' });

    let emailed = false;
    if (req.body && req.body.tell_them && bk.email) {
      try {
        const out = await mail.bookingCancelledByHolly(bk, bk.slots, clean(req.body.note, 300));
        emailed = !!(out && out.ok);
      } catch (e) { console.error('[booking] cancel notice failed:', e.message); }
    }
    // Freeing a seat is exactly when the waitlist should move.
    doSweep().catch(() => {});
    res.json({ ok: true, emailed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------- Holly-only API */

router.get('/schedule', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'schedule.html'))
);

router.get('/api/admin/slots', auth.requireAuth, async (req, res) => {
  try {
    await doSweep();
    const rows = await sb('slots?select=*,bookings(*),waitlist(*)&order=starts_at.asc');
    res.json(rows.map((s) => ({ ...s, seats_free: Math.max(0, free(s)) })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/admin/slots', auth.requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    if (!TYPE_LABEL[b.slot_type]) return res.status(400).json({ error: 'Pick what kind of session this is.' });
    if (!b.starts_at || isNaN(new Date(b.starts_at))) return res.status(400).json({ error: 'Pick a date and time.' });

    const cents = Math.max(0, Math.min(500000, parseInt(b.price_cents, 10) || 0));
    const note = clean(b.price_note, 120) || null;
    const trap = priceTrap(note, cents);
    if (trap && !b.confirm_free) {
      return res.status(400).json({ error: trap.error, price_trap: true, suggested_cents: trap.suggested_cents });
    }

    const exclusive = b.slot_type !== 'group_class';
    const base = {
      slot_type: b.slot_type,
      title: clean(b.title, 120) || null,
      price_cents: cents,
      duration_minutes: Math.min(600, Math.max(15, parseInt(b.duration_minutes, 10) || 120)),
      location: clean(b.location, 200) || null,
      seats_total: exclusive ? 1 : Math.min(40, Math.max(1, parseInt(b.seats_total, 10) || 8)),
      price_note: note,
      notes: clean(b.notes, 1000) || null,
      published: b.published !== false,
    };

    // Repeat weekly — a Tuesday class should not be typed out eight times.
    const weeks = Math.min(52, Math.max(1, parseInt(b.repeat_weeks, 10) || 1));
    const rows = [];
    for (let i = 0; i < weeks; i++) {
      const d = new Date(b.starts_at);
      d.setDate(d.getDate() + i * 7);
      rows.push({ ...base, starts_at: d.toISOString() });
    }
    const created = await sb('slots', { method: 'POST', body: JSON.stringify(rows) });
    res.json({ ...(created[0] || {}), created_count: created.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/api/admin/slots/:id', auth.requireAuth, async (req, res) => {
  try {
    const id = encodeURIComponent(req.params.id);
    const [before] = await sb(`slots?select=*&id=eq.${id}`);
    if (!before) return res.status(404).json({ error: 'That event is no longer here.' });

    const b = req.body || {};
    const patch = {};
    if ('published' in b) patch.published = !!b.published;
    if ('price_cents' in b) patch.price_cents = Math.max(0, Math.min(500000, parseInt(b.price_cents, 10) || 0));
    if ('price_note' in b) patch.price_note = clean(b.price_note, 120) || null;
    if ('title' in b) patch.title = clean(b.title, 120) || null;
    if ('location' in b) patch.location = clean(b.location, 200) || null;
    if ('notes' in b) patch.notes = clean(b.notes, 2000) || null;
    if ('slot_type' in b && TYPE_LABEL[b.slot_type]) patch.slot_type = b.slot_type;

    if ('starts_at' in b && b.starts_at) {
      const d = new Date(b.starts_at);
      if (isNaN(d)) return res.status(400).json({ error: 'That date and time did not make sense.' });
      patch.starts_at = d.toISOString();
    }
    if ('duration_minutes' in b) {
      patch.duration_minutes = Math.min(600, Math.max(15, parseInt(b.duration_minutes, 10) || 60));
    }
    if ('seats_total' in b) {
      const want = Math.min(40, Math.max(1, parseInt(b.seats_total, 10) || 1));
      const floor = before.seats_taken + (before.seats_held || 0);
      if (want < floor) {
        return res.status(409).json({ error: `${floor} seat${floor === 1 ? ' is' : 's are'} already spoken for, so you cannot drop below ${floor}. Cancel someone first if you need fewer.` });
      }
      patch.seats_total = want;
    }

    const trapNote = 'price_note' in patch ? patch.price_note : before.price_note;
    const trapCents = 'price_cents' in patch ? patch.price_cents : before.price_cents;
    const trap = priceTrap(trapNote, trapCents);
    if (trap && !b.confirm_free) {
      return res.status(400).json({ error: trap.error, price_trap: true, suggested_cents: trap.suggested_cents });
    }

    const [updated] = await sb(`slots?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

    // Work out what a guest would actually care about.
    const fmtDur = (m) => `${m} minutes`;
    const changes = [];
    if (patch.starts_at && patch.starts_at !== before.starts_at) {
      changes.push({ label: 'When', from: fmt(before.starts_at), to: fmt(patch.starts_at) });
    }
    if (patch.duration_minutes && patch.duration_minutes !== before.duration_minutes) {
      changes.push({ label: 'Length', from: fmtDur(before.duration_minutes), to: fmtDur(patch.duration_minutes) });
    }
    if ('location' in patch && (patch.location || '') !== (before.location || '')) {
      changes.push({ label: 'Where', from: before.location || 'To be confirmed', to: patch.location || 'To be confirmed' });
    }

    // Count only what actually sent. Reporting attempts would be the same silent
    // lie that let broken email go unnoticed for weeks.
    let notified = 0, failed = 0, warning = null;
    if (changes.length && b.notify_guests) {
      const live = await sb(`bookings?select=*&slot_id=eq.${id}&status=eq.confirmed`).catch(() => []);
      for (const bk of (live || [])) {
        try {
          const out = await mail.eventChanged(bk, updated, bk.manage_token, changes);
          if (out && out.ok) notified++;
          else { failed++; if (out && (out.reason || out.error)) warning = out.reason || out.error; }
          if (bk.phone) {
            sms.sendSMS(bk.phone, `Update from Tampa Bay Mahj — your ${updated.title || TYPE_LABEL[updated.slot_type]} is now ${fmt(updated.starts_at)}. Details: ${SITE_URL}/booking/${bk.manage_token}`).catch(() => {});
          }
        } catch (e) { failed++; console.error('[booking] change notice failed:', e.message); }
      }
      if (failed && !warning) warning = 'Some notices could not be sent.';
    }

    res.json({ ...updated, changed: changes, notified, failed, warning });
    return;

    doSweep().catch(() => {});
    res.json({ ...updated, changed: changes, notified });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


router.delete('/api/admin/slots/:id', auth.requireAuth, async (req, res) => {
  try {
    const [slot] = await sb(`slots?select=seats_taken,seats_held&id=eq.${encodeURIComponent(req.params.id)}`);
    if (slot?.seats_taken > 0 || slot?.seats_held > 0) {
      return res.status(409).json({ error: 'Someone is booked or holding a seat here. Hide it instead, then call them.' });
    }
    await sb(`slots?id=eq.${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/book', (req, res) => res.sendFile(path.join(__dirname, 'public', 'book.html')));

module.exports = router;
