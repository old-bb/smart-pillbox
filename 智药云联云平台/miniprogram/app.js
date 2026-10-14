// 智药云联 · 子女端小程序
App({
  globalData: {
    // 云开发环境 ID（云开发控制台 → 设置 → 环境 ID）
    env: 'cloud1-d4gkyr16k10bd7e23',
    openid: '',
    userInfo: null,
    // 当前选中的老人档案，空字符串表示看全部
    currentElderId: ''
  },

  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({
        title: '基础库版本过低',
        content: '请把微信开发者工具的调试基础库调到 2.2.3 以上再试',
        showCancel: false
      })
      return
    }

    if (this.globalData.env === 'YOUR_ENV_ID') {
      wx.showModal({
        title: '还没配置环境 ID',
        content: '请打开 miniprogram/app.js，把 env 改成你的云开发环境 ID',
        showCancel: false
      })
    }

    // 启动时把环境 ID 打到控制台，连不上云时先看这一行对不对
    console.log('[app] 云开发环境 ID =', this.globalData.env)

    wx.cloud.init({
      env: this.globalData.env,
      traceUser: true
    })

    this.loginPromise = this.login()
  },

  /** 登录并拿到 openid，返回 Promise 供页面 await */
  login() {
    return wx.cloud.callFunction({ name: 'login' })
      .then(res => {
        if (res.result && res.result.code === 0) {
          this.globalData.openid = res.result.data.openid
          return res.result.data.openid
        }
        throw new Error((res.result && res.result.msg) || '登录失败')
      })
      .catch(err => {
        console.error('[app] 登录失败', err)
        wx.showToast({ title: '登录失败，请重试', icon: 'none' })
        throw err
      })
  },

  /** 页面里用：确保登录完成后再发请求 */
  ready() {
    // 失败时必须把缓存的 promise 清掉。
    // 否则它是一个 rejected promise —— 真值，短路逻辑永远返回它，
    // 之后所有页面的「重试」和下拉刷新都会立刻失败，只能重启小程序。
    if (!this.loginPromise) {
      this.loginPromise = this.login().catch(err => {
        this.loginPromise = null
        throw err
      })
    }
    return this.loginPromise
  }
})
