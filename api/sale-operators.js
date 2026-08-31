// GET /api/sale-operators
// Live roster of assignable sale operators, grouped by sales group, read
// cross-DB from crm.dbo.users on the same SQL instance. Sales groups are
// usersgroups.Add3 = 1; active = Deleted IS NULL and not blocked/denied;
// placeholder accounts (System*, generic login==name) are excluded.
const { getPool } = require('./_db');
const { requireUser, send } = require('./_auth');

module.exports = async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });

  try {
    const pool = await getPool();
    const result = await pool.request().query(
      `SELECT g.ID AS group_id, g.Caption AS group_name, u.ID AS user_id, u.Name AS user_name
         FROM crm.dbo.users u
         JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID
        WHERE g.Add3 = 1
          AND u.Deleted IS NULL
          AND u.IsBlocked = 0
          AND u.IsDenyAccess = 0
          AND u.Name NOT LIKE 'System%'
          AND u.Login <> u.Name
        ORDER BY g.Caption, u.Name`
    );

    // Shape into groups -> operators for the grouped dropdown.
    const byGroup = new Map();
    for (const r of result.recordset) {
      if (!byGroup.has(r.group_id)) byGroup.set(r.group_id, { id: r.group_id, name: r.group_name, operators: [] });
      byGroup.get(r.group_id).operators.push({ id: r.user_id, name: r.user_name });
    }
    return send(res, 200, { groups: Array.from(byGroup.values()) });
  } catch (err) {
    return send(res, 500, { error: 'Could not load sale operators: ' + err.message });
  }
};
