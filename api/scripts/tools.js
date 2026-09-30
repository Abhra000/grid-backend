// Command-line helpers (run on the server from the api folder):
//   node scripts/tools.js schema                                   -> create tables (db/schema.sql)
//   node scripts/tools.js add-user <email> <password> <role> [name] -> role: viewer | admin | superadmin
//   node scripts/tools.js import <lobId> <file.xlsx> <YYYY-MM-DD> [rateCol]  -> publish an Excel grid
//   node scripts/tools.js set-order <lobId> "Insurer,Product Type,..."        -> filter order
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
pg.types.setTypeParser(1082, v => v);            // DATE columns as 'YYYY-MM-DD' (no timezone shift)
import bcrypt from 'bcryptjs';
import XLSX from 'xlsx';
import { publish } from '../lib/rates.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const [cmd, ...a] = process.argv.slice(2);
try {
  if (cmd === 'schema') {
    await pool.query(fs.readFileSync(path.join(here, '../../db/schema.sql'), 'utf8')); console.log('schema ok');
  } else if (cmd === 'add-user') {
    const [email, pw, role = 'viewer', name = null] = a;
    if (!email || !pw || pw.length < 8) throw new Error('usage: add-user <email> <password(8+)> <role> [name]');
    await pool.query(`INSERT INTO users (email, name, pass_hash, role) VALUES ($1,$2,$3,$4)
                      ON CONFLICT (email) DO UPDATE SET pass_hash=EXCLUDED.pass_hash, role=EXCLUDED.role, active=true`,
                     [email, name, await bcrypt.hash(pw, 11), role]);
    console.log('user saved:', email, role);
  } else if (cmd === 'import') {
    const [lobId, file, from, rateCol = 'Base Commission %'] = a;
    const wb = XLSX.readFile(file);
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
    const columns = aoa[0].map(String), rows = aoa.slice(1);
    const t = Date.now();
    const res = await publish(pool, { lobId, columns, rows, rateCol, from, fileName: path.basename(file) });
    console.log(JSON.stringify({ ...res, samples: undefined, ms: Date.now() - t }));
  } else if (cmd === 'set-order') {
    const [lobId, list] = a;
    const cols = list.split(',').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < cols.length; i++) await pool.query('UPDATE lob_columns SET position=$3 WHERE lob_id=$1 AND col=$2', [lobId, cols[i], i + 1]);
    console.log('order saved');
  } else console.log('commands: schema | add-user | import | set-order');
} catch (e) { console.error('ERROR:', e.message); process.exitCode = 1; }
await pool.end();
