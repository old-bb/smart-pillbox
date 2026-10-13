// 云函数：init
// 作用：一次性创建全部数据库集合。可重复执行（幂等）。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

// 集合名 → 说明
const COLLECTIONS = {
  users: '用户（子女端）',
  elders: '老人档案',
  devices: '药盒设备',
  plans: '用药计划',
  records: '服药记录',
  medicines: '药品字典',
  alerts: '预警消息',
  subscriptions: '订阅消息授权额度'
}

exports.main = async () => {
  const created = []
  const existed = []
  const failed = []

  for (const name of Object.keys(COLLECTIONS)) {
    try {
      await db.createCollection(name)
      created.push(name)
    } catch (err) {
      // -501001 / ResourceExists 表示集合已存在，属正常情况
      if (err.errCode === -501001 || /already exist/i.test(err.errMsg || err.message || '')) {
        existed.push(name)
      } else {
        failed.push({ name, msg: err.errMsg || err.message })
      }
    }
  }

  console.log('[init] created=', created, 'existed=', existed, 'failed=', failed)

  return {
    code: failed.length ? 500 : 0,
    data: {
      created,
      existed,
      failed,
      tip: '创建完成后，请到「云开发控制台 → 数据库」把每个集合的权限设为「仅管理端可读写」'
    }
  }
}
