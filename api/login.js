// POST /api/login  { email, password }  ->  { token, user }
const bcrypt = require('bcryptjs');
const { sql, getPool } = require('./_db');
const { signToken, send, readJson } = require('./_auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  try {
    const { email, password } = await readJson(req);
    if (!email || !password) return send(res, 400, { error: 'Enter your email and password.' });

    const pool = await getPool();

    // Portal closed? (merged into another site) — block sign-in until reopened.
    const st = await pool.request().query("SELECT val FROM dbo.app_settings WHERE [key] = 'portal_open'");
    if (st.recordset.length && Number(st.recordset[0].val) === 0) {
      return send(res, 503, { error: 'The portal is currently closed.' });
    }

    const result = await pool.request()
      .input('email', sql.NVarChar(190), String(email).trim().toLowerCase())
      .query('SELECT TOP 1 id, name, email, password_hash, role, branch, active, must_change, managed_group_id FROM dbo.users WHERE LOWER(email) = @email');

    const user = result.recordset[0];
    // Same response whether the email or the password is wrong.
    if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) {
      return send(res, 401, { error: 'Wrong email or password.' });
    }

    // Auto-link Delta group managers: if this account has no managed group yet
    // and the email matches a CRM user with a group-manager rule (Sales_Admin_
    // Retail/Dealer/Region, Apex MN...), inherit that sales group automatically.
    // crm.dbo.users.EmailLogin stores the email base64-encoded.
    if (!user.managed_group_id) {
      try {
        const rows = (await pool.request().query(
          `SELECT u.EmailLogin, u.GroupID FROM crm.dbo.users u
           JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID AND g.Add3 = 1
           WHERE u.Deleted IS NULL AND u.IsBlocked = 0
             AND u.RuleID IN (63, 68, 73, 84, 92, 104)
             AND u.EmailLogin IS NOT NULL AND u.EmailLogin <> ''`)).recordset;
        const mail = String(email).trim().toLowerCase();
        const hit = rows.find((r) => {
          try { return Buffer.from(r.EmailLogin, 'base64').toString('utf8').trim().toLowerCase() === mail; }
          catch (e) { return false; }
        });
        if (hit) {
          await pool.request().input('g', sql.Int, hit.GroupID).input('id', sql.Int, user.id)
            .query('UPDATE dbo.users SET managed_group_id = @g WHERE id = @id');
          user.managed_group_id = hit.GroupID;
        }
      } catch (e) { /* advisory only — login must never fail because of this */ }
    }

    return send(res, 200, {
      token: signToken(user),
      user: { id: user.id, name: user.name, email: user.email, role: user.role, branch: user.branch,
              mustChange: !!user.must_change, managedGroup: user.managed_group_id || null },
    });
  } catch (err) {
    return send(res, 500, { error: 'Login failed: ' + err.message });
  }
};
