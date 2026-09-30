// Core rate logic: publish (with automatic period end), query, filter options (facets), export.
import crypto from 'node:crypto';

const isAll = v => String(v ?? '').trim().toLowerCase() === 'all';
const norm = v => String(v ?? '').trim();
const INS_RE = /insurer|company/i;
const PROD_RE = /product\s*type|^product$|segment/i;
const NOTE_RE = /note|remark|condition|caps/i;

export function splitColumns(columns, rateCol) {
  const rc = columns.indexOf(rateCol);
  if (rc < 0) throw new Error(`Rate column "${rateCol}" not found in file`);
  const noteIdx = columns.findIndex((h, i) => i !== rc && NOTE_RE.test(h));
  const ins = columns.findIndex(h => INS_RE.test(h));
  if (ins < 0) throw new Error('Insurer column not found in file');
  const prod = columns.findIndex(h => PROD_RE.test(h));
  const paramCols = columns.filter((h, i) => i !== rc && i !== noteIdx);
  return { rc, noteIdx, ins, prod, paramCols };
}

export function rowKey(params, paramCols) {
  return crypto.createHash('md5').update(paramCols.map(c => norm(params[c])).join('\u0001')).digest('hex');
}
export const rateNum = t => { const m = String(t).match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
export const fmtRate = t => { const s = norm(t); const m = s.match(/^(\d+(?:\.\d+)?)\s*%?$/); if (!m) return s; let n = Number(m[1]); if (n > 0 && n <= 1 && s.indexOf('%') < 0 && m[1].includes('.')) n = +(n * 100).toFixed(3); return `${n}%`; };

/** Turn uploaded array-of-arrays (header row excluded) into rate records */
export function toRecords(columns, rows, rateCol) {
  const { rc, noteIdx, ins, prod, paramCols } = splitColumns(columns, rateCol);
  const out = [], seen = new Set();
  for (const r of rows) {
    if (!norm(r[ins]) || norm(r[rc]) === '') continue;
    const params = {};
    columns.forEach((h, i) => { if (i !== rc && i !== noteIdx) params[h] = norm(r[i]) || 'All'; });
    const key = rowKey(params, paramCols);
    if (seen.has(key)) continue; seen.add(key);                       // duplicate rows in file: first wins
    const rt = fmtRate(r[rc]);
    out.push({ insurer: norm(r[ins]), product_type: prod >= 0 ? (norm(r[prod]) || 'All') : 'All',
      params, row_key: key, rate_text: rt, rate_num: rateNum(rt), notes: noteIdx >= 0 ? norm(r[noteIdx]) : '' });
  }
  return { records: out, paramCols };
}

/**
 * Compare an upload with what is live on `from` (dry run) — used for the "check before publish" screen.
 */
export async function diffUpload(db, lobId, records, from) {
  const scopes = [...new Set(records.map(r => r.insurer + '\u0001' + r.product_type))];
  const cur = await db.query(
    `SELECT row_key, rate_text FROM rates
      WHERE lob_id=$1 AND (insurer || chr(1) || product_type) = ANY($2)
        AND effective_from < $3 AND (effective_to IS NULL OR effective_to >= ($3::date - 1))`, [lobId, scopes, from]);   // what was live the day before
  const live = new Map(cur.rows.map(r => [r.row_key, r.rate_text]));
  let changed = 0, added = 0, unchanged = 0; const samples = [];
  const newKeys = new Set();
  for (const r of records) {
    newKeys.add(r.row_key);
    if (!live.has(r.row_key)) added++;
    else if (live.get(r.row_key) !== r.rate_text) { changed++; if (samples.length < 50) samples.push({ params: r.params, from: live.get(r.row_key), to: r.rate_text }); }
    else unchanged++;
  }
  let ended = 0; for (const k of live.keys()) if (!newKeys.has(k)) ended++;
  return { rows: records.length, changed, added, unchanged, ended, scopes: scopes.map(s => s.split('\u0001')), samples };
}

/**
 * Publish: every row in the file starts a new period from `from`.
 * For each insurer + product type in the file, the rates valid before `from` end on `from - 1 day`.
 * replaceScope=false -> only rows present in the file are ended (partial update inside a scope).
 * Same Effective From again -> that date's rows are replaced.  Older date (back-fill) -> new rows end the
 * day before the next newer upload of the same scope.
 */
export async function publish(pool, { lobId, columns, rows, rateCol, from, fileName, replaceScope = true, userId = null }) {
  const { records, paramCols } = toRecords(columns, rows, rateCol);
  if (!records.length) throw new Error('No rate rows found in the file');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`INSERT INTO lobs (id, name, rate_col, columns) VALUES ($1,$1,$2,$3)
                    ON CONFLICT (id) DO UPDATE SET columns=EXCLUDED.columns, rate_col=EXCLUDED.rate_col`,
                   [lobId, rateCol, JSON.stringify(columns)]);
    // make sure every param column has a filter-config row (new columns go to the end)
    await db.query(`INSERT INTO lob_columns (lob_id, col, position)
                    SELECT $1, c, 1000 + ord FROM unnest($2::text[]) WITH ORDINALITY AS t(c, ord)
                    ON CONFLICT DO NOTHING`, [lobId, paramCols]);
    const summary = await diffUpload(db, lobId, records, from);
    const up = await db.query(`INSERT INTO uploads (lob_id, file_name, effective_from, replace_scope, row_count, summary, uploaded_by, columns)
                               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
                              [lobId, fileName || null, from, replaceScope, records.length, summary, userId, JSON.stringify(columns)]);
    const uploadId = up.rows[0].id;
    const scopes = summary.scopes.map(s => s.join('\u0001'));
    const keys = records.map(r => r.row_key);
    const scopeCond = `lob_id=$1 AND (insurer || chr(1) || product_type) = ANY($2)` + (replaceScope ? '' : ` AND row_key = ANY($4)`);
    // 1. same date re-published -> replace
    await db.query(`DELETE FROM rates WHERE ${scopeCond} AND effective_from = $3`, replaceScope ? [lobId, scopes, from] : [lobId, scopes, from, keys]);
    // 2. end the periods that are running on `from`
    await db.query(`UPDATE rates SET effective_to = ($3::date - 1)
                     WHERE ${scopeCond} AND effective_from < $3 AND (effective_to IS NULL OR effective_to >= $3)`,
                   replaceScope ? [lobId, scopes, from] : [lobId, scopes, from, keys]);
    // 3. back-fill: if a newer upload exists for the scope, new rows end the day before it
    const nx = await db.query(`SELECT insurer || chr(1) || product_type AS s, min(effective_from) AS nf FROM rates
                                WHERE lob_id=$1 AND (insurer || chr(1) || product_type) = ANY($2) AND effective_from > $3
                                GROUP BY 1`, [lobId, scopes, from]);
    const nextFrom = new Map(nx.rows.map(r => [r.s, r.nf]));
    // 4. insert (batched)
    const B = 1000;
    for (let i = 0; i < records.length; i += B) {
      const part = records.slice(i, i + B);
      const vals = [], args = [];
      part.forEach((r, j) => {
        const nf = nextFrom.get(r.insurer + '\u0001' + r.product_type);
        const to = nf ? new Date(new Date(nf).getTime() - 86400000).toISOString().slice(0, 10) : null;
        const b = j * 11;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`);
        args.push(lobId, uploadId, r.insurer, r.product_type, JSON.stringify(r.params), r.row_key, r.rate_text, r.rate_num, r.notes, from, to);
      });
      await db.query(`INSERT INTO rates (lob_id, upload_id, insurer, product_type, params, row_key, rate_text, rate_num, notes, effective_from, effective_to)
                      VALUES ${vals.join(',')}`, args);
    }
    await db.query(`INSERT INTO audit_log (user_id, action, detail) VALUES ($1,'publish',$2)`,
                   [userId, { lobId, uploadId, from, fileName, rows: records.length, changed: summary.changed, added: summary.added, ended: summary.ended }]);
    await db.query('COMMIT');
    return { uploadId, ...summary };
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }
}

