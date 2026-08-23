// GET /api/dashboard  ->  stats, pipeline, operator load, recent leads.
// Managers see all leads; operators see only leads assigned to them.
const { sql, getPool } = require('./_db');
const { requireUser, send } = require('./_auth');

const STATUS_IDS = ['new', 'contacted', 'quoted', 'won', 'lost'];

module.exports = async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const isManager = user.role === 'manager';
  try {
    const pool = await getPool();
    const scope = isManager ? '' : ' WHERE operator_id = @uid';
    const mk = () => {
      const r = pool.request();
      if (!isManager) r.input('uid', sql.Int, user.uid);
      return r;
    };

    // Pipeline counts by status.
    const pipeRes = await mk().query(
      `SELECT status, COUNT(*) AS c FROM dbo.leads${scope} GROUP BY status`
    );
    const counts = {};
    STATUS_IDS.forEach((s) => { counts[s] = 0; });
    pipeRes.recordset.forEach((row) => { counts[row.status] = row.c; });

    const total = STATUS_IDS.reduce((a, s) => a + counts[s], 0);
    const won = counts.won;
    const closed = counts.won + counts.lost;
    const inProgress = counts.contacted + counts.quoted;

    // New today (server local date).
    const todayRes = await mk().query(
      `SELECT COUNT(*) AS c FROM dbo.leads${scope}${scope ? ' AND' : ' WHERE'} CAST(created_at AS DATE) = CAST(SYSDATETIME() AS DATE)`
    );
    const newToday = todayRes.recordset[0].c;

    // Operator load (managers only — open leads per operator).
    let operatorLoad = [];
    if (isManager) {
      const loadRes = await pool.request().query(
        `SELECT u.id, u.name, u.branch,
                SUM(CASE WHEN l.status NOT IN ('won','lost') THEN 1 ELSE 0 END) AS open_count
         FROM dbo.users u
         LEFT JOIN dbo.leads l ON l.operator_id = u.id
         WHERE u.role = 'operator' AND u.active = 1
         GROUP BY u.id, u.name, u.branch
         ORDER BY u.id`
      );
      operatorLoad = loadRes.recordset.map((r) => ({ name: r.name, branch: r.branch, open: r.open_count || 0 }));
    }

    // Recent leads (4 newest in scope).
    const recentRes = await mk().query(
      `SELECT TOP 4 l.id, l.name, l.phone, l.service, l.status, u.name AS operator
       FROM dbo.leads l LEFT JOIN dbo.users u ON u.id = l.operator_id${scope}
       ORDER BY l.created_at DESC`
    );

    return send(res, 200, {
      role: user.role,
      stats: {
        total,
        newToday,
        inProgress,
        won,
        closed,
        wonRate: closed ? Math.round((won / closed) * 100) : null,
      },
      pipeline: STATUS_IDS.map((s) => ({ id: s, count: counts[s] })),
      operatorLoad,
      recent: recentRes.recordset,
    });
  } catch (err) {
    return send(res, 500, { error: 'Could not load dashboard: ' + err.message });
  }
};
