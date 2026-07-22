/**
 * auth.js — shared session verification for Tampa Bay Mahj.
 * Token scheme matches accounts.js exactly, so a session set at login
 * validates everywhere (dashboard, scheduling, CRM, profile).
 */
const crypto = require('crypto');
const SECRET = process.env.SESSION_SECRET || process.env.DASHBOARD_PASSWORD || 'tbm-session-fallback-2026';
const COOKIE = 'tbm_session';

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('='); if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
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
module.exports = { parseCookies, verifyToken, currentUser, requireAuth, requireOwner, COOKIE };
