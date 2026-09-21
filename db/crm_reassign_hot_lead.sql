-- crm.dbo.reassign_hot_lead — reassign an EXISTING hot lead from the portal,
-- optionally redefining fields (type / language / region) just like a new lead.
-- Owner: @force_operator_id (a specific pick) else fair last-N rotation. When
-- @restrict_group_id is given (a group manager), BOTH the eligible pool and any
-- forced pick are confined to that sales group. Otherwise the rule-based pool is
-- used (ru+dealer/ukr -> Markov, ru+retail -> Boris, else region/type/lang), the
-- same as create_hot_lead. Field overrides are written to the client (FIO never
-- touched). Stage-6 in-work loans are left alone; only the Stage-7 lead moves.
CREATE OR ALTER PROCEDURE dbo.reassign_hot_lead
  @lid               numeric(18,0),
  @clienttype        nvarchar(20)  = NULL,   -- 'Retail'/'Dealer' override, else keep
  @language          nvarchar(20)  = NULL,   -- 'georgian'/'russian'/... override, else keep
  @region            nvarchar(120) = NULL,   -- region override, else keep
  @force_operator_id int           = NULL,   -- specific operator, else rotate
  @restrict_group_id int           = NULL,   -- group manager: confine to this group
  @actor             int           = NULL,
  @out_aid           int           = NULL OUTPUT,
  @out_name          nvarchar(225) = NULL OUTPUT,
  @out_group         nvarchar(200) = NULL OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  SET LOCK_TIMEOUT 8000;   -- fail fast on Delta's locks (no web 504 / hang)
  SET XACT_ABORT ON;       -- any error aborts + rolls back the apply transaction

  DECLARE @cid numeric(18,0), @old_aid int, @stage int;
  SELECT @cid = CID, @old_aid = AID, @stage = Stage
  FROM crm.dbo.loans WHERE ID = @lid AND ISNULL(Archived,0) = 0;
  IF @cid IS NULL BEGIN RAISERROR('Lead not found or archived.',16,1); RETURN; END

  -- Permission fence for group managers: the lead must currently belong to their
  -- group (owner in that group), else refuse.
  IF @restrict_group_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM crm.dbo.users u WHERE u.ID = @old_aid AND u.GroupID = @restrict_group_id)
  BEGIN RAISERROR('This lead is not in your group.',16,1); RETURN; END

  -- Apply field overrides to the client (never the FIO).
  DECLARE @f14 nvarchar(60) = CASE LOWER(@language)
      WHEN 'georgian' THEN N'ქართული' WHEN 'russian' THEN N'რუსული'
      WHEN 'ukrainian' THEN N'რუსული'  WHEN 'english' THEN N'ინგლისური' ELSE NULL END;
  DECLARE @ct nvarchar(20) = CASE WHEN @clienttype IN ('Retail','Dealer') THEN @clienttype ELSE NULL END;
  DECLARE @reg nvarchar(120) = NULLIF(LTRIM(RTRIM(@region)), N'');
  SET @reg = CASE LOWER(ISNULL(@reg,''))
      WHEN 'tbilisi' THEN N'თბილისი' WHEN 'kutaisi' THEN N'ქუთაისი' WHEN 'batumi' THEN N'ბათუმი'
      WHEN 'gori' THEN N'გორი' WHEN 'rustavi' THEN N'რუსთავი' WHEN 'marneuli' THEN N'მარნეული'
      WHEN 'zugdidi' THEN N'ზუგდიდი' ELSE @reg END;
  UPDATE crm.dbo.clients
     SET F14 = ISNULL(@f14, F14),
         F15 = ISNULL(@reg, F15),
         F525 = ISNULL(@ct, F525), F609 = ISNULL(@ct, F609)
   WHERE ID = @cid;

  -- Read the effective routing attributes back from the client.
  DECLARE @clang nvarchar(60), @creg nvarchar(120), @cct nvarchar(20);
  SELECT @clang = ISNULL(NULLIF(F14,N''), N'ქართული'),
         @creg  = ISNULL(NULLIF(F15,N''), N'თბილისი'),
         @cct   = CASE WHEN F525 = 'Dealer' THEN 'Dealer' ELSE 'Retail' END
  FROM crm.dbo.clients WHERE ID = @cid;
  DECLARE @langkey nvarchar(20) = CASE @clang WHEN N'რუსული' THEN 'russian' WHEN N'ინგლისური' THEN 'english' ELSE 'georgian' END;

  DECLARE @dreg nvarchar(120) = CASE WHEN @creg = N'მარნეული' THEN N'გორი' ELSE @creg END;
  IF NOT EXISTS (SELECT 1 FROM CRM_Helper.dbo.Users_for_leaddistribute
                 WHERE StatusID = 1 AND Region = @dreg COLLATE SQL_Latin1_General_CP1_CI_AS)
    SET @dreg = N'თბილისი';

  DECLARE @final_aid int = NULL;
  DECLARE @elig TABLE (UserID int PRIMARY KEY);

  ------------------------------------------------------------------
  -- Forced pick (validated).
  ------------------------------------------------------------------
  IF @force_operator_id IS NOT NULL
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID=u.GroupID
                   WHERE u.ID=@force_operator_id AND g.Add3=1 AND u.Deleted IS NULL
                     AND u.IsBlocked=0 AND u.IsDenyAccess=0
                     AND (@restrict_group_id IS NULL OR u.GroupID=@restrict_group_id))
    BEGIN RAISERROR('The chosen operator is not valid for this reassignment.',16,1); RETURN; END
    SET @final_aid = @force_operator_id;
  END

  ------------------------------------------------------------------
  -- Group-restricted rotation: fair last-N inside the manager's group.
  ------------------------------------------------------------------
  IF @final_aid IS NULL AND @restrict_group_id IS NOT NULL
  BEGIN
    INSERT @elig (UserID)
    SELECT a.UserID FROM CRM_Helper.dbo.Users_for_leaddistribute a
      JOIN crm.dbo.users u ON u.ID = a.UserID
     WHERE u.GroupID = @restrict_group_id AND a.StatusID = 1
       AND u.Deleted IS NULL AND u.IsBlocked = 0 AND u.IsDenyAccess = 0
       AND a.UserID <> @old_aid;
    IF NOT EXISTS (SELECT 1 FROM @elig)   -- lone member: allow keeping if in rotation
      INSERT @elig (UserID)
      SELECT a.UserID FROM CRM_Helper.dbo.Users_for_leaddistribute a
        JOIN crm.dbo.users u ON u.ID = a.UserID
       WHERE u.GroupID = @restrict_group_id AND a.StatusID = 1
         AND u.Deleted IS NULL AND u.IsBlocked = 0 AND u.IsDenyAccess = 0;
  END

  ------------------------------------------------------------------
  -- Rule-based rotation (full manager, no group restriction).
  ------------------------------------------------------------------
  IF @final_aid IS NULL AND @restrict_group_id IS NULL
  BEGIN
    DECLARE @isUkraine bit = CASE WHEN @langkey='ukrainian' OR @creg=N'უკრაინა' OR LOWER(@creg) LIKE '%ukrain%' THEN 1 ELSE 0 END;
    IF @isUkraine = 1 OR (@langkey='russian' AND @cct='Dealer')
      INSERT @elig (UserID)
      SELECT a.UserID FROM CRM_Helper.dbo.Users_for_leaddistribute a
        JOIN crm.dbo.users u ON u.ID=a.UserID
       WHERE u.GroupID=56 AND a.Russian=1 AND a.StatusID=1 AND a.UserID<>@old_aid;
    ELSE IF @langkey='russian' AND @cct='Retail'
    BEGIN
      -- Russian retail by region: Batumi->1269, Kutaisi->1112, else Boris 1693.
      DECLARE @ruop int = CASE WHEN @creg = N'ბათუმი' THEN 1269
                               WHEN @creg = N'ქუთაისი' THEN 1112 ELSE 1693 END;
      IF NOT EXISTS (SELECT 1 FROM crm.dbo.users WHERE ID=@ruop AND Deleted IS NULL AND IsBlocked=0 AND IsDenyAccess=0)
        SET @ruop = 1693;
      IF EXISTS (SELECT 1 FROM crm.dbo.users WHERE ID=@ruop AND Deleted IS NULL AND IsBlocked=0 AND IsDenyAccess=0 AND ID<>@old_aid)
        SET @final_aid = @ruop;
    END

    IF @final_aid IS NULL AND NOT EXISTS (SELECT 1 FROM @elig)
      INSERT @elig (UserID)
      SELECT a.UserID FROM CRM_Helper.dbo.Users_for_leaddistribute a
       WHERE a.Region COLLATE SQL_Latin1_General_CP1_CI_AS = @dreg COLLATE SQL_Latin1_General_CP1_CI_AS
         AND a.StatusID=1
         AND a.allowedretail = CASE WHEN @cct='Retail' THEN 1 ELSE CASE WHEN @dreg=N'თბილისი' THEN 0 ELSE 1 END END
         AND a.alloweddealer = CASE WHEN @cct='Dealer' THEN 1 ELSE CASE WHEN @dreg=N'თბილისი' THEN 0 ELSE 1 END END
         AND ((@clang=N'ქართული' AND a.Georgian=1) OR (@clang=N'რუსული' AND a.Russian=1) OR (@clang=N'ინგლისური' AND a.English=1))
         AND a.UserID <> @old_aid;
  END

  ------------------------------------------------------------------
  -- Fair last-N pick over the eligible pool.
  ------------------------------------------------------------------
  IF @final_aid IS NULL AND EXISTS (SELECT 1 FROM @elig)
  BEGIN
    DECLARE @n int = (SELECT COUNT(*) FROM @elig);
    ;WITH recent AS (
       SELECT TOP (@n) d.Newuserid, d.ID FROM CRM_Helper.dbo.lead_to_distiribute d
        JOIN @elig e ON e.UserID=d.Newuserid ORDER BY d.ID DESC),
    lastseen AS (SELECT Newuserid, MAX(ID) AS maxid FROM recent GROUP BY Newuserid)
    SELECT TOP 1 @final_aid = e.UserID FROM @elig e
      LEFT JOIN lastseen r ON r.Newuserid=e.UserID
     ORDER BY CASE WHEN r.maxid IS NULL THEN 0 ELSE 1 END, r.maxid ASC, NEWID();
  END

  IF @final_aid IS NULL BEGIN RAISERROR('No eligible operator found for this reassignment.',16,1); RETURN; END

  ------------------------------------------------------------------
  -- Apply: move the Stage-7 lead + client card, feed reports, log (atomically).
  ------------------------------------------------------------------
  BEGIN TRY
  BEGIN TRAN;
  UPDATE crm.dbo.loans SET AID = @final_aid, State = CASE WHEN Stage=7 THEN 174 ELSE State END,
         Updated = SYSUTCDATETIME() WHERE ID = @lid;
  UPDATE crm.dbo.clients SET AID = @final_aid WHERE ID = @cid;
  INSERT CRM_Helper.dbo.lead_to_distiribute (leadID, CID, clienttype, [language], region, Newuserid, insertdate)
  VALUES (@lid, @cid, @cct, @clang, @creg, @final_aid, GETDATE());
  INSERT Indigo_Lead_Generation.dbo.lead_distribution_history
    (crm_lid, crm_cid, from_operator_id, to_operator_id, to_operator_name, to_group_name, method)
  SELECT @lid, @cid, @old_aid, @final_aid, u.Name, g.Caption, N'portal:reassign'
  FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID=u.GroupID WHERE u.ID=@final_aid;
  COMMIT TRAN;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRAN;
    THROW;
  END CATCH

  SELECT @out_aid = u.ID, @out_name = u.Name, @out_group = g.Caption
  FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID=u.GroupID WHERE u.ID=@final_aid;
END
