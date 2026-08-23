// GET  /api/leads?q=&status=   -> list (scoped by role)
// POST /api/leads              -> create a lead, auto-assign round-robin
const { sql, getPool } = require('../_db');
const { requireUser, send, readJson } = require('../_auth');

const STATUS_IDS = ['new', 'contacted', 'quoted', 'won', 'lost'];
const SERVICE_IDS = ['import', 'leasing', 'dealer', 'spares'];

module.exports = async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const pool = await getPool();

  // ---------------- LIST ----------------
  if (req.method === 'GET') {
    try {
      const q = (req.query.q || '').trim().toLowerCase();
      const status = req.query.status;
      const clauses = [];
      const reqd = pool.request();

      if (user.role !== 'manager') { clauses.push('l.operator_id = @uid'); reqd.input('uid', sql.Int, user.uid); }
      if (status && STATUS_IDS.includes(status)) { clauses.push('l.status = @status'); reqd.input('status', sql.NVarChar(20), status); }
      if (q) {
        clauses.push('(LOWER(l.name) LIKE @q OR LOWER(ISNULL(l.phone,\'\')) LIKE @q OR LOWER(ISNULL(l.car,\'\')) LIKE @q)');
        reqd.input('q', sql.NVarChar(200), '%' + q + '%');
      }
      const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
      const result = await reqd.query(
        `SELECT l.id, l.name, l.phone, l.service, l.car, l.branch, l.status,
                u.name AS operator
         FROM dbo.leads l LEFT JOIN dbo.users u ON u.id = l.operator_id${where}
         ORDER BY l.created_at DESC`
      );
      return send(res, 200, { leads: result.recordset });
    } catch (err) {
      return send(res, 500, { error: 'Could not load leads: ' + err.message });
    }
  }

  // ---------------- CREATE ----------------
  if (req.method === 'POST') {
    try {
      const b = await readJson(req);
      const name = (b.name || '').trim();
      const phone = (b.phone || '').trim();
      if (!name && !phone) return send(res, 400, { error: 'A lead needs at least a name or a phone number.' });

      const service = SERVICE_IDS.includes(b.service) ? b.service : 'import';

      // Assignment: operators keep their own leads; managers round-robin
      // across active operators using a persisted counter.
      let operatorId;
      if (user.role === 'operator') {
        operatorId = user.uid;
      } else {
        const ops = (await pool.request()
          .query("SELECT id FROM dbo.users WHERE role='operator' AND active=1 ORDER BY id")).recordset;
        if (!ops.length) return send(res, 400, { error: 'No active operators to assign this lead to.' });
        const bumped = await pool.request().query(
          'UPDATE dbo.app_settings SET val = val + 1 OUTPUT INSERTED.val AS v WHERE [key] = \'rr_counter\''
        );
        const n = bumped.recordset.length ? bumped.recordset[0].v : 1;
        operatorId = ops[(n - 1) % ops.length].id;
      }

      const insert = await pool.request()
        .input('name', sql.NVarChar(160), name || phone)
        .input('phone', sql.NVarChar(60), phone || null)
        .input('email', sql.NVarChar(190), (b.email || '').trim() || null)
        .input('channel', sql.NVarChar(40), b.channel || null)
        .input('branch', sql.NVarChar(120), b.branch || null)
        .input('service', sql.NVarChar(40), service)
        .input('car', sql.NVarChar(200), (b.car || '').trim() || null)
        .input('budget', sql.NVarChar(60), (b.budget || '').trim() || null)
        .input('source', sql.NVarChar(60), b.source || null)
        .input('notes', sql.NVarChar(sql.MAX), (b.notes || '').trim() || null)
        .input('followUp', sql.Date, b.followUp || null)
        .input('operatorId', sql.Int, operatorId)
        .query(
          `INSERT INTO dbo.leads (name, phone, email, channel, branch, service, car, budget, source, notes, follow_up, status, operator_id)
           OUTPUT INSERTED.id
           VALUES (@name, @phone, @email, @channel, @branch, @service, @car, @budget, @source, @notes, @followUp, 'new', @operatorId)`
        );
      const leadId = insert.recordset[0].id;

      await pool.request()
        .input('leadId', sql.Int, leadId)
        .input('text', sql.NVarChar(400), 'Lead created · ' + (b.source || 'manual'))
        .input('actorId', sql.Int, user.uid)
        .query('INSERT INTO dbo.lead_history (lead_id, text, actor_id) VALUES (@leadId, @text, @actorId)');

      const opRow = (await pool.request().input('id', sql.Int, operatorId)
        .query('SELECT name FROM dbo.users WHERE id = @id')).recordset[0];

      return send(res, 201, { id: leadId, operatorId, operatorName: opRow ? opRow.name : null });
    } catch (err) {
      return send(res, 500, { error: 'Could not save lead: ' + err.message });
    }
  }

  return send(res, 405, { error: 'Method not allowed.' });
};
