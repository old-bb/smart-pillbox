// 云函数：record
// 作用：服药记录的写入与查询。这是「设备上报 → 云端判定 → 子女可见」的核心链路。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// ── 时区处理 ────────────────────────────────────────────────
// 云函数运行在 UTC 环境，而服药时间是按北京时间设定的。
// 所有「日期字符串」和「当日分钟数」统一走下面两个函数换算，
// 否则会出现「早上 8 点的药被判成下午漏服」这类问题。
const TZ_OFFSET = 8 * 60 * 60 * 1000
const GRACE_MINUTES = 120    // 超过计划时间 2 小时仍无记录 → 漏服
const ON_TIME_MINUTES = 30   // ±30 分钟内算按时

/** 真实时刻 → 北京时间的 { 日期字符串, 当日分钟数 } */
function toBjParts(instant) {
  const bj = new Date(instant.getTime() + TZ_OFFSET)
  return {
    dateStr: bj.toISOString().slice(0, 10),
    minutes: bj.getUTCHours() * 60 + bj.getUTCMinutes()
  }
}

/** 北京时间的「日期 + 时刻」→ 真实时刻 */
function bjToInstant(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const [hh, mm] = hhmm.split(':').map(Number)
  return new Date(Date.UTC(y, m - 1, d, hh - 8, mm, 0))
}

/** 北京时间的今天往前推 n 天的日期字符串 */
function bjDateBefore(daysAgo) {
  const bj = new Date(Date.now() + TZ_OFFSET)
  bj.setUTCDate(bj.getUTCDate() - daysAgo)
  return bj.toISOString().slice(0, 10)
}

/** "08:30" → 510 */
function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/**
 * 判定服药状态。diff = 实际时间 − 计划时间（分钟）
 *   |diff| <= 30  → on_time  按时
 *   diff < −30    → early    提前 30 分钟以上
 *   diff > 30     → late     延迟补服
 */
function classify(diff) {
  if (Math.abs(diff) <= ON_TIME_MINUTES) return 'on_time'
  return diff < 0 ? 'early' : 'late'
}

// ── 入口 ────────────────────────────────────────────────────
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { action } = event

  try {
    switch (action) {
      case 'list':
        if (!OPENID) return { code: 401, msg: '未登录' }
        return await list(OPENID, event)
      case 'saveManual':
        if (!OPENID) return { code: 401, msg: '未登录' }
        return await saveManual(OPENID, event)
      case 'syncMissed':
        if (!OPENID) return { code: 401, msg: '未登录' }
        return await syncMissed(OPENID, event)
      // 由硬件端调用，走设备 token 鉴权而非用户登录
      case 'report':
        return await report(event)
      // 小程序端模拟上报（没有硬件时演示用），走用户登录态
      case 'simulateReport':
        if (!OPENID) return { code: 401, msg: '未登录' }
        return await simulateReport(OPENID, event)
      default:
        return { code: 400, msg: `未知 action: ${action}` }
    }
  } catch (err) {
    console.error('[record]', action, err)
    return { code: err.code || 500, msg: err.message }
  }
}

// ── 设备上报 ────────────────────────────────────────────────
/**
 * 硬件端调用，上报一次服药事件。
 *   event: { deviceId, bayIndex, eventType, timestamp?, token }
 *   eventType: 'taken' 取药 | 'vision_confirmed' 视觉确认已取走 | 'lid_open' 开盖
 *
 * 判定流程：找药仓生效计划 → 匹配最近的服药时点 → 按时间差定状态
 *          → 写记录 → 扣库存 → 触发库存预警
 */
