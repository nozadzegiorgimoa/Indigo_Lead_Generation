// Rotation management: group managers switch their members in/out of the
// hot-lead rotation; admins (role=manager) manage everyone.
//   GET  /api/rotation                     -> scoped roster with live status
//   POST /api/rotation {crmUserId,enable}  -> toggle Users_for_leaddistribute.StatusID
// Every toggle is audited in dbo.rotation_audit. Permission comes from the DB
// row (role / managed_group_id), never just the token.
const { sql, getPool } = require('./_db');
const { requireUser, send, readJson } = require('./_auth');

module.exports = async (req, res) => {
  const tok = requireUser(req, res);
  if (!tok) return;
  try {
    const pool = await getPool();
    const actor = (await pool.request().input('id', sql.Int, tok.uid)
      .query('SELECT id, name, role, managed_group_id FROM dbo.users WHERE id = @id AND active = 1')).recordset[0];
    if (!actor) return send(res, 403, { error: 'No access.' });
    const groupId = actor.managed_group_id || null;
    const isAdmin = actor.role === 'manager' && !groupId;  // group mgr is scoped even if role=manager
    if (!isAdmin && !groupId) return send(res, 403, { error: 'Rotation management is for managers only.' });

    if (req.method === 'GET') {
      const rq = pool.request();
      let where = 'so.active = 1';
      if (!isAdmin) { where += ' AND so.group_id = @g'; rq.input('g', sql.Int, groupId); }
      const rows = (await rq.query(
        `SELECT so.crm_user_id, so.name, so.group_id, so.group_name, so.temp_disabled, cfg.s AS status
         FROM dbo.sale_operators so
         LEFT JOIN (SELECT UserID, MAX(StatusID) AS s
                    FROM CRM_Helper.dbo.Users_for_leaddistribute GROUP BY UserID) cfg
           ON cfg.UserID = so.crm_user_id
         WHERE ${where}
         ORDER BY so.group_name, so.name`)).recordset;
      return send(res, 200, {
        canEditAll: isAdmin,
        operators: rows.map((r) => ({
          id: r.crm_user_id, name: r.name, groupId: r.group_id, group: r.group_name,
          inRotation: r.status === 1, hasConfig: r.status !== null,
          tempDisabled: !!r.temp_disabled,
        })),
      });
    }

    if (req.method === 'POST') {
      const b = await readJson(req);
      const opId = Number(b.crmUserId);
      const enable = !!b.enable;
      if (!opId) return send(res, 400, { error: 'crmUserId is required.' });

      const op = (await pool.request().input('id', sql.Int, opId)
        .query('SELECT crm_user_id, name, group_id, group_name FROM dbo.sale_operators WHERE crm_user_id = @id')).recordset[0];
      if (!op) return send(res, 404, { error: 'Operator not found.' });
      if (!isAdmin && op.group_id !== groupId) return send(res, 403, { error: 'You can manage only your own group.' });

      // Temporary disable (maternity / long leave): treat like a leaver — flag on
      // the mirror, drop from rotation, and reassign their open hot leads now.
      if (typeof b.tempDisabled === 'boolean') {
        await pool.request().input('id', sql.Int, opId).input('v', sql.Bit, b.tempDisabled)
          .query('UPDATE dbo.sale_operators SET temp_disabled = @v WHERE crm_user_id = @id');
        let moved = 0;
        if (b.tempDisabled) {
          await pool.request().input('id', sql.Int, opId)
            .query('UPDATE CRM_Helper.dbo.Users_for_leaddistribute SET StatusID = 0 WHERE UserID = @id');
          await pool.request().input('id', sql.Int, opId).input('v', sql.Bit, 0)
            .query('UPDATE dbo.sale_operators SET in_rotation = 0 WHERE crm_user_id = @id');
          const r = await pool.request().input('uid', sql.Int, opId).input('actor', sql.Int, actor.id)
            .output('moved', sql.Int).execute('crm.dbo.reassign_all_from_operator');
          moved = r.output.moved || 0;
        }
        await pool.request()
          .input('aid', sql.Int, actor.id).input('an', sql.NVarChar(120), actor.name)
          .input('oid', sql.Int, opId).input('opn', sql.NVarChar(225), op.name)
          .input('v', sql.Bit, b.tempDisabled)
          .query(`INSERT INTO dbo.rotation_audit (actor_id, actor_name, crm_user_id, operator_name, new_status)
                  VALUES (@aid, @an, @oid, @opn, @v)`);
        return send(res, 200, { ok: true, id: opId, tempDisabled: b.tempDisabled, moved });
      }

      const upd = await pool.request()
        .input('id', sql.Int, opId).input('v', sql.Int, enable ? 1 : 0)
        .query('UPDATE CRM_Helper.dbo.Users_for_leaddistribute SET StatusID = @v WHERE UserID = @id');
      if (!upd.rowsAffected[0]) {
        return send(res, 409, { error: 'This operator has no rotation configuration yet — ask the administrator to add one.' });
      }
      await pool.request().input('id', sql.Int, opId).input('v', sql.Bit, enable)
        .query('UPDATE dbo.sale_operators SET in_rotation = @v WHERE crm_user_id = @id');
      await pool.request()
        .input('aid', sql.Int, actor.id).input('an', sql.NVarChar(120), actor.name)
        .input('oid', sql.Int, opId).input('opn', sql.NVarChar(225), op.name)
        .input('v', sql.Bit, enable)
        .query('INSERT INTO dbo.rotation_audit (actor_id, actor_name, crm_user_id, operator_name, new_status) VALUES (@aid, @an, @oid, @opn, @v)');
      return send(res, 200, { ok: true, id: opId, inRotation: enable });
    }

    return send(res, 405, { error: 'Use GET or POST.' });
  } catch (err) {
    return send(res, 500, { error: 'Rotation request failed: ' + err.message });
  }
};
