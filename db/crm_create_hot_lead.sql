-- crm.dbo.create_hot_lead — portal entry point for web leads.
-- Creates a CRM hot lead (Stage=7, State=174). If @force_operator_id is a valid
-- active sale operator (manual pick on the portal), the lead is assigned directly
-- to them and their min-count is bumped; otherwise it lands in the AID=1574 pool
-- and CRM_Helper.dbo.distribute_hot_leads assigns it by min-count.
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

  DECLARE @f14 nvarchar(60) = CASE LOWER(@language)
      WHEN 'georgian'  THEN N'ქართული'
      WHEN 'russian'   THEN N'რუსული'
      WHEN 'ukrainian' THEN N'რუსული'
      WHEN 'english'   THEN N'ინგლისური'
      ELSE N'ქართული' END;
  DECLARE @reg nvarchar(120) = ISNULL(NULLIF(LTRIM(RTRIM(@region)),''), N'თბილისი');
  SET @reg = CASE LOWER(@reg)
      WHEN 'tbilisi'  THEN N'თბილისი'
      WHEN 'kutaisi'  THEN N'ქუთაისი'
      WHEN 'batumi'   THEN N'ბათუმი'
      WHEN 'gori'     THEN N'გორი'
      WHEN 'rustavi'  THEN N'რუსთავი'
      WHEN 'marneuli' THEN N'მარნეული'
      WHEN 'zugdidi'  THEN N'ზუგდიდი'
      ELSE @reg END;
  DECLARE @ct  nvarchar(20)  = CASE WHEN @clienttype = 'Dealer' THEN 'Dealer' ELSE 'Retail' END;
  DECLARE @digits nvarchar(40) =
      REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(@phone,''),' ',''),'+',''),'-',''),'(','');

  -- Manual pick: assign directly if it's a valid active sale operator; else pool.
  DECLARE @final_aid int = 1574;
  IF @force_operator_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID
                  WHERE u.ID = @force_operator_id AND g.Add3 = 1 AND u.Deleted IS NULL
                    AND u.IsBlocked = 0 AND u.IsDenyAccess = 0)
    SET @final_aid = @force_operator_id;

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
          SET @out_cid = @cid; SET @out_lid = @lid; SET @out_action = 'reheated';
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

  -- Keep min-count fair for a forced (direct) assignment.
  IF @final_aid <> 1574
    UPDATE CRM_Helper.dbo.Users_for_leaddistribute
       SET CountGeorgian = CountGeorgian + CASE WHEN @f14 = N'ქართული'   THEN 1 ELSE 0 END,
           CountRussian  = CountRussian  + CASE WHEN @f14 = N'რუსული'    THEN 1 ELSE 0 END,
           CountEnglish  = CountEnglish  + CASE WHEN @f14 = N'ინგლისური' THEN 1 ELSE 0 END
     WHERE UserID = @final_aid;

  SET @out_cid = @cid;
  SET @out_lid = @lid;
END