async function report(event) {
  const { deviceId, bayIndex, eventType, token } = event

  if (!deviceId) return { code: 400, msg: '缺少 deviceId' }
  if (typeof bayIndex !== 'number') return { code: 400, msg: '缺少 bayIndex' }

  // 设备鉴权。中期阶段用固定 token 占位，后续替换为设备密钥签名（肖開太负责）
  // 未配置令牌时一律拒绝（fail closed）。
  //
  // 这里原先有个 'zhihyao-dev-token' 作为默认值 —— 但本仓库是公开的，
  // 等于把线上凭证写在明面上：任何人克隆仓库就能伪造服药记录、
  // 读取用药计划、伪造设备在线状态。轮换 AppSecret 也挡不住。
  //
  // 正确做法是在云开发控制台为这个函数配置环境变量 DEVICE_TOKEN，
  // 值用一串足够长的随机字符，硬件端在 secret.json 里同步填同样的值。
  const EXPECTED = process.env.DEVICE_TOKEN
  if (!EXPECTED) {
    console.error('[record] 未配置 DEVICE_TOKEN 环境变量，拒绝所有设备请求')
    return { code: 500, msg: '服务端未配置设备令牌' }
  }
  if (token !== EXPECTED) {
    console.warn('[record] 设备鉴权失败', deviceId)
    return { code: 403, msg: '设备鉴权失败' }
  }

  const deviceRes = await db.collection('devices').where({ deviceId }).limit(1).get()
  if (deviceRes.data.length === 0) return { code: 404, msg: '设备未注册' }

  return await applyReport(deviceRes.data[0], bayIndex, eventType, event.timestamp)
}

/**
 * 小程序端触发的模拟上报，用于没有硬件时演示完整流程。
 *
 * 走用户登录态而不是设备令牌 —— 客户端代码可以被反编译，
 * 把设备令牌放进小程序等于公开它。
 * 这里用 OPENID 鉴权，并且要求这台设备确实属于调用者。
 */
async function simulateReport(openid, event) {
  const { deviceId, bayIndex, eventType } = event

  if (!deviceId) return { code: 400, msg: '缺少 deviceId' }
  if (typeof bayIndex !== 'number') return { code: 400, msg: '缺少 bayIndex' }

  const deviceRes = await db.collection('devices').where({ deviceId }).limit(1).get()
  if (deviceRes.data.length === 0) return { code: 404, msg: '设备未注册' }
  const device = deviceRes.data[0]

  // 归属校验：不能拿别人的设备来造记录
  if (device.ownerOpenid !== openid) {
    return { code: 403, msg: '无权操作该设备' }
  }

  return await applyReport(device, bayIndex, eventType, event.timestamp)
}

