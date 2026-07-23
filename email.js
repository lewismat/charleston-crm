/**
 * email.js — client emails via Resend.
 *
 * Env:
 *   RESEND_API_KEY   from resend.com → API Keys
 *   FROM_EMAIL       e.g. "Holly at Tampa Bay Mahj <holly@tampabaymahj.com>"
 *                    MUST use a domain verified in Resend, or Resend refuses
 *                    to send to anyone but your own account address.
 *   REPLY_TO         optional, defaults to NOTIFY_EMAIL
 *
 * If RESEND_API_KEY is missing, send() returns {skipped:true} instead of throwing.
 * Callers fall back to notifying Holly so nothing is silently lost.
 */

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY =
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Credentials live in the settings table so Holly can manage them in the app.
// Env vars still win if present, so existing deploys keep working.
let _cache = { at: 0, val: null };
async function cfg() {
  if (_cache.val && Date.now() - _cache.at < 30000) return _cache.val;
  let row = {};
  if (SB_URL && SB_KEY) {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/settings?id=eq.app&select=resend_api_key,from_email,notify_email&limit=1`,
        { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
      if (r.ok) row = (await r.json())[0] || {};
    } catch (e) { /* fall back to env */ }
  }
  const val = {
    key: process.env.RESEND_API_KEY || row.resend_api_key || '',
    from: process.env.FROM_EMAIL || row.from_email || '',
    replyTo: process.env.REPLY_TO || row.notify_email || process.env.NOTIFY_EMAIL || 'hollymahj@outlook.com',
  };
  _cache = { at: Date.now(), val };
  return val;
}
function clearCache() { _cache = { at: 0, val: null }; }
const SITE_URL = (process.env.SITE_URL || 'https://charlestoncrm.com').replace(/\/$/, '');
const TZ = 'America/New_York';

async function configured() { const c = await cfg(); return Boolean(c.key && c.from); }

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LABEL = {
  private_lesson: 'private lesson',
  group_class: 'group class',
  private_party: 'private party',
};

const when = (d) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  }).format(new Date(d));

const deadline = (d) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'long', hour: 'numeric', minute: '2-digit',
  }).format(new Date(d));

async function send({ to, subject, html }) {
  const c = await cfg();
  if (!c.key || !c.from) return { skipped: true, reason: 'Email sending is not set up yet (missing API key or from address).' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: c.from, to: [to], reply_to: c.replyTo, subject, html }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 403 here almost always means the domain in FROM_EMAIL is not verified yet.
      console.error('[email] Resend refused:', res.status, body?.message || body?.name || '');
      return { ok: false, status: res.status, error: body?.message || `Resend ${res.status}` };
    }
    return { ok: true, id: body.id };
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------- template */

let _brand = 'Charleston';
function setBrand(b) { _brand = (b && String(b).slice(0,80)) || 'Charleston'; }
function shell(inner) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#EFE7D2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EFE7D2;padding:28px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#FBF8EF;border:1px solid #DED3B4;border-bottom:5px solid #C6A248;border-radius:14px;">
<tr><td style="padding:32px 30px;font-family:Georgia,'Times New Roman',serif;color:#2C3327;">
${inner}
<p style="margin:26px 0 0;padding-top:16px;border-top:1px solid #DED3B4;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#5D6656;">
${_brand}<br>
Questions? Just reply to this email.
</p>
</td></tr></table>
</td></tr></table></body></html>`;
}

const h1 = (t) => `<h1 style="margin:0 0 6px;font-size:26px;font-weight:normal;color:#2C3327;">${t}</h1>`;
const big = (t) => `<p style="margin:16px 0 4px;font-size:19px;font-weight:bold;color:#5A6B4C;">${t}</p>`;
const p = (t) => `<p style="margin:8px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#5D6656;">${t}</p>`;
const btn = (href, label, solid = true) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 6px 0 0;display:inline-block;"><tr><td style="border-radius:8px;background:${solid ? '#7B8C6A' : 'transparent'};border:1.5px solid #7B8C6A;">
<a href="${href}" style="display:inline-block;padding:11px 20px;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:bold;color:${solid ? '#F7F2E4' : '#5A6B4C'};text-decoration:none;">${label}</a>
</td></tr></table>`;

const where = (slot) => (slot.location ? p(esc(slot.location)) : '');

/* ------------------------------------------------------------ messages */

// Sent the moment someone books.
function bookingConfirmed(booking, slot, manageToken) {
  const url = `${SITE_URL}/booking/${manageToken}`;
  return send({
    to: booking.email,
    subject: `You're booked — ${when(slot.starts_at)}`,
    html: shell(
      h1('You’re booked.') +
      p(`Hi ${esc(booking.first_name)} — you're booked for a ${LABEL[slot.slot_type]}.`) +
      big(when(slot.starts_at)) +
      p(`${slot.duration_minutes} minutes${booking.seats > 1 ? ` · ${booking.seats} seats` : ''}`) +
      where(slot) +
      btn(`${url}/google`, 'Add to Google Calendar') +
      btn(`${url}/calendar.ics`, 'Apple / Outlook (.ics)', false) +
      btn(url, 'View or cancel', false) +
      p('Nothing to bring — we provide the tiles and the cards.')
    ),
  });
}

// Sent when a session is full and they get in line.
function announcement(to, subject, message) {
  const paras = String(message || '').split(/\n{2,}/).map((t) => p(esc(t).replace(/\n/g, '<br>'))).join('');
  return send({ to, subject: subject || 'A note from your studio', html: shell(h1(subject || 'Hello!') + paras) });
}

