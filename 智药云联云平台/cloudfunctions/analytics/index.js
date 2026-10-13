// 云函数：analytics
// 作用：依从性评分、库存扫描、预警管理。对应计划书 2.3.2「用药依从性评分模型」。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const TZ_OFFSET = 8 * 60 * 60 * 1000

/**
 * 各状态的计分权重。
 * 依据：延迟服药仍有一定疗效但风险高于按时；提前服药影响相对小；
 *      漏服完全无疗效，计 0 分。
 */
const SCORE_WEIGHT = {
  on_time: 1.0,
  early: 0.8,
  late: 0.5,
  missed: 0,
  extra: null   // null = 不计入分母
}

const LEVELS = [
  { min: 90, label: '优秀', color: '#2E7D6F' },
  { min: 75, label: '良好', color: '#4A9D8E' },
  { min: 60, label: '一般', color: '#E8A33D' },
  { min: 0, label: '需关注', color: '#D9534F' }
]

function bjDateBefore(daysAgo) {
  const bj = new Date(Date.now() + TZ_OFFSET)
  bj.setUTCDate(bj.getUTCDate() - daysAgo)
  return bj.toISOString().slice(0, 10)
}

function levelOf(score) {
  return LEVELS.find(l => score >= l.min) || LEVELS[LEVELS.length - 1]
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { action } = event

  if (!OPENID) return { code: 401, msg: '未登录' }

  try {
    switch (action) {
      case 'adherence':
        return await adherence(OPENID, event)
      case 'checkStock':
        return await checkStock(OPENID, event)
      case 'alerts':
        return await listAlerts(OPENID, event)
      case 'readAlert':
        return await readAlert(OPENID, event.id)
      case 'readAllAlerts':
        return await readAllAlerts(OPENID)
      default:
        return { code: 400, msg: `未知 action: ${action}` }
    }
  } catch (err) {
    console.error('[analytics]', action, err)
    return { code: err.code || 500, msg: err.message }
  }
}

// ── 依从性评分 ──────────────────────────────────────────────
/**
 * 得分 = (按时×1.0 + 提前×0.8 + 延迟×0.5) / 应服总次数 × 100
 * 返回总分、分级、逐日趋势、逐药品明细。
 */
async function adherence(openid, event) {
  const days = [7, 30].includes(Number(event.days)) ? Number(event.days) : 7
  const startDate = bjDateBefore(days - 1)
  const endDate = bjDateBefore(0)

  const where = { ownerOpenid: openid, dateStr: _.gte(startDate).and(_.lte(endDate)) }
  if (event.deviceId) where.deviceId = event.deviceId
  if (event.elderId) where.elderId = event.elderId

  const res = await db.collection('records')
    .where(where)
    .orderBy('dateStr', 'asc')
    .limit(1000)   // 云开发单次最多取 1000 条，超出需分页或改用聚合
    .get()

  const records = res.data.filter(r => SCORE_WEIGHT[r.status] !== null)

  // 总体
  let weighted = 0
  const byStatus = { on_time: 0, early: 0, late: 0, missed: 0 }

  // 逐日
  const dayMap = {}
  // 逐药品
  const medMap = {}

  for (const r of records) {
    const w = SCORE_WEIGHT[r.status] || 0
    weighted += w
    byStatus[r.status] = (byStatus[r.status] || 0) + 1

    if (!dayMap[r.dateStr]) dayMap[r.dateStr] = { date: r.dateStr, total: 0, weighted: 0, missed: 0 }
    dayMap[r.dateStr].total++
    dayMap[r.dateStr].weighted += w
    if (r.status === 'missed') dayMap[r.dateStr].missed++

    const key = r.medicineName || '未命名药品'
    if (!medMap[key]) medMap[key] = { name: key, total: 0, weighted: 0, missed: 0 }
    medMap[key].total++
    medMap[key].weighted += w
    if (r.status === 'missed') medMap[key].missed++
  }

  const score = records.length > 0 ? Math.round((weighted / records.length) * 100) : null

  const trend = Object.values(dayMap)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(d => ({ ...d, score: Math.round((d.weighted / d.total) * 100) }))

  const byMedicine = Object.values(medMap)
    .sort((a, b) => a.weighted / a.total - b.weighted / b.total)
    .map(m => ({
      name: m.name,
      total: m.total,
      missed: m.missed,
      score: Math.round((m.weighted / m.total) * 100)
    }))

  return {
    code: 0,
    data: {
      score,
      level: score === null ? null : levelOf(score),
      days,
      startDate,
      endDate,
      totalCount: records.length,
      byStatus,
      trend,
      byMedicine
    }
  }
}

