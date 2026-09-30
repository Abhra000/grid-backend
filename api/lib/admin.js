// M-12: full admin — LOB templates, one-rate edits, upload history download, masters, "suggest a rate" approvals.
import XLSX from 'xlsx';
import { splitColumns, fmtRate, rateNum } from './rates.js';

const isAll = v => String(v ?? '').trim().toLowerCase() === 'all';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const xlsxReply = (reply, aoa, name, sheet = 'Rates') => {
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet);
  reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
       .header('Content-Disposition', `attachment; filename="${String(name).replace(/[^\w.\-]+/g, '_')}"`);
  return reply.send(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
};

/** Change ONE rate from a date. Same date as the running period -> corrected in place; later date -> the running
 *  period ends the day before and a new period starts (so the old % shows as "previous"). */
export async function editRate(pool, { lobId, rateId, rowKey, from, rate, notes, userId, source = 'Manual edit' }) {
  if (!DATE_RE.test(from || '')) throw new Error('Effective From (YYYY-MM-DD) is required');
  const rt = fmtRate(rate);
  if (!rt) throw new Error('Enter the new rate');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    if (!rowKey) {
      const r0 = (await db.query('SELECT row_key FROM rates WHERE id=$1 AND lob_id=$2', [rateId, lobId])).rows[0];
      if (!r0) throw new Error('Rate row not found');
      rowKey = r0.row_key;
    }
    const cur = (await db.query(`SELECT * FROM rates WHERE lob_id=$1 AND row_key=$2 AND period @> $3::date
                                  ORDER BY effective_from DESC LIMIT 1 FOR UPDATE`, [lobId, rowKey, from])).rows[0];
    if (!cur) throw new Error('No rate of this row is valid on ' + from + ' — use an upload for that date instead');
    const nn = notes === undefined || notes === null ? cur.notes : String(notes).trim();
    const up = (await db.query(`INSERT INTO uploads (lob_id, file_name, effective_from, replace_scope, row_count, summary, uploaded_by)
                                VALUES ($1,$2,$3,false,1,$4,$5) RETURNING id`,
                               [lobId, source, from, { manual: true, rateId: cur.id, params: cur.params, from: cur.rate_text, to: rt }, userId])).rows[0];
    let id;
    if (cur.effective_from === from) {
      await db.query('UPDATE rates SET rate_text=$2, rate_num=$3, notes=$4, upload_id=$5 WHERE id=$1', [cur.id, rt, rateNum(rt), nn, up.id]);
      id = cur.id;
    } else {
      await db.query(`UPDATE rates SET effective_to = ($2::date - 1) WHERE id=$1`, [cur.id, from]);
      id = (await db.query(`INSERT INTO rates (lob_id, upload_id, insurer, product_type, params, row_key, rate_text, rate_num, notes, effective_from, effective_to)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
                           [lobId, up.id, cur.insurer, cur.product_type, cur.params, cur.row_key, rt, rateNum(rt), nn, from, cur.effective_to])).rows[0].id;
    }
    await db.query(`INSERT INTO audit_log (user_id, action, detail) VALUES ($1,'edit_rate',$2)`,
                   [userId, { lobId, rateId: cur.id, newId: id, from, old: cur.rate_text, new: rt, source }]);
    await db.query('COMMIT');
    return { id, old: cur.rate_text, rate: rt, from, inPlace: cur.effective_from === from };
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }
}

/** Upload values that are not in the masters (only for columns that have a master list) */
export async function masterWarnings(pool, lobId, records) {
  const m = (await pool.query('SELECT col, array_agg(value) AS v FROM masters WHERE lob_id=$1 GROUP BY col', [lobId])).rows;
  const out = [];
  for (const { col, v } of m) {
    const set = new Set(v.map(x => x.toLowerCase())), bad = new Map();
    for (const r of records) {
      const val = r.params[col]; if (val == null || isAll(val) || set.has(String(val).toLowerCase())) continue;
      bad.set(val, (bad.get(val) || 0) + 1);
    }
    if (bad.size) out.push({ col, values: [...bad.keys()].slice(0, 40), rows: [...bad.values()].reduce((a, b) => a + b, 0), distinct: bad.size });
  }
  return out;
}

export function registerAdmin(app, { pool, viewer, admin, superadmin, audit, clearCache, lobColumns }) {
  const J = { 'content-type': 'application/json' };

  /* ---------- LOB templates ---------- */
  app.get('/api/admin/lobs', { preHandler: admin }, async () =>
    (await pool.query(`SELECT l.id, l.name, l.rate_col, l.columns, l.description, l.created_at,
                              (SELECT count(*) FROM rates r WHERE r.lob_id=l.id AND r.period @> current_date)::int AS live_rows,
                              (SELECT count(*) FROM rates r WHERE r.lob_id=l.id)::int AS all_rows,
                              (SELECT max(effective_from)::text FROM rates r WHERE r.lob_id=l.id) AS latest,
                              (SELECT count(*) FROM uploads u WHERE u.lob_id=l.id)::int AS uploads
                         FROM lobs l ORDER BY l.name`)).rows);

  async function saveColumns(db, lobId, columns, rateCol) {
    const { paramCols } = splitColumns(columns, rateCol);                 // validates rate + insurer columns
    await db.query(`INSERT INTO lob_columns (lob_id, col, position)
                    SELECT $1, c, ord FROM unnest($2::text[]) WITH ORDINALITY AS t(c, ord) ON CONFLICT DO NOTHING`, [lobId, paramCols]);
    await db.query(`DELETE FROM lob_columns WHERE lob_id=$1 AND NOT (col = ANY($2))`, [lobId, paramCols]);
  }
  const cleanCols = c => [...new Set((Array.isArray(c) ? c : String(c || '').split(/\n|,/)).map(x => String(x).trim()).filter(Boolean))];

  app.post('/api/lobs', { preHandler: admin }, async (req, reply) => {
    const b = req.body || {};
    const name = String(b.name || '').trim(); const id = slug(b.id || name);
    const rateCol = String(b.rateCol || 'Base Commission %').trim();
    const columns = cleanCols(b.columns);
    if (!name || !id) return reply.code(400).send({ error: 'Enter a name for the grid' });
    if (!columns.includes(rateCol)) columns.push(rateCol);
    try {
      splitColumns(columns, rateCol);
      if ((await pool.query('SELECT 1 FROM lobs WHERE id=$1', [id])).rowCount) return reply.code(400).send({ error: 'A grid with this id already exists: ' + id });
      await pool.query('INSERT INTO lobs (id, name, rate_col, columns, description) VALUES ($1,$2,$3,$4,$5)', [id, name, rateCol, JSON.stringify(columns), b.description || null]);
      await saveColumns(pool, id, columns, rateCol);
    } catch (e) { return reply.code(400).send({ error: e.message }); }
    clearCache(); audit(req.user.id, 'lob_add', { id, name }); return { id, name, rate_col: rateCol, columns };
  });

  app.patch('/api/lobs/:id', { preHandler: admin }, async (req, reply) => {
    const b = req.body || {};
    const cur = (await pool.query('SELECT * FROM lobs WHERE id=$1', [req.params.id])).rows[0];
    if (!cur) return reply.code(404).send({ error: 'Grid not found' });
    const rateCol = String(b.rateCol || cur.rate_col).trim();
    const columns = b.columns ? cleanCols(b.columns) : cur.columns;
    if (!columns.includes(rateCol)) columns.push(rateCol);
    try {
      splitColumns(columns, rateCol);
      await pool.query('UPDATE lobs SET name=$2, rate_col=$3, columns=$4, description=$5 WHERE id=$1',
                       [cur.id, String(b.name || cur.name).trim(), rateCol, JSON.stringify(columns), b.description ?? cur.description]);
      if (b.columns) await saveColumns(pool, cur.id, columns, rateCol);
    } catch (e) { return reply.code(400).send({ error: e.message }); }
    clearCache(); audit(req.user.id, 'lob_edit', { id: cur.id }); return { ok: true };
  });

  app.delete('/api/lobs/:id', { preHandler: superadmin }, async (req, reply) => {
    const n = (await pool.query('SELECT count(*)::int AS n FROM rates WHERE lob_id=$1', [req.params.id])).rows[0].n;
    if (n) return reply.code(400).send({ error: `This grid has ${n} rate rows — it cannot be deleted` });
    await pool.query('DELETE FROM lobs WHERE id=$1', [req.params.id]);
    clearCache(); audit(req.user.id, 'lob_delete', { id: req.params.id }); return { ok: true };
  });

  app.get('/api/lobs/:id/template', { preHandler: admin }, async (req, reply) => {
    const l = (await pool.query('SELECT * FROM lobs WHERE id=$1', [req.params.id])).rows[0];
    if (!l) return reply.code(404).send({ error: 'Grid not found' });
    return xlsxReply(reply, [l.columns], `${l.id}_template.xlsx`, 'Grid');
  });

  // admin filter settings: every column (visible or not)
  app.get('/api/lobs/:id/columns', { preHandler: admin }, async req =>
    (await pool.query(`SELECT col, label, position, is_filter, visible FROM lob_columns WHERE lob_id=$1 ORDER BY position, col`, [req.params.id])).rows);

  /* ---------- upload history ---------- */
  app.get('/api/lobs/:id/uploads/:uid/download', { preHandler: admin }, async (req, reply) => {
    const u = (await pool.query('SELECT * FROM uploads WHERE id=$1 AND lob_id=$2', [req.params.uid, req.params.id])).rows[0];
    if (!u) return reply.code(404).send({ error: 'Upload not found' });
    const rows = (await pool.query(`SELECT params, rate_text, notes, effective_from::text AS f, effective_to::text AS t FROM rates
                                     WHERE upload_id=$1 ORDER BY (rate_num = 0), insurer, product_type, id`, [u.id])).rows;
    const lob = (await pool.query('SELECT rate_col FROM lobs WHERE id=$1', [u.lob_id])).rows[0];
    const cols = (Array.isArray(u.columns) ? u.columns : (await lobColumns(u.lob_id)).map(c => c.col)).filter(c => c !== lob.rate_col && !/note|remark|condition|caps/i.test(c));
    const aoa = [[...cols, lob.rate_col, 'Notes', 'Effective From', 'Effective To'],
      ...rows.map(r => [...cols.map(c => r.params[c] ?? ''), r.rate_text, r.notes || '', r.f, r.t || ''])];
    return xlsxReply(reply, aoa, `${u.lob_id}_upload${u.id}_${u.effective_from}.xlsx`);
  });

  /* ---------- one rate: history + edit ---------- */
  app.get('/api/lobs/:id/rates/:rid/history', { preHandler: viewer }, async (req, reply) => {
    const r = (await pool.query(`SELECT r.id, r.rate_text, r.notes, r.effective_from::text AS effective_from, r.effective_to::text AS effective_to, u.file_name
                                   FROM rates r LEFT JOIN uploads u ON u.id=r.upload_id
                                  WHERE r.lob_id=$1 AND r.row_key=(SELECT row_key FROM rates WHERE id=$2 AND lob_id=$1)
                                  ORDER BY r.effective_from DESC LIMIT 50`, [req.params.id, req.params.rid])).rows;
    if (!r.length) return reply.code(404).send({ error: 'Rate not found' });
    if (req.user.role === 'viewer') r.forEach(x => delete x.file_name);
    return r;
  });
  app.post('/api/lobs/:id/rates/:rid/edit', { preHandler: admin }, async (req, reply) => {
    const b = req.body || {};
    try {
      const res = await editRate(pool, { lobId: req.params.id, rateId: req.params.rid, from: b.effectiveFrom, rate: b.rate, notes: b.notes, userId: req.user.id });
      clearCache(); return res;
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });

  /* ---------- masters ---------- */
  app.get('/api/lobs/:id/masters', { preHandler: admin }, async req => {
    const cols = await lobColumns(req.params.id);
    const [m, live] = await Promise.all([
      pool.query('SELECT col, value FROM masters WHERE lob_id=$1 ORDER BY col, value', [req.params.id]),
      pool.query(`SELECT kv.key AS col, kv.value, count(*)::int AS n FROM rates r CROSS JOIN LATERAL jsonb_each_text(r.params) kv
                   WHERE r.lob_id=$1 AND r.period @> current_date GROUP BY 1, 2`, [req.params.id])]);
    return cols.map(c => {
      const values = m.rows.filter(x => x.col === c.col).map(x => x.value);
      const lv = live.rows.filter(x => x.col === c.col && !isAll(x.value)).map(x => ({ value: x.value, rows: x.n }))
                      .sort((a, b) => a.value.localeCompare(b.value, 'en', { numeric: true }));
      const set = new Set(values.map(v => v.toLowerCase()));
      return { col: c.col, label: c.label, values, live: lv, unknown: values.length ? lv.filter(x => !set.has(x.value.toLowerCase())).map(x => x.value) : [] };
    });
  });
  app.put('/api/lobs/:id/masters', { preHandler: admin }, async (req, reply) => {
    const { col, values } = req.body || {};
    if (!col) return reply.code(400).send({ error: 'col is required' });
    const vals = [...new Set((values || []).map(v => String(v).trim()).filter(v => v && !isAll(v)))];
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('DELETE FROM masters WHERE lob_id=$1 AND col=$2', [req.params.id, col]);
      if (vals.length) await db.query('INSERT INTO masters (lob_id, col, value) SELECT $1, $2, unnest($3::text[])', [req.params.id, col, vals]);
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); return reply.code(400).send({ error: e.message }); } finally { db.release(); }
    audit(req.user.id, 'masters_save', { lob: req.params.id, col, n: vals.length }); return { ok: true, count: vals.length };
  });

  /* ---------- suggest a rate / approvals ---------- */
  app.post('/api/lobs/:id/suggestions', { preHandler: viewer, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = req.body || {};
    const sr = fmtRate(b.suggestedRate);
    if (!sr) return reply.code(400).send({ error: 'Enter the rate you suggest' });
    if (b.effectiveFrom && !DATE_RE.test(b.effectiveFrom)) return reply.code(400).send({ error: 'Bad date' });
    const r = (await pool.query('SELECT id, row_key, params, rate_text FROM rates WHERE id=$1 AND lob_id=$2', [b.rateId, req.params.id])).rows[0];
    if (!r) return reply.code(404).send({ error: 'Rate not found' });
    if (sr === r.rate_text && !String(b.note || '').trim()) return reply.code(400).send({ error: 'That is the current rate — add a note if something else is wrong' });
    const s = (await pool.query(`INSERT INTO suggestions (lob_id, rate_id, row_key, params, current_rate, suggested_rate, effective_from, note, user_id)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
                                [req.params.id, r.id, r.row_key, r.params, r.rate_text, sr, b.effectiveFrom || null, String(b.note || '').slice(0, 1000), req.user.id])).rows[0];
    audit(req.user.id, 'suggest', { id: s.id }); return { ok: true, id: s.id };
  });
  app.get('/api/suggestions/mine', { preHandler: viewer }, async req =>
    (await pool.query(`SELECT s.id, s.lob_id, s.params, s.current_rate, s.suggested_rate, s.effective_from::text AS effective_from, s.note, s.status,
                              s.created_at, s.decided_at, s.decision_note, s.applied_rate
                         FROM suggestions s WHERE s.user_id=$1 ORDER BY s.id DESC LIMIT 50`, [req.user.id])).rows);
  app.get('/api/suggestions/count', { preHandler: admin }, async () =>
    (await pool.query(`SELECT count(*)::int AS pending FROM suggestions WHERE status='pending'`)).rows[0]);
  app.get('/api/suggestions', { preHandler: admin }, async req => {
    const st = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    return (await pool.query(`SELECT s.*, s.effective_from::text AS effective_from, l.name AS lob_name, u.email AS by_email, u.name AS by_name, d.email AS decided_email,
                                     (SELECT rate_text FROM rates r WHERE r.lob_id=s.lob_id AND r.row_key=s.row_key AND r.period @> current_date LIMIT 1) AS live_rate
                                FROM suggestions s LEFT JOIN lobs l ON l.id=s.lob_id LEFT JOIN users u ON u.id=s.user_id LEFT JOIN users d ON d.id=s.decided_by
                               WHERE s.status=$1 ORDER BY s.id DESC LIMIT 300`, [st])).rows;
  });
  app.post('/api/suggestions/:sid/approve', { preHandler: admin }, async (req, reply) => {
    const b = req.body || {};
    const s = (await pool.query(`SELECT *, effective_from::text AS ef FROM suggestions WHERE id=$1`, [req.params.sid])).rows[0];
    if (!s) return reply.code(404).send({ error: 'Suggestion not found' });
    if (s.status !== 'pending') return reply.code(400).send({ error: 'Already ' + s.status });
    const from = b.effectiveFrom || s.ef || today();
    const rate = b.rate || s.suggested_rate;
    try {
      const res = await editRate(pool, { lobId: s.lob_id, rowKey: s.row_key, from, rate, userId: req.user.id, source: `Approved suggestion #${s.id}` });
      await pool.query(`UPDATE suggestions SET status='approved', decided_by=$2, decided_at=now(), decision_note=$3, applied_rate=$4, effective_from=$5 WHERE id=$1`,
                       [s.id, req.user.id, b.note || null, res.rate, from]);
      clearCache(); audit(req.user.id, 'suggest_approve', { id: s.id }); return { ok: true, ...res };
    } catch (e) { return reply.code(400).send({ error: e.message }); }
  });
  app.post('/api/suggestions/:sid/reject', { preHandler: admin }, async (req, reply) => {
    const r = await pool.query(`UPDATE suggestions SET status='rejected', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1 AND status='pending'`,
                               [req.params.sid, req.user.id, (req.body || {}).note || null]);
    if (!r.rowCount) return reply.code(400).send({ error: 'Not pending' });
    audit(req.user.id, 'suggest_reject', { id: req.params.sid }); return { ok: true };
  });

  /* ---------- audit trail (latest 200) ---------- */
  app.get('/api/admin/audit', { preHandler: admin }, async () =>
    (await pool.query(`SELECT a.at, a.action, a.detail, u.email FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
                        WHERE a.action NOT IN ('login','export') ORDER BY a.id DESC LIMIT 200`)).rows);
}
