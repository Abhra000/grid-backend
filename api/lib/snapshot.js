// Hot "snapshot" engine: the rates valid on a date are loaded once from Postgres into the API's memory
// and shared by all users. Filtering / filter options then take a few milliseconds instead of a DB round trip.
// Postgres stays the single source of truth; snapshots are dropped whenever anything is published.
import { locStates, rtoState, isRtoCol, isLocCol, locStateNames, cleanLoc, isCcCol, ccOptions, CC_BUCKETS, normRto, STATE_NAME } from './geo.js';
// P-10: RTO master (which RTOs each insurer's location covers) — set by the server at start and after an upload
let MAPS = null;
export const setRtoMaps = m => { MAPS = m; SNAP.clear(); };
export const rtoMaps = () => MAPS;
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
    // a column that only some uploads have (e.g. Shriram's "Max OD Discount") counts as "All" for every other row
    const allKeys = new Set(); for (const x of rows) for (const k in x.params) allKeys.add(k);
    for (const x of rows) for (const k of allKeys) if (!(k in x.params)) x.params[k] = 'All';
    const keyOf = p => ({ ins: Object.keys(p).find(k => /insurer|company/i.test(k)), loc: Object.keys(p).find(isLocCol), rto: Object.keys(p).find(isRtoCol) });
    const ctx = new Map();                                                       // insurer -> its locations (for "Rest of …")
    for (const x of rows) {
      const k = keyOf(x.params);
      if (k.loc) x.params[k.loc] = cleanLoc(x.params[k.loc]);                    // P-04: one spelling per place
      if (k.rto && !isAll(x.params[k.rto])) x.params[k.rto] = normRto(x.params[k.rto]);   // 'DL-1' -> 'DL-01'
      if (k.ins && k.loc) { const i = x.params[k.ins]; if (!ctx.has(i)) ctx.set(i, new Set()); ctx.get(i).add(x.params[k.loc]); }
    }
    for (const x of rows) {
      const k = keyOf(x.params), lc = k.loc;
      x._st = lc ? locStates(x.params[lc]) : new Set();                          // P-07: state(s) of the row's location (fallback)
      // P-10: RTO codes this row applies to (null = everywhere)
      x._rtos = undefined;
      if (MAPS && k.rto) {
        const v = x.params[k.rto];
        if (!isAll(v)) x._rtos = new Set([v]);
        else if (lc && k.ins) { const m = MAPS.map(x.params[k.ins], x.params[lc], [...ctx.get(x.params[k.ins]) || []]); x._rtos = m.codes ? new Set(m.codes) : null; }
        else x._rtos = null;
      }
      if (lc && !('State' in x.params)) {                                       // P-04: State filter worked out from Location / RTOs
        x._stN = x._rtos ? [...new Set([...x._rtos].map(c => MAPS.stateName(c)).filter(Boolean))].sort() : (x._rtos === null && MAPS ? [] : locStateNames(x.params[lc]));
        x.params = { ...x.params, State: x._stN.length ? x._stN.join(' / ') : 'All' };
      } else x._stN = null;
      const cc = Object.keys(x.params).find(isCcCol);
      x._cc = cc ? ccOptions(x.params[cc]) : null;                               // P-04: CC as 3 clean ranges
      x._s = (Object.values(x.params).join(' ') + ' ' + (x.notes || '') + ' ' + x.rate_text).toLowerCase();
    }
    return { date: d, rows };
  })();
  SNAP.set(key, loading);
  if (SNAP.size > MAX_SNAPS) SNAP.delete(SNAP.keys().next().value);
  try { return await loading; } catch (e) { SNAP.delete(key); throw e; }
}

