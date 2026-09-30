# Grid Matrix Portal — Backend (M-01)

PostgreSQL (your DigitalOcean server) + a small Node.js API. Replaces "every browser downloads the whole grid".

```
Browser (viewer / admin)  ──HTTPS──►  Nginx (SSL)  ──►  API (Node 20, port 8080, localhost only)  ──►  PostgreSQL
                                                         • login + roles (viewer / admin / superadmin)
                                                         • rates valid on a date kept in memory, shared by all users
                                                         • publish with automatic period end, audit log, Excel export
```

## Folder
| Path | What |
|---|---|
| `db/schema.sql` | Tables: lobs, lob_columns (filter order), users, uploads, rates, audit_log |
| `api/server.js` | API endpoints |
| `api/lib/rates.js` | Publish rules (Effective From, auto end-date per insurer + product type), dry-run check, export |
| `api/lib/snapshot.js` | In-memory "rates valid on date" snapshots → millisecond filtering |
| `api/scripts/tools.js` | Command line: create tables, add users, import an Excel grid, set filter order |
| `deploy/` | systemd service, Nginx site, nightly backup script, `.env.example` |
| `tests/` | Functional tests, 1.2 lakh-row generator, speed + 350-user load tests, `RESULTS_M-01.txt` |

## Rules implemented
* Admin gives only **Effective From**. Each uploaded row starts a new period from that date.
* For each **insurer + product type in the file**, rates running before that date end the day before. Other insurers/products are untouched.
* Rows of that insurer + product type missing from the new file also end (like "Replace" today); `replaceScope:false` ends only rows present in the file.
* Same Effective From again = replace that upload. Older date (back-fill) = new rows end the day before the next newer upload.
* "All" in a row matches any filter value. 0% rows sort last. Each result carries its previous rate + period (for M-07).
* Full history kept in Postgres (nothing overwritten).

## API
| Method | Path | Who | Body / notes |
|---|---|---|---|
| POST | /api/auth/login | all | `{email,password}` → cookie + token (12 h) |
| GET | /api/lobs | viewer | list of LOBs |
| GET | /api/lobs/:id/config | viewer | filter columns in admin order + upload dates |
| POST | /api/lobs/:id/query | viewer | `{filters:{col:[..]}, asOf:'YYYY-MM-DD', search, limit, offset}` → 50 rows + total |
| POST | /api/lobs/:id/facets | viewer | same body → options still available for every filter |
| POST | /api/lobs/:id/export | viewer | same body → .xlsx of all matching rows |
| POST | /api/lobs/:id/uploads | admin | `{columns, rows, effectiveFrom, fileName, replaceScope, dryRun}` (dryRun = check changes only) |
| GET | /api/lobs/:id/uploads | admin | upload history |
| PUT | /api/lobs/:id/columns | admin | `[{col,position,label,is_filter,visible}]` (filter order, M-06) |
| GET/POST/PATCH | /api/users | superadmin | manage users |

## Deploy on DigitalOcean (≈ 30–45 min for your IT person)
1. **Database** (DBeaver → SQL editor, connected as the Postgres admin user):
   ```sql
   CREATE DATABASE gridmatrix;
   CREATE USER gridapp WITH PASSWORD '<choose a strong password>';
   GRANT ALL PRIVILEGES ON DATABASE gridmatrix TO gridapp;
   \c gridmatrix   -- (in DBeaver: switch the editor to database gridmatrix)
   GRANT ALL ON SCHEMA public TO gridapp;
   CREATE EXTENSION IF NOT EXISTS btree_gist;   -- needs admin user; DO Managed Postgres supports it
   ```
2. **Node 20+ on the server:** `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`
3. **Copy the `api` and `db` folders** to `/opt/gridmatrix/`, then `cd /opt/gridmatrix/api && npm install --omit=dev`
4. **Settings:** copy `deploy/.env.example` to `/opt/gridmatrix/api/.env` and fill `DATABASE_URL`, a long random `JWT_SECRET`, `CORS_ORIGIN`.
5. **Create tables + first super admin + load data:**
   ```bash
   cd /opt/gridmatrix/api && set -a && . ./.env && set +a
   node scripts/tools.js schema
   node scripts/tools.js add-user you@company.com '<password 8+>' superadmin "Your Name"
   node scripts/tools.js import motor-pvt-car Motor_Pvt_Car_Grid_Sep26.xlsx 2026-09-01
   node scripts/tools.js import motor-pvt-car HDFC_SATP_Oct26.xlsx 2026-10-01
   node scripts/tools.js set-order motor-pvt-car "Insurer,Product Type,Business Type,Location,RTO,Fuel Type,NCB,CC,Age of Vehicle,Premium,Policy Term,Vehicle Name,PO calculated on"
   ```
6. **Run as a service:** `sudo cp deploy/gridmatrix-api.service /etc/systemd/system/ && sudo systemctl enable --now gridmatrix-api` — check: `curl localhost:8080/api/health`
7. **HTTPS:** point a sub-domain (e.g. `gridapi.yourcompany.com`) to the server, `sudo cp deploy/nginx-gridapi.conf /etc/nginx/sites-enabled/`, `sudo certbot --nginx -d gridapi.yourcompany.com`
8. **Backups:** `sudo cp deploy/backup.sh /opt/gridmatrix/ && sudo crontab -e` → `30 1 * * * /opt/gridmatrix/backup.sh` (keeps 30 days)

The Postgres port should NOT be open to the internet (only the API talks to it). DBeaver can still connect through an SSH tunnel.

## Tested (sandbox, PostgreSQL 18, 2 CPU) — see `tests/RESULTS_M-01.txt`
* 21/21 functional tests pass (login/roles, Oct vs Sep rates, previous rate, scope-based end dates, "All" wildcard, filter options, search, dry-run check, same-date re-publish, cache refresh after publish, Excel export, filter re-order, audit log).
* 1,21,530 rows (12 monthly uploads) → 240 MB. Loading the rates for a date: ~0.25 s once; afterwards page of results < 2 ms, filter options < 20 ms.
* 350 simultaneous users clicking every ~5 s: median 25 ms, p99 80 ms, 0 errors. Stress (350 users non-stop): ~770 result pages/s, 0 errors.
