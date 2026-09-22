// GET /api/status  ->  { open: bool }   (public, no auth)
// Portal open/closed is a DB flag (app_settings 'portal_open' = 1 open / 0 closed)
// so it can be toggled instantly with one SQL statement — no redeploy.
const { getPool } = require('./_db');
const { send } = require('./_auth');

module.exports = async (req, res) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query("SELECT val FROM dbo.app_settings WHERE [key] = 'portal_open'");
    // Default OPEN if the flag row is missing, so a lost row never locks everyone out.
    const open = r.recordset.length ? Number(r.recordset[0].val) === 1 : true;
    return send(res, 200, { open });
  } catch (e) {
    return send(res, 200, { open: true });   // never hard-fail the status probe
  }
};
