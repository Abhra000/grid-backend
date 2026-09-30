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
import { getSnapshot, querySnapshot, facetsSnapshot, clearSnapshots } from './lib/snapshot.js';
import { m365Config, startLogin, finishLogin } from './lib/m365.js';
import { touchVisit, usageReport } from './lib/usage.js';

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
// user sets their own password (required after the admin creates / resets the account)
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
const clearCache = () => { clearSnapshots(); COLS_CACHE.clear(); };

/* ---------------- read (viewer) ---------------- */
app.get('/api/lobs', { preHandler: viewer }, async () =>
  (await pool.query(`SELECT l.id, l.name, l.rate_col, max(r.effective_from)::text AS latest
                       FROM lobs l LEFT JOIN rates r ON r.lob_id=l.id GROUP BY l.id ORDER BY l.name`)).rows);

const COLS_CACHE = new Map();
async function lobColumns(lobId) {
  if (COLS_CACHE.has(lobId)) return COLS_CACHE.get(lobId);
  const v = await lobColumnsDb(lobId); COLS_CACHE.set(lobId, v); return v;
}
async function lobColumnsDb(lobId) {
  return (await pool.query(`SELECT col, coalesce(label,col) AS label, position, is_filter, visible
                              FROM lob_columns WHERE lob_id=$1 ORDER BY position, col`, [lobId])).rows;
}
app.get('/api/lobs/:id/config', { preHandler: viewer }, async req => ({
  columns: await lobColumns(req.params.id), dates: await effectiveDates(pool, req.params.id) }));

// body: { filters:{col:[..]}, asOf:'YYYY-MM-DD', search:'', limit, offset }
app.post('/api/lobs/:id/query', { preHandler: viewer }, async req => {
  const b = req.body || {}; if (!+b.offset) touchVisit(pool, req.user, req).catch(() => {});
  return querySnapshot(await getSnapshot(pool, req.params.id, b.asOf), b);
});

app.post('/api/lobs/:id/facets', { preHandler: viewer }, async req => {
  const b = req.body || {};
  const cols = (await lobColumns(req.params.id)).filter(c => c.is_filter).map(c => c.col);
  return facetsSnapshot(await getSnapshot(pool, req.params.id, b.asOf), b, cols);
});

app.post('/api/lobs/:id/export', { preHandler: viewer }, async (req, reply) => {
  const rows = await exportRows(pool, req.params.id, req.body || {});
  const cols = (await lobColumns(req.params.id)).map(c => c.col);
  const aoa = [[...cols, 'Rate %', 'Effective From', 'Effective To', 'Notes'],
    ...rows.map(r => [...cols.map(c => r.params[c] ?? ''), r.rate_text, r.effective_from, r.effective_to || '', r.notes || ''])];
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Rates');
  audit(req.user.id, 'export', { lob: req.params.id, rows: rows.length });
  reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
       .header('Content-Disposition', `attachment; filename="${req.params.id}_rates.xlsx"`);
  return reply.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
});

/* ---------------- write (admin) ---------------- */
// body: { columns:[...], rows:[[...]], rateCol, effectiveFrom:'YYYY-MM-DD', fileName, replaceScope, dryRun }
app.post('/api/lobs/:id/uploads', { preHandler: admin }, async (req, reply) => {
  const b = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.effectiveFrom || '')) return reply.code(400).send({ error: 'Effective From (YYYY-MM-DD) is required' });
  const rateCol = b.rateCol || 'Base Commission %';
  try {
    if (b.dryRun) { const { records } = toRecords(b.columns, b.rows, rateCol); return diffUpload(pool, req.params.id, records, b.effectiveFrom); }
    const res = await publish(pool, { lobId: req.params.id, columns: b.columns, rows: b.rows, rateCol, from: b.effectiveFrom,
                                      fileName: b.fileName, replaceScope: b.replaceScope !== false, userId: req.user.id });
    clearCache(); return res;
  } catch (e) { return reply.code(400).send({ error: e.message }); }
});

app.get('/api/lobs/:id/uploads', { preHandler: admin }, async req =>
  (await pool.query(`SELECT u.id, u.file_name, u.effective_from::text, u.row_count, u.summary, u.created_at, us.email AS by
                       FROM uploads u LEFT JOIN users us ON us.id=u.uploaded_by WHERE u.lob_id=$1 ORDER BY u.id DESC LIMIT 100`, [req.params.id])).rows);

