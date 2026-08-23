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
    const result = await pool.request()
      .input('email', sql.NVarChar(190), String(email).trim().toLowerCase())
      .query('SELECT TOP 1 id, name, email, password_hash, role, branch, active, must_change FROM dbo.users WHERE LOWER(email) = @email');

    const user = result.recordset[0];
    // Same response whether the email or the password is wrong.
    if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) {
      return send(res, 401, { error: 'Wrong email or password.' });
    }

    return send(res, 200, {
      token: signToken(user),
      user: { id: user.id, name: user.name, email: user.email, role: user.role, branch: user.branch, mustChange: !!user.must_change },
    });
  } catch (err) {
    return send(res, 500, { error: 'Login failed: ' + err.message });
  }
};