// ── 库存扫描 ────────────────────────────────────────────────
/** 扫描全部生效计划，对剩余天数 ≤7 的生成预警（同一计划 24h 内不重复） */
async function checkStock(openid, event) {
  const where = { ownerOpenid: openid, active: true }
  if (event.deviceId) where.deviceId = event.deviceId

  const plans = await db.collection('plans').where(where).get()
  const created = []

  // 一次性取回设备名，供订阅消息模板使用
  const devIds = [...new Set(plans.data.map(p => p.deviceId).filter(Boolean))]
  const devMap = {}
  if (devIds.length > 0) {
    const devs = await db.collection('devices').where({ _id: _.in(devIds) }).get()
    for (const d of devs.data) devMap[d._id] = d.name || '智能药盒'
  }

  for (const plan of plans.data) {
    const stock = Number(plan.stock) || 0
    const daily = Number(plan.dailyConsumption) || 0
    if (daily <= 0) continue

    const remainingDays = Math.floor(stock / daily)
    if (remainingDays > 7) continue

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const dup = await db.collection('alerts')
      .where({ planId: plan._id, type: 'low_stock', createdAt: _.gte(since) })
      .count()
    if (dup.total > 0) continue

    await db.collection('alerts').add({
      data: {
        ownerOpenid: openid,
        elderId: plan.elderId || '',
        deviceId: plan.deviceId,
        planId: plan._id,
        type: 'low_stock',
        level: remainingDays <= 3 ? 'high' : 'medium',
        title: '药品即将用完',
        // 以下三个字段供订阅消息模板使用
        medicineName: plan.medicineName,
        dosageText: plan.dosageText || '',
        deviceName: devMap[plan.deviceId] || '智能药盒',
        message: `${plan.medicineName} 剩余约 ${Math.max(remainingDays, 0)} 天用量，建议及时补药`,
        read: false,
        notified: false,   // notify 云函数据此判断是否已推送
        createdAt: db.serverDate()
      }
    })
    created.push({ planId: plan._id, medicineName: plan.medicineName, remainingDays })
  }

  return { code: 0, data: { created, count: created.length } }
}

// ── 预警列表 ────────────────────────────────────────────────
async function listAlerts(openid, event) {
  const page = Math.max(Number(event.page) || 1, 1)
  const pageSize = Math.min(Math.max(Number(event.pageSize) || 20, 1), 100)

  const where = { ownerOpenid: openid }
  if (event.onlyUnread) where.read = false
  if (event.elderId) where.elderId = event.elderId

  const total = await db.collection('alerts').where(where).count()
  const res = await db.collection('alerts')
    .where(where)
    .orderBy('createdAt', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  const unread = await db.collection('alerts')
    .where({ ownerOpenid: openid, read: false })
    .count()

  return {
    code: 0,
    data: {
      list: res.data,
      total: total.total,
      unread: unread.total,
      page,
      hasMore: page * pageSize < total.total
    }
  }
}

async function readAlert(openid, id) {
  if (!id) return { code: 400, msg: '缺少 id' }
  const res = await db.collection('alerts').doc(id).get().catch(() => null)
  if (!res || !res.data) return { code: 404, msg: '预警不存在' }
  if (res.data.ownerOpenid !== openid) return { code: 403, msg: '无权操作' }

  await db.collection('alerts').doc(id).update({ data: { read: true } })
  return { code: 0, data: { _id: id } }
}

async function readAllAlerts(openid) {
  const res = await db.collection('alerts')
    .where({ ownerOpenid: openid, read: false })
    .update({ data: { read: true } })
  return { code: 0, data: { updated: res.stats.updated } }
}
