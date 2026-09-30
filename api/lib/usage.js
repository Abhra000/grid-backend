// Usage tracking: a "visit" = one sitting; activity within 30 minutes counts as the same visit.
// hits = how many searches / filter changes the person made during that visit.
const GAP_MIN = 30;
const lastTouch = new Map();                       // userId -> ms, avoids a DB write on every click

export async function touchVisit(pool, user, req, { force = false } = {}) {
  if (!user || !user.id) return;
  const now = Date.now();
  if (!force && now - (lastTouch.get(user.id) || 0) < 20_000) return;   // at most one write per 20 s per user
  lastTouch.set(user.id, now);
  const upd = await pool.query(
    `UPDATE visits SET last_seen = now(), hits = hits + 1
      WHERE id = (SELECT id FROM visits WHERE user_id = $1 AND last_seen > now() - interval '${GAP_MIN} minutes'
                   ORDER BY last_seen DESC LIMIT 1) RETURNING id`, [user.id]);
  if (!upd.rowCount) await pool.query(
    `INSERT INTO visits (user_id, ip, ua) VALUES ($1, $2, $3)`,
    [user.id, String(req?.ip || '').slice(0, 64), String(req?.headers?.['user-agent'] || '').slice(0, 200)]);
}

export async function usageReport(pool, days = 30) {
  days = Math.min(Math.max(+days || 30, 1), 365);
  const [sum, daily, users] = await Promise.all([
    pool.query(`SELECT
        (SELECT count(*) FROM users)::int                                                        AS users_total,
        (SELECT count(*) FROM users WHERE active)::int                                           AS users_active_accounts,
        (SELECT count(DISTINCT user_id) FROM visits WHERE started_at > now()-interval '7 days')::int  AS users_active_7d,
        (SELECT count(DISTINCT user_id) FROM visits WHERE started_at > now()-($1||' days')::interval)::int AS users_active_period,
        (SELECT count(*) FROM visits WHERE started_at::date = current_date)::int                 AS visits_today,
        (SELECT count(*) FROM visits WHERE started_at > now()-interval '7 days')::int            AS visits_7d,
        (SELECT count(*) FROM visits WHERE started_at > now()-($1||' days')::interval)::int      AS visits_period,
        (SELECT coalesce(sum(hits),0) FROM visits WHERE started_at > now()-($1||' days')::interval)::int AS hits_period`, [String(days)]),
    pool.query(`SELECT d::date::text AS day,
                       count(v.id)::int AS visits, count(DISTINCT v.user_id)::int AS users
                  FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') d
                  LEFT JOIN visits v ON v.started_at::date = d::date
                 GROUP BY d ORDER BY d`, [days]),
    pool.query(`SELECT u.id, u.email, u.name, u.role, u.active, u.auth_provider, u.created_at, u.last_login, u.must_change, (u.pass_hash IS NOT NULL) AS has_password,
                       max(v.last_seen) AS last_visit,
                       count(v.id) FILTER (WHERE v.started_at > now()-($1||' days')::interval)::int AS visits_period,
                       count(v.id)::int AS visits_total,
                       coalesce(sum(v.hits) FILTER (WHERE v.started_at > now()-($1||' days')::interval),0)::int AS hits_period
                  FROM users u LEFT JOIN visits v ON v.user_id = u.id
                 GROUP BY u.id ORDER BY max(v.last_seen) DESC NULLS LAST, u.email`, [String(days)]),
  ]);
  return { days, summary: sum.rows[0], daily: daily.rows, users: users.rows };
}
