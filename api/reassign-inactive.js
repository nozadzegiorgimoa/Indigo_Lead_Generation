// POST /api/reassign-inactive   (managers only)
// Finds leads whose current sale operator is no longer an active crm operator
// (left the company / blocked / deleted) and re-distributes them to an active
// operator via the Stage 2 rules. Keeps full history (method 'reassign-inactive').
// GET returns a dry-run preview (what WOULD be reassigned) without changing data.
const { sql, getPool } = require('./_db');
const { requireManager, send } = require('./_auth');
const { distribute, OP_FILTER } = require('./_distribute');
const { setAssignment } = require('./_assign');

module.exports = async (req, res) => {
  const user = requireManager(req, res);
  if (!user) return;
  const dryRun = req.method === 'GET';
  if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });

  try {
    const pool = await getPool();
    // Leads assigned to someone who is NOT currently an active sale operator.
    const stale = (await pool.request().query(
      `SELECT l.id, l.language, l.customer_type AS customerType, l.country, l.city,
              l.sale_operator_id, l.sale_operator_name
         FROM dbo.leads l
        WHERE l.sale_operator_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID
             WHERE u.ID = l.sale_operator_id AND g.Add3 = 1 AND ${OP_FILTER})`
    )).recordset;

    const results = [];
    for (const lead of stale) {
      const target = await distribute(pool, sql, lead);
      const entry = {
        leadId: lead.id,
        from: { id: lead.sale_operator_id, name: lead.sale_operator_name },
        to: target ? { id: target.operatorId, name: target.operatorName, group: target.groupName } : null,
        reason: target ? target.reason : 'no active operator available',
      };
      if (!dryRun && target) {
        await setAssignment(pool, sql, {
          leadId: lead.id,
          op: { id: target.operatorId, name: target.operatorName, groupId: target.groupId, groupName: target.groupName },
          method: 'reassign-inactive',
          reason: 'previous operator inactive · ' + target.reason,
          assignedBy: user.uid,
        });
        await pool.request().input('lid', sql.Int, lead.id)
          .input('t', sql.NVarChar(400), ('Reassigned (inactive ' + (lead.sale_operator_name || lead.sale_operator_id) + ') → ' + target.operatorName).slice(0, 400))
          .input('a', sql.Int, user.uid)
          .query('INSERT INTO dbo.lead_history (lead_id, text, actor_id) VALUES (@lid, @t, @a)');
      }
      results.push(entry);
    }

    return send(res, 200, {
      dryRun,
      staleCount: stale.length,
      reassigned: dryRun ? 0 : results.filter(r => r.to).length,
      results,
      note: 'Marketing notification is deferred to a later step (Q4).',
    });
  } catch (err) {
    return send(res, 500, { error: 'Reassign-inactive failed: ' + err.message });
  }
};
