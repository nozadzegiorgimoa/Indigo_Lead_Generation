// GET /api/lead-check?phone=...&notes=...&mode=short|full
// Pre-submit helper for the form: validates the phone, detects the country,
// flags a duplicate, and (short mode) previews the parsed fields. Read-only.
const { getPool } = require('./_db');
const { requireUser, send } = require('./_auth');
const { analyzePhone } = require('./_phone');
const { parseComment } = require('./_parse');

module.exports = async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed.' });

  try {
    const notes = (req.query.notes || '').toString();
    const mode = (req.query.mode || 'full').toString();
    const parsed = mode === 'short' ? parseComment(notes, { defaultCountry: 'GE' }) : null;

    const phoneRaw = (req.query.phone || (parsed && parsed.phone) || '').toString().trim();
    const info = analyzePhone(phoneRaw, 'GE');

    let duplicate = null;
    if (info.normalized) {
      const pool = await getPool();
      const dup = (await pool.request().input('pn', info.normalized).query(
        `SELECT TOP 1 l.id, l.name, l.source, l.status, l.created_at,
                l.sale_operator_name, u.name AS operator,
                (SELECT MAX(created_at) FROM dbo.lead_history WHERE lead_id = l.id) AS last_activity
           FROM dbo.leads l LEFT JOIN dbo.users u ON u.id = l.operator_id
          WHERE l.phone_normalized = @pn ORDER BY l.created_at DESC`
      )).recordset[0];
      if (dup) duplicate = {
        id: dup.id, name: dup.name, source: dup.source, status: dup.status,
        createdAt: dup.created_at, lastActivity: dup.last_activity,
        manager: dup.sale_operator_name || dup.operator || null,
      };
    }

    return send(res, 200, {
      phone: { raw: phoneRaw, found: info.found, valid: info.valid, country: info.country, countryName: info.countryName, e164: info.e164 },
      duplicate,
      parsed: parsed ? {
        name: parsed.name, phone: parsed.phone, source: parsed.source,
        customerType: parsed.customerType, country: parsed.country, city: parsed.city,
        additionalComment: parsed.additionalComment,
      } : null,
    });
  } catch (err) {
    return send(res, 500, { error: 'Check failed: ' + err.message });
  }
};
