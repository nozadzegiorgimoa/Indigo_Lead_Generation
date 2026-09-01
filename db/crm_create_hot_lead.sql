-- crm.dbo.create_hot_lead — portal entry point for web leads.
-- Creates a CRM hot lead (Stage=7, State=174) and picks the owner in priority order:
--   1) @force_operator_id (manual pick on the portal) — always wins.
--   2) Web routing rules (user's Stage-2 rules, WEB LEADS ONLY):
--        Ukrainian/Ukraine          -> Markov's group (56), least-loaded Russian op
--        Russian + Dealer           -> Markov's group (56), least-loaded Russian op
--        Russian + Retail           -> Boris Jalalyan (1693)
--   3) Otherwise -> AID=1574 pool; CRM_Helper.dbo.distribute_hot_leads assigns by min-count.
-- Delta-native leads are unaffected (they never call this proc).
CREATE OR ALTER PROCEDURE dbo.create_hot_lead
  @phone             nvarchar(40),
  @name              nvarchar(200),
  @language          nvarchar(20)  = 'georgian',
  @region            nvarchar(120) = NULL,
  @clienttype        nvarchar(20)  = 'Retail',
  @source            nvarchar(60)  = NULL,
  @comment           nvarchar(max) = NULL,
  @force_operator_id int           = NULL,
  @out_cid           numeric(18,0) = NULL OUTPUT,
  @out_lid           numeric(18,0) = NULL OUTPUT,
  @out_action        nvarchar(40)  = NULL OUTPUT
