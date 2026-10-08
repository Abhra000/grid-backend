// Grid Matrix Portal API (M-01) — Fastify + PostgreSQL
// Env: DATABASE_URL, JWT_SECRET, PORT (default 8080), CORS_ORIGIN (e.g. https://idealgrid.vercel.app)
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
pg.types.setTypeParser(1082, v => v);            // DATE columns as 'YYYY-MM-DD' (no timezone shift)
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import XLSX from 'xlsx';
import { publish, diffUpload, toRecords, effectiveDates, exportRows } from './lib/rates.js';
import { insurerFilterTable, bestRates } from './lib/snapshot.js';
import { getSnapshot, querySnapshot, facetsSnapshot, clearSnapshots, filterSnapshot, setRtoMaps, rtoMaps } from './lib/snapshot.js';
import { renameInsurers } from './lib/insurers.js';
import { renameProducts } from './lib/products.js';
import { seedRtoMaster, seedLocOverrides, loadMaps, buildWorkbook, saveUpload } from './lib/rtoadmin.js';
import { m365Config, startLogin, finishLogin } from './lib/m365.js';
import { touchVisit, usageReport } from './lib/usage.js';
import { registerAdmin, masterWarnings } from './lib/admin.js';

const { DATABASE_URL, JWT_SECRET, PORT = 8080, CORS_ORIGIN = '' } = process.env;
if (!DATABASE_URL || !JWT_SECRET) { console.error('Set DATABASE_URL and JWT_SECRET'); process.exit(1); }

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 20 });
const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 30 * 1024 * 1024, trustProxy: true });
await app.register(cookie);
await app.register(cors, { origin: CORS_ORIGIN ? CORS_ORIGIN.split(',') : false, credentials: true });
await app.register(rateLimit, { global: false });

/* ---------------- auth ---------------- */
const COOKIE = 'gm_session';
const sign = u => jwt.sign({ id: u.id, role: u.role, email: u.email, mc: !!u.must_change }, JWT_SECRET, { expiresIn: '12h' });
function auth(roles) {
  return async (req, reply) => {
    const tok = req.cookies[COOKIE] || (req.headers.authorization || '').replace(/^Bearer /, '');
    try { req.user = jwt.verify(tok, JWT_SECRET); } catch { return reply.code(401).send({ error: 'Please log in' }); }
    if (req.user.mc && !/^\/api\/(me|auth\/)/.test(req.url)) return reply.code(403).send({ error: 'Please set your own password first', mustChange: true });
    if (roles && !roles.includes(req.user.role)) return reply.code(403).send({ error: 'Not allowed for your role' });
    const m = req.url.match(/^\/api\/lobs\/([^/?]+)\/(config|query|facets|export|suggestions|rates|best)/);      // M-20: hidden grid -> admins only
    if (m && !isAdminUser(req.user) && (await hiddenLobs()).has(decodeURIComponent(m[1]))) return reply.code(404).send({ error: 'Grid not found' });
  };
}
const viewer = auth(['viewer', 'admin', 'superadmin']);
const admin = auth(['admin', 'superadmin']);
const superadmin = auth(['superadmin']);
const audit = (uid, action, detail) => pool.query('INSERT INTO audit_log (user_id, action, detail) VALUES ($1,$2,$3)', [uid, action, detail]).catch(() => {});

