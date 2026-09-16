// POST /api/reassign  { leadId, customerType?, language?, region?, saleOperatorId? }
// Reassign an existing lead's hot lead in the CRM, optionally redefining fields.
// Full managers reassign any lead; group managers only within their own group.
// Without saleOperatorId it fair-rotates; with it, that operator is forced
// (validated, and — for group managers — required to be in their group).
const { sql, getPool } = require('./_db');
const { requireUser, send, readJson } = require('./_auth');

module.exports = async (req, res) => {
  const tok = requireUser(req, res);
  if (!tok) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  try {
    const pool = await getPool();
    const actor = (await pool.request().input('id', sql.Int, tok.uid)
      .query('SELECT id, role, managed_group_id FROM dbo.users WHERE id = @id AND active = 1')).recordset[0];
    if (!actor) return send(res, 403, { error: 'No access.' });
    const isAdmin = actor.role === 'manager';
    const groupId = actor.managed_group_id || null;
    if (!isAdmin && !groupId) return send(res, 403, { error: 'Only managers can reassign leads.' });

    const b = await readJson(req);
    const leadId = Number(b.leadId);
    if (!leadId) return send(res, 400, { error: 'leadId is required.' });

    const lead = (await pool.request().input('id', sql.Int, leadId)
      .query('SELECT id, crm_lid FROM dbo.leads WHERE id = @id')).recordset[0];
    if (!lead) return send(res, 404, { error: 'Lead not found.' });
    if (!lead.crm_lid) return send(res, 409, { error: 'This lead has no CRM hot lead yet — it is still being pushed. Try again in a minute.' });

    const ct = b.customerType === 'dealer' ? 'Dealer' : b.customerType === 'retail' ? 'Retail' : null;
    const langMap = { georgian: 'georgian', russian: 'russian', ukrainian: 'ukrainian', english: 'english' };
    const lang = langMap[b.language] || null;

    const rq = pool.request()
      .input('lid', sql.Numeric(18, 0), lead.crm_lid)
      .input('ct', sql.NVarChar(20), ct)
      .input('lang', sql.NVarChar(20), lang)
      .input('reg', sql.NVarChar(120), (b.region || '').trim() || null)
      .input('force', sql.Int, b.saleOperatorId ? Number(b.saleOperatorId) : null)
      .input('restrict', sql.Int, isAdmin ? null : groupId)
      .input('actor', sql.Int, actor.id)
      .output('out_aid', sql.Int)
      .output('out_name', sql.NVarChar(225))
      .output('out_group', sql.NVarChar(200));
    let r;
    try {
      r = await rq.execute('crm.dbo.reassign_hot_lead');
    } catch (e) {
      // Proc RAISERROR messages are meaningful to the user (group fence, no pool…).
      return send(res, 400, { error: e.message.replace(/^.*?:\s*/, '') });
    }
    const owner = { id: r.output.out_aid, name: r.output.out_name, group: r.output.out_group };

    await pool.request().input('id', sql.Int, leadId)
      .input('text', sql.NVarChar(400), ('Reassigned → ' + owner.name + ' (' + owner.group + ')' +
        (ct ? ' · ' + ct : '') + (lang ? ' · ' + lang : '')).slice(0, 400))
      .input('actorId', sql.Int, actor.id)
      .query('INSERT INTO dbo.lead_history (lead_id, text, actor_id) VALUES (@id, @text, @actorId)');

    return send(res, 200, { ok: true, owner });
  } catch (err) {
    return send(res, 500, { error: 'Reassign failed: ' + err.message });
  }
};
