-- ============================================================
-- Stage 3 — CRM-distributes, portal-reflects.
-- Portal DB (Indigo_Lead_Generation) objects. crm/CRM_Helper are on the same
-- SQL instance. The CRM proc crm.dbo.create_hot_lead lives in db/crm_create_hot_lead.sql.
-- ============================================================

-- Link a portal lead to its CRM client/loan.
IF COL_LENGTH('dbo.leads','crm_cid')    IS NULL ALTER TABLE dbo.leads ADD crm_cid    NUMERIC(18,0) NULL;
IF COL_LENGTH('dbo.leads','crm_lid')    IS NULL ALTER TABLE dbo.leads ADD crm_lid    NUMERIC(18,0) NULL;
IF COL_LENGTH('dbo.leads','crm_action') IS NULL ALTER TABLE dbo.leads ADD crm_action NVARCHAR(40)  NULL;
GO

-- Mirror of CRM sale operators (no credentials; crm_user_id -> crm.dbo.users.ID).
IF OBJECT_ID('dbo.sale_operators','U') IS NULL
BEGIN
  CREATE TABLE dbo.sale_operators (
    crm_user_id    INT PRIMARY KEY,
    name           NVARCHAR(225) NOT NULL,
    group_id       INT NULL,
    group_name     NVARCHAR(200) NULL,
    region         NVARCHAR(60)  NULL,
    allowed_retail BIT NULL,
    allowed_dealer BIT NULL,
    in_rotation    BIT NOT NULL CONSTRAINT DF_saleop_rot DEFAULT (0),
    active         BIT NOT NULL CONSTRAINT DF_saleop_active DEFAULT (1),
    synced_at      DATETIME2 NOT NULL CONSTRAINT DF_saleop_synced DEFAULT (SYSUTCDATETIME())
  );
END;
GO

-- Refresh the mirror from crm (Add3=1 groups, active). Aggregated to one row per
-- operator (some users have multiple Users_for_leaddistribute rows). Scheduled
-- hourly via the SQL Agent job "sync sale operators".
CREATE OR ALTER PROCEDURE dbo.sync_sale_operators AS
BEGIN
  SET NOCOUNT ON;
  MERGE dbo.sale_operators AS t
  USING (
    SELECT u.ID AS crm_user_id, MIN(u.Name) AS name, MIN(g.ID) AS group_id, MIN(g.Caption) AS group_name,
           MAX(d.Region) AS region, MAX(CAST(d.allowedretail AS int)) AS allowed_retail,
           MAX(CAST(d.alloweddealer AS int)) AS allowed_dealer,
           MAX(CASE WHEN d.StatusID = 1 THEN 1 ELSE 0 END) AS in_rotation
    FROM crm.dbo.users u
    JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID
    LEFT JOIN CRM_Helper.dbo.Users_for_leaddistribute d ON d.UserID = u.ID
    WHERE g.Add3 = 1 AND u.Deleted IS NULL AND u.IsBlocked = 0 AND u.IsDenyAccess = 0
      AND u.Name NOT LIKE 'System%' AND u.Login <> u.Name
    GROUP BY u.ID
  ) AS s
  ON t.crm_user_id = s.crm_user_id
  WHEN MATCHED THEN UPDATE SET
      t.name=s.name, t.group_id=s.group_id, t.group_name=s.group_name, t.region=s.region,
      t.allowed_retail=s.allowed_retail, t.allowed_dealer=s.allowed_dealer, t.in_rotation=s.in_rotation,
      t.active=1, t.synced_at=SYSUTCDATETIME()
  WHEN NOT MATCHED BY TARGET THEN INSERT
      (crm_user_id,name,group_id,group_name,region,allowed_retail,allowed_dealer,in_rotation,active,synced_at)
      VALUES (s.crm_user_id,s.name,s.group_id,s.group_name,s.region,s.allowed_retail,s.allowed_dealer,s.in_rotation,1,SYSUTCDATETIME())
  WHEN NOT MATCHED BY SOURCE THEN UPDATE SET t.active=0, t.synced_at=SYSUTCDATETIME();
END;
GO