app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
  const { email, password } = req.body || {};
  const r = await pool.query('SELECT * FROM users WHERE lower(email)=lower($1) AND active', [String(email || '')]);
  const u = r.rows[0];
  if (!u || !u.pass_hash || !(await bcrypt.compare(String(password || ''), u.pass_hash))) return reply.code(401).send({ error: u && !u.pass_hash ? 'Please use "Sign in with Microsoft"' : 'Wrong email or password' });
  await pool.query('UPDATE users SET last_login=now() WHERE id=$1', [u.id]); audit(u.id, 'login', { via: 'password' });
  touchVisit(pool, u, req, { force: true }).catch(() => {});
  reply.setCookie(COOKIE, sign(u), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 12 * 3600 });
  return { user: { id: u.id, email: u.email, name: u.name, role: u.role, mustChange: !!u.must_change }, token: sign(u) };
});
app.post('/api/auth/logout', async (req, reply) => { reply.clearCookie(COOKIE, { path: '/' }); return { ok: true }; });
app.get('/api/me', { preHandler: viewer }, async req => ({ user: { ...req.user, mustChange: !!req.user.mc } }));
// user changes their own password (optional — the admin's password works straight away)
app.post('/api/auth/change-password', { preHandler: viewer, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
  const { current, password } = req.body || {};
  const u = (await pool.query('SELECT * FROM users WHERE id=$1 AND active', [req.user.id])).rows[0];
  if (!u || !u.pass_hash) return reply.code(400).send({ error: 'This account signs in with Microsoft' });
  if (!(await bcrypt.compare(String(current || ''), u.pass_hash))) return reply.code(400).send({ error: 'Current password is wrong' });
  const pw = String(password || '');
  if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return reply.code(400).send({ error: 'New password: at least 8 characters with letters and numbers' });
  if (await bcrypt.compare(pw, u.pass_hash)) return reply.code(400).send({ error: 'Choose a password different from the temporary one' });
  const nu = (await pool.query('UPDATE users SET pass_hash=$2, must_change=false WHERE id=$1 RETURNING *', [u.id, await bcrypt.hash(pw, 11)])).rows[0];
  audit(u.id, 'password_changed', {});
  reply.setCookie(COOKIE, sign(nu), { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 12 * 3600 });
  return { ok: true };
});

/* ---------------- Microsoft 365 sign-in (M-09) ---------------- */
const M365 = m365Config();
const OIDC = 'gm_oidc';
const cookieOpts = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' };
app.get('/api/auth/providers', async () => ({ m365: !!M365, password: true }));
app.get('/api/auth/m365/login', async (req, reply) => {
  if (!M365) return reply.code(503).send({ error: 'Microsoft sign-in is not configured yet' });
  const { url, memo } = startLogin(M365);
  const next = /^\/(admin|import)?$/.test(String(req.query.next || '')) ? req.query.next : '/';
  reply.setCookie(OIDC, jwt.sign({ ...memo, next }, JWT_SECRET, { expiresIn: '10m' }), { ...cookieOpts, maxAge: 600 });
  return reply.redirect(url);
});
app.get('/api/auth/m365/callback', async (req, reply) => {
  const fail = msg => { reply.clearCookie(OIDC, { path: '/' }); return reply.redirect('/?login_error=' + encodeURIComponent(msg)); };
  if (!M365) return fail('Microsoft sign-in is not configured');
  if (req.query.error) return fail(String(req.query.error_description || req.query.error).split('\n')[0].slice(0, 160));
  let memo; try { memo = jwt.verify(req.cookies[OIDC] || '', JWT_SECRET); } catch { return fail('Sign-in expired, please try again'); }
  try {
    const p = await finishLogin(M365, { code: req.query.code, state: req.query.state }, memo);
    const found = await pool.query('SELECT * FROM users WHERE ms_oid = $1 OR lower(email) = $2 ORDER BY (ms_oid = $1) DESC NULLS LAST LIMIT 1', [p.oid, p.email]);
    let u = found.rows[0];
    if (u && !u.active) return fail('Your access to the Grid Portal is disabled — please contact the admin');
    if (u) u = (await pool.query(`UPDATE users SET ms_oid=$2, name=coalesce(name,$3), email=$4, last_login=now(),
                                   auth_provider=CASE WHEN pass_hash IS NULL THEN 'm365' ELSE auth_provider END
                                   WHERE id=$1 RETURNING *`, [u.id, p.oid, p.name, p.email])).rows[0];
    else u = (await pool.query(`INSERT INTO users (email, name, role, ms_oid, auth_provider, last_login)
                                VALUES ($1,$2,'viewer',$3,'m365',now()) RETURNING *`, [p.email, p.name, p.oid])).rows[0];
    audit(u.id, 'login', { via: 'm365' }); touchVisit(pool, u, req, { force: true }).catch(() => {});
    reply.clearCookie(OIDC, { path: '/' });
    reply.setCookie(COOKIE, sign(u), { ...cookieOpts, maxAge: 12 * 3600 });
    return reply.redirect(memo.next || '/');
  } catch (e) { req.log.warn(e); return fail(e.message || 'Microsoft sign-in failed'); }
});

