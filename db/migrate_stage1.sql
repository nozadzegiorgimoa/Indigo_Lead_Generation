-- ============================================================
-- Stage 1 — lead capture: additive columns on dbo.leads.
-- Safe to run repeatedly (guards on each column). No data loss:
-- all new columns are NULLable or have defaults.
-- Target DB: Indigo_Lead_Generation (srv_4_24).
-- ============================================================

-- Speaking language the processing operator should use.
IF COL_LENGTH('dbo.leads', 'language') IS NULL
  ALTER TABLE dbo.leads ADD language NVARCHAR(20) NULL;   -- 'georgian'|'russian'|'ukrainian'|'english'

-- Customer type: retail (საცალო) vs dealer (სადილერო). Defaults to retail.
IF COL_LENGTH('dbo.leads', 'customer_type') IS NULL
  ALTER TABLE dbo.leads ADD customer_type NVARCHAR(20) NOT NULL
    CONSTRAINT DF_leads_customer_type DEFAULT ('retail');

-- Customer location (distinct from branch = Indigo office).
IF COL_LENGTH('dbo.leads', 'country') IS NULL
  ALTER TABLE dbo.leads ADD country NVARCHAR(80) NULL;
IF COL_LENGTH('dbo.leads', 'city') IS NULL
  ALTER TABLE dbo.leads ADD city NVARCHAR(120) NULL;

-- Canonical phone form for duplicate detection (digits, E.164-ish).
IF COL_LENGTH('dbo.leads', 'phone_normalized') IS NULL
  ALTER TABLE dbo.leads ADD phone_normalized NVARCHAR(40) NULL;

-- Chosen sale operator = a crm.dbo.users row (different population from portal users).
-- Denormalised name/group cached for display because crm is a separate DB.
IF COL_LENGTH('dbo.leads', 'sale_operator_id') IS NULL
  ALTER TABLE dbo.leads ADD sale_operator_id INT NULL;
IF COL_LENGTH('dbo.leads', 'sale_operator_name') IS NULL
  ALTER TABLE dbo.leads ADD sale_operator_name NVARCHAR(225) NULL;
IF COL_LENGTH('dbo.leads', 'sale_group_id') IS NULL
  ALTER TABLE dbo.leads ADD sale_group_id INT NULL;
IF COL_LENGTH('dbo.leads', 'sale_group_name') IS NULL
  ALTER TABLE dbo.leads ADD sale_group_name NVARCHAR(200) NULL;

-- Leftover comment text after parsing (incl. the tail after "sms").
IF COL_LENGTH('dbo.leads', 'additional_comment') IS NULL
  ALTER TABLE dbo.leads ADD additional_comment NVARCHAR(MAX) NULL;

-- Which form produced the lead (audit).
IF COL_LENGTH('dbo.leads', 'form_mode') IS NULL
  ALTER TABLE dbo.leads ADD form_mode NVARCHAR(10) NULL;   -- 'short'|'full'
GO

-- Index to make duplicate lookups fast.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_leads_phone_norm' AND object_id = OBJECT_ID('dbo.leads'))
  CREATE INDEX IX_leads_phone_norm ON dbo.leads(phone_normalized) WHERE phone_normalized IS NOT NULL;
GO
