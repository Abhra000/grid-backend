-- =====================================================================
-- Grid Matrix Portal — PostgreSQL schema (M-01)
-- Run once on the DigitalOcean Postgres (e.g. in DBeaver: open SQL editor on
-- database "gridmatrix", paste, execute script).  Safe to re-run.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- fast "valid on date" lookups

-- One row per line of business (Motor Pvt Car, Life, Health, ...)
CREATE TABLE IF NOT EXISTS lobs (
  id          text PRIMARY KEY,                 -- e.g. 'motor-pvt-car'
  name        text NOT NULL,
  rate_col    text NOT NULL DEFAULT 'Base Commission %',
  columns     jsonb NOT NULL DEFAULT '[]',      -- template column names, in file order
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Filter / column settings per LOB. position = order shown to users (admin can re-arrange: M-06)
CREATE TABLE IF NOT EXISTS lob_columns (
  lob_id     text REFERENCES lobs(id) ON DELETE CASCADE,
  col        text NOT NULL,
  position   int  NOT NULL DEFAULT 0,
  label      text,                               -- optional display name
  is_filter  boolean NOT NULL DEFAULT true,
  visible    boolean NOT NULL DEFAULT true,
  PRIMARY KEY (lob_id, col)
);

CREATE TABLE IF NOT EXISTS users (
  id          serial PRIMARY KEY,
  email       text UNIQUE NOT NULL,
  name        text,
  pass_hash   text NOT NULL,                     -- bcrypt
  role        text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer','admin','superadmin')),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_login  timestamptz
);

-- Every upload (draft = checked but not published yet)
CREATE TABLE IF NOT EXISTS uploads (
  id              serial PRIMARY KEY,
  lob_id          text REFERENCES lobs(id) ON DELETE CASCADE,
  file_name       text,
  effective_from  date NOT NULL,
  replace_scope   boolean NOT NULL DEFAULT true,
  row_count       int NOT NULL DEFAULT 0,
  summary         jsonb,                          -- {changed, added, ended, unchanged, scopes:[...]}
  status          text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','rolled_back')),
  uploaded_by     int REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The rates. One row = one rate for one parameter combination for one period.
--   params        : every parameter column of the file (Insurer, Product Type, Location, RTO, ...), NOT rate / notes
--   row_key       : md5 of params -> links the same product across periods (for "previous %")
--   effective_to  : NULL = open-ended (still valid); set automatically when a newer upload for the
--                   same insurer + product type is published (day before its Effective From)
CREATE TABLE IF NOT EXISTS rates (
  id              bigserial PRIMARY KEY,
  lob_id          text NOT NULL REFERENCES lobs(id) ON DELETE CASCADE,
  upload_id       int REFERENCES uploads(id) ON DELETE SET NULL,
  insurer         text NOT NULL,
  product_type    text NOT NULL DEFAULT 'All',
  params          jsonb NOT NULL,
  row_key         text NOT NULL,
  rate_text       text NOT NULL,
  rate_num        numeric,
  notes           text,
  effective_from  date NOT NULL,
  effective_to    date,
  search_text     text GENERATED ALWAYS AS (lower(params::text || ' ' || coalesce(notes,'') || ' ' || rate_text)) STORED,
  period          daterange GENERATED ALWAYS AS (daterange(effective_from, effective_to, '[]')) STORED,
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE INDEX IF NOT EXISTS rates_period   ON rates (lob_id, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS rates_scope    ON rates (lob_id, insurer, product_type, effective_from);
CREATE INDEX IF NOT EXISTS rates_key      ON rates (lob_id, row_key, effective_from);
CREATE INDEX IF NOT EXISTS rates_params   ON rates USING gin (params jsonb_path_ops);
CREATE INDEX IF NOT EXISTS rates_valid    ON rates USING gist (lob_id, period);   -- "rates valid on date X"

CREATE TABLE IF NOT EXISTS audit_log (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  user_id  int REFERENCES users(id),
  action   text NOT NULL,                     -- login, publish, edit_rate, reorder_filters, user_add ...
  detail   jsonb
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log (at DESC);

-- ===== M-09 / M-10: Microsoft 365 sign-in + usage tracking (safe to re-run) =====
ALTER TABLE users ALTER COLUMN pass_hash DROP NOT NULL;                         -- Microsoft users have no password here
ALTER TABLE users ADD COLUMN IF NOT EXISTS ms_oid text UNIQUE;                  -- Microsoft account id
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider text NOT NULL DEFAULT 'password';   -- 'password' | 'm365'
CREATE TABLE IF NOT EXISTS visits (
  id          bigserial PRIMARY KEY,
  user_id     int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  hits        int NOT NULL DEFAULT 1,                                             -- searches / filter changes in the visit
  ip          text,
  ua          text
);
CREATE INDEX IF NOT EXISTS visits_user ON visits (user_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS visits_time ON visits (started_at DESC);

-- ===== email/password accounts for normal users =====
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change boolean NOT NULL DEFAULT false;   -- temporary password → must set own password

-- ===== M-12: full admin (LOB templates, masters, approvals, upload history) =====
ALTER TABLE lobs    ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS columns jsonb;                   -- file header as uploaded (for "download this version")
-- Masters: the allowed values of a column (Insurer, Product Type, ...) per LOB. Upload check warns on anything else.
CREATE TABLE IF NOT EXISTS masters (
  lob_id  text NOT NULL REFERENCES lobs(id) ON DELETE CASCADE,
  col     text NOT NULL,
  value   text NOT NULL,
  PRIMARY KEY (lob_id, col, value)
);
-- "Suggest a rate": a user proposes a correction for one row; an admin approves (becomes a new dated rate) or rejects.
CREATE TABLE IF NOT EXISTS suggestions (
  id              serial PRIMARY KEY,
  lob_id          text NOT NULL REFERENCES lobs(id) ON DELETE CASCADE,
  rate_id         bigint REFERENCES rates(id) ON DELETE SET NULL,
  row_key         text NOT NULL,
  params          jsonb NOT NULL,
  current_rate    text,
  suggested_rate  text NOT NULL,
  effective_from  date,
  note            text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  user_id         int REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_by      int REFERENCES users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  decision_note   text,
  applied_rate    text
);
CREATE INDEX IF NOT EXISTS suggestions_status ON suggestions (status, created_at DESC);

-- ===== M-13: default filter set + "see all filters" permission (per user / per role) =====
ALTER TABLE lob_columns ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT true;   -- filter shown to everyone
ALTER TABLE users       ADD COLUMN IF NOT EXISTS all_filters boolean NOT NULL DEFAULT false; -- this user sees every filter
CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL);
INSERT INTO settings (key, value) VALUES ('all_filters_roles', '["admin","superadmin"]') ON CONFLICT DO NOTHING;

-- ===== P-10: RTO master (all RTO codes) + which RTOs each insurer's Location covers =====
CREATE TABLE IF NOT EXISTS rto_master (
  code        text PRIMARY KEY,          -- 'WB-01'
  state_code  text,                      -- 'WB'
  state       text,
  district    text,
  city        text,                      -- RTO office / town
  status      text,
  source      text
);
-- manual corrections from the RTO_Master.xlsx upload; locations without a row here are worked out automatically
CREATE TABLE IF NOT EXISTS loc_rto (
  insurer     text NOT NULL,
  location    text NOT NULL,
  codes       text[] NOT NULL,
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (insurer, location)
);

-- ===== M-18: "insurer first" — other filters appear only after an insurer is picked, and only the ones that insurer's rates use =====
ALTER TABLE lobs ADD COLUMN IF NOT EXISTS insurer_first boolean;
UPDATE lobs SET insurer_first = (id LIKE 'motor%') WHERE insurer_first IS NULL;

-- ===== M-19: admin sets which filters show for an insurer + product type (no row = automatic) =====
CREATE TABLE IF NOT EXISTS insurer_filters (
  lob_id      text NOT NULL REFERENCES lobs(id) ON DELETE CASCADE,
  insurer     text NOT NULL,
  product     text NOT NULL,
  cols        jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lob_id, insurer, product)
);

-- ===== M-20: hide a grid from users (data kept; admins still see it) =====
ALTER TABLE lobs ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;

-- ===== M-21: no forced password change — passwords set by the admin work straight away =====
UPDATE users SET must_change=false WHERE must_change;

-- ===== M-23: line-of-business groups (Motor = Private car | PCV | GCV | 2 Wheeler | 3 Wheeler) =====
ALTER TABLE lobs ADD COLUMN IF NOT EXISTS lob_group text;      -- e.g. 'Motor'
ALTER TABLE lobs ADD COLUMN IF NOT EXISTS group_label text;    -- tab name inside the group, e.g. 'Private car', 'PCV'
ALTER TABLE lobs ADD COLUMN IF NOT EXISTS group_order int NOT NULL DEFAULT 0;
UPDATE lobs SET lob_group='Motor', group_label='Private car', group_order=1 WHERE id='motor-pvt-car' AND lob_group IS NULL;
-- Motor PCV grid (created once; switched off until its rates are uploaded — Admin > Grid settings > Hide from users)
INSERT INTO lobs (id, name, rate_col, columns, lob_group, group_label, group_order, insurer_first, hidden)
VALUES ('motor-pcv', 'Motor PCV', 'Base Commission %', '["Insurer", "Product Type", "Vehicle Category", "Age of Vehicle", "Seating", "Location", "RTO", "Vehicle Name", "Fuel Type", "CC", "Business Type", "NCB", "Category", "Depreciation", "Add-on", "Max OD Discount", "Premium", "Policy Term", "Condition", "Age detail", "Seating detail", "PO calculated on", "Base Commission %", "Notes"]', 'Motor', 'PCV', 2, true, true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO lob_columns (lob_id, col, position, is_filter)
SELECT 'motor-pcv', c, ord, c NOT IN ('Age detail','Seating detail','Condition','PO calculated on')
  FROM unnest(ARRAY['Insurer','Product Type','Vehicle Category','Age of Vehicle','Seating','Location','RTO','Vehicle Name','Fuel Type','CC','Business Type','NCB','Category','Depreciation','Add-on','Max OD Discount','Premium','Policy Term','Condition','Age detail','Seating detail','PO calculated on']::text[]) WITH ORDINALITY AS t(c, ord)
ON CONFLICT DO NOTHING;