/* ---------------- usage tracking (M-10) ---------------- */
app.post('/api/visit', { preHandler: viewer }, async req => { await touchVisit(pool, req.user, req, { force: true }); return { ok: true }; });
app.get('/api/admin/usage', { preHandler: auth(['admin', 'superadmin']) }, async req => usageReport(pool, req.query.days));

/* Reads are served from in-memory snapshots (lib/snapshot.js): rates valid on a date are loaded once from
   Postgres and shared by all users; any publish or filter change drops them so nobody sees stale rates. */
const IFIRST = new Map();                                   // M-18: lob -> insurer_first
const OVR = new Map();                                      // M-19: lob -> {ver, map insurer+product -> [cols]}
let OVR_VER = 1;
const clearCache = () => { clearSnapshots(); COLS_CACHE.clear(); IFIRST.clear(); OVR.clear(); OVR_VER++; HIDDEN.t = 0; ACCESS.clear(); ensureStateColumn().catch(() => {}); };   // publish / grid change

/* ---------------- read (viewer) ---------------- */
const isAdminUser = u => u && (u.role === 'admin' || u.role === 'superadmin');
app.get('/api/lobs', { preHandler: viewer }, async () =>          // hidden grids are left out of the viewer for everyone (admins check them in Admin → Preview)
  (await pool.query(`SELECT l.id, l.name, l.rate_col, max(r.effective_from)::text AS latest
                       FROM lobs l LEFT JOIN rates r ON r.lob_id=l.id WHERE NOT l.hidden
                      GROUP BY l.id ORDER BY l.created_at, l.name`)).rows);   // first grid created (Motor) opens first
// M-20: a hidden grid answers only admins
const HIDDEN = { t: 0, set: new Set() };
async function hiddenLobs() {
  if (Date.now() - HIDDEN.t > 15_000) { HIDDEN.set = new Set((await pool.query('SELECT id FROM lobs WHERE hidden')).rows.map(r => r.id)); HIDDEN.t = Date.now(); }
  return HIDDEN.set;
}

