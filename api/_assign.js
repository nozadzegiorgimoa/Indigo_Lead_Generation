// Shared assignment writer: closes the current assignment (stamps ended_at),
// opens a new current one, and syncs the denormalised owner on dbo.leads.
// Keeps the full rotation history in dbo.lead_assignments.

// op: { id, name, groupId, groupName } — sale operator (crm). id may be null
//     for a group-only inbox assignment.
async function setAssignment(pool, sql, { leadId, op, method, reason, assignedBy }) {
  // 1) Close the currently-active assignment, if any.
  await pool.request().input('lid', sql.Int, leadId).query(
    'UPDATE dbo.lead_assignments SET ended_at = SYSUTCDATETIME(), is_current = 0 WHERE lead_id = @lid AND is_current = 1'
  );

  // 2) Insert the new active assignment.
  await pool.request()
    .input('lid', sql.Int, leadId)
    .input('opId', sql.Int, op && op.id != null ? op.id : null)
    .input('opName', sql.NVarChar(225), op ? op.name || null : null)
    .input('gId', sql.Int, op && op.groupId != null ? op.groupId : null)
    .input('gName', sql.NVarChar(200), op ? op.groupName || null : null)
    .input('method', sql.NVarChar(24), method)
    .input('reason', sql.NVarChar(400), (reason || '').slice(0, 400) || null)
    .input('by', sql.Int, assignedBy != null ? assignedBy : null)
    .query(
      `INSERT INTO dbo.lead_assignments
         (lead_id, sale_operator_id, sale_operator_name, sale_group_id, sale_group_name, method, reason, assigned_by, is_current)
       VALUES (@lid, @opId, @opName, @gId, @gName, @method, @reason, @by, 1)`
    );

  // 3) Sync the denormalised owner on the lead for fast reads.
  await pool.request()
    .input('lid', sql.Int, leadId)
    .input('opId', sql.Int, op && op.id != null ? op.id : null)
    .input('opName', sql.NVarChar(225), op ? op.name || null : null)
    .input('gId', sql.Int, op && op.groupId != null ? op.groupId : null)
    .input('gName', sql.NVarChar(200), op ? op.groupName || null : null)
    .query(
      `UPDATE dbo.leads
          SET sale_operator_id = @opId, sale_operator_name = @opName,
              sale_group_id = @gId, sale_group_name = @gName
        WHERE id = @lid`
    );
}

module.exports = { setAssignment };
