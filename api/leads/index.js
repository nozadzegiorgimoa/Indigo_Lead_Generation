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
      // The real owner comes from the CRM (via crm_lid -> loans.AID -> mirrored operator).
      const result = await reqd.query(
        `SELECT l.id, l.name, l.phone, l.service, l.car, l.branch, l.status,
                so.name AS operator, so.group_name AS operator_group, l.crm_lid
         FROM dbo.leads l
         LEFT JOIN crm.dbo.loans cl ON cl.ID = l.crm_lid
         LEFT JOIN dbo.sale_operators so ON so.crm_user_id = cl.AID${where}
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
      // Duplicate handling is delegated to the CRM (create_hot_lead: existing phone
      // -> reuse the client and add a Stage-7 lead), so no portal-side 409 here.

      // ----- Field resolution + defaults -----
      // In SHORT mode the only typed inputs are the sale operator, the speaking
      // language and the comment; source/customer-type/country/city all come from
      // parsing, so parsed values win and the form's hidden defaults never override
      // them. In FULL mode the explicit fields win, with parsing as a fallback.
      const service = SERVICE_IDS.includes(b.service) ? b.service : 'import';
      const language = LANGUAGES.includes(b.language) ? b.language : null;
      const customerType = shortMode
        ? (CUSTOMER_TYPES.includes(parsed.customerType) ? parsed.customerType : 'retail')
        : (CUSTOMER_TYPES.includes(b.customerType) ? b.customerType : (parsed.customerType || 'retail'));
      const source = shortMode
        ? (parsed.source || null)
        : (normalizeSource(b.source) || parsed.source || null);
      let country = (shortMode ? (parsed.country || phoneInfo.countryName)
                               : (b.country || parsed.country || phoneInfo.countryName)) || '';
      country = country.toString().trim() || null;
      let city = (shortMode ? (parsed.city || '') : (b.city || parsed.city || '')).toString().trim() || null;
      if (!city && phoneInfo.country === 'GE') city = 'Tbilisi';   // GE default
      const additionalComment = shortMode ? (parsed.additionalComment || null)
                                          : ((b.additionalComment || '').trim() || null);

      // Distribution now happens in the CRM (create_hot_lead -> distribute_hot_leads),
      // so no portal-side sale-operator assignment here.

      // Portal operator_id (role-scoping for the portal UI) stays as before.
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
        .query(
          `INSERT INTO dbo.leads
             (name, phone, phone_normalized, email, channel, branch, service, car, budget, source,
              notes, follow_up, status, operator_id, language, customer_type, country, city,
              additional_comment, form_mode)
           OUTPUT INSERTED.id
           VALUES
             (@name, @phone, @phoneNorm, @email, @channel, @branch, @service, @car, @budget, @source,
              @notes, @followUp, 'new', @operatorId, @language, @customerType, @country, @city,
              @additional, @formMode)`
        );
      const leadId = insert.recordset[0].id;

      await pool.request()
        .input('leadId', sql.Int, leadId)
        .input('text', sql.NVarChar(400), ('Lead created · ' + (source || 'manual')).slice(0, 400))
        .input('actorId', sql.Int, user.uid)
        .query('INSERT INTO dbo.lead_history (lead_id, text, actor_id) VALUES (@leadId, @text, @actorId)');

      // ----- Push into the CRM as a hot lead; the CRM distributes it (min-count). -----
      let crm = null;
      try {
        const r = await pool.request()
          .input('phone', sql.NVarChar(40), phoneNorm || phoneRaw)
          .input('name', sql.NVarChar(200), name || phoneRaw)
          .input('language', sql.NVarChar(20), language || 'georgian')
          .input('region', sql.NVarChar(120), city || null)
          .input('clienttype', sql.NVarChar(20), customerType === 'dealer' ? 'Dealer' : 'Retail')
          .input('source', sql.NVarChar(60), source || null)
          .input('comment', sql.NVarChar(sql.MAX), additionalComment || null)
          .output('out_cid', sql.Numeric(18, 0))
          .output('out_lid', sql.Numeric(18, 0))
          .output('out_action', sql.NVarChar(40))
          .execute('crm.dbo.create_hot_lead');
        crm = { cid: r.output.out_cid, lid: r.output.out_lid, action: r.output.out_action };
        await pool.request()
          .input('id', sql.Int, leadId)
          .input('cid', sql.Numeric(18, 0), crm.cid)
          .input('lid', sql.Numeric(18, 0), crm.lid)
          .input('act', sql.NVarChar(40), crm.action)
          .query('UPDATE dbo.leads SET crm_cid = @cid, crm_lid = @lid, crm_action = @act WHERE id = @id');
        await pool.request()
          .input('leadId', sql.Int, leadId)
          .input('text', sql.NVarChar(400), ('Pushed to CRM · ' + (crm.action || '') + ' · loan ' + (crm.lid || '')).slice(0, 400))
          .input('actorId', sql.Int, user.uid)
          .query('INSERT INTO dbo.lead_history (lead_id, text, actor_id) VALUES (@leadId, @text, @actorId)');
      } catch (e) {
        // Keep the portal record even if the CRM push fails; flag it in history.
        await pool.request()
          .input('leadId', sql.Int, leadId)
          .input('text', sql.NVarChar(400), ('CRM push failed: ' + e.message).slice(0, 400))
          .input('actorId', sql.Int, user.uid)
          .query('INSERT INTO dbo.lead_history (lead_id, text, actor_id) VALUES (@leadId, @text, @actorId)');
      }

      return send(res, 201, {
        id: leadId, operatorId, crm,
        parsed: shortMode ? { name, phone: phoneRaw, source, customerType, country, city, additionalComment } : null,
      });
    } catch (err) {
      return send(res, 500, { error: 'Could not save lead: ' + err.message });
    }
  }

  return send(res, 405, { error: 'Method not allowed.' });
};
