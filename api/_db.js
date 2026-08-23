// Shared MSSQL connection pool for all serverless functions.
// The pool is cached on globalThis so warm Lambda invocations reuse a
// single connection instead of opening a new one on every request.
const sql = require('mssql');

const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || '1433', 10),
  options: {
    encrypt: String(process.env.DB_ENCRYPT || 'true') === 'true',
    trustServerCertificate: String(process.env.DB_TRUST_SERVER_CERTIFICATE || 'false') === 'true',
    enableArithAbort: true,
  },
  pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
  connectionTimeout: 15000,
  requestTimeout: 15000,
};

async function getPool() {
  if (!process.env.DB_SERVER) {
    throw new Error('Database is not configured. Set DB_SERVER, DB_NAME, DB_USER and DB_PASSWORD in the Vercel environment.');
  }
  if (!globalThis.__indigoPoolPromise) {
    globalThis.__indigoPoolPromise = sql.connect(config).catch((err) => {
      // Reset so the next request retries instead of caching a failed pool.
      globalThis.__indigoPoolPromise = null;
      throw err;
    });
  }
  return globalThis.__indigoPoolPromise;
}

module.exports = { sql, getPool };