/* ---------------- read side ---------------- */
// filters: { "Fuel Type": ["Petrol"], ... }   ("All" in a row always matches)
function whereClause(lobId, { filters = {}, asOf, search }, skipCol = null) {
  const args = [lobId]; const w = ['r.lob_id = $1'];
  const d = /^\d{4}-\d{2}-\d{2}$/.test(asOf || '') ? asOf : new Date().toISOString().slice(0, 10);
  args.push(d); w.push(`r.period @> $2::date`);                       // GiST index: rates valid on that date
  for (const [col, vals] of Object.entries(filters)) {
    if (col === skipCol || !Array.isArray(vals) || !vals.length) continue;
    args.push(col); const c = args.length; args.push(vals.map(String)); const v = args.length;
    w.push(`(r.params->>$${c} = ANY($${v}) OR lower(r.params->>$${c}) = 'all')`);
  }
  for (const term of String(search || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) {
    args.push('%' + term.replace(/[%_\\]/g, m => '\\' + m) + '%'); w.push(`r.search_text LIKE $${args.length}`);
  }
  return { sql: w.join(' AND '), args };
}

/** One page of rates valid on `asOf`, each with its previous rate (M-07) */
export async function queryRates(pool, lobId, q) {
  const limit = Math.min(Math.max(+q.limit || 50, 1), 200), offset = Math.max(+q.offset || 0, 0);
  const { sql, args } = whereClause(lobId, q);
  const [rows, cnt] = await Promise.all([
    pool.query(`SELECT r.id, r.params, r.rate_text, r.notes, r.effective_from, r.effective_to,
                       p.rate_text AS prev_rate, p.effective_from AS prev_from, p.effective_to AS prev_to
                  FROM rates r
                  LEFT JOIN LATERAL (SELECT rate_text, effective_from, effective_to FROM rates p
                                      WHERE p.lob_id = r.lob_id AND p.row_key = r.row_key AND p.effective_from < r.effective_from
                                      ORDER BY p.effective_from DESC LIMIT 1) p ON true
                 WHERE ${sql}
                 ORDER BY (r.rate_num = 0) ASC, r.insurer, r.product_type, r.id
                 LIMIT ${limit} OFFSET ${offset}`, args),
    pool.query(`SELECT count(*)::int AS n FROM rates r WHERE ${sql}`, args)
  ]);
  return { total: cnt.rows[0].n, limit, offset, rows: rows.rows };
}

/** Values still available for each filter, given the other filters (drives the step-by-step filters, M-05).
 *  One pass: a row counts for filter X if it passes every other filter (rows failing 2+ filters are skipped). */
export async function facets(pool, lobId, q, cols) {
  const base = whereClause(lobId, { asOf: q.asOf, search: q.search });
  const args = base.args.slice();
  const active = Object.entries(q.filters || {}).filter(([c, v]) => Array.isArray(v) && v.length);
  const conds = active.map(([col, vals]) => {
    args.push(col); const c = args.length; args.push(vals.map(String)); const v = args.length;
    return { col, sql: `(r.params->>$${c} = ANY($${v}) OR lower(r.params->>$${c}) = 'all')` };
  });
  args.push(cols); const colsArg = args.length;
  const failCount = conds.length ? conds.map(x => `(CASE WHEN ${x.sql} THEN 0 ELSE 1 END)`).join(' + ') : '0';
  const failCol = conds.length ? `CASE ${conds.map((x, k) => `WHEN NOT ${x.sql} THEN ${k}`).join(' ')} ELSE -1 END` : '-1';
  const colIdx = {}; conds.forEach((x, k) => { colIdx[k] = x.col; });
  const r = await pool.query(
    `WITH f AS (SELECT r.params, ${failCount} AS nf, ${failCol} AS fc FROM rates r WHERE ${base.sql})
     SELECT kv.key, kv.value, f.nf, f.fc FROM f CROSS JOIN LATERAL jsonb_each_text(f.params) kv
      WHERE kv.key = ANY($${colsArg}) AND f.nf <= 1
      GROUP BY 1, 2, 3, 4`, args);
  const sets = Object.fromEntries(cols.map(c => [c, new Set()]));
  for (const x of r.rows) {
    if (isAll(x.value) || !x.value) continue;
    if (x.nf === 0 || colIdx[x.fc] === x.key) sets[x.key]?.add(x.value);
  }
  return Object.fromEntries(cols.map(c => [c, [...sets[c]].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))]));
}

/** Dates that have uploads (for the "Rates as on" picker) */
export async function effectiveDates(pool, lobId) {
  const r = await pool.query(`SELECT DISTINCT effective_from::text AS d FROM rates WHERE lob_id=$1 ORDER BY 1`, [lobId]);
  return r.rows.map(x => x.d);
}

/** All matching rows for Excel download (M-02) */
export async function exportRows(pool, lobId, q) {
  const { sql, args } = whereClause(lobId, q);
  const r = await pool.query(`SELECT r.params, r.rate_text, r.notes, r.effective_from::text AS effective_from, r.effective_to::text AS effective_to
                                FROM rates r WHERE ${sql} ORDER BY (r.rate_num = 0), r.insurer, r.product_type, r.id LIMIT 200000`, args);
  return r.rows;
}
