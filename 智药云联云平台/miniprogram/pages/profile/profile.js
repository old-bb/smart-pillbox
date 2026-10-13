// 我的：老人档案与设置
const api = require('../../utils/api')
const subscribe = require('../../utils/subscribe')
const { CONDITION_OPTIONS } = require('../../utils/constants')

function emptyForm() {
  return { _id: '', name: '', age: '', gender: 'unknown', conditions: [], note: '' }
}

Page({
  data: {
    loading: true,
    elders: [],
    conditions: CONDITION_OPTIONS,

    showEditor: false,
    form: emptyForm(),
    submitting: false,

    openid: '',
    alertCount: 0,

    // 订阅消息推送
    notifyConfigured: false,
    notifyQuota: 0,
    notifyLow: false
  },

  onShow() {
    this.setData({ openid: getApp().globalData.openid || '' })
    this.load()
    this.loadQuota()
  },

  loadQuota() {
    this.setData({ notifyConfigured: subscribe.isConfigured() })
    return subscribe.quota().then(q => {
      this.setData({ notifyQuota: q, notifyLow: q <= subscribe.LOW_QUOTA })
    })
  },

  /** 开启/补充用药提醒推送 */
  onEnableNotify() {
    if (!this.data.notifyConfigured) {
      wx.showModal({
        title: '还没配置模板',
        content: '请先到小程序后台申请订阅消息模板，把模板 ID 填到 miniprogram/utils/subscribe.js',
        showCancel: false
      })
      return
    }

    subscribe.request()
      .then(res => {
        if (res.rejected) {
          wx.showModal({
            title: '没开启成功',
            content: '你刚才点了「拒绝」。漏服提醒对你可能很重要，建议重新开启一次。',
            confirmText: '再试一次',
            success: r => { if (r.confirm) this.onEnableNotify() }
          })
          return
        }
        if (res.cancelled) return
        wx.showToast({ title: `已增加 ${res.accepted.length} 次提醒额度`, icon: 'none' })
        this.setData({ notifyQuota: res.quota, notifyLow: res.quota <= subscribe.LOW_QUOTA })
      })
      .catch(err => {
        wx.showToast({ title: err.message || '开启失败', icon: 'none' })
      })
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    this.setData({ loading: true })
    return Promise.all([
      api.elder.list(),
      api.analytics.alerts({ pageSize: 1, onlyUnread: true }).catch(() => null)
    ]).then(([elders, alerts]) => {
      this.setData({
        loading: false,
        elders,
        alertCount: alerts ? alerts.unread : 0
      })
    }).catch(() => this.setData({ loading: false }))
  },

  // ── 档案编辑 ──────────────────────────────────

  onAdd() {
    this.setData({ showEditor: true, form: emptyForm() })
  },

  onEdit(e) {
    const elder = this.data.elders.find(x => x._id === e.currentTarget.dataset.id)
    if (!elder) return
    this.setData({
      showEditor: true,
      form: {
        _id: elder._id,
        name: elder.name || '',
        age: elder.age || '',
        gender: elder.gender || 'unknown',
        conditions: (elder.conditions || []).slice(),
        note: elder.note || ''
      }
    })
  },

  onCloseEditor() {
    this.setData({ showEditor: false })
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: e.detail.value })
  },

  onGenderTap(e) {
    this.setData({ 'form.gender': e.currentTarget.dataset.value })
  },

  onConditionTap(e) {
    const value = e.currentTarget.dataset.value
    const list = this.data.form.conditions.slice()
    const i = list.indexOf(value)
    if (i >= 0) list.splice(i, 1)
    else list.push(value)
    this.setData({ 'form.conditions': list })
  },

  onSubmit() {
    const f = this.data.form
    if (!f.name.trim()) return wx.showToast({ title: '请填写姓名', icon: 'none' })
    if (this.data.submitting) return

    this.setData({ submitting: true })
    api.elder.save({
      _id: f._id || undefined,
      name: f.name.trim(),
      age: f.age,
      gender: f.gender,
      conditions: f.conditions,
      note: f.note
    }).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' })
      this.setData({ showEditor: false, submitting: false })
      this.load()
    }).catch(() => this.setData({ submitting: false }))
  },

  onDelete(e) {
    wx.showModal({
      title: '删除档案',
      content: '删除后关联的药盒会解除绑定，历史记录保留。确定删除吗？',
      confirmColor: '#D9534F',
      success: r => {
        if (!r.confirm) return
        api.elder.remove(e.currentTarget.dataset.id).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' })
          this.load()
        }).catch(() => {})
      }
    })
  },

  onCopyOpenid() {
    if (!this.data.openid) return
    wx.setClipboardData({
      data: this.data.openid,
      success: () => wx.showToast({ title: '已复制', icon: 'none' })
    })
  },

  onAbout() {
    wx.showModal({
      title: '关于本项目',
      content: '银发守护·智药云联\n面向老年人的离线语音智能药盒及云平台\n\n项目编号 202610042210\n国际关系学院 大学生创新创业训练计划',
      showCancel: false
    })
  },

  noop() {}
})
