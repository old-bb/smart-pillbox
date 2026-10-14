// 云函数：plan
// 作用：用药计划的增删改查。计划是依从性统计与库存预警的数据源头。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const MEAL_RELATIONS = ['饭前', '饭后', '随餐', '空腹', '睡前', '不限']

/** 校验 plan 归属 */
async function assertOwner(id, openid) {
  const res = await db.collection('plans').doc(id).get().catch(() => null)
  if (!res || !res.data) {
    const err = new Error('计划不存在')
    err.code = 404
    throw err
  }
  if (res.data.ownerOpenid !== openid) {
    const err = new Error('无权操作该计划')
    err.code = 403
    throw err
  }
  return res.data
}

/** 校验设备归属 */
async function assertDevice(deviceId, openid) {
  const res = await db.collection('devices').doc(deviceId).get().catch(() => null)
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

/** "08:30" → 510（当日分钟数），用于排序 */
function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { action } = event

  try {
    // 药盒设备拉取自己的用药计划。走设备 token 鉴权，不需要用户登录
    if (action === 'listForDevice') {
      return await listForDevice(event)
    }

    if (!OPENID) return { code: 401, msg: '未登录' }

    switch (action) {
      case 'list':
        return await list(OPENID, event)
      case 'save':
        return await save(OPENID, event.data || {})
      case 'delete':
        return await remove(OPENID, event.id)
      case 'toggle':
        return await toggle(OPENID, event.id, event.active)
      default:
        return { code: 400, msg: `未知 action: ${action}` }
    }
  } catch (err) {
    console.error('[plan]', action, err)
    return { code: err.code || 500, msg: err.message }
  }
}

/**
 * 药盒设备拉取自己的用药计划。
 *
 * 硬件端定时调用，拿到计划后才知道什么时候该提醒哪个药仓。
 * 用 deviceId + token 鉴权 —— 设备没有微信身份，拿不到 OPENID。
 *
 * ⚠️ token 目前是固定占位方案，正式做法是设备密钥签名，见 record 云函数的说明。
 */
async function listForDevice(event) {
  const { deviceId, token } = event
  if (!deviceId) return { code: 400, msg: '缺少 deviceId' }

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
    console.error('[plan] 未配置 DEVICE_TOKEN 环境变量，拒绝所有设备请求')
    return { code: 500, msg: '服务端未配置设备令牌' }
  }
  if (token !== EXPECTED) {
    console.warn('[plan] 设备鉴权失败', deviceId)
    return { code: 403, msg: '设备鉴权失败' }
  }

  const devRes = await db.collection('devices').where({ deviceId }).limit(1).get()
  if (devRes.data.length === 0) return { code: 404, msg: '设备未注册' }
  const device = devRes.data[0]

  const res = await db.collection('plans')
    .where({ deviceId: device._id, active: true })
    .orderBy('bayIndex', 'asc')
    .get()

  return {
    code: 0,
    data: {
      deviceId: device._id,
      bayCount: (device.bays || []).length,
      list: res.data.map(decorate)
    }
  }
}

async function list(openid, event) {
  const where = { ownerOpenid: openid }
  if (event.deviceId) where.deviceId = event.deviceId
  if (event.activeOnly) where.active = true

  const res = await db.collection('plans')
    .where(where)
    .orderBy('bayIndex', 'asc')
    .get()

  // 计算派生字段供前端展示
  const plans = res.data.map(p => decorate(p))

  return { code: 0, data: plans }
}

/** 补上剩余天数等派生字段 */
function decorate(p) {
  const stock = Number(p.stock) || 0
  const daily = Number(p.dailyConsumption) || 0
  p.remainingDays = daily > 0 ? Math.floor(stock / daily) : null
  p.lowStock = p.remainingDays !== null && p.remainingDays <= 7
  p.times = (p.times || []).slice().sort((a, b) => toMinutes(a) - toMinutes(b))
  return p
}

async function save(openid, data) {
  const { _id, deviceId, bayIndex, medicineName, times } = data

  // 归属校验必须排在参数校验前面：越权请求应当在第一步就被拒掉，
  // 而不是先经过一堆参数规则、再从后面的分支里返回。
  if (_id) await assertOwner(_id, openid)

  if (!deviceId) return { code: 400, msg: '请选择药盒设备' }
  if (!medicineName || !String(medicineName).trim()) return { code: 400, msg: '请填写药品名称' }
  if (!Array.isArray(times) || times.length === 0) return { code: 400, msg: '至少设置一个服药时间' }
  if (typeof bayIndex !== 'number' || bayIndex < 0) return { code: 400, msg: '请选择药仓' }

  await assertDevice(deviceId, openid)

  const perDose = Number(data.perDose) || 1
  const validTimes = times
    .filter(t => /^\d{1,2}:\d{2}$/.test(t))
    .map(t => t.padStart(5, '0'))
  if (validTimes.length === 0) return { code: 400, msg: '服药时间格式应为 HH:mm' }

  const doc = {
    deviceId,
    bayIndex,
    medicineName: String(medicineName).trim(),
    dosageText: data.dosageText || `${perDose}片`,
    perDose,
    times: validTimes,
    // 每日消耗量 = 每次用量 × 每日次数，用于库存预警
    dailyConsumption: perDose * validTimes.length,
    mealRelation: MEAL_RELATIONS.includes(data.mealRelation) ? data.mealRelation : '不限',
    stock: Number(data.stock) || 0,
    // 药盒上播报的语音文本，留空则由云端按模板生成
    voiceText: data.voiceText || '',
    note: data.note || '',
    active: data.active !== false,
    updatedAt: db.serverDate()
  }

  if (_id) {
    await db.collection('plans').doc(_id).update({ data: doc })
    return { code: 0, data: { _id } }
  }

  // 同一药仓不允许有两个并存的有效计划，否则提醒会打架
  const clash = await db.collection('plans')
    .where({ deviceId, bayIndex, active: true })
    .count()
  if (clash.total > 0) {
    return { code: 400, msg: `该药仓已有生效中的计划，请先停用或改用其他药仓` }
  }

  doc.ownerOpenid = openid
  doc.createdAt = db.serverDate()
  const res = await db.collection('plans').add({ data: doc })
  return { code: 0, data: { _id: res._id } }
}

async function remove(openid, id) {
  if (!id) return { code: 400, msg: '缺少 id' }
  await assertOwner(id, openid)
  await db.collection('plans').doc(id).remove()
  return { code: 0, data: { _id: id } }
}

async function toggle(openid, id, active) {
  if (!id) return { code: 400, msg: '缺少 id' }
  await assertOwner(id, openid)
  await db.collection('plans').doc(id).update({
    data: { active: !!active, updatedAt: db.serverDate() }
  })
  return { code: 0, data: { _id: id, active: !!active } }
}
