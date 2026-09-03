-- ============================================================
-- Stage 4 — data provenance: RAW entered values vs PROCESSED (parser/ML) values.
-- Existing columns keep ONLY what was typed on the portal (NULL if not entered);
-- new *_processed columns hold parser output. Display/push = entered ?? processed.
-- Idempotent. Target DB: Indigo_Lead_Generation.
-- ============================================================

-- Entered columns must allow NULL (short form enters almost nothing).
ALTER TABLE dbo.leads ALTER COLUMN name NVARCHAR(160) NULL;
ALTER TABLE dbo.leads ALTER COLUMN customer_type NVARCHAR(20) NULL;
GO

IF COL_LENGTH('dbo.leads','name_processed')          IS NULL ALTER TABLE dbo.leads ADD name_processed          NVARCHAR(160) NULL;
IF COL_LENGTH('dbo.leads','phone_processed')         IS NULL ALTER TABLE dbo.leads ADD phone_processed         NVARCHAR(60)  NULL;
IF COL_LENGTH('dbo.leads','source_processed')        IS NULL ALTER TABLE dbo.leads ADD source_processed        NVARCHAR(60)  NULL;
IF COL_LENGTH('dbo.leads','customer_type_processed') IS NULL ALTER TABLE dbo.leads ADD customer_type_processed NVARCHAR(20)  NULL;
IF COL_LENGTH('dbo.leads','city_processed')          IS NULL ALTER TABLE dbo.leads ADD city_processed          NVARCHAR(120) NULL;
IF COL_LENGTH('dbo.leads','country_processed')       IS NULL ALTER TABLE dbo.leads ADD country_processed       NVARCHAR(80)  NULL;
GO

-- One-time migration of historical SHORT-form rows: their name/phone/source/type/
-- city/country came from the parser, not typing -> move to *_processed and clear
-- the entered columns. (Runs only while *_processed is still empty.)
UPDATE dbo.leads
   SET name_processed          = name,
       phone_processed         = phone,
       source_processed        = source,
       customer_type_processed = customer_type,
       city_processed          = city,
       country_processed       = country,
       name = NULL, phone = NULL, source = NULL, customer_type = NULL, city = NULL, country = NULL
 WHERE form_mode = 'short'
   AND name_processed IS NULL AND phone_processed IS NULL AND source_processed IS NULL;
GO
