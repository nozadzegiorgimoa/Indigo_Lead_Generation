// GET   /api/leads/:id           -> one lead + history (scoped by role)
// PATCH /api/leads/:id           -> { status } and/or { operatorId }
const { sql, getPool } = require('../_db');
const { requireUser, send, readJson } = require('../_auth');

const STATUS_IDS = ['new', 'contacted', 'quoted', 'won', 'lost'];
const STATUS_LABEL = { new: 'New', contacted: 'Contacted', quoted: 'Quoted', won: 'Won', lost: 'Lost' };

module.exports = async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;

  const id = parseInt(req.query.id, 10);
  if (!Number.isInteger(id)) return send(res, 400, { error: 'Invalid lead id.' });

  const pool = await getPool();

  // Fetch the lead and enforce operator scoping.
  const leadRes = await pool.request().input('id', sql.Int, id).query(
    `SELECT l.*, u.name AS operator_name, u.branch AS operator_branch
     FROM dbo.leads l LEFT JOIN dbo.users u ON u.id = l.operator_id
     WHERE l.id = @id`
  );
  const lead = leadRes.recordset[0];
  if (!lead) return send(res, 404, { error: 'Lead not found.' });
  if (user.role !== 'manager' && lead.operator_id !== user.uid) {
    return send(res, 403, { error: 'This lead is assigned to another operator.' });
  }

  // ---------------- READ ----------------
  if (req.method === 'GET') {
    const hist = await pool.request().input('id', sql.Int, id).query(
      'SELECT text, created_at FROM dbo.lead_history WHERE lead_id = @id ORDER BY created_at DESC, id DESC'
    );
    return send(res, 200, { lead: shape(lead), history: hist.recordset });
  }

  // ---------------- UPDATE ----------------
  if (req.method === 'PATCH') {
    try {
      const b = await readJson(req);
      const events = [];

      if (b.status && STATUS_IDS.includes(b.status) && b.status !== lead.status) {
        await pool.request().input('id', sql.Int, id).input('s', sql.NVarChar(20), b.status)
          .query('UPDATE dbo.leads SET status = @s WHERE id = @id');
        events.push('Status → ' + (STATUS_LABEL[b.status] || b.status));
      }

      // Only managers may reassign.
      if (b.operatorId != null && user.role === 'manager' && Number(b.operatorId) !== lead.operator_id) {
        const target = (await pool.request().input('oid', sql.Int, Number(b.operatorId))
          .query("SELECT name FROM dbo.users WHERE id = @oid AND role='operator' AND active=1")).recordset[0];
        if (!target) return send(res, 400, { error: 'That operator is not available.' });
        await pool.request().input('id', sql.Int, id).input('oid', sql.Int, Number(b.operatorId))
          .query('UPDATE dbo.leads SET operator_id = @oid WHERE id = @id');
        events.push('Reassigned to ' + target.name);
      }

      for (const text of events) {
        await pool.request().input('id', sql.Int, id)
          .input('text', sql.NVarChar(400), text).input('actorId', sql.Int, user.uid)
          .query('INSERT INTO dbo.lead_history (lead_id, text, actor_id) VALUES (@id, @text, @actorId)');
      }

      // Return the refreshed lead + history.
      const fresh = await pool.request().input('id', sql.Int, id).query(
        `SELECT l.*, u.name AS operator_name, u.branch AS operator_branch
         FROM dbo.leads l LEFT JOIN dbo.users u ON u.id = l.operator_id WHERE l.id = @id`
      );
      const hist = await pool.request().input('id', sql.Int, id).query(
        'SELECT text, created_at FROM dbo.lead_history WHERE lead_id = @id ORDER BY created_at DESC, id DESC'
      );
      return send(res, 200, { lead: shape(fresh.recordset[0]), history: hist.recordset });
    } catch (err) {
      return send(res, 500, { error: 'Could not update lead: ' + err.message });
    }
  }

  return send(res, 405, { error: 'Method not allowed.' });
};

function shape(l) {
  return {
    id: l.id, name: l.name, phone: l.phone, email: l.email, channel: l.channel,
    branch: l.branch, service: l.service, car: l.car, budget: l.budget,
    source: l.source, notes: l.notes, followUp: l.follow_up, status: l.status,
    operatorId: l.operator_id, operator: l.operator_name, operatorBranch: l.operator_branch,
    createdAt: l.created_at,
  };
}
