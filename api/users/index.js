// GET  /api/users   -> all users (manager only)
// POST /api/users    -> create a user, returns a one-time temp password (manager only)
const bcrypt = require('bcryptjs');
const { sql, getPool } = require('../_db');
const { requireManager, send, readJson } = require('../_auth');

function tempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = require('crypto').randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += chars[bytes[i] % chars.length];
  return out;
}

module.exports = async (req, res) => {
  const mgr = requireManager(req, res);
  if (!mgr) return;
  const pool = await getPool();

  if (req.method === 'GET') {
    try {
      const result = await pool.request().query(
        `SELECT u.id, u.name, u.email, u.role, u.branch, u.active, u.must_change,
                (SELECT COUNT(*) FROM dbo.leads l WHERE l.operator_id = u.id AND l.status NOT IN ('won','lost')) AS open_leads
         FROM dbo.users u ORDER BY u.role, u.name`
      );
      return send(res, 200, { users: result.recordset });
    } catch (err) {
      return send(res, 500, { error: 'Could not load users: ' + err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const b = await readJson(req);
      const name = (b.name || '').trim();
      const email = (b.email || '').trim().toLowerCase();
      const role = b.role === 'manager' ? 'manager' : 'operator';
      const branch = (b.branch || '').trim() || null;
      if (!name || !email) return send(res, 400, { error: 'Name and email are required.' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: 'Enter a valid email address.' });

      const exists = await pool.request().input('email', sql.NVarChar(190), email)
        .query('SELECT id FROM dbo.users WHERE LOWER(email) = @email');
      if (exists.recordset.length) return send(res, 409, { error: 'A user with that email already exists.' });

      const plain = tempPassword();
      const hash = await bcrypt.hash(plain, 10);
      const ins = await pool.request()
        .input('name', sql.NVarChar(120), name)
        .input('email', sql.NVarChar(190), email)
        .input('hash', sql.NVarChar(255), hash)
        .input('role', sql.NVarChar(20), role)
        .input('branch', sql.NVarChar(120), branch)
        .query('INSERT INTO dbo.users (name, email, password_hash, role, branch, must_change) OUTPUT INSERTED.id VALUES (@name, @email, @hash, @role, @branch, 1)');

      return send(res, 201, { id: ins.recordset[0].id, name, email, role, branch, tempPassword: plain });
    } catch (err) {
      return send(res, 500, { error: 'Could not create user: ' + err.message });
    }
  }

  return send(res, 405, { error: 'Method not allowed.' });
};
