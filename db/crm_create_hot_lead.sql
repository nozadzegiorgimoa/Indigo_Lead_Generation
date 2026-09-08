-- crm.dbo.create_hot_lead — portal entry point for web leads.
-- Owner priority: manual @force_operator_id > (existing hot lead: keep its active
-- owner) > web rules > fair last-N rotation > pool.
-- Existing-lead flow (user spec 2026-09-04):
--  * Client FIO is NEVER changed; a differing web name goes to the FRONT of the
--    new lead's F145 (კომენტარი).
--  * If a Stage-7 lead exists and its owner is an ACTIVE in-rotation operator,
--    the owner is kept ('reheat-kept'); a manual pick still overrides.
--  * Reheat = UPDATE IN PLACE (user decision 2026-09-08, replacing the earlier
--    new-lead+archive scheme whose archived rows looked like duplicates on the
--    Delta client card): the existing newest open Stage-7 lead is re-hotted and
--    reassigned; its previous F145 is preserved as a TypeID=638 history comment;
--    F145 gets the new web text. History stays attached naturally. A NEW lead is
--    created only when no open Stage-7 exists. Extra open Stage-7 duplicates on
--    the person's other cards are still archived (one open hot lead per person).
--  * Keep-owner check spans ALL of the client's Stage-6/7 leads: open-lead
--    owners AND whoever actually worked them (history authors — called or
--    commented, archived duplicates included), sales groups only (Add3=1);
--    most recent activity wins. Stage 6 in work => that operator also keeps
--    new submissions. Every open Stage-7 duplicate is archived so exactly one
--    hot lead remains (open Stage-6 work items are left untouched).
--  * Ex-employee/System/pool owners (2026-09-07): the lead goes STRAIGHT to
--    normal distribution (rules + rotation) — the former 'blocked' hold is gone.
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
  -- ALL client cards carrying this number (the same person is sometimes
  -- duplicated across cards; matching only the newest card left the other
  -- card's lead alive — the duplicate the operators kept seeing). GE numbers
  -- are matched by their last 9 digits so 995-prefixed and bare forms meet.
  DECLARE @suffix nvarchar(20) = CASE WHEN LEN(@digits) >= 9 THEN RIGHT(@digits, 9) ELSE @digits END;
  DECLARE @cids TABLE (cid numeric(18,0) PRIMARY KEY);
  INSERT @cids (cid)
  SELECT DISTINCT CID FROM crm.dbo.phones
  WHERE RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(PhoneNumber,' ',''),'+',''),'-',''),'(',''),
              CASE WHEN LEN(@digits) >= 9 THEN 9 ELSE LEN(@digits) END) = @suffix;

  -- Primary card: prefer one with open Stage-6/7 activity, else the newest.
  DECLARE @cid numeric(18,0) = (
      SELECT TOP 1 c.cid FROM @cids c
      ORDER BY CASE WHEN EXISTS (SELECT 1 FROM crm.dbo.loans l
                                 WHERE l.CID = c.cid AND l.Stage IN (6,7) AND ISNULL(l.Archived,0)=0)
                    THEN 0 ELSE 1 END,
               c.cid DESC);
  DECLARE @fio nvarchar(200) = NULL, @bought bit = 0, @name_diff bit = 0;
  IF @cid IS NOT NULL
  BEGIN
      SELECT @fio = LTRIM(RTRIM(ISNULL(FIO, N''))),
             @ct = CASE WHEN @ct = 'Retail' AND F525 = 'Dealer' THEN 'Dealer' ELSE @ct END
      FROM crm.dbo.clients WHERE ID = @cid;
      IF EXISTS (SELECT 1 FROM crm.dbo.loans WHERE CID IN (SELECT cid FROM @cids) AND Stage = 5) SET @bought = 1;
      IF @name <> N'' AND @fio <> @name SET @name_diff = 1;
  END

  -- Latest NON-ARCHIVED Stage-7 lead across ALL the person's cards (primary:
  -- supplies the carried history/comment; every open Stage-7 dupe is archived).
  DECLARE @old_lid numeric(18,0) = NULL, @old_aid int = NULL, @old_f145 nvarchar(max) = NULL;
  IF @cid IS NOT NULL
      SELECT TOP 1 @old_lid = ID, @old_aid = AID, @old_f145 = F145
      FROM crm.dbo.loans
      WHERE CID IN (SELECT cid FROM @cids) AND Stage = 7 AND ISNULL(Archived, 0) = 0
      ORDER BY Created DESC;

  -- Who should keep this client? Candidates (must be an active user in a SALES
  -- group, never System/pool):
  --   * owners of the client's OPEN Stage-6/7 leads (a System duplicate must not
  --     hide a real owner; Stage 6 = already in work — that owner keeps new
  --     submissions too), and
  --   * operators who actually WORKED any of the client's Stage-6/7 leads
  --     (called / commented — history authors, archived duplicates included).
  -- Priority: most recent history activity first ("who worked it"), then open-
  -- lead owners, then in-rotation, then newest lead.
  DECLARE @keep_aid int = NULL;
  IF @cid IS NOT NULL
      SELECT TOP 1 @keep_aid = c.uid
      FROM (
          SELECT x.uid, MAX(x.act) AS last_act, MAX(x.own) AS is_owner, MAX(x.crt) AS newest_lead
          FROM (
              SELECT l.AID AS uid, CAST(NULL AS int) AS act, 1 AS own, l.Created AS crt
              FROM crm.dbo.loans l
              WHERE l.CID IN (SELECT cid FROM @cids) AND l.Stage IN (6, 7) AND ISNULL(l.Archived, 0) = 0
              UNION ALL
              SELECT h.AID, h.ID, 0, NULL
              FROM crm.dbo.history h
              JOIN crm.dbo.loans hl ON hl.ID = h.LID
              WHERE hl.CID IN (SELECT cid FROM @cids) AND hl.Stage IN (6, 7)
          ) x
          GROUP BY x.uid
      ) c
      JOIN crm.dbo.users u ON u.ID = c.uid AND u.Deleted IS NULL AND u.IsBlocked = 0 AND u.IsDenyAccess = 0
      JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID AND g.Add3 = 1
      LEFT JOIN CRM_Helper.dbo.Users_for_leaddistribute r ON r.UserID = c.uid
      WHERE c.uid NOT IN (1, 986, 1574)
      ORDER BY CASE WHEN c.last_act IS NULL THEN 1 ELSE 0 END,
               c.last_act DESC,
               c.is_owner DESC,
               CASE WHEN r.StatusID = 1 THEN 0 ELSE 1 END,
               c.newest_lead DESC;

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

  -- Existing hot lead owned by a still-employed operator (on any of the client's
  -- open Stage-7 leads): keep them. Ex-employee/System/pool owners fall through
  -- to normal distribution (user rule 2026-09-07: such leads go straight to
  -- distribution — no 'blocked' hold any more).
  IF @rule IS NULL AND @keep_aid IS NOT NULL
  BEGIN SET @final_aid = @keep_aid; SET @rule = 'reheat-kept'; END

  IF @rule IS NULL   -- no keepable owner: web rules, then fair rotation.
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
  BEGIN
      -- Update in place: same lead object, no duplicates on the client card.
      -- Preserve the previous comment as a TypeID=638 history note, then re-hot,
      -- reassign, and write the fresh web text into F145. If the new submission
      -- carried no text at all, the old F145 simply stays.
      IF ISNULL(@f145, N'') <> N'' AND ISNULL(@old_f145, N'') <> N''
          INSERT crm.dbo.history
            (LID, CID, AID, TypeID, Text, Created,
             isPayment, isNotify, isViewved, isDeclared, isSkipTracing, DeclaredValue,
             HasFields, HasEvents)
          VALUES
            (@old_lid, @cid, 986, 638, @old_f145, GETDATE(), 0, 0, 1, 0, 0, 0, 0, 0);

      UPDATE crm.dbo.loans
         SET State = 174, AID = @final_aid, Updated = SYSUTCDATETIME(),
             F145 = CASE WHEN ISNULL(@f145, N'') <> N'' THEN @f145 ELSE F145 END
       WHERE ID = @old_lid;
      SET @lid = @old_lid;

      -- Extra open Stage-7 duplicates on the person's OTHER cards: archive, so
      -- exactly one open hot lead remains per person.
      UPDATE crm.dbo.loans
         SET Archived = 1, AID = 986, Updated = SYSUTCDATETIME()
       WHERE CID IN (SELECT cid FROM @cids) AND Stage = 7
         AND ISNULL(Archived, 0) = 0 AND ID <> @old_lid;
  END
  ELSE
  BEGIN
      INSERT crm.dbo.loans
        (Created, Updated, CID, PID, GID, EID, Currency, CurrencyPen, Region, Unit,
         Stage, State, LoanType, LoanSubType, ENumber, GNumber, Account, AID, F145)
      VALUES
        (SYSUTCDATETIME(), SYSUTCDATETIME(), @cid, 2, 0, 0, 2, 2, 3, N'',
         7, 174, N'', N'', N'', N'', N'', @final_aid, NULLIF(@f145, N''));
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
