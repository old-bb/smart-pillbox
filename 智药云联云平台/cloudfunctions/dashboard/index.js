// 云函数：dashboard
// 作用：首页看板的一次性聚合查询。前端只调这一个接口，减少往返。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const TZ_OFFSET = 8 * 60 * 60 * 1000
const SCORE_WEIGHT = { on_time: 1.0, early: 0.8, late: 0.5, missed: 0 }
const ONLINE_WINDOW = 5 * 60 * 1000   // 5 分钟内有心跳视为在线

function bjDateBefore(daysAgo) {
  const bj = new Date(Date.now() + TZ_OFFSET)
  bj.setUTCDate(bj.getUTCDate() - daysAgo)
  return bj.toISOString().slice(0, 10)
}

/** 某个真实时刻对应的北京时间「当日分钟数」 */
function bjMinutesOf(instant) {
  const bj = new Date(instant.getTime() + TZ_OFFSET)
  return bj.getUTCHours() * 60 + bj.getUTCMinutes()
}

/** 某个真实时刻对应的北京时间 "HH:mm" */
function bjHhmmOf(instant) {
  const bj = new Date(instant.getTime() + TZ_OFFSET)
  return `${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { code: 401, msg: '未登录' }

  try {
    const todayDate = bjDateBefore(0)
    const nowMin = bjMinutesOf(new Date())

    // ── 设备 ──
    const deviceRes = await db.collection('devices')
      .where({ ownerOpenid: OPENID })
      .orderBy('createdAt', 'asc')
      .get()

    const devices = deviceRes.data.map(d => {
      const last = d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0
      return {
        _id: d._id,
        deviceId: d.deviceId,
        name: d.name,
        elderId: d.elderId || '',
        battery: d.battery,
        online: Date.now() - last < ONLINE_WINDOW,
        lastSeenAt: d.lastSeenAt,
        bayCount: (d.bays || []).length
      }
    })

    if (devices.length === 0) {
      return { code: 0, data: { empty: true, devices: [], today: null, adherence: null, alerts: [], unreadAlerts: 0 } }
    }

    const deviceIds = devices.map(d => d._id)

    // ── 今日记录，按「计划ID + 北京时间时点」建索引 ──
    const todayRecords = await db.collection('records')
      .where({ ownerOpenid: OPENID, dateStr: todayDate })
      .get()

    const recMap = {}
    for (const r of todayRecords.data) {
      const key = `${r.planId}_${bjHhmmOf(new Date(r.scheduledAt))}`
      recMap[key] = r
    }

    // ── 把每个生效计划的 times 展开成具体时点 ──
    const planRes = await db.collection('plans')
      .where({ deviceId: _.in(deviceIds), active: true })
      .orderBy('bayIndex', 'asc')
      .get()

    const slots = []
    for (const p of planRes.data) {
      const device = devices.find(d => d._id === p.deviceId)
      for (const t of p.times || []) {
        const rec = recMap[`${p._id}_${t}`]
        const passed = nowMin > toMinutes(t)
        slots.push({
          planId: p._id,
          bayIndex: p.bayIndex,
          medicineName: p.medicineName,
          dosageText: p.dosageText,
          mealRelation: p.mealRelation,
          time: t,
          deviceName: device ? device.name : '',
          // 已到点但没记录 → pending（等云端 syncMissed 补写成 missed）
          status: rec ? rec.status : (passed ? 'pending' : 'upcoming'),
          source: rec ? rec.source : null,
          recordId: rec ? rec._id : null
        })
      }
    }
    slots.sort((a, b) => toMinutes(a.time) - toMinutes(b.time))

    const done = slots.filter(s => ['on_time', 'early', 'late'].includes(s.status)).length
    const nextSlot = slots.find(s => s.status === 'upcoming' || s.status === 'pending') || null

    // ── 7 日依从性 ──
    const start7 = bjDateBefore(6)
    const rec7 = await db.collection('records')
      .where({ ownerOpenid: OPENID, dateStr: _.gte(start7).and(_.lte(todayDate)) })
      .limit(1000)
      .get()

    const valid = rec7.data.filter(r => SCORE_WEIGHT[r.status] !== null && r.status !== undefined)
    let weighted = 0, missedCount = 0
    for (const r of valid) {
      weighted += SCORE_WEIGHT[r.status] || 0
      if (r.status === 'missed') missedCount++
    }

    // 逐日趋势：先把 7 天都铺出来，再往里填数据。
    // 没有记录的那天 score 置 null —— 那天可能是还没开始用药，
    // 判成 0 分会让折线凭空出现一个深谷，是误导。
    const dayMap = {}
    for (let i = 6; i >= 0; i--) {
      const d = bjDateBefore(i)
      dayMap[d] = { date: d, weighted: 0, total: 0, missed: 0 }
    }
    for (const r of valid) {
      const d = dayMap[r.dateStr]
      if (!d) continue
      d.total++
      d.weighted += SCORE_WEIGHT[r.status] || 0
      if (r.status === 'missed') d.missed++
    }
    const trend = Object.keys(dayMap).sort().map(d => {
      const day = dayMap[d]
      return {
        date: d,
        score: day.total > 0 ? Math.round((day.weighted / day.total) * 100) : null,
        total: day.total,
        missed: day.missed
      }
    })

    const adherence = valid.length > 0
      ? { score: Math.round((weighted / valid.length) * 100), total: valid.length, missed: missedCount, trend }
      : null

    // ── 未读预警 ──
    const alertRes = await db.collection('alerts')
      .where({ ownerOpenid: OPENID, read: false })
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get()
    const unreadTotal = await db.collection('alerts')
      .where({ ownerOpenid: OPENID, read: false })
      .count()

    return {
      code: 0,
      data: {
        empty: false,
        date: todayDate,
        devices,
        today: {
          slots,
          done,
          total: slots.length,
          next: nextSlot,
          progress: slots.length ? Math.round((done / slots.length) * 100) : 0
        },
        adherence,
        alerts: alertRes.data,
        unreadAlerts: unreadTotal.total
      }
    }
  } catch (err) {
    console.error('[dashboard]', err)
    return { code: 500, msg: err.message }
  }
}
