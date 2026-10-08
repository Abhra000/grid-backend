// Product type names shown to users (agreed 08-Oct-2026): SAOD -> "Stand alone OD", SATP -> "Stand alone TP".
// Any spelling in an upload ("SAOD", "SA-OD", "Standalone OD", "STP", "SA TP" …) is saved under the agreed name.
import { rowKey, splitColumns } from './rates.js';

const PRODUCTS = [
  [/^(sa[\s-]*od|stand[\s-]*alone[\s-]*od|standalone[\s-]*own[\s-]*damage|stand[\s-]*alone[\s-]*own[\s-]*damage)$/i, 'Stand alone OD'],
  [/^(sa[\s-]*tp|stp|stand[\s-]*alone[\s-]*tp|standalone[\s-]*third[\s-]*party|stand[\s-]*alone[\s-]*third[\s-]*party)$/i, 'Stand alone TP'],
];
export const isProdCol = c => /product\s*type|^product$|segment/i.test(c);
/** file spelling -> agreed product type name (anything else is kept as written) */
export function productName(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  for (const [rx, name] of PRODUCTS) if (rx.test(s)) return name;
  return s;
}

/**
 * Rename product types already in the database (runs at every start; does nothing once done).
 * row_key is re-worked with each row's own upload column order, so "Previous %" keeps working;
 * a row is only changed when its old key can be re-produced exactly.
 */
export async function renameProducts(pool) {
  const todo = (await pool.query('SELECT DISTINCT product_type FROM rates')).rows.map(r => r.product_type).filter(p => productName(p) !== p);
  const extra = (await pool.query('SELECT DISTINCT product FROM insurer_filters')).rows.map(r => r.product).filter(p => productName(p) !== p);
  if (!todo.length && !extra.length) return null;
  const db = await pool.connect(), done = {}, skipped = {};
  try {
    await db.query('BEGIN');
    const lobs = new Map((await db.query('SELECT id, rate_col, columns FROM lobs')).rows.map(l => [l.id, l]));
    const ups = new Map((await db.query('SELECT id, columns FROM uploads WHERE columns IS NOT NULL')).rows.map(u => [u.id, u.columns]));
    const keyMap = new Map();
    const rows = todo.length ? (await db.query('SELECT id, lob_id, upload_id, product_type, params, row_key FROM rates WHERE product_type = ANY($1)', [todo])).rows : [];
    for (const r of rows) {
      const lob = lobs.get(r.lob_id), name = productName(r.product_type);
      const pc = Object.keys(r.params).find(isProdCol);
      let cols = null;
      for (const c of [ups.get(r.upload_id), lob?.columns].filter(Boolean)) {
        try { const p = splitColumns(c, lob.rate_col).paramCols; if (rowKey(r.params, p) === r.row_key) { cols = p; break; } } catch { /* next */ }
      }
      if (!cols) { const p = Object.keys(r.params); if (rowKey(r.params, p) === r.row_key) cols = p; }
      if (!cols || !pc) { skipped[r.product_type] = (skipped[r.product_type] || 0) + 1; continue; }
      const params = { ...r.params, [pc]: name }, key = rowKey(params, cols);
      keyMap.set(r.lob_id + '\u0001' + r.row_key, key);
      await db.query('UPDATE rates SET product_type=$2, params=$3, row_key=$4 WHERE id=$1', [r.id, name, JSON.stringify(params), key]);
      done[`${r.product_type} -> ${name}`] = (done[`${r.product_type} -> ${name}`] || 0) + 1;
    }
    for (const s of (await db.query('SELECT id, lob_id, row_key, params FROM suggestions')).rows) {
      const pc = Object.keys(s.params || {}).find(isProdCol);
      if (!pc || productName(s.params[pc]) === s.params[pc]) continue;
      await db.query('UPDATE suggestions SET params=$2, row_key=$3 WHERE id=$1',
        [s.id, JSON.stringify({ ...s.params, [pc]: productName(s.params[pc]) }), keyMap.get(s.lob_id + '\u0001' + s.row_key) || s.row_key]);
    }
    for (const old of new Set([...todo, ...extra])) {
      const name = productName(old);
      await db.query(`DELETE FROM insurer_filters o WHERE product=$1 AND EXISTS (SELECT 1 FROM insurer_filters n WHERE n.lob_id=o.lob_id AND n.insurer=o.insurer AND n.product=$2)`, [old, name]);
      await db.query('UPDATE insurer_filters SET product=$2 WHERE product=$1', [old, name]);
      await db.query(`DELETE FROM masters o WHERE value=$1 AND col ~* 'product' AND EXISTS (SELECT 1 FROM masters n WHERE n.lob_id=o.lob_id AND n.col=o.col AND n.value=$2)`, [old, name]);
      await db.query(`UPDATE masters SET value=$2 WHERE value=$1 AND col ~* 'product'`, [old, name]);
    }
    await db.query(`INSERT INTO audit_log (action, detail) VALUES ('rename_products', $1)`, [JSON.stringify({ done, skipped })]);
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  return { done, skipped };
}