/** 设备上报与模拟上报共用的主体逻辑 */
async function applyReport(device, bayIndex, eventType, timestamp) {
  // 设备能上报任何事件，都说明它此刻在线。放在最前面，
  // 这样开盖、重复上报等分支也都会刷新心跳，不会出现
  // 「有上报记录却显示离线」的矛盾状态。
  await db.collection('devices').doc(device._id).update({
    data: { lastSeenAt: db.serverDate(), online: true }
  })

  // 开盖事件不单独计为服药，只作为过程日志
  if (eventType === 'lid_open') {
    return { code: 0, data: { ignored: true, reason: '开盖事件不计为服药' } }
  }

  const planRes = await db.collection('plans')
    .where({ deviceId: device._id, bayIndex, active: true })
    .limit(1)
    .get()
  if (planRes.data.length === 0) {
    return { code: 0, data: { ignored: true, reason: '该药仓没有生效中的计划' } }
  }
  const plan = planRes.data[0]

  // 统一换算到北京时间再比对
  const at = timestamp ? new Date(timestamp) : new Date()
  if (isNaN(at.getTime())) return { code: 400, msg: 'timestamp 格式错误' }
  const { dateStr, minutes: atMinutes } = toBjParts(at)

  // 找距离本次事件最近的服药时点
  let nearest = null
  for (const t of plan.times || []) {
    const diff = atMinutes - toMinutes(t)
    if (nearest === null || Math.abs(diff) < Math.abs(nearest.diff)) {
      nearest = { time: t, diff }
    }
  }
  if (!nearest) return { code: 400, msg: '计划未配置服药时间' }

  const scheduledAt = bjToInstant(dateStr, nearest.time)

  // 设备本地判定漏服后上报的事件，必须单独处理，不能走 classify()：
  //
  //   硬件端在提醒超时（REMIND_TIMEOUT = 120 秒）后才上报 missed，
  //   此时「事件时刻 − 计划时刻」约等于 +2 分钟，落在 ±30 分钟窗口内，
  //   classify() 会判成 on_time —— 结果是漏服被记成按时服药、
  //   依从性得分虚高、漏服预警永不产生（而漏服提醒恰恰是本项目的核心卖点），
  //   而且药没取走却扣了库存。
  const isMissedReport = eventType === 'missed'
  const status = isMissedReport ? 'missed' : classify(nearest.diff)

  // 同一个计划时点只记一条，重复上报按可信度升级处理
  const exist = await db.collection('records')
    .where({ planId: plan._id, dateStr, scheduledAt })
    .limit(1)
    .get()

  if (exist.data.length > 0) {
    const rec = exist.data[0]
    // 只有「视觉确认」能升级传感器的记录。
    // 漏服上报不参与升级：已经有服药记录说明药被取走了，
    // 迟到的 missed 不该把它覆盖成漏服；反过来也一样。
    const upgraded = eventType === 'vision_confirmed' && rec.source !== 'vision_confirmed'
    if (upgraded) {
      await db.collection('records').doc(rec._id).update({
        data: { source: 'vision_confirmed', updatedAt: db.serverDate() }
      })
    }
    return { code: 0, data: { _id: rec._id, status: rec.status, upgraded, duplicate: true } }
  }

  const res = await db.collection('records').add({
    data: {
      deviceId: device._id,
      deviceCode: device.deviceId,
      elderId: device.elderId || '',
      planId: plan._id,
      bayIndex,
      medicineName: plan.medicineName,
      dosageText: plan.dosageText,
      dateStr,
      scheduledAt,
      actualAt: isMissedReport ? null : at,
      status,
      diffMinutes: nearest.diff,
      // vision_confirmed：摄像头确认药片真的被取走，可信度高于传感器触发
      // device：药盒本地判定漏服后主动上报
      source: isMissedReport ? 'device'
            : (eventType === 'vision_confirmed' ? 'vision_confirmed' : 'sensor'),
      ownerOpenid: device.ownerOpenid,
      createdAt: db.serverDate()
    }
  })

  if (isMissedReport) {
    // 漏服不扣库存（药根本没被取走），但要及时产生预警 ——
    // 设备在线时由这条路径推送，比等 syncMissed 兜底更及时
    await createMissedAlert(device, plan, res._id, dateStr)
    return {
      code: 0,
      data: { _id: res._id, status, plannedTime: nearest.time, diffMinutes: nearest.diff }
    }
  }

  // 扣库存
  const perDose = Number(plan.perDose) || 1
  await db.collection('plans').doc(plan._id).update({
    data: { stock: _.inc(-perDose), updatedAt: db.serverDate() }
  })

  await checkStock(plan._id, device)

  return { code: 0, data: { _id: res._id, status, plannedTime: nearest.time, diffMinutes: nearest.diff } }
}

/**
 * 为设备上报的漏服生成预警。
 *
 * 字段结构与 pushMissedAlerts 保持一致 —— notify 云函数按这些字段组装
 * 订阅消息，两边字段名必须一样，否则推送会因为缺字段报 47003。
 */
async function createMissedAlert(device, plan, recordId, dateStr) {
  // 同一条记录只告警一次
  const dup = await db.collection('alerts')
    .where({ recordId, type: 'missed_dose' })
    .count()
  if (dup.total > 0) return

  await db.collection('alerts').add({
    data: {
      ownerOpenid: device.ownerOpenid,
      elderId: device.elderId || '',
      deviceId: device._id,
      recordId,
      type: 'missed_dose',
      level: 'high',
      title: '检测到漏服',
      // 以下三个字段供订阅消息模板使用
      medicineName: plan.medicineName,
      dosageText: plan.dosageText || '',
      deviceName: device.name || '智能药盒',
      message: `${plan.medicineName} 在 ${dateStr} 未按时服用`,
      read: false,
      notified: false,
      createdAt: db.serverDate()
    }
  })
}

