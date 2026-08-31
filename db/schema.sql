-- ============================================================
-- Indigo Cars Portal — Microsoft SQL Server schema
-- ------------------------------------------------------------
-- You do NOT have to run this by hand: POST /api/setup creates
-- these same tables automatically. This file is here for
-- reference and for DBAs who prefer to provision manually.
-- ============================================================

-- ---------- Users (managers + operators) ----------
IF OBJECT_ID('dbo.users', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.users (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    name          NVARCHAR(120)  NOT NULL,
    email         NVARCHAR(190)  NOT NULL UNIQUE,
    password_hash NVARCHAR(255)  NOT NULL,
    role          NVARCHAR(20)   NOT NULL CONSTRAINT CK_users_role CHECK (role IN ('manager','operator')),
    branch        NVARCHAR(120)  NULL,
    active        BIT            NOT NULL CONSTRAINT DF_users_active DEFAULT (1),
    must_change   BIT            NOT NULL CONSTRAINT DF_users_must_change DEFAULT (0),
    created_at    DATETIME2      NOT NULL CONSTRAINT DF_users_created DEFAULT (SYSUTCDATETIME())
  );
END;

-- ---------- Leads ----------
IF OBJECT_ID('dbo.leads', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.leads (
    id           INT IDENTITY(1042,1) PRIMARY KEY,   -- matches the design's starting id
    name         NVARCHAR(160)  NOT NULL,
    phone        NVARCHAR(60)   NULL,
    email        NVARCHAR(190)  NULL,
    channel      NVARCHAR(40)   NULL,
    branch       NVARCHAR(120)  NULL,
    service      NVARCHAR(40)   NOT NULL CONSTRAINT DF_leads_service DEFAULT ('import'),
    car          NVARCHAR(200)  NULL,
    budget       NVARCHAR(60)   NULL,
    source       NVARCHAR(60)   NULL,
    notes        NVARCHAR(MAX)  NULL,
    follow_up    DATE           NULL,
    status       NVARCHAR(20)   NOT NULL CONSTRAINT DF_leads_status DEFAULT ('new')
                   CONSTRAINT CK_leads_status CHECK (status IN ('new','contacted','quoted','won','lost')),
    operator_id  INT            NULL CONSTRAINT FK_leads_operator REFERENCES dbo.users(id),
    -- Stage 1 (lead capture) additions:
    language           NVARCHAR(20)  NULL,   -- 'georgian'|'russian'|'ukrainian'|'english'
    customer_type      NVARCHAR(20)  NOT NULL CONSTRAINT DF_leads_customer_type DEFAULT ('retail'),
    country            NVARCHAR(80)  NULL,
    city               NVARCHAR(120) NULL,
    phone_normalized   NVARCHAR(40)  NULL,   -- canonical digits for duplicate matching
    sale_operator_id   INT           NULL,   -- crm.dbo.users.ID (separate population from portal users)
    sale_operator_name NVARCHAR(225) NULL,
    sale_group_id      INT           NULL,   -- crm.dbo.usersgroups.ID
    sale_group_name    NVARCHAR(200) NULL,
    additional_comment NVARCHAR(MAX) NULL,   -- leftover comment text after parsing (incl. sms tail)
    form_mode          NVARCHAR(10)  NULL,   -- 'short'|'full'
    created_at   DATETIME2      NOT NULL CONSTRAINT DF_leads_created DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX IX_leads_operator ON dbo.leads(operator_id);
  CREATE INDEX IX_leads_status   ON dbo.leads(status);
  CREATE INDEX IX_leads_created  ON dbo.leads(created_at DESC);
  CREATE INDEX IX_leads_phone_norm ON dbo.leads(phone_normalized) WHERE phone_normalized IS NOT NULL;
END;

-- ---------- Activity history ----------
IF OBJECT_ID('dbo.lead_history', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.lead_history (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    lead_id    INT           NOT NULL CONSTRAINT FK_history_lead REFERENCES dbo.leads(id),
    text       NVARCHAR(400) NOT NULL,
    actor_id   INT           NULL CONSTRAINT FK_history_actor REFERENCES dbo.users(id),
    created_at DATETIME2      NOT NULL CONSTRAINT DF_history_created DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX IX_history_lead ON dbo.lead_history(lead_id, created_at DESC);
END;

-- ---------- App settings (round-robin counter etc.) ----------
IF OBJECT_ID('dbo.app_settings', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.app_settings (
    [key] NVARCHAR(60) PRIMARY KEY,
    val   INT NOT NULL
  );
  INSERT INTO dbo.app_settings ([key], val) VALUES ('rr_counter', 0);
END;
