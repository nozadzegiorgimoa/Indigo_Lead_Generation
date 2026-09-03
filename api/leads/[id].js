// GET   /api/leads/:id           -> one lead + history (scoped by role)
// PATCH /api/leads/:id           -> { status } and/or { operatorId }
const { sql, getPool } = require('../_db');
const { requireUser, send, readJson } = require('../_auth');
const { getOperator } = require('../_distribute');
const { setAssignment } = require('../_assign');

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
    const crm = await fetchCrmOwner(pool, lead.crm_lid);
    const distHistory = await fetchDistHistory(pool, lead.crm_lid);
    return send(res, 200, { lead: shape(lead), history: hist.recordset, crm, distHistory });
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

      // Only managers may reassign the portal operator (visibility scoping).
      if (b.operatorId != null && user.role === 'manager' && Number(b.operatorId) !== lead.operator_id) {
        const target = (await pool.request().input('oid', sql.Int, Number(b.operatorId))
          .query("SELECT name FROM dbo.users WHERE id = @oid AND role='operator' AND active=1")).recordset[0];
        if (!target) return send(res, 400, { error: 'That operator is not available.' });
        await pool.request().input('id', sql.Int, id).input('oid', sql.Int, Number(b.operatorId))
          .query('UPDATE dbo.leads SET operator_id = @oid WHERE id = @id');
        events.push('Reassigned to ' + target.name);
      }

      // Managers may rotate the SALE operator (crm) — full history is kept.
      if (b.saleOperatorId != null && user.role === 'manager' && Number(b.saleOperatorId) !== lead.sale_operator_id) {
        const picked = await getOperator(pool, sql, b.saleOperatorId);
        if (!picked) return send(res, 400, { error: 'That sale operator is not a valid active operator.' });
        await setAssignment(pool, sql, {
          leadId: id,
          op: { id: picked.id, name: picked.name, groupId: picked.group_id, groupName: picked.group_name },
          method: 'rotation', reason: 'manual reassign', assignedBy: user.uid,
        });
        events.push('Sale operator → ' + picked.name + ' (' + picked.group_name + ')');
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
      const assignments = await fetchAssignments(pool, id);
      return send(res, 200, { lead: shape(fresh.recordset[0]), history: hist.recordset, assignments });
    } catch (err) {
      return send(res, 500, { error: 'Could not update lead: ' + err.message });
    }
  }

  return send(res, 405, { error: 'Method not allowed.' });
};

function shape(l) {
  // Display values = effective (entered ?? processed); `entered` and `processed`
  // expose the untouched originals so provenance is always visible.
  return {
    id: l.id,
    name: l.name || l.name_processed || l.phone || l.phone_processed,
    phone: l.phone || l.phone_processed,
    email: l.email, channel: l.channel,
    branch: l.branch, service: l.service, car: l.car, budget: l.budget,
    source: l.source || l.source_processed,
    notes: l.notes, followUp: l.follow_up, status: l.status,
    operatorId: l.operator_id, operator: l.operator_name, operatorBranch: l.operator_branch,
    language: l.language,
    customerType: l.customer_type || l.customer_type_processed || 'retail',
    country: l.country || l.country_processed,
    city: l.city || l.city_processed,
    additionalComment: l.additional_comment,
    saleOperatorId: l.sale_operator_id, saleOperator: l.sale_operator_name,
    saleGroupId: l.sale_group_id, saleGroup: l.sale_group_name,
    createdAt: l.created_at,
    entered: { name: l.name, phone: l.phone, source: l.source,
               customerType: l.customer_type, country: l.country, city: l.city,
               saleOperatorId: l.sale_operator_id, saleOperator: l.sale_operator_name },
    processed: { name: l.name_processed, phone: l.phone_processed, source: l.source_processed,
                 customerType: l.customer_type_processed, country: l.country_processed,
                 city: l.city_processed },
  };
}

// Local log of procedure-made assignments (create_hot_lead + distribute_hot_leads).
async function fetchDistHistory(pool, crmLid) {
  if (!crmLid) return [];
  const r = await pool.request().input('lid', sql.Numeric(18, 0), crmLid).query(
    `SELECT to_operator_id, to_operator_name, to_group_name, from_operator_id, method, changed_at
       FROM dbo.lead_distribution_history
      WHERE crm_lid = @lid ORDER BY id`
  );
  return r.recordset;
}

// Reflect the lead's current owner from the CRM (the real distribution).
async function fetchCrmOwner(pool, crmLid) {
  if (!crmLid) return null;
  const r = await pool.request().input('lid', sql.Numeric(18, 0), crmLid).query(
    `SELECT cl.AID AS aid, cl.Stage AS stage, cl.State AS state,
            so.name AS operator, so.group_name AS group_name,
            CAST(st.Caption AS nvarchar(100)) COLLATE DATABASE_DEFAULT AS state_caption
       FROM crm.dbo.loans cl
       LEFT JOIN dbo.sale_operators so ON so.crm_user_id = cl.AID
       LEFT JOIN crm.dbo.states st ON st.id = cl.State
      WHERE cl.ID = @lid`
  );
  const row = r.recordset[0];
  if (!row) return null;
  return {
    operator: row.operator, group: row.group_name,
    stage: row.stage, state: row.state, stateCaption: row.state_caption,
    pooled: Number(row.aid) === 1574,
  };
}

// Full assignment timeline for a lead: which operator held it, and when.
async function fetchAssignments(pool, id) {
  const r = await pool.request().input('id', sql.Int, id).query(
    `SELECT la.sale_operator_id, la.sale_operator_name, la.sale_group_name,
            la.method, la.reason, la.assigned_at, la.ended_at, la.is_current,
            u.name AS assigned_by_name
       FROM dbo.lead_assignments la
       LEFT JOIN dbo.users u ON u.id = la.assigned_by
      WHERE la.lead_id = @id
      ORDER BY la.assigned_at DESC, la.id DESC`
  );
  return r.recordset;
}
