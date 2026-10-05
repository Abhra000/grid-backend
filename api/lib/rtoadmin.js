// P-10: load / save the RTO master and build the RTO_Master.xlsx (download -> edit -> upload)
import fs from 'node:fs';
import XLSX from 'xlsx';
import { RtoMaps, readMasterCsv } from './rtomap.js';
import { STATE_NAME, normRto, stateOfCode, cleanLoc, isLocCol, isRtoCol } from './geo.js';

const CSV = new URL('../../db/rto_master.csv', import.meta.url);

/** first start: fill rto_master from db/rto_master.csv */
export async function seedRtoMaster(pool) {
  const n = (await pool.query('SELECT count(*)::int n FROM rto_master')).rows[0].n;
  if (n || !fs.existsSync(CSV)) return n;
  const rows = readMasterCsv(CSV);
  await saveMaster(pool, rows);
  return rows.length;
}
async function saveMaster(pool, rows) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN'); await db.query('DELETE FROM rto_master');
    const seen = new Set();
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500).map(r => ({ ...r, code: normRto(r.code) })).filter(r => /^[A-Z]{2}-\d/.test(r.code) && !seen.has(r.code) && seen.add(r.code));
      if (!part.length) continue;
      const vals = [], args = [];
      part.forEach((r, j) => {
        const st = stateOfCode(r.code) || r.st;
        vals.push(`($${j * 7 + 1},$${j * 7 + 2},$${j * 7 + 3},$${j * 7 + 4},$${j * 7 + 5},$${j * 7 + 6},$${j * 7 + 7})`);
        args.push(r.code, st, STATE_NAME[st] || r.state || st, r.district || '', r.city || '', r.status || 'active', r.source || '');
      });
      await db.query(`INSERT INTO rto_master (code, state_code, state, district, city, status, source) VALUES ${vals.join(',')}`, args);
    }
    await db.query('COMMIT');
  } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
}
export async function loadMaps(pool) {
  const [m, o] = await Promise.all([pool.query('SELECT code, state_code AS st, district, city, status FROM rto_master'),
                                    pool.query('SELECT insurer, location, codes FROM loc_rto')]);
  return new RtoMaps(m.rows, o.rows);
}

/** every insurer + location (rows whose RTO is "All") of the rates live today, per grid */
async function liveLocations(pool) {
  const r = await pool.query(`SELECT DISTINCT r.lob_id, r.insurer, kv.key AS lcol, kv.value AS loc
                                FROM rates r CROSS JOIN LATERAL jsonb_each_text(r.params) kv
                               WHERE r.period @> current_date AND kv.key ~* '^(location|city|cluster|zone)$'
                                 AND lower(coalesce(r.params->>'RTO','all')) = 'all'`);
  return r.rows;
}

