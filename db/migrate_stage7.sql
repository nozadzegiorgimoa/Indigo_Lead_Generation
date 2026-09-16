-- ============================================================
-- Stage 7 — temporarily disabled operators (maternity/long leave).
-- Treated like deleted users: skipped by keeper + rotation, and their existing
-- open hot leads are reassigned to others. Flag lives on the portal mirror and
-- is preserved by sync_sale_operators (its MERGE never writes this column).
-- Idempotent. Target DB: Indigo_Lead_Generation.
-- ============================================================
IF COL_LENGTH('dbo.sale_operators','temp_disabled') IS NULL
  ALTER TABLE dbo.sale_operators ADD temp_disabled BIT NOT NULL CONSTRAINT DF_saleop_tempdis DEFAULT (0);
GO
