// Hot "snapshot" engine: the rates valid on a date are loaded once from Postgres into the API's memory
// and shared by all users. Filtering / filter options then take a few milliseconds instead of a DB round trip.
// Postgres stays the single source of truth; snapshots are dropped whenever anything is published.
const isAll = v => String(v ?? '').trim().toLowerCase() === 'all';
const SNAP = new Map(); const MAX_SNAPS = 40;
const today = () => new Date().toISOString().slice(0, 10);
export const clearSnapshots = () => SNAP.clear();

export async function getSnapshot(pool, lobId, asOf) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(asOf || '') ? asOf : today();
  const key = lobId + '|' + d;
  if (SNAP.has(key)) { const s = SNAP.get(key); SNAP.delete(key); SNAP.set(key, s); return s; }   // LRU touch
  const loading = (async () => {
    const r = await pool.query(
      `SELECT r.id, r.params, r.rate_text, r.rate_num, r.notes, r.effective_from, r.effective_to,
              p.rate_text AS prev_rate, p.effective_from AS prev_from, p.effective_to AS prev_to
         FROM rates r
         LEFT JOIN LATERAL (SELECT rate_text, effective_from, effective_to FROM rates p
                             WHERE p.lob_id = r.lob_id AND p.row_key = r.row_key AND p.effective_from < r.effective_from
                             ORDER BY p.effective_from DESC LIMIT 1) p ON true
        WHERE r.lob_id = $1 AND r.period @> $2::date
        ORDER BY (r.rate_num = 0), r.insurer, r.product_type, r.id`, [lobId, d]);
    const rows = r.rows;
    for (const x of rows) x._s = (Object.values(x.params).join(' ') + ' ' + (x.notes || '') + ' ' + x.rate_text).toLowerCase();
    return { date: d, rows };
  })();
  SNAP.set(key, loading);
  if (SNAP.size > MAX_SNAPS) SNAP.delete(SNAP.keys().next().value);
  try { return await loading; } catch (e) { SNAP.delete(key); throw e; }
}

// row passes filter col? ("All" in the row = applies to every value)
const passes = (row, col, set) => { const v = row.params[col]; return set.has(v) || isAll(v); };
function prep(q) {
  const f = Object.entries(q.filters || {}).filter(([, v]) => Array.isArray(v) && v.length).map(([c, v]) => [c, new Set(v.map(String))]);
  const terms = String(q.search || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  return { f, terms };
}
const searchOk = (row, terms) => terms.every(t => row._s.includes(t));

export function querySnapshot(snap, q) {
  const { f, terms } = prep(q);
  const limit = Math.min(Math.max(+q.limit || 50, 1), 200), offset = Math.max(+q.offset || 0, 0);
  const hits = snap.rows.filter(r => f.every(([c, s]) => passes(r, c, s)) && searchOk(r, terms));
  const page = hits.slice(offset, offset + limit).map(({ _s, rate_num, ...x }) => x);
  return { asOf: snap.date, total: hits.length, limit, offset, rows: page };
}

// options for each filter = values of rows that pass every OTHER filter (one pass, like the current portal)
export function facetsSnapshot(snap, q, cols) {
  const mk = JSON.stringify([cols, String(q.search || '').toLowerCase().trim(),
    Object.keys(q.filters || {}).sort().map(k => [k, [...(q.filters[k] || [])].map(String).sort()])]);
  snap.memo = snap.memo || new Map();
  if (snap.memo.has(mk)) return snap.memo.get(mk);                     // same question already answered for this snapshot
  const res = facetsCompute(snap, q, cols);
  if (snap.memo.size > 3000) snap.memo.clear();
  snap.memo.set(mk, res); return res;
}
function facetsCompute(snap, q, cols) {
  const { f, terms } = prep(q);
  const sets = Object.fromEntries(cols.map(c => [c, new Set()]));
  for (const r of snap.rows) {
    if (!searchOk(r, terms)) continue;
    let fails = 0, failCol = null;
    for (const [c, s] of f) { if (!passes(r, c, s)) { fails++; failCol = c; if (fails > 1) break; } }
    if (fails > 1) continue;
    if (fails === 0) { for (const c of cols) { const v = r.params[c]; if (v) sets[c].add(isAll(v) ? 'All' : v); } }
    else if (sets[failCol]) { const v = r.params[failCol]; if (v) sets[failCol].add(isAll(v) ? 'All' : v); }
  }
  return Object.fromEntries(cols.map(c => [c, [...sets[c]].sort(byAllFirst)]));
}
// "All" (= blank / applies to every value) is offered as a choice of its own, listed first
const byAllFirst = (a, b) => (b === 'All') - (a === 'All') || a.localeCompare(b, 'en', { numeric: true });
