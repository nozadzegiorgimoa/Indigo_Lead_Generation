// One-time bootstrap: creates the tables and seeds the first users.
// Protected by the SETUP_TOKEN env var — send it in the x-setup-token header.
// Idempotent: safe to call more than once; it never re-creates existing
// tables or duplicates users, and reports temp passwords only for the
// users it actually creates on this call.
const bcrypt = require('bcryptjs');
const { sql, getPool } = require('./_db');
const { send, readJson } = require('./_auth');

const SCHEMA = `
IF OBJECT_ID('dbo.users', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.users (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(120) NOT NULL,
    email NVARCHAR(190) NOT NULL UNIQUE,
    password_hash NVARCHAR(255) NOT NULL,
    role NVARCHAR(20) NOT NULL CONSTRAINT CK_users_role CHECK (role IN ('manager','operator')),
    branch NVARCHAR(120) NULL,
    active BIT NOT NULL CONSTRAINT DF_users_active DEFAULT (1),
    must_change BIT NOT NULL CONSTRAINT DF_users_must_change DEFAULT (0),
    created_at DATETIME2 NOT NULL CONSTRAINT DF_users_created DEFAULT (SYSUTCDATETIME())
  );
END;
-- Add must_change to databases created before this column existed.
IF COL_LENGTH('dbo.users', 'must_change') IS NULL
  ALTER TABLE dbo.users ADD must_change BIT NOT NULL CONSTRAINT DF_users_must_change DEFAULT (0);
IF OBJECT_ID('dbo.leads', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.leads (
    id INT IDENTITY(1042,1) PRIMARY KEY,
    name NVARCHAR(160) NOT NULL,
    phone NVARCHAR(60) NULL,
    email NVARCHAR(190) NULL,
    channel NVARCHAR(40) NULL,
    branch NVARCHAR(120) NULL,
    service NVARCHAR(40) NOT NULL CONSTRAINT DF_leads_service DEFAULT ('import'),
    car NVARCHAR(200) NULL,
    budget NVARCHAR(60) NULL,
    source NVARCHAR(60) NULL,
    notes NVARCHAR(MAX) NULL,
    follow_up DATE NULL,
    status NVARCHAR(20) NOT NULL CONSTRAINT DF_leads_status DEFAULT ('new')
      CONSTRAINT CK_leads_status CHECK (status IN ('new','contacted','quoted','won','lost')),
    operator_id INT NULL CONSTRAINT FK_leads_operator REFERENCES dbo.users(id),
    created_at DATETIME2 NOT NULL CONSTRAINT DF_leads_created DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX IX_leads_operator ON dbo.leads(operator_id);
  CREATE INDEX IX_leads_status ON dbo.leads(status);
  CREATE INDEX IX_leads_created ON dbo.leads(created_at DESC);
END;
-- Stage 1 lead-capture columns (idempotent; migrates databases created earlier).
IF COL_LENGTH('dbo.leads', 'language') IS NULL ALTER TABLE dbo.leads ADD language NVARCHAR(20) NULL;
IF COL_LENGTH('dbo.leads', 'customer_type') IS NULL ALTER TABLE dbo.leads ADD customer_type NVARCHAR(20) NOT NULL CONSTRAINT DF_leads_customer_type DEFAULT ('retail');
IF COL_LENGTH('dbo.leads', 'country') IS NULL ALTER TABLE dbo.leads ADD country NVARCHAR(80) NULL;
IF COL_LENGTH('dbo.leads', 'city') IS NULL ALTER TABLE dbo.leads ADD city NVARCHAR(120) NULL;
IF COL_LENGTH('dbo.leads', 'phone_normalized') IS NULL ALTER TABLE dbo.leads ADD phone_normalized NVARCHAR(40) NULL;
IF COL_LENGTH('dbo.leads', 'sale_operator_id') IS NULL ALTER TABLE dbo.leads ADD sale_operator_id INT NULL;
IF COL_LENGTH('dbo.leads', 'sale_operator_name') IS NULL ALTER TABLE dbo.leads ADD sale_operator_name NVARCHAR(225) NULL;
IF COL_LENGTH('dbo.leads', 'sale_group_id') IS NULL ALTER TABLE dbo.leads ADD sale_group_id INT NULL;
IF COL_LENGTH('dbo.leads', 'sale_group_name') IS NULL ALTER TABLE dbo.leads ADD sale_group_name NVARCHAR(200) NULL;
IF COL_LENGTH('dbo.leads', 'additional_comment') IS NULL ALTER TABLE dbo.leads ADD additional_comment NVARCHAR(MAX) NULL;
IF COL_LENGTH('dbo.leads', 'form_mode') IS NULL ALTER TABLE dbo.leads ADD form_mode NVARCHAR(10) NULL;
IF OBJECT_ID('dbo.lead_history', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.lead_history (
    id INT IDENTITY(1,1) PRIMARY KEY,
    lead_id INT NOT NULL CONSTRAINT FK_history_lead REFERENCES dbo.leads(id),
    text NVARCHAR(400) NOT NULL,
    actor_id INT NULL CONSTRAINT FK_history_actor REFERENCES dbo.users(id),
    created_at DATETIME2 NOT NULL CONSTRAINT DF_history_created DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX IX_history_lead ON dbo.lead_history(lead_id, created_at DESC);
END;
IF OBJECT_ID('dbo.app_settings', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.app_settings ([key] NVARCHAR(60) PRIMARY KEY, val INT NOT NULL);
  INSERT INTO dbo.app_settings ([key], val) VALUES ('rr_counter', 0);
END;
IF OBJECT_ID('dbo.lead_assignments', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.lead_assignments (
    id INT IDENTITY(1,1) PRIMARY KEY,
    lead_id INT NOT NULL CONSTRAINT FK_assign_lead REFERENCES dbo.leads(id),
    sale_operator_id INT NULL,
    sale_operator_name NVARCHAR(225) NULL,
    sale_group_id INT NULL,
    sale_group_name NVARCHAR(200) NULL,
    method NVARCHAR(24) NOT NULL,
    reason NVARCHAR(400) NULL,
    assigned_by INT NULL CONSTRAINT FK_assign_actor REFERENCES dbo.users(id),
    assigned_at DATETIME2 NOT NULL CONSTRAINT DF_assign_at DEFAULT (SYSUTCDATETIME()),
    ended_at DATETIME2 NULL,
    is_current BIT NOT NULL CONSTRAINT DF_assign_current DEFAULT (1)
  );
  CREATE INDEX IX_assign_lead ON dbo.lead_assignments(lead_id, assigned_at DESC);
  CREATE INDEX IX_assign_op ON dbo.lead_assignments(sale_operator_id, is_current);
END;
`;

