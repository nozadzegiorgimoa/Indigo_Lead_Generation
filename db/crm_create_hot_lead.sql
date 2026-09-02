-- crm.dbo.create_hot_lead — portal entry point for web leads.
-- Owner priority: manual @force_operator_id > web rules > DIRECT min-count pick
-- (same eligibility as distribute_hot_leads) > pool (only if nobody matched).
-- Web rules: Ukrainian/Ukraine & Russian+Dealer -> least-loaded Russian op in
-- Markov's group (56); Russian+Retail -> Boris (1693). Counts bumped on every
-- direct assignment, so min-count fairness holds. Logs each assignment into
-- Indigo_Lead_Generation.dbo.lead_distribution_history.
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
      WHEN 'georgian'  THEN N'ქართული'  WHEN 'russian'   THEN N'რუსული'
      WHEN 'ukrainian' THEN N'რუსული'    WHEN 'english'   THEN N'ინგლისური'
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

  -- Matching region for distribution (mirrors distribute_hot_leads normalisation):
  -- Marneuli -> Gori; unknown/unconfigured region -> Tbilisi.
  DECLARE @dreg nvarchar(120) = CASE WHEN @reg = N'მარნეული' THEN N'გორი' ELSE @reg END;
  IF NOT EXISTS (SELECT 1 FROM CRM_Helper.dbo.Users_for_leaddistribute
                 WHERE StatusID = 1 AND Region = @dreg COLLATE SQL_Latin1_General_CP1_CI_AS)
    SET @dreg = N'თბილისი';

  ---------------------------------------------------------------------------
  -- Owner: manual pick -> web rules -> direct min-count -> pool.
  ---------------------------------------------------------------------------
  DECLARE @final_aid int = 1574, @rule nvarchar(60) = NULL;

  IF @force_operator_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID
                  WHERE u.ID = @force_operator_id AND g.Add3 = 1 AND u.Deleted IS NULL
                    AND u.IsBlocked = 0 AND u.IsDenyAccess = 0)
  BEGIN SET @final_aid = @force_operator_id; SET @rule = 'manual'; END

  IF @final_aid = 1574
  BEGIN
    DECLARE @isUkraine bit = CASE WHEN @lang = 'ukrainian' OR @reg = N'უკრაინა'
                                       OR LOWER(@reg) LIKE '%ukrain%' THEN 1 ELSE 0 END;
    IF @isUkraine = 1 OR (@lang = 'russian' AND @ct = 'Dealer')
    BEGIN
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

  -- Direct min-count pick (same eligibility as distribute_hot_leads).
  IF @final_aid = 1574
  BEGIN
    SELECT TOP 1 @final_aid = a.UserID
      FROM CRM_Helper.dbo.Users_for_leaddistribute a
     WHERE a.Region = @dreg COLLATE SQL_Latin1_General_CP1_CI_AS
       AND a.StatusID = 1
       AND a.allowedretail = CASE WHEN @ct='Retail' THEN 1 ELSE CASE WHEN @dreg=N'თბილისი' THEN 0 ELSE 1 END END
       AND a.alloweddealer = CASE WHEN @ct='Dealer' THEN 1 ELSE CASE WHEN @dreg=N'თბილისი' THEN 0 ELSE 1 END END
       AND ( (@f14 = N'ქართული'   AND a.Georgian = 1)
          OR (@f14 = N'რუსული'    AND a.Russian  = 1)
          OR (@f14 = N'ინგლისური' AND a.English  = 1) )
     ORDER BY CASE @f14 WHEN N'ქართული' THEN a.CountGeorgian
                        WHEN N'რუსული'  THEN a.CountRussian
                        ELSE a.CountEnglish END ASC, NEWID();
    IF @final_aid <> 1574 SET @rule = 'mincount';
  END

  ---------------------------------------------------------------------------
  DECLARE @cid numeric(18,0) = (
      SELECT TOP 1 CID FROM crm.dbo.phones
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(PhoneNumber,' ',''),'+',''),'-',''),'(','') = @digits
      ORDER BY ID DESC);
  DECLARE @lid numeric(18,0) = NULL, @old_aid int = NULL;

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
          SET @old_aid = (SELECT AID FROM crm.dbo.loans WHERE ID = @lid);
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

  -- Keep min-count fair for any direct assignment.
  IF @final_aid <> 1574
    UPDATE CRM_Helper.dbo.Users_for_leaddistribute
       SET CountGeorgian = CountGeorgian + CASE WHEN @f14 = N'ქართული'   THEN 1 ELSE 0 END,
           CountRussian  = CountRussian  + CASE WHEN @f14 = N'რუსული'    THEN 1 ELSE 0 END,
           CountEnglish  = CountEnglish  + CASE WHEN @f14 = N'ინგლისური' THEN 1 ELSE 0 END
     WHERE UserID = @final_aid;

  -- Log the assignment into the portal's local history.
  DECLARE @toName nvarchar(225) = CASE WHEN @final_aid = 1574 THEN N'გასანაწილებელი ლიდები (pool)'
                                       ELSE (SELECT Name FROM crm.dbo.users WHERE ID = @final_aid) END;
  DECLARE @toGrp  nvarchar(200) = CASE WHEN @final_aid = 1574 THEN N'—'
       ELSE (SELECT g.Caption FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID WHERE u.ID = @final_aid) END;
  INSERT Indigo_Lead_Generation.dbo.lead_distribution_history
    (crm_lid, crm_cid, from_operator_id, to_operator_id, to_operator_name, to_group_name, method)
  VALUES (@lid, @cid, @old_aid, @final_aid, @toName, @toGrp,
          N'portal:' + ISNULL(@rule, 'pool'));

  SET @out_cid = @cid;
  SET @out_lid = @lid;
  IF @out_action IS NOT NULL AND @rule IS NOT NULL SET @out_action = @out_action + ' · ' + @rule;
END
