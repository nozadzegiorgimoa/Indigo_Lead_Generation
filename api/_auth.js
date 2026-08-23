// Auth + request helpers shared by the API routes.
const jwt = require('jsonwebtoken');

const TOKEN_TTL = '12h';

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not configured in the Vercel environment.');
  return s;
}

function signToken(user) {
  return jwt.sign(
    { uid: user.id, role: user.role, name: user.name, branch: user.branch || null, mustChange: !!user.must_change },
    getSecret(),
    { expiresIn: TOKEN_TTL }
  );
}

// Guard: ensures a valid manager token. Sends 401/403 and returns null otherwise.
function requireManager(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'manager') { send(res, 403, { error: 'Managers only.' }); return null; }
  return user;
}

// Reads and verifies the Bearer token. Returns the decoded payload, or
// null when missing/invalid.
function getUser(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  try {
    return jwt.verify(match[1], getSecret());
  } catch (e) {
    return null;
  }
}

// Guard: ensures a valid token. Sends 401 and returns null when absent.
function requireUser(req, res) {
  const user = getUser(req);
  if (!user) {
    send(res, 401, { error: 'Not signed in. Please log in again.' });
    return null;
  }
  return user;
}

function send(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

// Reads a JSON body regardless of whether the platform pre-parsed it.
async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = { signToken, getUser, requireUser, requireManager, send, readJson };
