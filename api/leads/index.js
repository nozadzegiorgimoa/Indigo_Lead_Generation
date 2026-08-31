// GET  /api/leads?q=&status=   -> list (scoped by role)
// POST /api/leads              -> create a lead, auto-assign round-robin
const { sql, getPool } = require('../_db');
const { requireUser, send, readJson } = require('../_auth');
const { parseComment } = require('../_parse');
const { analyzePhone } = require('../_phone');
const { normalizeSource } = require('../_sources');

const STATUS_IDS = ['new', 'contacted', 'quoted', 'won', 'lost'];
const SERVICE_IDS = ['import', 'leasing', 'dealer', 'spares'];
const LANGUAGES = ['georgian', 'russian', 'ukrainian', 'english'];
const CUSTOMER_TYPES = ['retail', 'dealer'];

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
      const shortMode = b.formMode === 'short';

      // In short mode, parse the comment blob; explicit body fields still win.
      const parsed = shortMode ? parseComment(b.notes, { defaultCountry: 'GE' })
                               : { name: null, phone: null, phoneInfo: null, country: null, city: null, source: null, customerType: null, additionalComment: null };

      const name = (b.name || parsed.name || '').trim();
      const phoneRaw = (b.phone || parsed.phone || '').trim();
      if (!name && !phoneRaw) return send(res, 400, { error: 'A lead needs at least a name or a phone number.' });

      // ----- Phone validation + country detection -----
      const phoneInfo = analyzePhone(phoneRaw, 'GE');
      if ((!phoneInfo.found || !phoneInfo.valid) && !b.confirmInvalidPhone) {
        return send(res, 422, {
          status: 'invalid_phone',
          message: phoneInfo.found
            ? 'This phone number does not look valid. Please check it, or confirm to save anyway.'
            : 'No valid phone number was found. Please add one, or confirm to save without a phone.',
          phone: { raw: phoneRaw, valid: phoneInfo.valid, country: phoneInfo.country, countryName: phoneInfo.countryName },
        });
      }
      const phoneNorm = phoneInfo.normalized || null;

      // ----- Duplicate detection (normalised phone) -----
      if (phoneNorm) {
        const dup = (await pool.request().input('pn', sql.NVarChar(40), phoneNorm).query(
          `SELECT TOP 1 l.id, l.name, l.source, l.status, l.created_at,
                  l.sale_operator_name, u.name AS operator,
                  (SELECT MAX(created_at) FROM dbo.lead_history WHERE lead_id = l.id) AS last_activity
             FROM dbo.leads l LEFT JOIN dbo.users u ON u.id = l.operator_id
            WHERE l.phone_normalized = @pn ORDER BY l.created_at DESC`
        )).recordset[0];
        if (dup) {
          // Per spec: do NOT create a second independent lead. (Notifications = Stage 2.)
          return send(res, 409, {
            status: 'duplicate',
            message: 'This phone number is already registered.',
            existing: {
              id: dup.id, name: dup.name, source: dup.source, status: dup.status,
              createdAt: dup.created_at, lastActivity: dup.last_activity,
              manager: dup.sale_operator_name || dup.operator || null,
            },
          });
        }
      }

      // ----- Field resolution + defaults -----
      const service = SERVICE_IDS.includes(b.service) ? b.service : 'import';
      const language = LANGUAGES.includes(b.language) ? b.language : null;
      const customerType = CUSTOMER_TYPES.includes(b.customerType) ? b.customerType
                         : (CUSTOMER_TYPES.includes(parsed.customerType) ? parsed.customerType : 'retail');
      const source = normalizeSource(b.source) || parsed.source || null;
      let country = (b.country || parsed.country || phoneInfo.countryName || '').trim() || null;
      let city = (b.city || parsed.city || '').trim() || null;
      if (!city && phoneInfo.country === 'GE') city = 'Tbilisi';   // GE default
      const additionalComment = shortMode ? (parsed.additionalComment || null)
                                          : ((b.additionalComment || '').trim() || null);

      // ----- Chosen sale operator (crm.dbo.users), validated live -----
      let saleOp = null;
      if (b.saleOperatorId) {
        saleOp = (await pool.request().input('sid', sql.Int, Number(b.saleOperatorId)).query(
          `SELECT u.ID AS id, u.Name AS name, g.ID AS group_id, g.Caption AS group_name
             FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID
            WHERE u.ID = @sid AND g.Add3 = 1 AND u.Deleted IS NULL
              AND u.IsBlocked = 0 AND u.IsDenyAccess = 0`
        )).recordset[0] || null;
        if (!saleOp) return send(res, 400, { error: 'The selected sale operator is not a valid active operator.' });
      }

      // Portal assignment (role-scoping) stays as before; Stage 2 rewires routing.
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
        .input('name', sql.NVarChar(160), name || phoneRaw)
        .input('phone', sql.NVarChar(60), phoneRaw || null)
        .input('phoneNorm', sql.NVarChar(40), phoneNorm)
        .input('email', sql.NVarChar(190), (b.email || '').trim() || null)
        .input('channel', sql.NVarChar(40), b.channel || null)
        .input('branch', sql.NVarChar(120), b.branch || null)
        .input('service', sql.NVarChar(40), service)
        .input('car', sql.NVarChar(200), (b.car || '').trim() || null)
        .input('budget', sql.NVarChar(60), (b.budget || '').trim() || null)
        .input('source', sql.NVarChar(60), source)
        .input('notes', sql.NVarChar(sql.MAX), (b.notes || '').trim() || null)
        .input('followUp', sql.Date, b.followUp || null)
        .input('operatorId', sql.Int, operatorId)
        .input('language', sql.NVarChar(20), language)
        .input('customerType', sql.NVarChar(20), customerType)
        .input('country', sql.NVarChar(80), country)
        .input('city', sql.NVarChar(120), city)
        .input('additional', sql.NVarChar(sql.MAX), additionalComment)
        .input('formMode', sql.NVarChar(10), shortMode ? 'short' : 'full')
        .input('saleOpId', sql.Int, saleOp ? saleOp.id : null)
        .input('saleOpName', sql.NVarChar(225), saleOp ? saleOp.name : null)
        .input('saleGroupId', sql.Int, saleOp ? saleOp.group_id : null)
        .input('saleGroupName', sql.NVarChar(200), saleOp ? saleOp.group_name : null)
        .query(
          `INSERT INTO dbo.leads
             (name, phone, phone_normalized, email, channel, branch, service, car, budget, source,
              notes, follow_up, status, operator_id, language, customer_type, country, city,
              additional_comment, form_mode, sale_operator_id, sale_operator_name, sale_group_id, sale_group_name)
           OUTPUT INSERTED.id
           VALUES
             (@name, @phone, @phoneNorm, @email, @channel, @branch, @service, @car, @budget, @source,
              @notes, @followUp, 'new', @operatorId, @language, @customerType, @country, @city,
              @additional, @formMode, @saleOpId, @saleOpName, @saleGroupId, @saleGroupName)`
        );
      const leadId = insert.recordset[0].id;

      const histText = ('Lead created · ' + (source || 'manual')
        + (saleOp ? ' · → ' + saleOp.name + ' (' + saleOp.group_name + ')' : '')).slice(0, 400);
      await pool.request()
        .input('leadId', sql.Int, leadId)
        .input('text', sql.NVarChar(400), histText)
        .input('actorId', sql.Int, user.uid)
        .query('INSERT INTO dbo.lead_history (lead_id, text, actor_id) VALUES (@leadId, @text, @actorId)');

      const opRow = (await pool.request().input('id', sql.Int, operatorId)
        .query('SELECT name FROM dbo.users WHERE id = @id')).recordset[0];

      return send(res, 201, {
        id: leadId, operatorId, operatorName: opRow ? opRow.name : null,
        saleOperator: saleOp ? { id: saleOp.id, name: saleOp.name, group: saleOp.group_name } : null,
        parsed: shortMode ? { name, phone: phoneRaw, source, customerType, country, city, additionalComment } : null,
      });
    } catch (err) {
      return send(res, 500, { error: 'Could not save lead: ' + err.message });
    }
  }

  return send(res, 405, { error: 'Method not allowed.' });
};
