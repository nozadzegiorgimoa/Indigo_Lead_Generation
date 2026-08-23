// GET /api/me  ->  the signed-in user (verifies the token is still valid)
const { requireUser, send } = require('./_auth');

module.exports = async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  return send(res, 200, { id: user.uid, name: user.name, role: user.role, branch: user.branch, mustChange: !!user.mustChange });
};
