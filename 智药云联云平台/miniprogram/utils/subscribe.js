// 订阅消息授权
//
// 微信的「一次性订阅消息」规则：用户每授权一次，开发者获得 1 次推送机会。
// 授权额度会被消耗，所以要在用户每次打开小程序时提醒他补充，
// 否则漏服了却推不出去 —— 那是这个功能最不能失效的时刻。
//
// ┌──────────────────────────────────────────────────────┐
// │ 申请到模板后，把模板 ID 填到下面的 TEMPLATE_IDS 里      │
// └──────────────────────────────────────────────────────┘

const api = require('./api')

// 订阅消息模板 ID（小程序后台 → 订阅消息 → 我的模板）
// 可填多个，requestSubscribeMessage 会一次性让用户全部勾选
const TEMPLATE_IDS = ['aN68Y67LW9U8UXyLLKF17rYc5c5yEbCHUJ9yPUZFQlk']

const isConfigured = () => TEMPLATE_IDS.length > 0 && TEMPLATE_IDS[0] !== 'YOUR_TEMPLATE_ID'

/**
 * 发起订阅授权。
 * @returns {Promise<{accepted: string[], quota: number}>}
 *   accepted 为用户点了「允许」的模板 ID 列表
 */
function request() {
  if (!isConfigured()) {
    return Promise.reject(new Error('还没配置订阅消息模板 ID'))
  }

  return new Promise((resolve, reject) => {
    wx.requestSubscribeMessage({
      tmplIds: TEMPLATE_IDS,
      success: res => {
        // res 形如 { errMsg, [templateId]: 'accept' | 'reject' | 'ban' }
        const accepted = TEMPLATE_IDS.filter(id => res[id] === 'accept')
        if (accepted.length === 0) {
          resolve({ accepted: [], quota: 0, rejected: true })
          return
        }
        // 授权成功就把额度记到云端
        api.notify.addQuota(accepted)
          .then(data => resolve({ accepted, quota: data.quota }))
          .catch(reject)
      },
      fail: err => {
        // 用户关闭授权弹窗不算错误，给个温和的返回
        if (err && /cancel/i.test(err.errMsg || '')) {
          resolve({ accepted: [], quota: 0, cancelled: true })
          return
        }
        reject(new Error((err && err.errMsg) || '订阅授权失败'))
      }
    })
  })
}

/**
 * 查询剩余可推送次数。
 *
 * ⚠️ 查询失败返回 null，**不要返回 0**。
 * 返回 0 会让界面显示「额度用完了，父母漏服你不会收到通知」——
 * 一个接口故障被伪装成了紧急的业务告警，是吓唬人也是误导。
 * 调用方按 null 显示「查询失败」。
 */
function quota() {
  if (!isConfigured()) return Promise.resolve(null)
  return api.notify.getQuota()
    .then(d => (typeof d.quota === 'number' ? d.quota : null))
    .catch(() => null)
}

/** 额度低于这个值时提示用户补充 */
const LOW_QUOTA = 2

module.exports = { request, quota, isConfigured, LOW_QUOTA }