// M-06: admin re-arranges / renames / hides filters.  body: [{col, position, label, is_filter, visible}]
app.put('/api/lobs/:id/columns', { preHandler: admin }, async req => {
  for (const c of req.body || []) await pool.query(
    `UPDATE lob_columns SET position=$3, label=$4, is_filter=$5, visible=$6 WHERE lob_id=$1 AND col=$2`,
    [req.params.id, c.col, +c.position || 0, c.label || null, c.is_filter !== false, c.visible !== false]);
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
  const r = await pool.query(`INSERT INTO users (email, name, pass_hash, role, must_change, auth_provider) VALUES ($1,$2,$3,$4,true,'password')
                              ON CONFLICT (email) DO UPDATE SET name=coalesce(EXCLUDED.name,users.name), pass_hash=EXCLUDED.pass_hash, role=EXCLUDED.role, active=true, must_change=true
                              RETURNING id, email, role`, [em, name || null, await bcrypt.hash(String(password), 11), role]);
  audit(req.user.id, 'user_save', { email: em, role }); return r.rows[0];
});
app.post('/api/users/:uid/reset-password', { preHandler: admin }, async (req, reply) => {
  const t = (await pool.query('SELECT id, role FROM users WHERE id=$1', [req.params.uid])).rows[0];
  if (!t) return reply.code(404).send({ error: 'User not found' });
  if (t.role !== 'viewer' && req.user.role !== 'superadmin') return reply.code(403).send({ error: 'Only the super admin can reset an admin' });
  const pw = String((req.body || {}).password || '');
  if (pw.length < 8) return reply.code(400).send({ error: 'Temporary password: at least 8 characters' });
  await pool.query("UPDATE users SET pass_hash=$2, must_change=true, auth_provider=CASE WHEN auth_provider='m365' THEN 'm365' ELSE 'password' END WHERE id=$1", [t.id, await bcrypt.hash(pw, 11)]);
  audit(req.user.id, 'password_reset', { id: t.id }); return { ok: true };
});
app.patch('/api/users/:uid', { preHandler: admin }, async (req, reply) => {
  const { role, active } = req.body || {};
  const t = (await pool.query('SELECT id, role FROM users WHERE id=$1', [req.params.uid])).rows[0];
  if (!t) return reply.code(404).send({ error: 'User not found' });
  if (req.user.role !== 'superadmin' && (role !== undefined || t.role !== 'viewer')) return reply.code(403).send({ error: 'Only the super admin can change roles or admins' });
  if (+req.params.uid === req.user.id) return reply.code(400).send({ error: 'You cannot change your own account here' });
  await pool.query('UPDATE users SET role=coalesce($2,role), active=coalesce($3,active) WHERE id=$1', [req.params.uid, role ?? null, active ?? null]);
  audit(req.user.id, 'user_update', { id: req.params.uid, role, active }); return { ok: true };
});

app.get('/api/health', async () => { await pool.query('select 1'); return { ok: true }; });
// one-page admin upload tool (used until the new admin screens of M-02..M-07 are live)
import fsImport from 'node:fs';
const IMPORT_HTML = fsImport.readFileSync(new URL('./public/import.html', import.meta.url), 'utf8');
app.get('/import', async (req, reply) => reply.type('text/html; charset=utf-8').send(IMPORT_HTML));
// M-02: viewer for users at "/" ; admin screens come at /admin (M-03..M-07) — until then /admin opens the upload tool
const VIEWER_HTML = fsImport.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const noCache = r => r.header('Cache-Control', 'no-cache');
app.get('/', async (req, reply) => noCache(reply).type('text/html; charset=utf-8').send(VIEWER_HTML));
const ADMIN_HTML = fsImport.readFileSync(new URL('./public/admin.html', import.meta.url), 'utf8');
app.get('/admin', async (req, reply) => noCache(reply).type('text/html; charset=utf-8').send(ADMIN_HTML));

if (process.env.NODE_ENV !== 'test') app.listen({ port: +PORT, host: process.env.HOST || '127.0.0.1' }).then(() => console.log('API on :' + PORT));
export default app;