const COLS_CACHE = new Map();
async function lobColumns(lobId) {
  if (COLS_CACHE.has(lobId)) return COLS_CACHE.get(lobId);
  const v = await lobColumnsDb(lobId); COLS_CACHE.set(lobId, v); return v;
}
async function lobColumnsDb(lobId) {
  return (await pool.query(`SELECT col, coalesce(label,col) AS label, position, is_filter, visible, is_default
                              FROM lob_columns WHERE lob_id=$1 ORDER BY position, col`, [lobId])).rows;
}
/* M-13: normal users get the DEFAULT filter set; users / roles with "see all filters" get every filter */
const ACCESS = new Map();                                   // userId -> {v, t}, refreshed every 30 s or on change
async function seesAll(user) {
  const c = ACCESS.get(user.id); if (c && Date.now() - c.t < 30_000) return c.v;
  const r = (await pool.query(`SELECT u.all_filters OR u.role IN (SELECT jsonb_array_elements_text(value) FROM settings WHERE key='all_filters_roles') AS v
                                 FROM users u WHERE u.id=$1`, [user.id])).rows[0];
  const v = !!r?.v; ACCESS.set(user.id, { v, t: Date.now() }); return v;
}
async function userColumns(lobId, user) {
  const cols = await lobColumns(lobId);
  if (await seesAll(user)) return cols;
  return cols.map(c => c.is_filter && !c.is_default ? { ...c, is_filter: false } : c);
}
async function allowedFilters(lobId, user, filters) {
  const ok = new Set((await userColumns(lobId, user)).filter(c => c.is_filter).map(c => c.col));
  return Object.fromEntries(Object.entries(filters || {}).filter(([k]) => ok.has(k)));
}
async function insurerFirst(lobId) {
  if (!IFIRST.has(lobId)) IFIRST.set(lobId, !!(await pool.query('SELECT insurer_first FROM lobs WHERE id=$1', [lobId])).rows[0]?.insurer_first);
  return IFIRST.get(lobId);
}
async function overrides(lobId) {
  if (!OVR.has(lobId)) {
    const rows = (await pool.query('SELECT insurer, product, cols FROM insurer_filters WHERE lob_id=$1', [lobId])).rows;
    OVR.set(lobId, { ver: OVR_VER, map: new Map(rows.map(r => [r.insurer + '\u0001' + r.product, r.cols])) });
  }
  return OVR.get(lobId);
}
/* M-19: admin — filters per insurer + product type (automatic unless the admin sets them) */
app.get('/api/admin/lobs/:id/insurer-filters', { preHandler: admin }, async req => {
  const all = (await lobColumns(req.params.id)).filter(c => c.is_filter);
  const cols = all.map(c => c.col);
  const rows = insurerFilterTable(await getSnapshot(pool, req.params.id), cols, (await overrides(req.params.id)).map);
  return { columns: all.map(c => ({ col: c.col, label: c.label })), rows, insurerFirst: await insurerFirst(req.params.id) };
});
app.put('/api/admin/lobs/:id/insurer-filters', { preHandler: admin }, async (req, reply) => {
  const b = req.body || {}, insurer = String(b.insurer || ''), product = String(b.product || '');
  if (!insurer || !product) return reply.code(400).send({ error: 'Insurer and product type are needed' });
  if (b.cols == null) await pool.query('DELETE FROM insurer_filters WHERE lob_id=$1 AND insurer=$2 AND product=$3', [req.params.id, insurer, product]);
  else {
    const ok = new Set((await lobColumns(req.params.id)).filter(c => c.is_filter).map(c => c.col));
    const cols = [...new Set((b.cols || []).map(String))].filter(c => ok.has(c) && !/insurer|company/i.test(c) && !/product\s*type|^product$/i.test(c));
    await pool.query(`INSERT INTO insurer_filters (lob_id, insurer, product, cols) VALUES ($1,$2,$3,$4)
                      ON CONFLICT (lob_id, insurer, product) DO UPDATE SET cols=EXCLUDED.cols, updated_at=now()`, [req.params.id, insurer, product, JSON.stringify(cols)]);
  }
  OVR.delete(req.params.id); OVR_VER++;
  audit(req.user.id, 'insurer_filters', { lob: req.params.id, insurer, product, cols: b.cols ?? 'automatic' });
  return { ok: true };
});
app.get('/api/lobs/:id/config', { preHandler: viewer }, async req => ({ insurerFirst: await insurerFirst(req.params.id),
  columns: await userColumns(req.params.id, req.user), dates: await effectiveDates(pool, req.params.id), allFilters: await seesAll(req.user),
  rtoStates: RTO_STATES() }));
// P-10: RTO code -> State name (viewer picks State automatically when an RTO is chosen)
let rtoStatesCache = null;
const RTO_STATES = () => { const m = rtoMaps(); if (!m) return {}; if (rtoStatesCache?.m === m) return rtoStatesCache.v;
  const v = {}; for (const code of m.master.keys()) v[code] = m.stateName(code); rtoStatesCache = { m, v }; return v; };

// body: { filters:{col:[..]}, asOf:'YYYY-MM-DD', search:'', limit, offset }
app.post('/api/lobs/:id/query', { preHandler: viewer }, async req => {
  const b = { ...(req.body || {}) }; if (!+b.offset) touchVisit(pool, req.user, req).catch(() => {});
  b.filters = await allowedFilters(req.params.id, req.user, b.filters);
  return querySnapshot(await getSnapshot(pool, req.params.id, b.asOf), b);
});

app.post('/api/lobs/:id/facets', { preHandler: viewer }, async req => {
  const b = { ...(req.body || {}) };
  b.filters = await allowedFilters(req.params.id, req.user, b.filters);
  const cols = (await userColumns(req.params.id, req.user)).filter(c => c.is_filter).map(c => c.col);
  b.insurerFirst = await insurerFirst(req.params.id);
  if (b.insurerFirst) { const o = await overrides(req.params.id); b.overrides = o.map; b.ovVer = o.ver; }
  return facetsSnapshot(await getSnapshot(pool, req.params.id, b.asOf), b, cols);
});

