// 云函数调用封装
// 统一处理：等待登录完成、剥离 result 包装、错误提示

/**
 * 调用云函数。
 * @param {string} name    云函数名
 * @param {object} data    参数（需含 action）
 * @param {object} options { silent: 不弹错误提示 }
 * @returns {Promise<any>} 成功时 resolve 云函数的 data 字段
 */
function call(name, data = {}, options = {}) {
  const { silent = false } = options
  // 延迟取 app：模块加载时 App() 可能还没执行完
  const app = getApp()

  return app.ready()
    .then(() => wx.cloud.callFunction({ name, data }))
    .then(res => {
      const r = res.result || {}
      if (r.code !== 0) {
        const err = new Error(r.msg || `调用 ${name} 失败`)
        err.code = r.code
        throw err
      }
      return r.data
    })
    .catch(err => {
      console.error(`[api] ${name} ${data.action || ''}`, err)
      if (!silent) {
        wx.showToast({
          title: err.message || '网络异常，请重试',
          icon: 'none',
          duration: 2500
        })
      }
      throw err
    })
}

// ── 各模块的语义化封装 ──────────────────────────────

const elder = {
  list: () => call('elder', { action: 'list' }),
  save: (data) => call('elder', { action: 'save', data }),
  remove: (id) => call('elder', { action: 'delete', id })
}

const device = {
  list: () => call('device', { action: 'list' }),
  bind: (bindCode, elderId, name) => call('device', { action: 'bind', bindCode, elderId, name }),
  unbind: (id) => call('device', { action: 'unbind', id }),
  updateBays: (id, bays) => call('device', { action: 'updateBays', id, bays })
}

const plan = {
  list: (deviceId, activeOnly) => call('plan', { action: 'list', deviceId, activeOnly }),
  save: (data) => call('plan', { action: 'save', data }),
  remove: (id) => call('plan', { action: 'delete', id }),
  toggle: (id, active) => call('plan', { action: 'toggle', id, active })
}

const record = {
  list: (params) => call('record', { action: 'list', ...params }),
  saveManual: (params) => call('record', { action: 'saveManual', ...params }),
  syncMissed: (days = 7) => call('record', { action: 'syncMissed', days }, { silent: true }),
  // 模拟上报：没有硬件时演示完整流程用。
  // 走用户登录态（OPENID）而不是设备令牌 —— 客户端代码可被反编译，
  // 把设备令牌放进小程序等于公开它。
  simulateReport: (params) => call('record', { action: 'simulateReport', ...params })
}

const dashboard = {
  summary: () => call('dashboard', { action: 'summary' })
}

const analytics = {
  adherence: (days = 7, elderId) => call('analytics', { action: 'adherence', days, elderId }),
  checkStock: (deviceId) => call('analytics', { action: 'checkStock', deviceId }, { silent: true }),
  alerts: (params = {}) => call('analytics', { action: 'alerts', ...params }),
  readAlert: (id) => call('analytics', { action: 'readAlert', id }),
  readAllAlerts: () => call('analytics', { action: 'readAllAlerts' })
}

const notify = {
  addQuota: (accepted) => call('notify', { action: 'addQuota', accepted }),
  getQuota: () => call('notify', { action: 'getQuota' }, { silent: true }),
  // 手动触发一次推送扫描，调试用
  sendPending: () => call('notify', { action: 'sendPending' }, { silent: true })
}

module.exports = { call, elder, device, plan, record, dashboard, analytics, notify }
