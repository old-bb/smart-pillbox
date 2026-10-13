// 云函数：login
// 作用：获取用户 openid，首次调用时自动建档
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { OPENID, APPID, UNIONID } = cloud.getWXContext()

  if (!OPENID) {
    return { code: 401, msg: '无法获取 openid' }
  }

  try {
    const users = db.collection('users')
    const found = await users.where({ _openid: OPENID }).limit(1).get()

    if (found.data.length === 0) {
      // 首次登录，建档
      await users.add({
        data: {
          _openid: OPENID,
          nickName: event.nickName || '',
          avatarUrl: event.avatarUrl || '',
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      })
    } else {
      // 已有记录，顺带更新昵称头像（用户可能在授权后改了）
      const patch = { updatedAt: db.serverDate() }
      if (event.nickName) patch.nickName = event.nickName
      if (event.avatarUrl) patch.avatarUrl = event.avatarUrl
      await users.doc(found.data[0]._id).update({ data: patch })
    }

    return { code: 0, data: { openid: OPENID, appid: APPID, unionid: UNIONID } }
  } catch (err) {
    console.error('[login] 失败', err)
    return { code: 500, msg: err.message }
  }
}
