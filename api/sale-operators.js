// GET /api/sale-operators
// Grouped sale-operator roster from the portal's own mirror (dbo.sale_operators),
// refreshed from crm by sync_sale_operators. Shows ALL active sale operators
// (every group) so any can be picked for a manual/force assignment.
const { getPool } = require('./_db');
const { requireUser, send } = require('./_auth');

module.exports = async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });

  try {
    const pool = await getPool();
    const result = await pool.request().query(
      `SELECT group_id, group_name, crm_user_id, name, in_rotation
         FROM dbo.sale_operators
        WHERE active = 1
        ORDER BY group_name, name`
    );
    const byGroup = new Map();
    for (const r of result.recordset) {
      if (!byGroup.has(r.group_id)) byGroup.set(r.group_id, { id: r.group_id, name: r.group_name, operators: [] });
      byGroup.get(r.group_id).operators.push({ id: r.crm_user_id, name: r.name, inRotation: !!r.in_rotation });
    }
    return send(res, 200, { groups: Array.from(byGroup.values()) });
  } catch (err) {
    return send(res, 500, { error: 'Could not load sale operators: ' + err.message });
  }
};
