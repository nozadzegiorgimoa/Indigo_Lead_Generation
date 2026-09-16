-- Add a guard parameter @onlyif (default 0) to the old auto-distribution proc so
-- it does NOTHING unless explicitly called with 1. Whoever/whatever calls it the
-- old way (no arg) now gets a no-op; only our controlled calls pass 1.
-- Done via dynamic SQL so the whole body need not be retyped.
USE CRM_Helper;
DECLARE @def nvarchar(max) = OBJECT_DEFINITION(OBJECT_ID('dbo.distribute_hot_leads'));
IF @def IS NULL BEGIN PRINT 'proc not found'; RETURN; END
IF CHARINDEX('@onlyif', @def) > 0 BEGIN PRINT 'guard already present'; RETURN; END

DECLARE @nm nvarchar(50) = '[distribute_hot_leads]';
DECLARE @p int = CHARINDEX(@nm, @def) + LEN(@nm);
-- 1) inject the parameter right after the proc name
SET @def = STUFF(@def, @p, 0, CHAR(13)+CHAR(10)+'  @onlyif int = 0');
-- 2) inject the early return right after the first BEGIN (outer body)
DECLARE @b int = CHARINDEX('begin', @def, @p);
SET @def = STUFF(@def, @b + 5, 0, CHAR(13)+CHAR(10)+'if @onlyif <> 1 return;'+CHAR(13)+CHAR(10));
-- 3) CREATE -> ALTER
SET @def = STUFF(@def, CHARINDEX('CREATE', @def), 6, 'ALTER');
EXEC sys.sp_executesql @def;
PRINT 'guard added';
