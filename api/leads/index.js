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
        clauses.push('(LOWER(ISNULL(l.name, ISNULL(l.name_processed,\'\'))) LIKE @q OR LOWER(ISNULL(l.phone, ISNULL(l.phone_processed,\'\'))) LIKE @q OR LOWER(ISNULL(l.car,\'\')) LIKE @q)');
        reqd.input('q', sql.NVarChar(200), '%' + q + '%');
      }
      const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
      // Display = effective (entered ?? processed); raw stays untouched in the table.
      // The real owner comes from the CRM (via crm_lid -> loans.AID -> mirrored operator).
      const result = await reqd.query(
        `SELECT l.id,
                COALESCE(l.name, l.name_processed, l.phone, l.phone_processed) AS name,
                COALESCE(l.phone, l.phone_processed) AS phone,
                l.service, l.car, l.branch, l.status,
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

      // ===== PROVENANCE MODEL =====
      // ENTERED (raw, stored in the base columns): exactly what the person typed/
      // picked on the portal — never merged with parser output, NULL when blank.
      // PROCESSED (stored in *_processed): what the parser extracted from the
      // comment. EFFECTIVE (entered ?? processed) is used for validation, dedup
      // and the CRM push, but is never written over either original.
      const parsed = shortMode ? parseComment(b.notes, { defaultCountry: 'GE' })
                               : { name: null, phone: null, phoneInfo: null, country: null, city: null, source: null, customerType: null, additionalComment: null };

      // --- entered (raw) ---
      const entName    = (b.name || '').trim() || null;
      const entPhone   = (b.phone || '').trim() || null;
      const entSource  = shortMode ? null : ((b.source || '').trim() || null);
      const entType    = shortMode ? null : (CUSTOMER_TYPES.includes(b.customerType) ? b.customerType : null);
      const entCountry = shortMode ? null : ((b.country || '').trim() || null);
      const entCity    = shortMode ? null : ((b.city || '').trim() || null);
      const language   = LANGUAGES.includes(b.language) ? b.language : null;  // dropdown = entered
      const service    = SERVICE_IDS.includes(b.service) ? b.service : 'import';

      // --- processed (parser/ML) ---
      const procName   = parsed.name || null;
      const procPhone  = parsed.phone || null;
      const procSource = parsed.source || null;
      const procType   = CUSTOMER_TYPES.includes(parsed.customerType) ? parsed.customerType : null;

      // --- effective (entered wins) ---
      const name = entName || procName || '';
      const phoneRaw = entPhone || procPhone || '';
      if (!name && !phoneRaw) return send(res, 400, { error: 'A lead needs at least a name or a phone number.' });

      // ----- Phone validation + country detection (on the effective phone) -----
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
      // Duplicate handling is delegated to the CRM (create_hot_lead reuses the client).

      const procCountry = parsed.country || phoneInfo.countryName || null;        // derived
      const procCity    = parsed.city || (phoneInfo.country === 'GE' ? 'Tbilisi' : null);

      const customerType = entType || procType || 'retail';
      const source  = entSource || procSource || null;
      const country = entCountry || procCountry || null;
      const city    = entCity || procCity || null;
      const additionalComment = shortMode ? (parsed.additionalComment || null)
                                          : ((b.additionalComment || '').trim() || null);

      // --- raw manual sale-operator pick (persisted from the mirror) ---
      let pickedOp = null;
      if (b.saleOperatorId) {
        pickedOp = (await pool.request().input('sid', sql.Int, Number(b.saleOperatorId)).query(
          'SELECT crm_user_id, name, group_id, group_name FROM dbo.sale_operators WHERE crm_user_id = @sid'
        )).recordset[0] || null;
      }

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
        .input('name', sql.NVarChar(160), entName)                       // RAW entered only
        .input('phone', sql.NVarChar(60), entPhone)
        .input('phoneNorm', sql.NVarChar(40), phoneNorm)                 // technical (effective)
        .input('email', sql.NVarChar(190), (b.email || '').trim() || null)
        .input('channel', sql.NVarChar(40), b.channel || null)
        .input('branch', sql.NVarChar(120), b.branch || null)
        .input('service', sql.NVarChar(40), service)
        .input('car', sql.NVarChar(200), (b.car || '').trim() || null)
        .input('budget', sql.NVarChar(60), (b.budget || '').trim() || null)
        .input('source', sql.NVarChar(60), entSource)
        .input('notes', sql.NVarChar(sql.MAX), (b.notes || '').trim() || null)
        .input('followUp', sql.Date, b.followUp || null)
        .input('operatorId', sql.Int, operatorId)
        .input('language', sql.NVarChar(20), language)
        .input('customerType', sql.NVarChar(20), entType)
        .input('country', sql.NVarChar(80), entCountry)
        .input('city', sql.NVarChar(120), entCity)
        .input('additional', sql.NVarChar(sql.MAX), additionalComment)
        .input('formMode', sql.NVarChar(10), shortMode ? 'short' : 'full')
        .input('pName', sql.NVarChar(160), procName)                     // PROCESSED (parser)
        .input('pPhone', sql.NVarChar(60), procPhone)
        .input('pSource', sql.NVarChar(60), procSource)
        .input('pType', sql.NVarChar(20), procType)
        .input('pCity', sql.NVarChar(120), procCity)
        .input('pCountry', sql.NVarChar(80), procCountry)
        .input('soId', sql.Int, pickedOp ? pickedOp.crm_user_id : null)  // RAW manual pick
        .input('soName', sql.NVarChar(225), pickedOp ? pickedOp.name : null)
        .input('sgId', sql.Int, pickedOp ? pickedOp.group_id : null)
        .input('sgName', sql.NVarChar(200), pickedOp ? pickedOp.group_name : null)
        .query(
          `INSERT INTO dbo.leads
             (name, phone, phone_normalized, email, channel, branch, service, car, budget, source,
              notes, follow_up, status, operator_id, language, customer_type, country, city,
              additional_comment, form_mode,
              name_processed, phone_processed, source_processed, customer_type_processed,
              city_processed, country_processed,
              sale_operator_id, sale_operator_name, sale_group_id, sale_group_name)
           OUTPUT INSERTED.id
           VALUES
             (@name, @phone, @phoneNorm, @email, @channel, @branch, @service, @car, @budget, @source,
              @notes, @followUp, 'new', @operatorId, @language, @customerType, @country, @city,
              @additional, @formMode,
              @pName, @pPhone, @pSource, @pType, @pCity, @pCountry,
              @soId, @soName, @sgId, @sgName)`
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
          .input('force_operator_id', sql.Int, b.saleOperatorId ? Number(b.saleOperatorId) : null)
          .output('out_cid', sql.Numeric(18, 0))
          .output('out_lid', sql.Numeric(18, 0))
          .output('out_action', sql.NVarChar(40))
          .output('out_note', sql.NVarChar(300))
          .execute('crm.dbo.create_hot_lead');
        crm = { cid: r.output.out_cid, lid: r.output.out_lid, action: r.output.out_action,
                note: r.output.out_note || null };
        if (crm.action === 'blocked') {
          // CRM refused to auto-assign (previous owner invalid): flag the portal
          // lead for a human and surface the reason to the person who entered it.
          await pool.request()
            .input('id', sql.Int, leadId)
            .input('cid', sql.Numeric(18, 0), crm.cid)
            .query("UPDATE dbo.leads SET crm_cid = @cid, crm_action = 'blocked', status = 'blocked' WHERE id = @id");
          await pool.request()
            .input('leadId', sql.Int, leadId)
            .input('text', sql.NVarChar(400), ('BLOCKED — not distributed: ' + (crm.note || 'previous owner invalid') + '. Re-submit with a manually selected sale operator.').slice(0, 400))
            .input('actorId', sql.Int, user.uid)
            .query('INSERT INTO dbo.lead_history (lead_id, text, actor_id) VALUES (@leadId, @text, @actorId)');
        } else {
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
        }
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