export async function buildWorkbook(pool, maps) {
  const master = (await pool.query('SELECT * FROM rto_master ORDER BY state, code')).rows;
  const locs = await liveLocations(pool);
  const over = new Map((await pool.query('SELECT insurer, location, codes, note FROM loc_rto')).rows.map(o => [o.insurer + '\u0001' + o.location, o]));
  const byIns = {};
  for (const x of locs) (byIns[x.insurer] = byIns[x.insurer] || new Set()).add(cleanLoc(x.loc));
  const lm = [];
  for (const [ins, set] of Object.entries(byIns)) {
    const ctx = [...set];
    for (const loc of ctx.sort()) {
      const o = over.get(ins + '\u0001' + loc);
      const auto = maps.auto(ins, loc, ctx);
      const used = o ? o.codes : auto.codes;
      const states = used ? [...new Set(used.map(c => maps.stateName(c)))].sort().join(', ') : 'All India';
      lm.push([ins, loc, states, auto.rule, auto.review && !o ? 'YES' : '', used ? used.length : 'All', (auto.codes || []).join(', '), o ? o.codes.join(', ') : '', o?.note || '']);
    }
  }
  lm.sort((a, b) => (b[4] === 'YES') - (a[4] === 'YES') || a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  const wb = XLSX.utils.book_new();
  const help = [
    ['RTO Master — how it works'], [],
    ['Sheet "RTO Master"', 'Every RTO code in India with its state, district and office. Add a missing code as a new row (RTO Code like WB-75). Used for: RTO list in the filters, State of each RTO.'],
    ['Sheet "Location Map"', 'One row per insurer + Location that appears in the grids with RTO = All. "Auto RTO codes" = what the portal works out by itself (from state / city names / "Rest of" / codes written in the name).'],
    ['', 'To correct a row: type the right codes in "Override RTO codes" (comma separated, e.g. GJ-01, GJ-27, GJ-18). Leave blank to keep the automatic codes. Type ALL to make a location apply everywhere.'],
    ['', 'Rows marked "Needs review = YES" are guesses (insurer clusters like (Good)/(Bad), East/West UP, North (Ref) …) — please check them first.'],
    ['Upload', 'Admin → Masters → RTO master → Upload. The portal then uses the new codes immediately. A new month\'s new locations are mapped automatically; download again to review them.'],
    ['Filters', 'User picks an RTO → State is picked for them and Location shows only the locations covering that RTO. User picks a State → RTO list shows only that state\'s RTOs.'],
  ];
  const sh0 = XLSX.utils.aoa_to_sheet(help); sh0['!cols'] = [{ wch: 22 }, { wch: 150 }];
  XLSX.utils.book_append_sheet(wb, sh0, 'How to use');
  const sh1 = XLSX.utils.aoa_to_sheet([['RTO Code', 'State Code', 'State', 'District', 'City / Office', 'Status', 'Source'],
    ...master.map(m => [m.code, m.state_code, m.state, m.district, m.city, m.status, m.source])]);
  sh1['!cols'] = [{ wch: 10 }, { wch: 6 }, { wch: 22 }, { wch: 24 }, { wch: 34 }, { wch: 10 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, sh1, 'RTO Master');
  const sh2 = XLSX.utils.aoa_to_sheet([['Insurer', 'Location', 'State(s)', 'How it was mapped', 'Needs review', 'RTO count', 'Auto RTO codes', 'Override RTO codes', 'Note'], ...lm]);
  sh2['!cols'] = [{ wch: 30 }, { wch: 34 }, { wch: 22 }, { wch: 34 }, { wch: 8 }, { wch: 8 }, { wch: 60 }, { wch: 40 }, { wch: 30 }];
  sh2['!autofilter'] = { ref: `A1:I${lm.length + 1}` };
  XLSX.utils.book_append_sheet(wb, sh2, 'Location Map');
  return { buf: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), stats: { codes: master.length, locations: lm.length, review: lm.filter(x => x[4] === 'YES').length, overrides: over.size } };
}

/** body: { master:[[code,stateCode,state,district,city,status,source]...] | null, map:[[insurer,location,...,override,note]...] } */
export async function saveUpload(pool, body, userId) {
  let masterRows = 0, overrides = 0;
  if (Array.isArray(body.master) && body.master.length > 50) {
    const rows = body.master.map(r => ({ code: r[0], st: r[1], state: r[2], district: r[3], city: r[4], status: r[5], source: r[6] })).filter(r => r.code);
    await saveMaster(pool, rows); masterRows = rows.length;
  }
  if (Array.isArray(body.map)) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN'); await db.query('DELETE FROM loc_rto');
      for (const r of body.map) {
        const [insurer, location] = [String(r.insurer || '').trim(), cleanLoc(String(r.location || '').trim())];
        const raw = String(r.override || '').trim();
        if (!insurer || !location || !raw) continue;
        const codes = /^all$/i.test(raw) ? [] : raw.split(/[,;\s]+/).map(normRto).filter(c => /^[A-Z]{2}-\d/.test(c));
        if (!codes.length && !/^all$/i.test(raw)) continue;
        await db.query('INSERT INTO loc_rto (insurer, location, codes, note) VALUES ($1,$2,$3,$4) ON CONFLICT (insurer, location) DO UPDATE SET codes=EXCLUDED.codes, note=EXCLUDED.note, updated_at=now()',
                       [insurer, location, codes, r.note || null]);
        overrides++;
      }
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  await pool.query(`INSERT INTO audit_log (user_id, action, detail) VALUES ($1,'rto_master',$2)`, [userId, { masterRows, overrides }]);
  return { masterRows, overrides };
}