// row passes filter col? ("All" in the row = applies to every value)
// P-07: for the RTO filter, an "All"-RTO row only counts if its Location is in the state of a picked RTO
// (WB-01 -> West Bengal / Kolkata / Rest of West Bengal …) or is not tied to any state (All India, North (Ref) …).
const passes = (row, col, set) => {
  const v = row.params[col];
  if (col === 'State' && row._stN) return !row._stN.length || row._stN.some(n => set.has(n));   // no state = applies everywhere
  if (row._cc && isCcCol(col)) return isAll(v) || set.has(v) || row._cc.some(o => set.has(o));
  if (row._rtos !== undefined && isRtoCol(col)) {                               // P-10: RTO master
    if (set.has(v)) return true;
    if (!isAll(v)) return false;
    if (set.has('All') || row._rtos === null) return true;
    for (const c of row._rtos) if (set.has(c)) return true;
    return false;
  }
  if (set.has(v)) return true;
  if (!isAll(v)) return false;
  if (!set.rto || set.has('All')) return true;
  if (!row._st || !row._st.size) return true;
  for (const st of set.rto) if (row._st.has(st)) return true;
  return false;
};
function prep(q) {
  const f = Object.entries(q.filters || {}).filter(([, v]) => Array.isArray(v) && v.length).map(([c, v]) => {
    const set = new Set(v.map(String));
    if (isRtoCol(c)) { const sts = new Set(v.map(rtoState).filter(Boolean)); if (sts.size) set.rto = sts; }
    return [c, set];
  });
  const terms = String(q.search || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  return { f, terms };
}
const searchOk = (row, terms) => terms.every(t => row._s.includes(t));

/** every matching row (for the Excel download — same rules as the screen) */
export function filterSnapshot(snap, q, max = 200000) {
  const { f, terms } = prep(q);
  const out = [];
  for (const r of snap.rows) { if (f.every(([c, s]) => passes(r, c, s)) && searchOk(r, terms)) { out.push(r); if (out.length >= max) break; } }
  return out;
}
export function querySnapshot(snap, q) {
  const { f, terms } = prep(q);
  const limit = Math.min(Math.max(+q.limit || 50, 1), 200), offset = Math.max(+q.offset || 0, 0);
  const hits = snap.rows.filter(r => f.every(([c, s]) => passes(r, c, s)) && searchOk(r, terms));
  const page = hits.slice(offset, offset + limit).map(({ _s, rate_num, ...x }) => x);
  return { asOf: snap.date, total: hits.length, limit, offset, rows: page };
}

// options for each filter = values of rows that pass every OTHER filter (one pass, like the current portal)
export function facetsSnapshot(snap, q, cols) {
  const mk = JSON.stringify([cols, !!q.insurerFirst, q.ovVer || 0, String(q.search || '').toLowerCase().trim(),
    Object.keys(q.filters || {}).sort().map(k => [k, [...(q.filters[k] || [])].map(String).sort()])]);
  snap.memo = snap.memo || new Map();
  if (snap.memo.has(mk)) return snap.memo.get(mk);                     // same question already answered for this snapshot
  const res = facetsCompute(snap, q, cols);
  // P-10: State <-> RTO stay consistent: a picked State limits the RTO list, picked RTOs limit the State list
  const rc = cols.find(isRtoCol), F = q.filters || {};
  if (MAPS && rc && res[rc]) {
    const st = (F.State || []).filter(x => x !== 'All');
    if (st.length && res[rc]) res[rc] = res[rc].filter(c => c === 'All' || st.includes(MAPS.stateName(c)));
    const rs = (F[rc] || []).filter(x => x !== 'All');
    if (rs.length && res.State) { const ok = new Set(rs.map(c => MAPS.stateName(c))); res.State = res.State.filter(s => s === 'All' || ok.has(s)); }
  }
  if (q.insurerFirst) res.__used = usedCols(snap, q, cols);
  if (snap.memo.size > 3000) snap.memo.clear();
  snap.memo.set(mk, res); return res;
}
/**
 * M-18: the filters the chosen insurer(s) actually use ("parameter to check"): a column is used when that insurer's
 * rates have more than one value in it (Product Type: any value). Location / RTO / State count as one group.
 * Steps: no insurer / no product type -> Insurer + Product Type + Location (product + location alone = insurers ranked);
 * both -> the filters that insurer's rates for those product types use (Stand alone OD -> Location + NCB …).
 */
const GEO = c => c === 'State' || isLocCol(c) || isRtoCol(c);
const insCol = cols => cols.find(c => /insurer|company/i.test(c));
const prodCol = cols => cols.find(c => /product\s*type|^product$/i.test(c));
const pv = (r, c) => isAll(r.params[c]) ? 'All' : String(r.params[c] ?? 'All');
/** automatic filter list for one group of rates: a column is used when it has more than one value */
function autoCols(rows, cols, ic, pc) {
  const vals = Object.fromEntries(cols.map(c => [c, new Set()]));
  for (const r of rows) for (const c of cols) if (c !== 'State') vals[c].add(pv(r, c));
  const uses = c => vals[c].size > 1;
  const geo = cols.some(c => GEO(c) && c !== 'State' && uses(c));
  return cols.filter(c => c !== ic && c !== pc && (GEO(c) ? geo : uses(c)));
}
/** rates grouped by insurer + product type ("All" product rows belong to every product of that insurer) */
function combos(rows, ic, pc, insurers, products) {
  const g = new Map(), allRows = new Map();
  for (const r of rows) {
    const i = String(r.params[ic]); if (insurers && !insurers.has(i)) continue;
    const p = pc ? pv(r, pc) : 'All';
    if (p === 'All') { if (!allRows.has(i)) allRows.set(i, []); allRows.get(i).push(r); continue; }
    if (products && !products.has(p)) continue;
    const k = i + '\u0001' + p; if (!g.has(k)) g.set(k, { insurer: i, product: p, rows: [] }); g.get(k).rows.push(r);
  }
  for (const v of g.values()) v.rows.push(...(allRows.get(v.insurer) || []));
  for (const [i, rs] of allRows) if (![...g.values()].some(v => v.insurer === i) && (!products || products.has('All')))
    g.set(i + '\u0001All', { insurer: i, product: 'All', rows: rs });
  return [...g.values()];
}
/**
 * M-18 / M-19: steps — no insurer -> Insurer only; insurer, no product -> Insurer + Product;
 * both -> for every chosen insurer + product: the admin's own filter list if set (q.overrides), else automatic.
 */
function usedCols(snap, q, cols) {
  const ic = insCol(cols); if (!ic) return cols;
  const pc = prodCol(cols), lc = cols.find(c => /^location$/i.test(c));
  const vc = cols.find(c => /vehicle\s*category/i.test(c));                     // PCV: vehicle category is also asked first
  const start = [ic, pc, vc, lc].filter(Boolean);                                   // M-22: Product type + Location also open at the start (best-rate compare)
  const pick = new Set((q.filters || {})[ic] || []); if (!pick.size) return start;
  const pt = new Set(((q.filters || {})[pc] || []).map(String));
  if (pc && !pt.size) return start;
  const out = new Set([ic, pc, vc].filter(Boolean));
  for (const g of combos(snap.rows, ic, pc, pick, pt.size ? pt : null)) {
    const ov = q.overrides && q.overrides.get(g.insurer + '\u0001' + g.product);
    (ov || autoCols(g.rows, cols, ic, pc)).forEach(c => out.add(c));
  }
  return cols.filter(c => out.has(c));
}
/** admin: every insurer + product type in the grid with its automatic and admin-set filters */
export function insurerFilterTable(snap, cols, overrides) {
  const ic = insCol(cols), pc = prodCol(cols); if (!ic) return [];
  return combos(snap.rows, ic, pc, null, null).map(g => ({ insurer: g.insurer, product: g.product, rows: g.rows.length,
    auto: autoCols(g.rows, cols, ic, pc), set: (overrides && overrides.get(g.insurer + '\u0001' + g.product)) || null }))
    .sort((a, b) => a.insurer.localeCompare(b.insurer) || a.product.localeCompare(b.product));
}
function facetsCompute(snap, q, cols) {
  const { f, terms } = prep(q);
  const sets = Object.fromEntries(cols.map(c => [c, new Set()]));
  for (const r of snap.rows) {
    if (!searchOk(r, terms)) continue;
    let fails = 0, failCol = null;
    for (const [c, s] of f) { if (!passes(r, c, s)) { fails++; failCol = c; if (fails > 1) break; } }
    if (fails > 1) continue;
    if (fails === 0) { for (const c of cols) if (sets[c]) for (const o of optsOf(r, c)) sets[c].add(o); }
    else if (sets[failCol]) { for (const o of optsOf(r, failCol)) sets[failCol].add(o); }
  }
  return Object.fromEntries(cols.map(c => [c, [...sets[c]].filter(v => v != null && v !== '').map(String).sort(byAllFirst)]));
}
// "All" (= blank / applies to every value) is offered as a choice of its own, listed first
const CC_ORDER = Object.fromEntries(CC_BUCKETS.map((b, i) => [b[0], i]));
const byAllFirst = (a, b) => (b === 'All') - (a === 'All') || ((a in CC_ORDER && b in CC_ORDER) ? CC_ORDER[a] - CC_ORDER[b] : a.localeCompare(b, 'en', { numeric: true }));
// the choices one row contributes to a filter list
function optsOf(r, c) {
  if (c === 'State' && r._stN) return r._stN.length ? r._stN : ['All'];
  if (r._cc && isCcCol(c)) return r._cc;
  if (r._rtos && isRtoCol(c) && isAll(r.params[c])) return [...r._rtos, 'All'];   // P-10: every RTO the location covers
  const v = r.params[c]; return v ? [isAll(v) ? 'All' : v] : [];
}

/**
 * M-22 Best rate: for a product type + location, every insurer's highest rate there, best first.
 * Location is matched by RTO coverage (Mumbai = every insurer location covering the Mumbai RTOs: "Maharashtra",
 * "Rest of Maharashtra" …), with State as fallback. Other picked filters (fuel, CC …) apply; Insurer / RTO / State do not.
 */
export function bestRates(snap, q, cols) {
  const F = q.filters || {}, ic = cols.find(c => /insurer|company/i.test(c)), pc = cols.find(c => /product\s*type|^product$/i.test(c)), lc = cols.find(c => /^location$/i.test(c)) || cols.find(c => isLocCol(c) && c !== 'State');
  const prods = new Set(F[pc] || []), locs = new Set(F[lc] || []);
  if (!ic || !pc || !lc || !prods.size || !locs.size) return { ranked: [], notPayable: [] };
  const tR = new Set(), tS = new Set();
  for (const r of snap.rows) if (locs.has(r.params[lc])) { if (r._rtos) r._rtos.forEach(c => tR.add(c)); (r._stN || []).forEach(s => tS.add(s)); r._st.forEach(s => tS.add(STATE_NAME[s] || s)); }
  const covers = r => {
    if (locs.has(r.params[lc]) || isAll(r.params[lc])) return true;
    if (r._rtos === null) return true;                                         // pan-India location
    if (r._rtos && tR.size) { for (const c of r._rtos) if (tR.has(c)) return true; return false; }
    const st = r._stN || [...r._st].map(s => STATE_NAME[s] || s);
    return st.some(s => tS.has(s));
  };
  const skip = new Set([ic, pc, lc, 'State', ...cols.filter(isRtoCol)]);
  const other = Object.entries(F).filter(([c, v]) => !skip.has(c) && v && v.length).map(([c, v]) => [c, new Set(v)]);
  const best = new Map(), seen = new Set(), locOf = new Map();               // locOf: the insurer's own location names for this place
  for (const r of snap.rows) {
    const p = r.params[pc]; if (!(prods.has(p) || isAll(p))) continue;
    if (!covers(r) || !other.every(([c, s]) => passes(r, c, s))) continue;
    const ins = String(r.params[ic]); seen.add(ins);
    if (!isAll(r.params[lc]) && r._rtos !== null) { if (!locOf.has(ins)) locOf.set(ins, new Set()); locOf.get(ins).add(r.params[lc]); }
    const n = parseFloat(r.rate_text); if (!(n > 0)) continue;
    if (!best.has(ins) || n > best.get(ins).n) best.set(ins, { insurer: ins, rate: r.rate_text, n });
  }
  const ranked = [...best.values()].sort((a, b) => b.n - a.n || a.insurer.localeCompare(b.insurer)).map(({ insurer, rate }) => ({ insurer, rate, locations: [...(locOf.get(insurer) || [])].sort() }));
  return { ranked, notPayable: [...seen].filter(i => !best.has(i)).sort() };
}
