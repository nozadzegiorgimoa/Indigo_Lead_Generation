-- sync_lead_history v2 (runs every 3 min via SQL Agent job "sync lead history"):
-- (0) NEW: pool leads (AID=1574) whose client already has a keeper — a sales
--     operator who owns or worked their Stage-6/7 leads — are assigned to that
--     keeper BEFORE the Delta distribute job can hand them to someone else
--     (principle: one client is never processed by two different operators).
-- (1) as before: poll-log owner changes of portal leads into the local history.
CREATE OR ALTER PROCEDURE dbo.sync_lead_history AS
BEGIN
  SET NOCOUNT ON;

  ------------------------------------------------------------------
  -- (0) keeper pre-assignment for pool leads.
  ------------------------------------------------------------------
  DECLARE @w TABLE (lid numeric(18,0), cid numeric(18,0), keeper int, kname nvarchar(225), kgrp nvarchar(200));
  INSERT @w (lid, cid, keeper, kname, kgrp)
  SELECT l.ID, l.CID, k.uid, u.Name, g.Caption
  FROM crm.dbo.loans l
  CROSS APPLY (
      SELECT TOP 1 c.uid FROM (
        SELECT x.uid, MAX(x.act) AS last_act, MAX(x.own) AS is_owner, MAX(x.crt) AS newest_lead
        FROM (
          SELECT l2.AID AS uid, CAST(NULL AS int) AS act, 1 AS own, l2.Created AS crt
          FROM crm.dbo.loans l2 WHERE l2.CID = l.CID AND l2.Stage IN (6,7) AND ISNULL(l2.Archived,0)=0
          UNION ALL
          SELECT h.AID, h.ID, 0, NULL
          FROM crm.dbo.history h JOIN crm.dbo.loans hl ON hl.ID = h.LID
          WHERE hl.CID = l.CID AND hl.Stage IN (6,7)
        ) x GROUP BY x.uid
      ) c
      JOIN crm.dbo.users cu ON cu.ID = c.uid AND cu.Deleted IS NULL AND cu.IsBlocked = 0 AND cu.IsDenyAccess = 0
                           AND cu.Name NOT LIKE 'System%' AND cu.[Login] <> cu.Name
      JOIN crm.dbo.usersgroups cg ON cg.ID = cu.GroupID AND cg.Add3 = 1
      WHERE c.uid NOT IN (1, 986, 1574)
      ORDER BY CASE WHEN c.last_act IS NULL THEN 1 ELSE 0 END, c.last_act DESC,
               c.is_owner DESC, c.newest_lead DESC
  ) k(uid)
  JOIN crm.dbo.users u ON u.ID = k.uid
  JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID
  WHERE l.Stage = 7 AND ISNULL(l.Archived,0) = 0 AND l.AID = 1574;

  IF EXISTS (SELECT 1 FROM @w)
  BEGIN
      UPDATE l SET AID = w.keeper, Updated = SYSUTCDATETIME()
      FROM crm.dbo.loans l JOIN @w w ON w.lid = l.ID
      WHERE l.AID = 1574;

      UPDATE c SET AID = w.keeper
      FROM crm.dbo.clients c JOIN @w w ON w.cid = c.ID
      WHERE c.AID <> w.keeper;

      -- report 297 + rotation window see it as an assignment
      INSERT CRM_Helper.dbo.lead_to_distiribute (leadID, CID, clienttype, [language], region, Newuserid, insertdate)
      SELECT w.lid, w.cid,
             CASE WHEN cl.F525 = 'Retail' THEN 'Retail' ELSE 'Dealer' END,
             CASE WHEN ISNULL(cl.F14,N'') = N'' THEN N'ქართული' ELSE cl.F14 END,
             CASE WHEN ISNULL(cl.F15,N'') = N'' THEN N'თბილისი' ELSE cl.F15 END,
             w.keeper, GETDATE()
      FROM @w w JOIN crm.dbo.clients cl ON cl.ID = w.cid;

      INSERT dbo.lead_distribution_history
        (crm_lid, crm_cid, from_operator_id, to_operator_id, to_operator_name, to_group_name, method)
      SELECT w.lid, w.cid, 1574, w.keeper, w.kname, w.kgrp, N'keeper-preassign'
      FROM @w w;
  END

  ------------------------------------------------------------------
  -- (1) poll-log owner changes for portal leads (unchanged).
  ------------------------------------------------------------------
  INSERT INTO dbo.lead_distribution_history
    (crm_lid, crm_cid, from_operator_id, to_operator_id, to_operator_name, to_group_name, method)
  SELECT l.crm_lid, cl.CID, h.last_to, cl.AID,
         CASE WHEN cl.AID = 1574 THEN N'გასანაწილებელი ლიდები (pool)' ELSE so.name END,
         CASE WHEN cl.AID = 1574 THEN N'—' ELSE so.group_name END,
         CASE WHEN h.last_to IS NULL THEN N'backfill' WHEN h.last_to = 1574 THEN N'distribute' ELSE N'reassigned' END
  FROM dbo.leads l
  JOIN crm.dbo.loans cl ON cl.ID = l.crm_lid
  OUTER APPLY (SELECT TOP 1 to_operator_id AS last_to FROM dbo.lead_distribution_history h2 WHERE h2.crm_lid = l.crm_lid ORDER BY h2.id DESC) h
  LEFT JOIN dbo.sale_operators so ON so.crm_user_id = cl.AID
  WHERE l.crm_lid IS NOT NULL AND cl.AID IS NOT NULL AND (h.last_to IS NULL OR h.last_to <> cl.AID);
END;
