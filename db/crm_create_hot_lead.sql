-- crm.dbo.create_hot_lead — portal entry point for web leads.
-- Owner priority: manual @force_operator_id > (existing hot lead: keep its active
-- owner) > web rules > fair last-N rotation > pool.
-- Existing-lead flow (user spec 2026-09-04):
--  * Client FIO is NEVER changed; a differing web name goes to the FRONT of the
--    new lead's F145 (კომენტარი).
--  * If a Stage-7 lead exists and its owner is an ACTIVE in-rotation operator,
--    the owner is kept ('reheat-kept'); a manual pick still overrides.
--  * The old lead is REPLACED, not updated: a NEW hot lead is created, all of the
--    old lead's history rows are copied to it (TypeID 630 doc-merge rows excluded
--    — the gaertianeba trigger/doc logic must not double them), the old F145 is
--    added as a TypeID=638 comment dated MAX(old history Created)+1s, and the old
--    lead is archived (Archived=1) and parked on System2 (986).
--  * If the old owner is invalid (ex-employee/blocked/out of rotation/System/pool)
--    and there is no manual pick: NOTHING is changed; the proc returns
--    out_action='blocked' + out_note so the portal can flag the lead for a human.
--  * If the client has a Stage-5 loan (bought a car), F145 gets
--    'ჩვენთან ნაყიდი ყავს ავტომობილი, გადაამოწმეთ' after the name part.
-- Fair rotation: within the eligible pool of N active operators, operators missing
-- from the last N assignments (CRM_Helper.dbo.lead_to_distiribute) are picked first
-- (randomly among them); otherwise the one whose assignment is oldest.
-- Also fills empty client fields, sets client AID, feeds lead_to_distiribute,
-- and logs to the portal's lead_distribution_history.
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
  @out_action        nvarchar(40)  = NULL OUTPUT,
  @out_note          nvarchar(300) = NULL OUTPUT
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
  SET @name = LTRIM(RTRIM(ISNULL(@name, N'')));
  DECLARE @digits nvarchar(40) =
      REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(@phone,''),' ',''),'+',''),'-',''),'(','');

  DECLARE @dreg nvarchar(120) = CASE WHEN @reg = N'მარნეული' THEN N'გორი' ELSE @reg END;
  IF NOT EXISTS (SELECT 1 FROM CRM_Helper.dbo.Users_for_leaddistribute
                 WHERE StatusID = 1 AND Region = @dreg COLLATE SQL_Latin1_General_CP1_CI_AS)
    SET @dreg = N'თბილისი';

  ---------------------------------------------------------------------------
  -- Known client? Load FIO / type / bought-flag; the stored type wins over a
  -- defaulted 'Retail'.
  ---------------------------------------------------------------------------
  DECLARE @cid numeric(18,0) = (
      SELECT TOP 1 CID FROM crm.dbo.phones
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(PhoneNumber,' ',''),'+',''),'-',''),'(','') = @digits
      ORDER BY ID DESC);
  DECLARE @fio nvarchar(200) = NULL, @bought bit = 0, @name_diff bit = 0;
  IF @cid IS NOT NULL
  BEGIN
      SELECT @fio = LTRIM(RTRIM(ISNULL(FIO, N''))),
             @ct = CASE WHEN @ct = 'Retail' AND F525 = 'Dealer' THEN 'Dealer' ELSE @ct END
      FROM crm.dbo.clients WHERE ID = @cid;
      IF EXISTS (SELECT 1 FROM crm.dbo.loans WHERE CID = @cid AND Stage = 5) SET @bought = 1;
      IF @name <> N'' AND @fio <> @name SET @name_diff = 1;
  END

  -- Latest NON-ARCHIVED Stage-7 lead of this client.
  DECLARE @old_lid numeric(18,0) = NULL, @old_aid int = NULL, @old_f145 nvarchar(max) = NULL;
  IF @cid IS NOT NULL
      SELECT TOP 1 @old_lid = ID, @old_aid = AID, @old_f145 = F145
      FROM crm.dbo.loans
      WHERE CID = @cid AND Stage = 7 AND ISNULL(Archived, 0) = 0
      ORDER BY Created DESC;

  ---------------------------------------------------------------------------
  -- Owner resolution.
  ---------------------------------------------------------------------------
  DECLARE @final_aid int = 1574, @rule nvarchar(60) = NULL;
  DECLARE @elig TABLE (UserID int PRIMARY KEY);

  IF @force_operator_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID
                  WHERE u.ID = @force_operator_id AND g.Add3 = 1 AND u.Deleted IS NULL
                    AND u.IsBlocked = 0 AND u.IsDenyAccess = 0)
  BEGIN SET @final_aid = @force_operator_id; SET @rule = 'manual'; END

  IF @rule IS NULL AND @old_lid IS NOT NULL
  BEGIN
      -- Existing hot lead: keep an ACTIVE in-rotation owner; otherwise block for
      -- a human decision (no automatic rotation, not even off System).
      IF EXISTS (SELECT 1 FROM crm.dbo.users u
                  WHERE u.ID = @old_aid AND u.Deleted IS NULL AND u.IsBlocked = 0 AND u.IsDenyAccess = 0)
         AND EXISTS (SELECT 1 FROM CRM_Helper.dbo.Users_for_leaddistribute
                      WHERE UserID = @old_aid AND StatusID = 1)
      BEGIN SET @final_aid = @old_aid; SET @rule = 'reheat-kept'; END
      ELSE
      BEGIN
          SET @out_cid = @cid; SET @out_lid = NULL; SET @out_action = 'blocked';
          SET @out_note = N'previous owner: '
              + ISNULL((SELECT Name FROM crm.dbo.users WHERE ID = @old_aid), N'#' + CAST(ISNULL(@old_aid,0) AS nvarchar(12)))
              + N' (inactive/out of rotation) — assign manually';
          RETURN;
      END
  END

  IF @rule IS NULL   -- no existing hot lead: web rules, then fair rotation.
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
       ORDER BY CASE WHEN r.maxid IS NULL THEN 0 ELSE 1 END,
                r.maxid ASC,
                NEWID();
    END
  END

  ---------------------------------------------------------------------------
  -- New lead's F145: [differing name] ; [bought-a-car warning] ; [web comment]
  ---------------------------------------------------------------------------
  DECLARE @f145 nvarchar(max) = N'';
  IF @name_diff = 1 SET @f145 = @name;
  IF @bought = 1
    SET @f145 = @f145 + CASE WHEN @f145 <> N'' THEN N'; ' ELSE N'' END
              + N'ჩვენთან ნაყიდი ყავს ავტომობილი, გადაამოწმეთ';
  IF ISNULL(@comment, N'') <> N''
    SET @f145 = @f145 + CASE WHEN @f145 <> N'' THEN N'; ' ELSE N'' END + @comment;

  ---------------------------------------------------------------------------
  -- Client: create, or fill empty fields (FIO is never touched).
  ---------------------------------------------------------------------------
  DECLARE @lid numeric(18,0) = NULL;
  IF @cid IS NULL
  BEGIN
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
      UPDATE crm.dbo.clients
         SET F524 = CASE WHEN ISNULL(F524,N'') = N'' THEN @source ELSE F524 END,
             F14  = CASE WHEN ISNULL(F14, N'') = N'' THEN @f14    ELSE F14  END,
             F15  = CASE WHEN ISNULL(F15, N'') = N'' THEN @reg    ELSE F15  END,
             F525 = CASE WHEN ISNULL(F525,N'') = N'' THEN @ct     ELSE F525 END,
             F609 = CASE WHEN ISNULL(F609,N'') = N'' THEN @ct     ELSE F609 END,
             AID  = CASE WHEN @final_aid <> 1574 THEN @final_aid ELSE AID END
       WHERE ID = @cid;
      SET @out_action = CASE WHEN @old_lid IS NOT NULL THEN 'reheated' ELSE 'new_lead_existing_client' END;
  END

  ---------------------------------------------------------------------------
  -- Replace the old hot lead (archive + carry history), or just create one.
  ---------------------------------------------------------------------------
  IF @old_lid IS NOT NULL
      UPDATE crm.dbo.loans
         SET Archived = 1, AID = 986, Updated = SYSUTCDATETIME()
       WHERE ID = @old_lid;

  INSERT crm.dbo.loans
    (Created, Updated, CID, PID, GID, EID, Currency, CurrencyPen, Region, Unit,
     Stage, State, LoanType, LoanSubType, ENumber, GNumber, Account, AID, F145)
  VALUES
    (SYSUTCDATETIME(), SYSUTCDATETIME(), @cid, 2, 0, 0, 2, 2, 3, N'',
     7, 174, N'', N'', N'', N'', N'', @final_aid, NULLIF(@f145, N''));
  SET @lid = SCOPE_IDENTITY();

  IF @old_lid IS NOT NULL
  BEGIN
      -- Carry the old lead's history to the new one (multi-row single INSERT;
      -- TypeID 630 doc-merge rows excluded so document logic is not doubled).
      INSERT crm.dbo.history
        (LID, CID, AID, TypeID, Text, Created, Notification, PaymentDate, PaymentValue,
         isPayment, isNotify, isViewved, isDeclared, isSkipTracing, DeclaredDate, DeclaredValue,
         Scenario, DR, PhoneID, AddressID, DictID, HasFields, HasEvents, MoodIndicatorId,
         CollateralId, ActualizationId, HasActualization, EmailID, InsertedFromPab, PAbcommnetid,
         Creatorid, DOCID, UrlID, Latitude, Longitude, Accuracy, QueueId)
      SELECT @lid, CID, AID, TypeID, Text, Created, Notification, PaymentDate, PaymentValue,
             isPayment, isNotify, isViewved, isDeclared, isSkipTracing, DeclaredDate, DeclaredValue,
             Scenario, DR, PhoneID, AddressID, DictID, HasFields, HasEvents, MoodIndicatorId,
             CollateralId, ActualizationId, HasActualization, EmailID, InsertedFromPab, PAbcommnetid,
             Creatorid, DOCID, UrlID, Latitude, Longitude, Accuracy, QueueId
      FROM crm.dbo.history
      WHERE LID = @old_lid AND TypeID <> 630;

      -- Old lead's comment survives as a TypeID=638 note right after its history.
      IF ISNULL(@old_f145, N'') <> N''
          INSERT crm.dbo.history
            (LID, CID, AID, TypeID, Text, Created,
             isPayment, isNotify, isViewved, isDeclared, isSkipTracing, DeclaredValue,
             HasFields, HasEvents)
          VALUES
            (@lid, @cid, 986, 638, @old_f145,
             DATEADD(SECOND, 1, ISNULL((SELECT MAX(Created) FROM crm.dbo.history WHERE LID = @old_lid), GETDATE())),
             0, 0, 1, 0, 0, 0, 0, 0);
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
