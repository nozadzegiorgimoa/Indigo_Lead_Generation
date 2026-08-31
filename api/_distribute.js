// Stage 2 — lead distribution engine.
// Pure rule resolution + fair round-robin operator pick within a target group.
// Targets are crm groups/users; IDs are grouped here so they're easy to retune.

const GROUP = { MARKOV: 56, DEALER: 52, RETAIL: 49 };
const OPERATOR = { BORIS: 1693 };            // Russian + retail → this specific operator

// The active-sale-operator filter, reused everywhere (matches /api/sale-operators).
const OP_FILTER =
  "u.Deleted IS NULL AND u.IsBlocked = 0 AND u.IsDenyAccess = 0 AND u.Name NOT LIKE 'System%' AND u.Login <> u.Name";

function looksUkraine(lead) {
  if (lead.language === 'ukrainian') return true;
  return /ukrain|укра|укра[иї]н|უკრაინ/i.test(lead.country || '');
}

// Decide the target from lead attributes. Returns either a specific operator
// (kind 'operator') or a group to round-robin (kind 'group'), plus a reason.
function resolveTarget(lead) {
  const lang = lead.language || null;
  const type = lead.customerType === 'dealer' ? 'dealer' : 'retail';   // default retail

  if (looksUkraine(lead)) return { kind: 'group', groupId: GROUP.MARKOV, reason: 'ukraine/ukrainian → Markov' };
  if (lang === 'russian' && type === 'dealer') return { kind: 'group', groupId: GROUP.MARKOV, reason: 'russian+dealer → Markov' };
  if (lang === 'russian' && type === 'retail') return { kind: 'operator', operatorId: OPERATOR.BORIS, reason: 'russian+retail → Boris Jalalyan' };
  if (type === 'dealer') return { kind: 'group', groupId: GROUP.DEALER, reason: 'dealer → Dealer group' };
  return { kind: 'group', groupId: GROUP.RETAIL, reason: 'retail/none → Retail group' };
}

// Active operators of one group, ordered by ID (stable for round-robin).
async function groupOperators(pool, sql, groupId) {
  const r = await pool.request().input('g', sql.Int, groupId).query(
    `SELECT u.ID AS id, u.Name AS name, g.Caption AS group_name
       FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID
      WHERE g.ID = @g AND ${OP_FILTER}
      ORDER BY u.ID`);
  return r.recordset;
}

// Validate + fetch a single crm operator (must be an active sale operator).
async function getOperator(pool, sql, operatorId) {
  const r = await pool.request().input('id', sql.Int, Number(operatorId)).query(
    `SELECT u.ID AS id, u.Name AS name, g.ID AS group_id, g.Caption AS group_name
       FROM crm.dbo.users u JOIN crm.dbo.usersgroups g ON g.ID = u.GroupID
      WHERE u.ID = @id AND g.Add3 = 1 AND ${OP_FILTER}`);
  return r.recordset[0] || null;
}

// Fair round-robin: random start when the group has no pointer yet, otherwise
// the next operator after the last-assigned one (by ID, wrapping). State is a
// per-group pointer in app_settings ('rr_grp_<id>' = last operator id).
async function pickInGroup(pool, sql, groupId) {
  const ops = await groupOperators(pool, sql, groupId);
  if (!ops.length) return null;
  const key = 'rr_grp_' + groupId;
  const last = (await pool.request().input('k', sql.NVarChar(60), key)
    .query('SELECT val FROM dbo.app_settings WHERE [key] = @k')).recordset[0];

  let chosen;
  if (!last) {
    chosen = ops[Math.floor(Math.random() * ops.length)];
    await pool.request().input('k', sql.NVarChar(60), key).input('v', sql.Int, chosen.id)
      .query('INSERT INTO dbo.app_settings ([key], val) VALUES (@k, @v)');
  } else {
    chosen = ops.find(o => o.id > last.val) || ops[0];
    await pool.request().input('k', sql.NVarChar(60), key).input('v', sql.Int, chosen.id)
      .query('UPDATE dbo.app_settings SET val = @v WHERE [key] = @k');
  }
  return chosen;
}

// Full auto distribution: resolve the rule, then land on a concrete operator.
// Returns { operatorId, operatorName, groupId, groupName, reason } or null.
async function distribute(pool, sql, lead) {
  const target = resolveTarget(lead);
  let op = null, groupName = null;

  if (target.kind === 'operator') {
    op = await getOperator(pool, sql, target.operatorId);
    // If the named operator is no longer active, fall back to their group's rotation.
    if (!op) {
      const chosen = await pickInGroup(pool, sql, GROUP.RETAIL);
      if (!chosen) return null;
      return { operatorId: chosen.id, operatorName: chosen.name, groupId: GROUP.RETAIL, groupName: chosen.group_name, reason: target.reason + ' (fallback: operator inactive)' };
    }
    return { operatorId: op.id, operatorName: op.name, groupId: op.group_id, groupName: op.group_name, reason: target.reason };
  }

  const chosen = await pickInGroup(pool, sql, target.groupId);
  if (!chosen) return null;
  return { operatorId: chosen.id, operatorName: chosen.name, groupId: target.groupId, groupName: chosen.group_name, reason: target.reason + ' (rr)' };
}

module.exports = { distribute, resolveTarget, pickInGroup, getOperator, groupOperators, GROUP, OPERATOR, OP_FILTER };
