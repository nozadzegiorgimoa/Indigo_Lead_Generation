-- crm.dbo.reassign_all_from_operator — move EVERY open Stage-7 lead currently
-- owned by @uid to someone else, via the rule-based rotation (reassign_hot_lead).
-- Used when an operator is temporarily disabled (treated like a leaver).
CREATE OR ALTER PROCEDURE dbo.reassign_all_from_operator
  @uid    int,
  @actor  int = NULL,
  @moved  int = NULL OUTPUT
AS
BEGIN
  SET NOCOUNT ON;
  SET @moved = 0;
  DECLARE @lid numeric(18,0), @a int, @nm nvarchar(225), @g nvarchar(200);
  DECLARE cur CURSOR LOCAL FAST_FORWARD FOR
    SELECT ID FROM crm.dbo.loans WHERE AID = @uid AND Stage = 7 AND ISNULL(Archived,0) = 0;
  OPEN cur; FETCH NEXT FROM cur INTO @lid;
  WHILE @@FETCH_STATUS = 0
  BEGIN
    BEGIN TRY
      EXEC crm.dbo.reassign_hot_lead @lid=@lid, @actor=@actor,
           @out_aid=@a OUTPUT, @out_name=@nm OUTPUT, @out_group=@g OUTPUT;
      IF @a IS NOT NULL AND @a <> @uid SET @moved = @moved + 1;
    END TRY BEGIN CATCH
      -- no eligible target for this one; leave it and continue
    END CATCH
    FETCH NEXT FROM cur INTO @lid;
  END
  CLOSE cur; DEALLOCATE cur;
END
