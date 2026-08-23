// POST /api/password  { currentPassword, newPassword }
// Any signed-in user changes their own password. Clears the must_change flag
// and returns a fresh token so the client updates without re-login.
const bcrypt = require('bcryptjs');
const { sql, getPool } = require('./_db');
const { requireUser, signToken, send, readJson } = require('./_auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
  const auth = requireUser(req, res);
  if (!auth) return;

  try {
    const { currentPassword, newPassword } = await readJson(req);
    if (!currentPassword || !newPassword) return send(res, 400, { error: 'Enter your current and new password.' });
    if (String(newPassword).length < 8) return send(res, 400, { error: 'New password must be at least 8 characters.' });

    const pool = await getPool();
    const row = (await pool.request().input('id', sql.Int, auth.uid)
      .query('SELECT id, name, email, password_hash, role, branch FROM dbo.users WHERE id = @id AND active = 1')).recordset[0];
    if (!row) return send(res, 401, { error: 'Account not found.' });

    if (!(await bcrypt.compare(currentPassword, row.password_hash))) {
      return send(res, 400, { error: 'Your current password is incorrect.' });
    }

    const hash = await bcrypt.hash(String(newPassword), 10);
    await pool.request().input('id', sql.Int, auth.uid).input('hash', sql.NVarChar(255), hash)
      .query('UPDATE dbo.users SET password_hash = @hash, must_change = 0 WHERE id = @id');

    // Re-issue the token with must_change cleared.
    const fresh = { id: row.id, name: row.name, role: row.role, branch: row.branch, must_change: 0 };
    return send(res, 200, { ok: true, token: signToken(fresh) });
  } catch (err) {
    return send(res, 500, { error: 'Could not change password: ' + err.message });
  }
};
