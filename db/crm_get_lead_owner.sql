-- crm.dbo.get_lead_owner — who currently "owns" the person behind a phone number
-- (same keeper logic as create_hot_lead, across ALL client cards sharing the
-- number's last 9 digits). Used by the portal to warn on manual-pick conflicts.
CREATE OR ALTER PROCEDURE dbo.get_lead_owner
  @phone     nvarchar(40),
  @out_cid   numeric(18,0) = NULL OUTPUT,
  @out_aid   int           = NULL OUTPUT,
  @out_name  nvarchar(225) = NULL OUTPUT,
  @out_group nvarchar(200) = NULL OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  SET @out_cid = NULL; SET @out_aid = NULL; SET @out_name = NULL; SET @out_group = NULL;

  DECLARE @digits nvarchar(40) =
      REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(@phone,''),' ',''),'+',''),'-',''),'(','');
  DECLARE @suffix nvarchar(20) = CASE WHEN LEN(@digits) >= 9 THEN RIGHT(@digits, 9) ELSE @digits END;

  DECLARE @cids TABLE (cid numeric(18,0) PRIMARY KEY);
  INSERT @cids (cid)
  SELECT DISTINCT CID FROM crm.dbo.phones
  WHERE RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(PhoneNumber,' ',''),'+',''),'-',''),'(',''),
              CASE WHEN LEN(@digits) >= 9 THEN 9 ELSE LEN(@digits) END) = @suffix;
  IF NOT EXISTS (SELECT 1 FROM @cids) RETURN;

  SET @out_cid = (
      SELECT TOP 1 c.cid FROM @cids c
      ORDER BY CASE WHEN EXISTS (SELECT 1 FROM crm.dbo.loans l
                                 WHERE l.CID = c.cid AND l.Stage IN (6,7) AND ISNULL(l.Archived,0)=0)
                    THEN 0 ELSE 1 END,
               c.cid DESC);

  SELECT TOP 1 @out_aid = c.uid
  FROM (
      SELECT x.uid, MAX(x.act) AS last_act, MAX(x.own) AS is_owner, MAX(x.crt) AS newest_lead
      FROM (
          SELECT l.AID AS uid, CAST(NULL AS int) AS act, 1 AS own, l.Created AS crt
          FROM crm.dbo.loans l
          WHERE l.CID IN (SELECT cid FROM @cids) AND l.Stage IN (6,7) AND ISNULL(l.Archived,0)=0
          UNION ALL
          SELECT h.AID, h.ID, 0, NULL
          FROM crm.dbo.history h JOIN crm.dbo.loans hl ON hl.ID = h.LID
          WHERE hl.CID IN (SELECT cid FROM @cids) AND hl.Stage IN (6,7)
      ) x GROUP BY x.uid
  ) c
  JOIN crm.dbo.users u ON u.ID = c.uid AND u.Deleted IS NULL AND u.IsBlocked = 0 AND u.IsDenyAccess = 0
  JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID AND g.Add3 = 1
  WHERE c.uid NOT IN (1, 986, 1574)
  ORDER BY CASE WHEN c.last_act IS NULL THEN 1 ELSE 0 END, c.last_act DESC,
           c.is_owner DESC, c.newest_lead DESC;

  IF @out_aid IS NOT NULL
      SELECT @out_name = u.Name, @out_group = g.Caption
      FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID
      WHERE u.ID = @out_aid;
END