AS
BEGIN
  SET NOCOUNT ON;

  DECLARE @lang nvarchar(20) = LOWER(@language);
  DECLARE @f14 nvarchar(60) = CASE @lang
      WHEN 'georgian'  THEN N'ქართული'
      WHEN 'russian'   THEN N'რუსული'
      WHEN 'ukrainian' THEN N'რუსული'
      WHEN 'english'   THEN N'ინგლისური'
      ELSE N'ქართული' END;
  DECLARE @reg nvarchar(120) = ISNULL(NULLIF(LTRIM(RTRIM(@region)),''), N'თბილისი');
  SET @reg = CASE LOWER(@reg)
      WHEN 'tbilisi'  THEN N'თბილისი'  WHEN 'kutaisi'  THEN N'ქუთაისი'
      WHEN 'batumi'   THEN N'ბათუმი'   WHEN 'gori'     THEN N'გორი'
      WHEN 'rustavi'  THEN N'რუსთავი'  WHEN 'marneuli' THEN N'მარნეული'
      WHEN 'zugdidi'  THEN N'ზუგდიდი'  ELSE @reg END;
  DECLARE @ct  nvarchar(20)  = CASE WHEN @clienttype = 'Dealer' THEN 'Dealer' ELSE 'Retail' END;
  DECLARE @digits nvarchar(40) =
      REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(@phone,''),' ',''),'+',''),'-',''),'(','');

  ---------------------------------------------------------------------------
  -- Owner resolution: manual pick -> web routing rules -> pool.
  ---------------------------------------------------------------------------
  DECLARE @final_aid int = 1574, @rule nvarchar(60) = NULL;

  IF @force_operator_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID
                  WHERE u.ID = @force_operator_id AND g.Add3 = 1 AND u.Deleted IS NULL
                    AND u.IsBlocked = 0 AND u.IsDenyAccess = 0)
  BEGIN
    SET @final_aid = @force_operator_id; SET @rule = 'manual';
  END

  IF @final_aid = 1574
  BEGIN
    DECLARE @isUkraine bit = CASE WHEN @lang = 'ukrainian' OR @reg = N'უკრაინა'
                                       OR LOWER(@reg) LIKE '%ukrain%' THEN 1 ELSE 0 END;
    IF @isUkraine = 1 OR (@lang = 'russian' AND @ct = 'Dealer')
    BEGIN
      -- least-loaded Russian operator in Markov's group (56)
      SELECT TOP 1 @final_aid = a.UserID
        FROM CRM_Helper.dbo.Users_for_leaddistribute a
        JOIN crm.dbo.users u ON u.ID = a.UserID
       WHERE u.GroupID = 56 AND a.Russian = 1 AND a.StatusID = 1
       ORDER BY a.CountRussian ASC, NEWID();
      IF @final_aid <> 1574 SET @rule = CASE WHEN @isUkraine = 1 THEN 'ukraine->markov' ELSE 'ru+dealer->markov' END;
    END
    ELSE IF @lang = 'russian' AND @ct = 'Retail'
    BEGIN
      IF EXISTS (SELECT 1 FROM crm.dbo.users WHERE ID = 1693 AND Deleted IS NULL AND IsBlocked = 0 AND IsDenyAccess = 0)
      BEGIN SET @final_aid = 1693; SET @rule = 'ru+retail->boris'; END
    END
  END

  ---------------------------------------------------------------------------
  DECLARE @cid numeric(18,0) = (
      SELECT TOP 1 CID FROM crm.dbo.phones
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(PhoneNumber,' ',''),'+',''),'-',''),'(','') = @digits
      ORDER BY ID DESC);
  DECLARE @lid numeric(18,0) = NULL;

  IF @cid IS NULL
  BEGIN
      INSERT crm.dbo.clients (Created, Updated, T, FIO, FIOen, F14, F15, F524, F525, F609)
      VALUES (SYSUTCDATETIME(), SYSUTCDATETIME(), 10, @name, N'', @f14, @reg, @source, @ct, @ct);
      SET @cid = SCOPE_IDENTITY();
      INSERT crm.dbo.phones (CID, PhoneNumber, FT, State, Owner, IsImport, IsValid, ChAID, Created)
      VALUES (@cid, @digits, 13, 0, 0, 0, 1, 1, SYSUTCDATETIME());
      SET @out_action = 'new_client';
  END
  ELSE
  BEGIN
      SET @lid = (SELECT TOP 1 ID FROM crm.dbo.loans WHERE CID = @cid AND Stage = 7 ORDER BY Created DESC);
      IF @lid IS NOT NULL
      BEGIN
          UPDATE crm.dbo.loans SET State = 174, AID = @final_aid, Updated = SYSUTCDATETIME() WHERE ID = @lid;
          SET @out_action = 'reheated';
      END
      ELSE SET @out_action = 'new_lead_existing_client';
  END

  IF @lid IS NULL
  BEGIN
      INSERT crm.dbo.loans
        (Created, Updated, CID, PID, GID, EID, Currency, CurrencyPen, Region, Unit,
         Stage, State, LoanType, LoanSubType, ENumber, GNumber, Account, AID)
      VALUES
        (SYSUTCDATETIME(), SYSUTCDATETIME(), @cid, 2, 0, 0, 2, 2, 3, N'',
         7, 174, N'', N'', N'', N'', N'', @final_aid);
      SET @lid = SCOPE_IDENTITY();
  END

  -- Keep min-count fair for any direct assignment (manual or rule).
  IF @final_aid <> 1574
    UPDATE CRM_Helper.dbo.Users_for_leaddistribute
       SET CountGeorgian = CountGeorgian + CASE WHEN @f14 = N'ქართული'   THEN 1 ELSE 0 END,
           CountRussian  = CountRussian  + CASE WHEN @f14 = N'რუსული'    THEN 1 ELSE 0 END,
           CountEnglish  = CountEnglish  + CASE WHEN @f14 = N'ინგლისური' THEN 1 ELSE 0 END
     WHERE UserID = @final_aid;

  IF @out_action IS NOT NULL AND @rule IS NOT NULL SET @out_action = @out_action + ' · ' + @rule;
  SET @out_cid = @cid;
  SET @out_lid = @lid;
END
