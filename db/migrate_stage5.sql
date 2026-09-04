-- Stage 5 — 'blocked' lead status (CRM refused auto-distribution: previous owner
-- invalid; a human must re-submit with a manual sale-operator pick).
-- Applied 2026-09-04. Target DB: Indigo_Lead_Generation.
DECLARE @n nvarchar(200) = (SELECT name FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID('dbo.leads'));
IF @n IS NOT NULL EXEC('ALTER TABLE dbo.leads DROP CONSTRAINT [' + @n + ']');
ALTER TABLE dbo.leads ADD CONSTRAINT CK_leads_status
  CHECK (status IN ('new','contacted','quoted','won','lost','blocked'));
