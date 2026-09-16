-- ============================================================
-- Stage 8 — Cross-selling recommender (free-text employee name, required when
-- the source is Cross-selling). Stored on the portal lead; also folded into the
-- CRM comment (F145) so the operator sees who referred the client.
-- Idempotent. Target DB: Indigo_Lead_Generation.
-- ============================================================
IF COL_LENGTH('dbo.leads','recommender') IS NULL
  ALTER TABLE dbo.leads ADD recommender NVARCHAR(200) NULL;
GO