// M-22: Best rate — insurers ranked by their highest rate for the chosen product type + location
app.post('/api/lobs/:id/best', { preHandler: viewer }, async req => {
  const b = { ...(req.body || {}) };
  b.filters = await allowedFilters(req.params.id, req.user, b.filters);
  const cols = (await lobColumns(req.params.id)).map(c => c.col);
  return bestRates(await getSnapshot(pool, req.params.id, b.asOf), b, cols);
});
app.post('/api/lobs/:id/export', { preHandler: viewer }, async (req, reply) => {
  const eq = { ...(req.body || {}), filters: await allowedFilters(req.params.id, req.user, (req.body || {}).filters) };
  const rows = filterSnapshot(await getSnapshot(pool, req.params.id, eq.asOf), eq);          // same rules as the screen
  const cols = (await lobColumns(req.params.id)).map(c => c.col);
  const aoa = [[...cols, 'Rate %', 'Previous %', 'Previous till', 'Effective From', 'Effective To', 'Notes'],
    ...rows.map(r => [...cols.map(c => r.params[c] ?? ''), r.rate_text, r.prev_rate && r.prev_rate !== r.rate_text ? r.prev_rate : '',
                      r.prev_rate && r.prev_rate !== r.rate_text ? (r.prev_to || '') : '', r.effective_from, r.effective_to || '', r.notes || ''])];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Rates');
  const fl = Object.entries((req.body || {}).filters || {}).filter(([, v]) => Array.isArray(v) && v.length);
  const info = [['Grid', req.params.id], ['Rates as on', (req.body || {}).asOf || new Date().toISOString().slice(0, 10)], ['Rows', rows.length],
    ['Filters', fl.length || (req.body || {}).search ? '' : 'None — full grid'], ...fl.map(([k, v]) => [k, v.join(', ')]),
    ...((req.body || {}).search ? [['Search', req.body.search]] : []), ['Downloaded', new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'], ['By', req.user.email]];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), 'Filters used');
  audit(req.user.id, 'export', { lob: req.params.id, rows: rows.length, filters: Object.fromEntries(fl) });
  reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
       .header('Content-Disposition', `attachment; filename="${req.params.id}_rates.xlsx"`);
  return reply.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

/* ---------------- write (admin) ---------------- */
// body: { columns:[...], rows:[[...]], rateCol, effectiveFrom:'YYYY-MM-DD', fileName, replaceScope, dryRun }
app.post('/api/lobs/:id/uploads', { preHandler: admin }, async (req, reply) => {
  const b = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.effectiveFrom || '')) return reply.code(400).send({ error: 'Effective From (YYYY-MM-DD) is required' });
  const lob = (await pool.query('SELECT rate_col, columns, name FROM lobs WHERE id=$1', [req.params.id])).rows[0];
  const rateCol = b.rateCol || lob?.rate_col || 'Base Commission %';
  // guard: a file made for another grid (e.g. a Motor file while "Fire" is selected) must not be loaded here
  const own = new Set((lob?.columns || []).map(String)), skip = /insurer|company|note|remark/i;
  const hdr = (b.columns || []).map(String).filter(c => c !== rateCol && !skip.test(c));
  if (own.size && hdr.length && !b.force) {
    const common = hdr.filter(c => own.has(c)).length;
    if (common < Math.min(2, hdr.length)) return reply.code(400).send({ error: `This file's columns do not match the "${lob.name}" grid — wrong grid selected? (file: ${hdr.slice(0, 6).join(', ')}…)` });
  }
  try {
    const { records } = toRecords(b.columns, b.rows, rateCol);
    const warnings = await masterWarnings(pool, req.params.id, records);
    if (b.dryRun) return { ...(await diffUpload(pool, req.params.id, records, b.effectiveFrom)), warnings };
    const res = await publish(pool, { lobId: req.params.id, columns: b.columns, rows: b.rows, rateCol, from: b.effectiveFrom,
                                      fileName: b.fileName, replaceScope: b.replaceScope !== false, userId: req.user.id });
    clearCache(); return { ...res, warnings };
  } catch (e) { return reply.code(400).send({ error: e.message }); }
});

app.get('/api/lobs/:id/uploads', { preHandler: admin }, async req =>
  (await pool.query(`SELECT u.id, u.file_name, u.effective_from::text, u.row_count, u.summary, u.created_at, us.email AS by,
                              (SELECT count(*) FROM rates r WHERE r.upload_id=u.id)::int AS rows_kept
                       FROM uploads u LEFT JOIN users us ON us.id=u.uploaded_by WHERE u.lob_id=$1 ORDER BY u.id DESC LIMIT 100`, [req.params.id])).rows);

// M-06: admin re-arranges / renames / hides filters.  body: [{col, position, label, is_filter, visible}]
app.put('/api/lobs/:id/columns', { preHandler: admin }, async req => {
  for (const c of req.body || []) await pool.query(
    `UPDATE lob_columns SET position=$3, label=$4, is_filter=$5, visible=$6, is_default=$7 WHERE lob_id=$1 AND col=$2`,
    [req.params.id, c.col, +c.position || 0, c.label || null, c.is_filter !== false, c.visible !== false, c.is_default !== false]);
  clearCache(); audit(req.user.id, 'reorder_filters', { lob: req.params.id }); return lobColumns(req.params.id);
});

/* ---------------- users (super admin) ---------------- */
app.get('/api/users', { preHandler: admin }, async () =>
  (await pool.query('SELECT id, email, name, role, active, auth_provider, must_change, last_login FROM users ORDER BY email')).rows);
// Admins add email/password users (viewers); only the super admin can create or change admins.
app.post('/api/users', { preHandler: admin }, async (req, reply) => {
  const { email, name, password, role = 'viewer' } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return reply.code(400).send({ error: 'Enter a valid email' });
  if (String(password || '').length < 8) return reply.code(400).send({ error: 'Temporary password: at least 8 characters' });
  if (!['viewer', 'admin', 'superadmin'].includes(role)) return reply.code(400).send({ error: 'Unknown role' });
  if (role !== 'viewer' && req.user.role !== 'superadmin') return reply.code(403).send({ error: 'Only the super admin can create admins' });
  const ex = (await pool.query('SELECT id, role FROM users WHERE lower(email)=$1', [em])).rows[0];
  if (ex && ex.role !== 'viewer' && req.user.role !== 'superadmin') return reply.code(403).send({ error: 'Only the super admin can change an admin' });
  const r = await pool.query(`INSERT INTO users (email, name, pass_hash, role, must_change, auth_provider) VALUES ($1,$2,$3,$4,false,'password')
                              ON CONFLICT (email) DO UPDATE SET name=coalesce(EXCLUDED.name,users.name), pass_hash=EXCLUDED.pass_hash, role=EXCLUDED.role, active=true, must_change=false
                              RETURNING id, email, role`, [em, name || null, await bcrypt.hash(String(password), 11), role]);
  audit(req.user.id, 'user_save', { email: em, role }); return r.rows[0];
});
// Bulk add / update users from an Excel sheet (admin: viewers only; super admin: any role). dryRun = check only.
// body: { users:[{email, name, role, password, allFilters}], dryRun }
app.post('/api/users/bulk', { preHandler: admin }, async (req, reply) => {
  const b = req.body || {}, list = Array.isArray(b.users) ? b.users : [];
  if (!list.length) return reply.code(400).send({ error: 'No users in the file' });
  if (list.length > 2000) return reply.code(400).send({ error: 'At most 2,000 users per file' });
  const sup = req.user.role === 'superadmin', seen = new Set();
  const existing = new Map((await pool.query('SELECT id, lower(email) AS email, role FROM users')).rows.map(u => [u.email, u]));
  const yes = v => /^(y|yes|true|1)$/i.test(String(v ?? '').trim());
  const rows = list.map((u, i) => {
    const email = String(u.email || '').trim().toLowerCase(), role = String(u.role || 'viewer').trim().toLowerCase().replace(/[\s_-]+/g, '');
    const out = { row: i + 2, email, name: String(u.name || '').trim(), role: role === 'superadmin' ? 'superadmin' : role, password: String(u.password ?? '').trim(), allFilters: yes(u.allFilters) };
    const ex = existing.get(email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) out.error = 'Email is not valid';
    else if (seen.has(email)) out.error = 'Same email twice in the file';
    else if (!['viewer', 'admin', 'superadmin'].includes(out.role)) out.error = 'Role must be viewer, admin or superadmin';
    else if (out.role !== 'viewer' && !sup) out.error = 'Only the super admin can add admins';
    else if (ex && ex.role !== 'viewer' && !sup) out.error = 'Only the super admin can change an admin';
    else if (ex && ex.id === req.user.id) out.error = 'This is your own account — change it from Users';
    else if (out.password && out.password.length < 8) out.error = 'Password: at least 8 characters';
    else if (!ex && !out.password) out.error = 'New user needs a password';
    seen.add(email); out.action = out.error ? 'error' : ex ? 'update' : 'add';
    return out;
  });
  const sum = { add: rows.filter(r => r.action === 'add').length, update: rows.filter(r => r.action === 'update').length, error: rows.filter(r => r.action === 'error').length };
  const strip = r => ({ row: r.row, email: r.email, name: r.name, role: r.role, allFilters: r.allFilters, action: r.action, error: r.error, newPassword: !!r.password });
  if (b.dryRun || sum.error) return { ...sum, saved: false, rows: rows.map(strip) };
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    for (const r of rows) {
      const hash = r.password ? await bcrypt.hash(r.password, 10) : null;
      await db.query(`INSERT INTO users (email, name, pass_hash, role, must_change, auth_provider, all_filters) VALUES ($1,$2,$3,$4,false,'password',$5)
                      ON CONFLICT (email) DO UPDATE SET name=coalesce(nullif(EXCLUDED.name,''),users.name), role=EXCLUDED.role, active=true, all_filters=EXCLUDED.all_filters,
                        pass_hash=coalesce($3,users.pass_hash), must_change=false`,
                     [r.email, r.name || null, hash, r.role, r.allFilters]);
    }
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); return reply.code(400).send({ error: e.message }); } finally { db.release(); }
  ACCESS.clear(); audit(req.user.id, 'users_bulk', sum);
  return { ...sum, saved: true, rows: rows.map(strip) };
});
app.post('/api/users/:uid/reset-password', { preHandler: admin }, async (req, reply) => {
  const t = (await pool.query('SELECT id, role FROM users WHERE id=$1', [req.params.uid])).rows[0];
  if (!t) return reply.code(404).send({ error: 'User not found' });
  if (t.role !== 'viewer' && req.user.role !== 'superadmin') return reply.code(403).send({ error: 'Only the super admin can reset an admin' });
  const pw = String((req.body || {}).password || '');
  if (pw.length < 8) return reply.code(400).send({ error: 'Temporary password: at least 8 characters' });
  await pool.query("UPDATE users SET pass_hash=$2, must_change=false, auth_provider=CASE WHEN auth_provider='m365' THEN 'm365' ELSE 'password' END WHERE id=$1", [t.id, await bcrypt.hash(pw, 11)]);
  audit(req.user.id, 'password_reset', { id: t.id }); return { ok: true };
});
app.patch('/api/users/:uid', { preHandler: admin }, async (req, reply) => {
  const { role, active, all_filters } = req.body || {};
  const t = (await pool.query('SELECT id, role FROM users WHERE id=$1', [req.params.uid])).rows[0];
  if (!t) return reply.code(404).send({ error: 'User not found' });
  if (req.user.role !== 'superadmin' && (role !== undefined || t.role !== 'viewer')) return reply.code(403).send({ error: 'Only the super admin can change roles or admins' });
  if (+req.params.uid === req.user.id) return reply.code(400).send({ error: 'You cannot change your own account here' });
  await pool.query('UPDATE users SET role=coalesce($2,role), active=coalesce($3,active), all_filters=coalesce($4,all_filters) WHERE id=$1',
                   [req.params.uid, role ?? null, active ?? null, typeof all_filters === 'boolean' ? all_filters : null]);
  ACCESS.delete(+req.params.uid);
  audit(req.user.id, 'user_update', { id: req.params.uid, role, active, all_filters }); return { ok: true };
});

