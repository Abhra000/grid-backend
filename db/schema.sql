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