// ── 库存预警 ────────────────────────────────────────────────
async function checkStock(planId, device) {
  const res = await db.collection('plans').doc(planId).get().catch(() => null)
  if (!res || !res.data) return

  const plan = res.data
  const stock = Number(plan.stock) || 0
  const daily = Number(plan.dailyConsumption) || 0
  if (daily <= 0) return

  const remainingDays = Math.floor(stock / daily)
  if (remainingDays > 7) return

  // 同一计划 24 小时内不重复告警
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const dup = await db.collection('alerts')
    .where({ planId, type: 'low_stock', createdAt: _.gte(since) })
    .count()
  if (dup.total > 0) return

  await db.collection('alerts').add({
    data: {
      ownerOpenid: device.ownerOpenid,
      elderId: device.elderId || '',
      deviceId: device._id,
      planId,
      type: 'low_stock',
      level: remainingDays <= 3 ? 'high' : 'medium',
      title: '药品即将用完',
      // 以下三个字段供订阅消息模板使用
      medicineName: plan.medicineName,
      dosageText: plan.dosageText || '',
      deviceName: device.name || '智能药盒',
      message: `${plan.medicineName} 剩余约 ${Math.max(remainingDays, 0)} 天用量，建议及时补药`,
      read: false,
      notified: false,   // notify 云函数据此判断是否已推送
      createdAt: db.serverDate()
    }
  })
}

// ── 漏服补齐 ────────────────────────────────────────────────
/**
 * 把「已过补救窗口、但没有任何记录」的计划时点补写成 missed 记录。
 * 前端每次进首页时调一次，保证看板数据完整。
 *
 * ⚠️ 云开发单次云函数最长 20 秒，这里靠 days 控制规模。
 *    设备多、天数大时建议改成定时触发器分批跑。
 */
async function syncMissed(openid, event) {
  const days = Math.min(Math.max(Number(event.days) || 7, 1), 30)

  const devices = await db.collection('devices').where({ ownerOpenid: openid }).get()
  if (devices.data.length === 0) return { code: 0, data: { created: 0 } }
  const deviceIds = devices.data.map(d => d._id)

  const plans = await db.collection('plans')
    .where({ deviceId: _.in(deviceIds), active: true })
    .get()

  const nowMinutes = toBjParts(new Date()).minutes
  let created = 0

  for (let i = 0; i < days; i++) {
    const dateStr = bjDateBefore(i)
    const isToday = i === 0

    for (const plan of plans.data) {
      // 计划创建之前就过去的时点不算漏服 —— 那时还没有这个计划，
      // 否则「下午建一个含早上 8 点的计划」会立刻被判成漏服。
      const planCreatedAt = plan.createdAt ? new Date(plan.createdAt).getTime() : 0

      for (const t of plan.times || []) {
        // 还没到点、或仍在补救宽限期内 → 跳过
        if (isToday && nowMinutes - toMinutes(t) < GRACE_MINUTES) continue

        const scheduledAt = bjToInstant(dateStr, t)

        // 早于计划创建时刻的时点直接跳过
        if (scheduledAt.getTime() < planCreatedAt) continue
        const exist = await db.collection('records')
          .where({ planId: plan._id, dateStr, scheduledAt })
          .count()
        if (exist.total > 0) continue

        const device = devices.data.find(d => d._id === plan.deviceId)
        await db.collection('records').add({
          data: {
            deviceId: plan.deviceId,
            deviceCode: device ? device.deviceId : '',
            elderId: (device && device.elderId) || '',
            planId: plan._id,
            bayIndex: plan.bayIndex,
            medicineName: plan.medicineName,
            dosageText: plan.dosageText,
            dateStr,
            scheduledAt,
            actualAt: null,
            status: 'missed',
            diffMinutes: null,
            source: 'auto',
            ownerOpenid: openid,
            createdAt: db.serverDate()
          }
        })
        created++
      }
    }
  }

  if (created > 0) await pushMissedAlerts(openid, days)

  return { code: 0, data: { created } }
}

