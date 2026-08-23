// GET /api/operators  ->  list of active operators (for the reassign dropdown)
const { getPool } = require('./_db');
const { requireUser, send } = require('./_auth');

module.exports = async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query("SELECT id, name, branch FROM dbo.users WHERE role = 'operator' AND active = 1 ORDER BY id");
    return send(res, 200, { operators: result.recordset });
  } catch (err) {
    return send(res, 500, { error: 'Could not load operators: ' + err.message });
  }
};
