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

const { DATABASE_URL, JWT_SECRET, PORT = 8080, CORS_ORIGIN = '' } = process.env;
if (!DATABASE_URL || !JWT_SECRET) { console.error('Set DATABASE_URL and JWT_SECRET'); process.exit(1); }

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 20 });
const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 30 * 1024 * 1024, trustProxy: true });
await app.register(cookie);
await app.register(cors, { origin: CORS_ORIGIN ? CORS_ORIGIN.split(',') : false, credentials: true });
await app.register(rateLimit, { global: false });

/* ---------------- auth ---------------- */
const COOKIE = 'gm_session';
const sign = u => jwt.sign({ id: u.id, role: u.role, email: u.email }, JWT_SECRET, { expiresIn: '12h' });
function auth(roles) {
  return async (req, reply) => {
    const tok = req.cookies[COOKIE] || (req.headers.authorization || '').replace(/^Bearer /, '');
    try { req.user = jwt.verify(tok, JWT_SECRET); } catch { return reply.code(401).send({ error: 'Please log in' }); }
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
  if (!u || !(await bcrypt.compare(String(password || ''), u.pass_hash))) return reply.code(401).send({ error: 'Wrong email or password' });
  await pool.query('UPDATE users SET last_login=now() WHERE id=$1', [u.id]); audit(u.id, 'login', {});
  reply.setCookie(COOKIE, sign(u), { httpOnly: true, secure: true, sameSite: 'none', path: '/', maxAge: 12 * 3600 });
  return { user: { id: u.id, email: u.email, name: u.name, role: u.role }, token: sign(u) };
});
app.post('/api/auth/logout', async (req, reply) => { reply.clearCookie(COOKIE, { path: '/' }); return { ok: true }; });
app.get('/api/me', { preHandler: viewer }, async req => ({ user: req.user }));

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
  const b = req.body || {}; return querySnapshot(await getSnapshot(pool, req.params.id, b.asOf), b);
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
app.get('/api/users', { preHandler: superadmin }, async () =>
  (await pool.query('SELECT id, email, name, role, active, last_login FROM users ORDER BY email')).rows);
app.post('/api/users', { preHandler: superadmin }, async (req, reply) => {
  const { email, name, password, role = 'viewer' } = req.body || {};
  if (!email || !password || String(password).length < 8) return reply.code(400).send({ error: 'Email and a password of 8+ characters are required' });
  const r = await pool.query(`INSERT INTO users (email, name, pass_hash, role) VALUES ($1,$2,$3,$4)
                              ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, pass_hash=EXCLUDED.pass_hash, role=EXCLUDED.role, active=true
                              RETURNING id, email, role`, [email, name || null, await bcrypt.hash(String(password), 11), role]);
  audit(req.user.id, 'user_save', { email, role }); return r.rows[0];
});
app.patch('/api/users/:uid', { preHandler: superadmin }, async req => {
  const { role, active } = req.body || {};
  await pool.query('UPDATE users SET role=coalesce($2,role), active=coalesce($3,active) WHERE id=$1', [req.params.uid, role ?? null, active ?? null]);
  audit(req.user.id, 'user_update', { id: req.params.uid, role, active }); return { ok: true };
});

app.get('/api/health', async () => { await pool.query('select 1'); return { ok: true }; });
// one-page admin upload tool (used until the new admin screens of M-02..M-07 are live)
import fsImport from 'node:fs';
const IMPORT_HTML = fsImport.readFileSync(new URL('./public/import.html', import.meta.url), 'utf8');
app.get('/import', async (req, reply) => reply.type('text/html; charset=utf-8').send(IMPORT_HTML));

if (process.env.NODE_ENV !== 'test') app.listen({ port: +PORT, host: process.env.HOST || '127.0.0.1' }).then(() => console.log('API on :' + PORT));
export default app;