// Default team from the design. Passwords are generated at runtime.
const DEFAULT_USERS = [
  { name: 'Nino Beridze',      email: 'nino@indigocars.ge',    role: 'manager',  branch: 'Tbilisi · Avlabari' },
  { name: 'Giorgi Kapanadze',  email: 'giorgi@indigocars.ge',  role: 'operator', branch: 'Tbilisi · Avlabari' },
  { name: 'Mariam Abuladze',   email: 'mariam@indigocars.ge',  role: 'operator', branch: 'Batumi' },
  { name: 'Data Tsiklauri',    email: 'data@indigocars.ge',    role: 'operator', branch: 'Kutaisi' },
  { name: 'Levan Gogia',       email: 'levan@indigocars.ge',   role: 'operator', branch: 'Gori' },
  { name: 'Ana Melua',         email: 'ana@indigocars.ge',     role: 'operator', branch: 'Marneuli' },
];

function tempPassword() {
  // Readable-ish temp password: 12 url-safe chars.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = require('crypto').randomBytes(12);
  for (let i = 0; i < 12; i++) out += chars[bytes[i] % chars.length];
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });

  const token = req.headers['x-setup-token'];
  if (!process.env.SETUP_TOKEN) return send(res, 500, { error: 'SETUP_TOKEN is not configured.' });
  if (!token || token !== process.env.SETUP_TOKEN) return send(res, 403, { error: 'Invalid setup token.' });

  try {
    const pool = await getPool();
    // 1) Ensure schema.
    await pool.request().batch(SCHEMA);

    // 2) Seed users. Allow caller to override the list via the body.
    const body = await readJson(req);
    const wanted = Array.isArray(body.users) && body.users.length ? body.users : DEFAULT_USERS;

    const created = [];
    for (const u of wanted) {
      if (!u.email || !u.name || !u.role) continue;
      const exists = await pool.request()
        .input('email', sql.NVarChar(190), String(u.email).trim().toLowerCase())
        .query('SELECT id FROM dbo.users WHERE LOWER(email) = @email');
      if (exists.recordset.length) continue;

      const generated = !u.password;
      const plain = u.password || tempPassword();
      const hash = await bcrypt.hash(plain, 10);
      await pool.request()
        .input('name', sql.NVarChar(120), u.name)
        .input('email', sql.NVarChar(190), String(u.email).trim().toLowerCase())
        .input('hash', sql.NVarChar(255), hash)
        .input('role', sql.NVarChar(20), u.role === 'manager' ? 'manager' : 'operator')
        .input('branch', sql.NVarChar(120), u.branch || null)
        .input('mustChange', sql.Bit, generated ? 1 : 0)
        .query('INSERT INTO dbo.users (name, email, password_hash, role, branch, must_change) VALUES (@name, @email, @hash, @role, @branch, @mustChange)');

      // Only echo a generated password (not one the caller supplied).
      created.push({ name: u.name, email: u.email, role: u.role, tempPassword: u.password ? '(as provided)' : plain });
    }

    return send(res, 200, {
      ok: true,
      message: created.length
        ? 'Setup complete. Save these temp passwords now — they are shown only once. Ask each user to change theirs after first login.'
        : 'Schema is ready. All users already existed; nothing was created.',
      created,
    });
  } catch (err) {
    return send(res, 500, { error: 'Setup failed: ' + err.message });
  }
};