function eventReminder(booking, slot, manageToken) {
  const url = `${SITE_URL}/booking/${manageToken}`;
  return send({
    to: booking.email,
    subject: `Reminder — ${when(slot.starts_at)}`,
    html: shell(
      h1('See you soon!') +
      big(when(slot.starts_at)) +
      where(slot) +
      p(`This is a friendly reminder about your ${(slot.title || '') || 'session'}.`) +
      btn(url, 'View or manage booking') +
      btn(`${SITE_URL}/booking/${manageToken}/google`, 'Add to calendar', false)
    ),
  });
}

function waitlistJoined(person, slot, token, position) {
  return send({
    to: person.email,
    subject: `You're #${position} on the list — ${when(slot.starts_at)}`,
    html: shell(
      h1(`You’re #${position} in line.`) +
      p(`Hi ${esc(person.first_name)} — that ${LABEL[slot.slot_type]} is full, but you’re on the list.`) +
      big(when(slot.starts_at)) +
      where(slot) +
      p(`If a seat opens up, we’ll email you and hold it for 24 hours — first come, first served down the list.`) +
      btn(`${SITE_URL}/waitlist/${token}`, 'Check your place in line') +
      p('Changed your mind? You can leave the list from that same link.')
    ),
  });
}

// The one that matters: a seat opened and it is being held for them.
function waitlistOffer(offer) {
  const url = `${SITE_URL}/waitlist/${offer.token}`;
  return send({
    to: offer.email,
    subject: `A seat opened up — ${when(offer.starts_at)}`,
    html: shell(
      h1('A seat opened up.') +
      p(`Hi ${esc(offer.first_name)} — someone cancelled, and the seat is yours if you want it.`) +
      big(when(offer.starts_at)) +
      p(`${LABEL[offer.slot_type]} · ${offer.duration_minutes} minutes${offer.seats > 1 ? ` · ${offer.seats} seats` : ''}`) +
      where(offer) +
      p(`<strong style="color:#8A6D14;">It’s held for you until ${deadline(offer.expires_at)}.</strong> After that it goes to the next person in line.`) +
      btn(url, 'Claim my seat') +
      p('Can’t make it? Use the same link to pass — it goes to the next person straight away.')
    ),
  });
}

// Sent when they claim a held seat.
function offerClaimed(offer, manageToken) {
  const url = `${SITE_URL}/booking/${manageToken}`;
  return send({
    to: offer.email,
    subject: `Seat claimed — ${when(offer.starts_at)}`,
    html: shell(
      h1('The seat is yours.') +
      p(`Hi ${esc(offer.first_name)} — you’re off the list and on the table.`) +
      big(when(offer.starts_at)) +
      where(offer) +
      btn(`${url}/google`, 'Add to Google Calendar') +
      btn(`${url}/calendar.ics`, 'Apple / Outlook (.ics)', false) +
      btn(url, 'View or cancel', false)
    ),
  });
}

// Internal alert to Holly. Uses Resend (already verified) rather than formsubmit,
// which silently drops mail until the recipient clicks a one-time activation link.
function ownerAlert(to, subject, fields) {
  const rows = Object.entries(fields || {}).map(([k, v]) =>
    `<tr><td style="padding:6px 14px 6px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#7A8A6B;white-space:nowrap;vertical-align:top;">${esc(k)}</td>` +
    `<td style="padding:6px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#3B4832;">${esc(String(v))}</td></tr>`
  ).join('');
  return send({
    to,
    subject,
    html: shell(
      h1(subject) +
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 4px;">${rows}</table>`
    ),
  });
}

// Sent when Holly changes the date, time, length or place of an event.
function eventChanged(booking, slot, manageToken, changes) {
  const url = `${SITE_URL}/booking/${manageToken}`;
  const lines = (changes || []).map((c) =>
    `<tr><td style="padding:5px 14px 5px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#7A8A6B;white-space:nowrap;">${esc(c.label)}</td>` +
    `<td style="padding:5px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#3B4832;">` +
    `<s style="color:#9AA88C;">${esc(c.from)}</s> &rarr; <b>${esc(c.to)}</b></td></tr>`
  ).join('');
  return send({
    to: booking.email,
    subject: `Updated — your ${LABEL[slot.slot_type]} on ${when(slot.starts_at)}`,
    html: shell(
      h1('A change to your booking.') +
      p(`Hi ${esc(booking.first_name)} — the details for your ${LABEL[slot.slot_type]} changed. Your seat is still reserved.`) +
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:10px 0 4px;">${lines}</table>` +
      big(when(slot.starts_at)) +
      where(slot) +
      btn(`${url}/google`, 'Update Google Calendar') +
      btn(`${url}/calendar.ics`, 'Apple / Outlook (.ics)', false) +
      btn(url, 'View or cancel', false) +
      p('If the new time does not work, you can cancel from that link and we will be notified.')
    ),
  });
}

// Holly cancelled someone's seat from her end.
function bookingCancelledByHolly(booking, slot, note) {
  return send({
    to: booking.email,
    subject: `Cancelled — ${LABEL[slot.slot_type]} on ${when(slot.starts_at)}`,
    html: shell(
      h1('Your booking was cancelled.') +
      p(`Hi ${esc(booking.first_name)} — your seat for the ${LABEL[slot.slot_type]} on ${when(slot.starts_at)} was cancelled.`) +
      (note ? p(esc(note)) : '') +
      p('If this is a surprise, just reply to this email and we will sort it out.')
    ),
  });
}

module.exports = { send, setBrand, announcement, eventReminder, configured, clearCache, ownerAlert, eventChanged, bookingCancelledByHolly, bookingConfirmed, waitlistJoined, waitlistOffer, offerClaimed };