// M-13: which roles see every filter (default: admin + super admin)
app.get('/api/admin/filter-access', { preHandler: admin }, async () =>
  ({ roles: (await pool.query(`SELECT value FROM settings WHERE key='all_filters_roles'`)).rows[0]?.value || [] }));
app.put('/api/admin/filter-access', { preHandler: admin }, async req => {
  const roles = ((req.body || {}).roles || []).filter(r => ['viewer', 'admin', 'superadmin'].includes(r));
  await pool.query(`INSERT INTO settings (key, value) VALUES ('all_filters_roles', $1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(roles)]);
  ACCESS.clear(); audit(req.user.id, 'filter_access', { roles }); return { roles };
});

registerAdmin(app, { pool, viewer, admin, superadmin, audit, clearCache, lobColumns });

/* ---------- P-10: RTO master (download → edit in Excel → upload) ---------- */
app.get('/api/admin/rto-master/export', { preHandler: admin }, async (req, reply) => {
  const { buf } = await buildWorkbook(pool, rtoMaps() || await loadMaps(pool));
  reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
       .header('Content-Disposition', 'attachment; filename="RTO_Master.xlsx"');
  return reply.send(buf);
});
app.get('/api/admin/rto-master/stats', { preHandler: admin }, async () => (await buildWorkbook(pool, rtoMaps() || await loadMaps(pool))).stats);
app.post('/api/admin/rto-master', { preHandler: admin }, async (req, reply) => {
  try {
    const res = await saveUpload(pool, req.body || {}, req.user.id);
    setRtoMaps(await loadMaps(pool)); clearCache();
    return { ok: true, ...res };
  } catch (e) { return reply.code(400).send({ error: e.message }); }
});

/* P-04: every grid with a Location column gets a "State" filter (worked out from Location), placed just before Location */
async function ensureStateColumn() {
  const r = await pool.query(`SELECT l.lob_id, l.position FROM lob_columns l WHERE lower(l.col)='location'
                                AND NOT EXISTS (SELECT 1 FROM lob_columns s WHERE s.lob_id=l.lob_id AND lower(s.col)='state')`);
  for (const x of r.rows) {
    await pool.query('UPDATE lob_columns SET position=position+1 WHERE lob_id=$1 AND position>=$2', [x.lob_id, x.position]);
    await pool.query(`INSERT INTO lob_columns (lob_id, col, position) VALUES ($1,'State',$2) ON CONFLICT DO NOTHING`, [x.lob_id, x.position]);
  }
  if (r.rows.length) { clearSnapshots(); COLS_CACHE.clear(); }
}


app.get('/api/health', async () => { await pool.query('select 1'); return { ok: true }; });
import fsImport from 'node:fs';
app.get('/import', async (req, reply) => reply.redirect('/admin#lobs'));   // old temporary uploader -> full admin
// M-02: viewer for users at "/" ; admin screens come at /admin (M-03..M-07) — until then /admin opens the upload tool
const VIEWER_HTML = fsImport.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const noCache = r => r.header('Cache-Control', 'no-cache');
app.get('/', async (req, reply) => noCache(reply).type('text/html; charset=utf-8').send(VIEWER_HTML));
const ADMIN_HTML = fsImport.readFileSync(new URL('./public/admin.html', import.meta.url), 'utf8');
app.get('/admin', async (req, reply) => noCache(reply).type('text/html; charset=utf-8').send(ADMIN_HTML));

try {                                                        // keep the database up to date on every start (all statements are safe to re-run)
  const sf = [new URL('../db/schema.sql', import.meta.url), new URL('/db/schema.sql', 'file:///')].find(u => fsImport.existsSync(u));
  if (sf) await pool.query(fsImport.readFileSync(sf, 'utf8'));
} catch (e) { console.warn('schema:', e.message); }
await ensureStateColumn().catch(e => console.warn('State column:', e.message));
try { const r = await renameProducts(pool); if (r) console.log('Product types renamed:', JSON.stringify(r)); } catch (e) { console.warn('Product rename:', e.message); }
try { const r = await renameInsurers(pool); if (r) console.log('Insurer names cleaned:', JSON.stringify(r)); } catch (e) { console.warn('Insurer rename:', e.message); }
try { await seedRtoMaster(pool); const n = await seedLocOverrides(pool); if (n) console.log('RTO lists added for', n, 'insurer locations'); setRtoMaps(await loadMaps(pool)); } catch (e) { console.warn('RTO master:', e.message); }
if (process.env.NODE_ENV !== 'test') app.listen({ port: +PORT, host: process.env.HOST || '127.0.0.1' }).then(() => console.log('API on :' + PORT));
export default app;
