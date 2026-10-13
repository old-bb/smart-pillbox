// 云函数：device
// 作用：药盒设备的绑定、解绑、药仓配置、心跳上报
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const DEFAULT_BAY_COUNT = 6

/** 生成默认的空药仓配置 */
function emptyBays(count = DEFAULT_BAY_COUNT) {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    label: `${i + 1}号仓`,
    medicineName: '',
    customVoice: ''
  }))
}

async function assertOwner(id, openid) {
  const res = await db.collection('devices').doc(id).get().catch(() => null)
  if (!res || !res.data) {
    const err = new Error('设备不存在')
    err.code = 404
    throw err
  }
  if (res.data.ownerOpenid !== openid) {
    const err = new Error('无权操作该设备')
    err.code = 403
    throw err
  }
  return res.data
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { action } = event

  try {
    // 药盒设备上报心跳。走设备 token 鉴权，不需要用户登录 ——
    // 设备没有微信身份，拿不到 OPENID，所以这一分支必须排在登录校验【之前】。
    // （与 record.report / plan.listForDevice 的处理方式保持一致。）
    if (action === 'heartbeat') {
      return await heartbeat(event)
    }

    if (!OPENID) return { code: 401, msg: '未登录' }

    switch (action) {
      case 'list':
        return await list(OPENID)
      case 'bind':
        return await bind(OPENID, event)
      case 'unbind':
        return await unbind(OPENID, event.id)
      case 'updateBays':
        return await updateBays(OPENID, event)
      default:
        return { code: 400, msg: `未知 action: ${action}` }
    }
  } catch (err) {
    console.error('[device]', action, err)
    return { code: err.code || 500, msg: err.message }
  }
}

async function list(openid) {
  const res = await db.collection('devices')
    .where({ ownerOpenid: openid })
    .orderBy('createdAt', 'asc')
    .get()

  // 补充派生字段，前端直接展示
  const devices = res.data
  for (const d of devices) {
    const cnt = await db.collection('plans').where({ deviceId: d._id, active: true }).count()
    d.planCount = cnt.total
    d.bayCount = (d.bays || []).length
    // 超过 5 分钟没心跳视为离线
    const last = d.lastSeenAt ? new Date(d.lastSeenAt).getTime() : 0
    d.online = Date.now() - last < 5 * 60 * 1000
  }

  return { code: 0, data: devices }
}

/**
 * 绑定设备
 * 真实场景：药盒机身贴有 6 位绑定码，子女输入绑定码完成绑定。
 * 调试场景：bindCode 随便填，deviceId 缺省用绑定码，便于无硬件时先跑通流程。
 */
async function bind(openid, event) {
  const bindCode = String(event.bindCode || '').trim().toUpperCase()
  if (!bindCode) return { code: 400, msg: '请输入绑定码' }

  const deviceId = event.deviceId || `BOX-${bindCode}`

  const dup = await db.collection('devices').where({ deviceId }).limit(1).get()
  if (dup.data.length > 0) {
    const owner = dup.data[0].ownerOpenid
    if (owner === openid) return { code: 400, msg: '你已经绑定过这台药盒了' }
    return { code: 400, msg: '这台药盒已被其他账号绑定' }
  }

  if (event.elderId) {
    const elder = await db.collection('elders').doc(event.elderId).get().catch(() => null)
    if (!elder || !elder.data) return { code: 404, msg: '绑定的老人档案不存在' }
    if (elder.data._openid !== openid) return { code: 403, msg: '无权关联该档案' }
  }

  const res = await db.collection('devices').add({
    data: {
      deviceId,
      bindCode,
      name: event.name || '智能药盒',
      ownerOpenid: openid,
      elderId: event.elderId || '',
      bays: emptyBays(event.bayCount || DEFAULT_BAY_COUNT),
      battery: null,
      firmware: '',
      online: false,
      lastSeenAt: null,
      createdAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  })

  return { code: 0, data: { _id: res._id, deviceId } }
}

async function unbind(openid, id) {
  if (!id) return { code: 400, msg: '缺少 id' }
  await assertOwner(id, openid)

  // 同时停用该设备下的所有计划，避免残留数据继续参与统计
  await db.collection('plans')
    .where({ deviceId: id, active: true })
    .update({ data: { active: false, updatedAt: db.serverDate() } })

  await db.collection('devices').doc(id).remove()
  return { code: 0, data: { _id: id } }
}

/** 更新药仓配置：每个仓放什么药、播报什么语音 */
async function updateBays(openid, event) {
  if (!event.id) return { code: 400, msg: '缺少设备 id' }
  await assertOwner(event.id, openid)

  const bays = Array.isArray(event.bays) ? event.bays : null
  if (!bays) return { code: 400, msg: '药仓配置格式错误' }

  await db.collection('devices').doc(event.id).update({
    data: {
      bays: bays.map((b, i) => ({
        index: typeof b.index === 'number' ? b.index : i,
        label: b.label || `${i + 1}号仓`,
        medicineName: b.medicineName || '',
        customVoice: b.customVoice || ''
      })),
      updatedAt: db.serverDate()
    }
  })

  return { code: 0, data: { _id: event.id } }
}

/**
 * 设备心跳：硬件端定时上报电量与在线状态。
 *
 * 由药盒通过云函数 HTTP 触发调用，走 deviceId + token 鉴权（设备没有 OPENID）。
 * 与 record.report / plan.listForDevice 使用同一个 DEVICE_TOKEN。
 *
 * ⚠️ token 目前是固定占位方案，正式做法是设备密钥签名，见 record 云函数的说明。
 */
async function heartbeat(event) {
  const { deviceId, battery, firmware, token } = event
  if (!deviceId) return { code: 400, msg: '缺少 deviceId' }

  const EXPECTED = process.env.DEVICE_TOKEN || 'zhihyao-dev-token'
  if (token !== EXPECTED) {
    console.warn('[device] 设备鉴权失败', deviceId)
    return { code: 403, msg: '设备鉴权失败' }
  }

  const found = await db.collection('devices').where({ deviceId }).limit(1).get()
  if (found.data.length === 0) return { code: 404, msg: '设备未注册' }

  const patch = { lastSeenAt: db.serverDate(), online: true, updatedAt: db.serverDate() }
  if (typeof battery === 'number') patch.battery = battery
  if (firmware) patch.firmware = firmware

  await db.collection('devices').doc(found.data[0]._id).update({ data: patch })
  return { code: 0, data: { deviceId } }
}
