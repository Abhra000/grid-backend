// One short name per insurer (agreed 05-Oct-2026). Any spelling in an upload file ("HDFC", "HDFC ERGO General
// Insurance Company Limited", "TATA AIG GENERAL INSURANCE CO. LTD" …) is saved under the short name, so every grid
// and every month uses the same name.  Life insurers (HDFC Life, Tata AIA, SBI Life, ICICI Pru …) are never touched.
import { rowKey, splitColumns } from './rates.js';

export const INSURERS = [
  [/^bajaj\b/i, 'Bajaj Allianz'],
  [/^chola/i, 'Chola MS'],
  [/^(future generali|generali central)/i, 'Future Generali'],
  [/^(go )?digit\b/i, 'Go Digit'],
  [/^hdfc\b/i, 'HDFC ERGO'],
  [/^icici\s*lombard|^lombard\b|^icici$/i, 'ICICI Lombard'],
  [/^iffco/i, 'IFFCO Tokio'],
  [/^indusind/i, 'IndusInd General'],
  [/^kiwi\b/i, 'Kiwi General'],
  [/^(zurich\s*)?kotak/i, 'Zurich Kotak'],
  [/^liberty\b/i, 'Liberty General'],
  [/^magma\b/i, 'Magma General'],
  [/^national\s+insurance/i, 'National Insurance'],
  [/^royal\s*sundaram/i, 'Royal Sundaram'],
  [/^sbi\b/i, 'SBI General'],
  [/^shriram\b/i, 'Shriram General'],
  [/^tata\b/i, 'Tata AIG'],
  [/^(the\s+)?new\s+india/i, 'New India Assurance'],
  [/^(the\s+)?oriental/i, 'Oriental Insurance'],
  [/^united\s+india/i, 'United India'],
  [/^universal\s+sompo/i, 'Universal Sompo'],
  [/^zuno\b/i, 'Zuno General'],
];
const LIFE = /\blife\b|\baia\b|\bpru|prudential|\blic\b/i;

/** file spelling -> agreed short name (unknown insurers are kept as written) */
export function insurerName(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s || LIFE.test(s)) return s;
  for (const [rx, name] of INSURERS) if (rx.test(s)) return name;
  return s;
}

/**
 * Rename the insurers already in the database to the short names (runs at every start; does nothing once done).
 * row_key is re-worked with the column order of each row's own upload, so "Previous %" keeps working.
 * A row is only changed when its old key can be re-produced exactly (proof that the column order is right).
 */
export async function renameInsurers(pool) {
  const todo = (await pool.query(`SELECT DISTINCT insurer FROM rates`)).rows.map(r => r.insurer).filter(n => insurerName(n) !== n);
  const extra = (await pool.query(`SELECT DISTINCT insurer FROM loc_rto UNION SELECT value FROM masters WHERE col ~* 'insurer|company'`)).rows
    .map(r => r.insurer).filter(n => insurerName(n) !== n);
  if (!todo.length && !extra.length) return null;
  const db = await pool.connect(), done = {}, skipped = {};
  try {
    await db.query('BEGIN');
    const lobs = new Map((await db.query('SELECT id, rate_col, columns FROM lobs')).rows.map(l => [l.id, l]));
    const ups = new Map((await db.query('SELECT id, columns FROM uploads WHERE columns IS NOT NULL')).rows.map(u => [u.id, u.columns]));
    const keyMap = new Map();                                           // lob + old key -> new key (for suggestions)
    const rows = todo.length ? (await db.query('SELECT id, lob_id, upload_id, insurer, params, row_key FROM rates WHERE insurer = ANY($1)', [todo])).rows : [];
    for (const r of rows) {
      const lob = lobs.get(r.lob_id), name = insurerName(r.insurer);
      const insCol = Object.keys(r.params).find(k => /insurer|company/i.test(k));
      let cols = null;
      for (const c of [ups.get(r.upload_id), lob?.columns].filter(Boolean)) {
        try { const pc = splitColumns(c, lob.rate_col).paramCols; if (rowKey(r.params, pc) === r.row_key) { cols = pc; break; } } catch { /* next */ }
      }
      if (!cols) { const pc = Object.keys(r.params); if (rowKey(r.params, pc) === r.row_key) cols = pc; }
      if (!cols || !insCol) { skipped[r.insurer] = (skipped[r.insurer] || 0) + 1; continue; }
      const params = { ...r.params, [insCol]: name };
      const key = rowKey(params, cols);
      keyMap.set(r.lob_id + '\u0001' + r.row_key, key);
      await db.query('UPDATE rates SET insurer=$2, params=$3, row_key=$4 WHERE id=$1', [r.id, name, JSON.stringify(params), key]);
      done[`${r.insurer} -> ${name}`] = (done[`${r.insurer} -> ${name}`] || 0) + 1;
    }
    // suggestions (pending / old) follow their rate
    for (const s of (await db.query('SELECT id, lob_id, row_key, params FROM suggestions')).rows) {
      const insCol = Object.keys(s.params || {}).find(k => /insurer|company/i.test(k));
      if (!insCol || insurerName(s.params[insCol]) === s.params[insCol]) continue;
      const key = keyMap.get(s.lob_id + '\u0001' + s.row_key) || s.row_key;
      await db.query('UPDATE suggestions SET params=$2, row_key=$3 WHERE id=$1', [s.id, JSON.stringify({ ...s.params, [insCol]: insurerName(s.params[insCol]) }), key]);
    }
    // RTO-master overrides + masters (keep the new-name row if both exist)
    for (const old of new Set([...todo, ...extra])) {
      const name = insurerName(old);
      await db.query(`DELETE FROM loc_rto o WHERE insurer=$1 AND EXISTS (SELECT 1 FROM loc_rto n WHERE n.insurer=$2 AND n.location=o.location)`, [old, name]);
      await db.query('UPDATE loc_rto SET insurer=$2 WHERE insurer=$1', [old, name]);
      await db.query(`DELETE FROM masters o WHERE value=$1 AND col ~* 'insurer|company' AND EXISTS (SELECT 1 FROM masters n WHERE n.lob_id=o.lob_id AND n.col=o.col AND n.value=$2)`, [old, name]);
      await db.query(`UPDATE masters SET value=$2 WHERE value=$1 AND col ~* 'insurer|company'`, [old, name]);
    }
    await db.query(`INSERT INTO audit_log (action, detail) VALUES ('rename_insurers', $1)`, [JSON.stringify({ done, skipped })]);
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  return { done, skipped };
}
