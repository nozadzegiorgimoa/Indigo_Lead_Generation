-- ============================================================
-- Stage 2 — lead distribution: assignment history table.
-- One row per assignment of a lead to a sale operator/group.
-- The active assignment has is_current=1 and ended_at IS NULL;
-- superseded rows get ended_at set, so each row is a time window
-- "operator X held this lead from assigned_at to ended_at".
-- Idempotent. Target DB: Indigo_Lead_Generation (srv_4_24).
-- ============================================================

IF OBJECT_ID('dbo.lead_assignments', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.lead_assignments (
    id                 INT IDENTITY(1,1) PRIMARY KEY,
    lead_id            INT           NOT NULL CONSTRAINT FK_assign_lead REFERENCES dbo.leads(id),
    sale_operator_id   INT           NULL,       -- crm.dbo.users.ID (null only for a group-inbox assignment)
    sale_operator_name NVARCHAR(225) NULL,       -- snapshot (crm is a separate DB)
    sale_group_id      INT           NULL,       -- crm.dbo.usersgroups.ID
    sale_group_name    NVARCHAR(200) NULL,
    method             NVARCHAR(24)  NOT NULL,   -- 'manual'|'auto-rule'|'rotation'|'reassign-inactive'
    reason             NVARCHAR(400) NULL,       -- e.g. 'russian+dealer -> Markov (rr)'
    assigned_by        INT           NULL CONSTRAINT FK_assign_actor REFERENCES dbo.users(id),  -- portal user (null=system)
    assigned_at        DATETIME2     NOT NULL CONSTRAINT DF_assign_at DEFAULT (SYSUTCDATETIME()),
    ended_at           DATETIME2     NULL,        -- set when superseded; NULL = still active
    is_current         BIT           NOT NULL CONSTRAINT DF_assign_current DEFAULT (1)
  );
  CREATE INDEX IX_assign_lead    ON dbo.lead_assignments(lead_id, assigned_at DESC);
  CREATE INDEX IX_assign_current ON dbo.lead_assignments(lead_id) WHERE is_current = 1;
  CREATE INDEX IX_assign_op      ON dbo.lead_assignments(sale_operator_id, is_current);
END;
GO
