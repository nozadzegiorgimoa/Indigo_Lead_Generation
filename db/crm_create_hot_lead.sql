-- crm.dbo.create_hot_lead — portal entry point for web leads.
-- Owner priority: manual @force_operator_id > web rules > FAIR ROTATION > pool.
-- Fair rotation (user spec 2026-09-03): within the eligible pool of N active
-- operators, look at the last N assignments (CRM_Helper.dbo.lead_to_distiribute);
-- operators MISSING from that window get picked first (randomly among them);
-- if all are present, pick the one whose assignment is OLDEST. This gives strict
-- one-by-one rotation — a newly added operator no longer swallows every lead.
-- Also: fills client fields, sets client AID, writes comment to loans.F145,
-- feeds lead_to_distiribute (reports), logs to portal history.
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
  SET @source = ISNULL(NULLIF(LTRIM(RTRIM(ISNULL(@source,N''))),N''), N'Website form');
  DECLARE @digits nvarchar(40) =
      REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(@phone,''),' ',''),'+',''),'-',''),'(','');

  DECLARE @dreg nvarchar(120) = CASE WHEN @reg = N'მარნეული' THEN N'გორი' ELSE @reg END;
  IF NOT EXISTS (SELECT 1 FROM CRM_Helper.dbo.Users_for_leaddistribute
                 WHERE StatusID = 1 AND Region = @dreg COLLATE SQL_Latin1_General_CP1_CI_AS)
    SET @dreg = N'თბილისი';

  ---------------------------------------------------------------------------
  -- Owner: manual pick -> web rules -> fair rotation -> pool.
  ---------------------------------------------------------------------------
  DECLARE @final_aid int = 1574, @rule nvarchar(60) = NULL;
  DECLARE @elig TABLE (UserID int PRIMARY KEY);

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
      INSERT @elig (UserID)
      SELECT a.UserID FROM CRM_Helper.dbo.Users_for_leaddistribute a
        JOIN crm.dbo.users u ON u.ID = a.UserID
       WHERE u.GroupID = 56 AND a.Russian = 1 AND a.StatusID = 1;
      IF EXISTS (SELECT 1 FROM @elig)
        SET @rule = CASE WHEN @isUkraine = 1 THEN 'ukraine->markov' ELSE 'ru+dealer->markov' END;
    END
    ELSE IF @lang = 'russian' AND @ct = 'Retail'
    BEGIN
      IF EXISTS (SELECT 1 FROM crm.dbo.users WHERE ID = 1693 AND Deleted IS NULL AND IsBlocked = 0 AND IsDenyAccess = 0)
      BEGIN SET @final_aid = 1693; SET @rule = 'ru+retail->boris'; END
    END

    -- General pool (no rule matched): region + type + language eligibility.
    IF @final_aid = 1574 AND NOT EXISTS (SELECT 1 FROM @elig)
    BEGIN
      INSERT @elig (UserID)
      SELECT a.UserID FROM CRM_Helper.dbo.Users_for_leaddistribute a
       WHERE a.Region COLLATE SQL_Latin1_General_CP1_CI_AS = @dreg COLLATE SQL_Latin1_General_CP1_CI_AS
         AND a.StatusID = 1
         AND a.allowedretail = CASE WHEN @ct='Retail' THEN 1 ELSE CASE WHEN @dreg=N'თბილისი' THEN 0 ELSE 1 END END
         AND a.alloweddealer = CASE WHEN @ct='Dealer' THEN 1 ELSE CASE WHEN @dreg=N'თბილისი' THEN 0 ELSE 1 END END
         AND ( (@f14 = N'ქართული'   AND a.Georgian = 1)
            OR (@f14 = N'რუსული'    AND a.Russian  = 1)
            OR (@f14 = N'ინგლისური' AND a.English  = 1) );
      IF EXISTS (SELECT 1 FROM @elig) SET @rule = 'rotation';
    END

    -- Fair rotation pick over @elig: last N assignments to this pool decide.
    IF @final_aid = 1574 AND EXISTS (SELECT 1 FROM @elig)
    BEGIN
      DECLARE @n int = (SELECT COUNT(*) FROM @elig);
      ;WITH recent AS (
         SELECT TOP (@n) d.Newuserid, d.ID
           FROM CRM_Helper.dbo.lead_to_distiribute d
           JOIN @elig e ON e.UserID = d.Newuserid
          ORDER BY d.ID DESC),
      lastseen AS (SELECT Newuserid, MAX(ID) AS maxid FROM recent GROUP BY Newuserid)
      SELECT TOP 1 @final_aid = e.UserID
        FROM @elig e
        LEFT JOIN lastseen r ON r.Newuserid = e.UserID
       ORDER BY CASE WHEN r.maxid IS NULL THEN 0 ELSE 1 END,  -- not in window -> first
                r.maxid ASC,                                   -- else oldest in window
                NEWID();                                       -- random among equals
    END
  END

  ---------------------------------------------------------------------------
  DECLARE @cid numeric(18,0) = (
      SELECT TOP 1 CID FROM crm.dbo.phones
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(PhoneNumber,' ',''),'+',''),'-',''),'(','') = @digits
      ORDER BY ID DESC);
  DECLARE @lid numeric(18,0) = NULL, @old_aid int = NULL;

  IF @cid IS NULL
  BEGIN
      -- AID set directly so the Delta client card shows the operator (the sync
      -- trigger only fires on loan UPDATEs, not our INSERT).
      INSERT crm.dbo.clients (Created, Updated, T, FIO, FIOen, F14, F15, F524, F525, F609, AID)
      VALUES (SYSUTCDATETIME(), SYSUTCDATETIME(), 10, @name, N'', @f14, @reg, @source, @ct, @ct,
              CASE WHEN @final_aid <> 1574 THEN @final_aid ELSE 1 END);
      SET @cid = SCOPE_IDENTITY();
      INSERT crm.dbo.phones (CID, PhoneNumber, FT, State, Owner, IsImport, IsValid, ChAID, Created)
      VALUES (@cid, @digits, 13, 0, 0, 0, 1, 1, SYSUTCDATETIME());
      SET @out_action = 'new_client';
  END
  ELSE
  BEGIN
      -- Existing client: fill EMPTY profile fields; set owner so the Delta client
      -- card shows the operator. Never overwrite non-empty business fields.
      UPDATE crm.dbo.clients
         SET F524 = CASE WHEN ISNULL(F524,N'') = N'' THEN @source ELSE F524 END,
             F14  = CASE WHEN ISNULL(F14, N'') = N'' THEN @f14    ELSE F14  END,
             F15  = CASE WHEN ISNULL(F15, N'') = N'' THEN @reg    ELSE F15  END,
             F525 = CASE WHEN ISNULL(F525,N'') = N'' THEN @ct     ELSE F525 END,
             F609 = CASE WHEN ISNULL(F609,N'') = N'' THEN @ct     ELSE F609 END,
             AID  = CASE WHEN @final_aid <> 1574 THEN @final_aid ELSE AID END
       WHERE ID = @cid;

      SET @lid = (SELECT TOP 1 ID FROM crm.dbo.loans WHERE CID = @cid AND Stage = 7 ORDER BY Created DESC);
      IF @lid IS NOT NULL
      BEGIN
          SET @old_aid = (SELECT AID FROM crm.dbo.loans WHERE ID = @lid);
          -- Reheat: keep any existing comment; append the new web comment (F145=კომენტარი).
          UPDATE crm.dbo.loans
             SET State = 174, AID = @final_aid, Updated = SYSUTCDATETIME(),
                 F145 = CASE WHEN ISNULL(@comment,N'') = N'' THEN F145
                             WHEN ISNULL(F145,N'') = N'' THEN @comment
                             WHEN CHARINDEX(@comment, F145) > 0 THEN F145
                             ELSE F145 + N' | ' + @comment END
           WHERE ID = @lid;
          SET @out_action = 'reheated';
      END
      ELSE SET @out_action = 'new_lead_existing_client';
  END

  IF @lid IS NULL
  BEGIN
      INSERT crm.dbo.loans
        (Created, Updated, CID, PID, GID, EID, Currency, CurrencyPen, Region, Unit,
         Stage, State, LoanType, LoanSubType, ENumber, GNumber, Account, AID, F145)
      VALUES
        (SYSUTCDATETIME(), SYSUTCDATETIME(), @cid, 2, 0, 0, 2, 2, 3, N'',
         7, 174, N'', N'', N'', N'', N'', @final_aid, NULLIF(@comment,N''));
      SET @lid = SCOPE_IDENTITY();
  END

  -- Counters kept for stats/compatibility (no longer drive selection).
  IF @final_aid <> 1574
    UPDATE CRM_Helper.dbo.Users_for_leaddistribute
       SET CountGeorgian = CountGeorgian + CASE WHEN @f14 = N'ქართული'   THEN 1 ELSE 0 END,
           CountRussian  = CountRussian  + CASE WHEN @f14 = N'რუსული'    THEN 1 ELSE 0 END,
           CountEnglish  = CountEnglish  + CASE WHEN @f14 = N'ინგლისური' THEN 1 ELSE 0 END
     WHERE UserID = @final_aid;

  -- Feed the CRM's distribution working table (reports + rotation window).
  IF @final_aid <> 1574
    INSERT CRM_Helper.dbo.lead_to_distiribute (leadID, CID, clienttype, [language], region, Newuserid, insertdate)
    VALUES (@lid, @cid, @ct, @f14, @reg, @final_aid, GETDATE());

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
