// PATCH /api/users/:id   (manager only)
//   { name, branch, role, active }        -> update fields
//   { resetPassword: true }               -> returns a new one-time temp password
// Safety: a manager cannot deactivate or demote themselves, and the last
// active manager cannot be removed/demoted.
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
  if (req.method !== 'PATCH') return send(res, 405, { error: 'Method not allowed.' });

  const id = parseInt(req.query.id, 10);
  if (!Number.isInteger(id)) return send(res, 400, { error: 'Invalid user id.' });

  const pool = await getPool();
  const target = (await pool.request().input('id', sql.Int, id)
    .query('SELECT id, name, email, role, branch, active FROM dbo.users WHERE id = @id')).recordset[0];
  if (!target) return send(res, 404, { error: 'User not found.' });

  try {
    const b = await readJson(req);

    // Password reset.
    if (b.resetPassword === true) {
      const plain = tempPassword();
      const hash = await bcrypt.hash(plain, 10);
      await pool.request().input('id', sql.Int, id).input('hash', sql.NVarChar(255), hash)
        .query('UPDATE dbo.users SET password_hash = @hash, must_change = 1 WHERE id = @id');
      return send(res, 200, { ok: true, tempPassword: plain });
    }

    // Field updates.
    const sets = [];
    const r = pool.request().input('id', sql.Int, id);

    if (typeof b.name === 'string' && b.name.trim()) { sets.push('name = @name'); r.input('name', sql.NVarChar(120), b.name.trim()); }
    if (typeof b.branch === 'string') { sets.push('branch = @branch'); r.input('branch', sql.NVarChar(120), b.branch.trim() || null); }

    // Role / active changes carry guards against locking out management.
    const demoting = b.role === 'operator' && target.role === 'manager';
    const deactivating = b.active === false && target.active;
    if ((demoting || deactivating)) {
      if (target.id === mgr.uid) return send(res, 400, { error: 'You cannot demote or deactivate your own account.' });
      if (target.role === 'manager') {
        const activeManagers = (await pool.request()
          .query("SELECT COUNT(*) AS c FROM dbo.users WHERE role='manager' AND active=1")).recordset[0].c;
        if (activeManagers <= 1) return send(res, 400, { error: 'At least one active manager is required.' });
      }
    }
    if (b.role === 'manager' || b.role === 'operator') { sets.push('role = @role'); r.input('role', sql.NVarChar(20), b.role); }
    if (typeof b.active === 'boolean') { sets.push('active = @active'); r.input('active', sql.Bit, b.active ? 1 : 0); }

    if (!sets.length) return send(res, 400, { error: 'Nothing to update.' });
    await r.query('UPDATE dbo.users SET ' + sets.join(', ') + ' WHERE id = @id');

    const fresh = (await pool.request().input('id', sql.Int, id)
      .query('SELECT id, name, email, role, branch, active, must_change FROM dbo.users WHERE id = @id')).recordset[0];
    return send(res, 200, { ok: true, user: fresh });
  } catch (err) {
    return send(res, 500, { error: 'Could not update user: ' + err.message });
  }
};
