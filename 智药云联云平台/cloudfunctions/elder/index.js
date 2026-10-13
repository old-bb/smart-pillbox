// 云函数：elder
// 作用：老人档案的增删改查。所有操作限定在调用者自己的数据范围内。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

/** 校验档案归属，防止越权操作他人数据 */
async function assertOwner(id, openid) {
  const res = await db.collection('elders').doc(id).get().catch(() => null)
  if (!res || !res.data) {
    const err = new Error('档案不存在')
    err.code = 404
    throw err
  }
  if (res.data._openid !== openid) {
    const err = new Error('无权操作该档案')
    err.code = 403
    throw err
  }
  return res.data
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const { action } = event

  if (!OPENID) return { code: 401, msg: '未登录' }

  try {
    switch (action) {
      case 'list':
        return await list(OPENID)
      case 'save':
        return await save(OPENID, event.data || {})
      case 'delete':
        return await remove(OPENID, event.id)
      default:
        return { code: 400, msg: `未知 action: ${action}` }
    }
  } catch (err) {
    console.error('[elder]', action, err)
    return { code: err.code || 500, msg: err.message }
  }
}

async function list(openid) {
  const res = await db.collection('elders')
    .where({ _openid: openid })
    .orderBy('createdAt', 'asc')
    .get()

  // 顺带把每个老人的设备数带出来，前端一次拿全
  const elders = res.data
  for (const e of elders) {
    const cnt = await db.collection('devices').where({ elderId: e._id, ownerOpenid: openid }).count()
    e.deviceCount = cnt.total
  }

  return { code: 0, data: elders }
}

async function save(openid, data) {
  const { _id, name } = data
  if (!name || !String(name).trim()) {
    return { code: 400, msg: '请填写老人姓名' }
  }

  const doc = {
    name: String(name).trim(),
    age: Number(data.age) || null,
    gender: data.gender || 'unknown',
    // 慢性病标签，如 ['高血压', '糖尿病']
    conditions: Array.isArray(data.conditions) ? data.conditions : [],
    note: data.note || '',
    updatedAt: db.serverDate()
  }

  if (_id) {
    await assertOwner(_id, openid)
    await db.collection('elders').doc(_id).update({ data: doc })
    return { code: 0, data: { _id } }
  }

  doc._openid = openid
  doc.createdAt = db.serverDate()
  const res = await db.collection('elders').add({ data: doc })
  return { code: 0, data: { _id: res._id } }
}

async function remove(openid, id) {
  if (!id) return { code: 400, msg: '缺少 id' }
  await assertOwner(id, openid)

  // 解绑该老人名下的设备（不删设备记录，只解除关联）
  await db.collection('devices')
    .where({ elderId: id, ownerOpenid: openid })
    .update({ data: { elderId: '', updatedAt: db.serverDate() } })

  await db.collection('elders').doc(id).remove()
  return { code: 0, data: { _id: id } }
}
