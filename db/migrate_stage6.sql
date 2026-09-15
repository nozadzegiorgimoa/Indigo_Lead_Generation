-- ============================================================
-- Stage 6 — group managers can enable/disable their members for lead rotation.
-- Portal users get an optional managed_group_id (CRM usersgroups.ID); toggles
-- write CRM_Helper.dbo.Users_for_leaddistribute.StatusID and are audited.
-- Idempotent. Target DB: Indigo_Lead_Generation.
-- ============================================================
IF COL_LENGTH('dbo.users','managed_group_id') IS NULL
  ALTER TABLE dbo.users ADD managed_group_id INT NULL;
GO

IF OBJECT_ID('dbo.rotation_audit','U') IS NULL
BEGIN
  CREATE TABLE dbo.rotation_audit (
    id INT IDENTITY(1,1) PRIMARY KEY,
    actor_id INT NOT NULL,
    actor_name NVARCHAR(120) NULL,
    crm_user_id INT NOT NULL,
    operator_name NVARCHAR(225) NULL,
    new_status BIT NOT NULL,
    changed_at DATETIME2 NOT NULL CONSTRAINT DF_rota_at DEFAULT (SYSUTCDATETIME())
  );
END;
GO