/** 为最近的漏服记录生成预警，同一记录不重复告警 */
async function pushMissedAlerts(openid, days) {
  const missed = await db.collection('records')
    .where({
      ownerOpenid: openid,
      status: 'missed',
      dateStr: _.gte(bjDateBefore(days))
    })
    .orderBy('scheduledAt', 'desc')
    .limit(20)
    .get()

  // 一次性取回设备名，避免逐条查询
  const devIds = [...new Set(missed.data.map(r => r.deviceId).filter(Boolean))]
  const devMap = {}
  if (devIds.length > 0) {
    const devs = await db.collection('devices').where({ _id: _.in(devIds) }).get()
    for (const d of devs.data) devMap[d._id] = d.name || '智能药盒'
  }

  for (const rec of missed.data) {
    const dup = await db.collection('alerts')
      .where({ recordId: rec._id, type: 'missed_dose' })
      .count()
    if (dup.total > 0) continue

    await db.collection('alerts').add({
      data: {
        ownerOpenid: openid,
        elderId: rec.elderId || '',
        deviceId: rec.deviceId,
        recordId: rec._id,
        type: 'missed_dose',
        level: 'high',
        title: '检测到漏服',
        // 以下三个字段供订阅消息模板使用
        medicineName: rec.medicineName,
        dosageText: rec.dosageText || '',
        deviceName: devMap[rec.deviceId] || '智能药盒',
        message: `${rec.medicineName} 在 ${rec.dateStr} 未按时服用`,
        read: false,
        notified: false,
        createdAt: db.serverDate()
      }
    })
  }
}

// ── 查询 ────────────────────────────────────────────────────
async function list(openid, event) {
  const page = Math.max(Number(event.page) || 1, 1)
  const pageSize = Math.min(Math.max(Number(event.pageSize) || 20, 1), 100)

  const where = { ownerOpenid: openid }
  if (event.deviceId) where.deviceId = event.deviceId
  if (event.status) where.status = event.status
  if (event.startDate && event.endDate) {
    where.dateStr = _.gte(event.startDate).and(_.lte(event.endDate))
  }

  const total = await db.collection('records').where(where).count()
  const res = await db.collection('records')
    .where(where)
    .orderBy('scheduledAt', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get()

  return {
    code: 0,
    data: {
      list: res.data,
      total: total.total,
      page,
      pageSize,
      hasMore: page * pageSize < total.total
    }
  }
}

/** 子女手动补录，应对老人服了药但没按确认键的情况 */
async function saveManual(openid, event) {
  const { planId, dateStr, time } = event
  if (!planId || !dateStr || !time) return { code: 400, msg: '缺少必要参数' }

  const planRes = await db.collection('plans').doc(planId).get().catch(() => null)
  if (!planRes || !planRes.data) return { code: 404, msg: '计划不存在' }
  const plan = planRes.data
  if (plan.ownerOpenid !== openid) return { code: 403, msg: '无权操作' }

  const scheduledAt = bjToInstant(dateStr, time)
  const exist = await db.collection('records')
    .where({ planId, dateStr, scheduledAt })
    .limit(1)
    .get()
  if (exist.data.length > 0) return { code: 400, msg: '该时点已有记录' }

  const res = await db.collection('records').add({
    data: {
      deviceId: plan.deviceId,
      elderId: plan.elderId || '',
      planId,
      bayIndex: plan.bayIndex,
      medicineName: plan.medicineName,
      dosageText: plan.dosageText,
      dateStr,
      scheduledAt,
      actualAt: new Date(),
      status: 'on_time',
      diffMinutes: 0,
      source: 'manual',
      ownerOpenid: openid,
      createdAt: db.serverDate()
    }
  })

  return { code: 0, data: { _id: res._id } }
}
