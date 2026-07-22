/**
 * sms.js — send SMS via Twilio using creds stored in the settings table.
 * Degrades gracefully: if not configured, returns {skipped:true}.
 */
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function getTwilio() {
  if (!SB_URL || !SB_KEY) return null;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/settings?id=eq.app&select=twilio_account_sid,twilio_auth_token,twilio_from&limit=1`,
      { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
    const rows = await r.json();
    const s = rows && rows[0];
    if (s && s.twilio_account_sid && s.twilio_auth_token && s.twilio_from) {
      return { sid: s.twilio_account_sid, token: s.twilio_auth_token, from: s.twilio_from };
    }
  } catch (e) { console.error('[sms] settings:', e.message); }
  return null;
}
function tidyPhone(p) {
  p = String(p || '').trim();
  if (!p) return '';
  if (p[0] === '+') return p;
  const d = p.replace(/[^0-9]/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return d ? '+' + d : '';
}
async function sendSMS(to, body) {
  const t = await getTwilio();
  if (!t) return { skipped: true };
  const dest = tidyPhone(to);
  if (!dest) return { skipped: true, reason: 'no phone' };
  try {
    const params = new URLSearchParams({ To: dest, From: t.from, Body: body });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(t.sid + ':' + t.token).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { console.error('[sms] Twilio:', r.status, j.message || ''); return { ok: false, error: j.message || ('Twilio ' + r.status) }; }
    return { ok: true, sid: j.sid };
  } catch (e) { console.error('[sms] send:', e.message); return { ok: false, error: e.message }; }
}
module.exports = { sendSMS, getTwilio };
