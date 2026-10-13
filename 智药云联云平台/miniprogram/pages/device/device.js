// 药盒设备管理
const api = require('../../utils/api')
const { BAY_COUNT } = require('../../utils/constants')
const fmt = require('../../utils/format')

Page({
  data: {
    loading: true,
    devices: [],
    elders: [],

    // 绑定面板
    showBind: false,
    bindCode: '',
    bindElderIndex: 0,
    binding: false,

    // 药仓配置面板
    showBays: false,
    bayDevice: null,
    bayList: []
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    this.setData({ loading: true })
    return Promise.all([api.device.list(), api.elder.list()])
      .then(([devices, elders]) => {
        this.setData({
          loading: false,
          elders,
          devices: devices.map(d => ({
            ...d,
            batteryText: fmt.batteryText(d.battery),
            lastSeenText: d.lastSeenAt ? fmt.fromNow(d.lastSeenAt) : '从未上报',
            elderName: (elders.find(e => e._id === d.elderId) || {}).name || ''
          }))
        })
      })
      .catch(() => this.setData({ loading: false }))
  },

  // ── 绑定 ──────────────────────────────────────

  onOpenBind() {
    this.setData({ showBind: true, bindCode: '', bindElderIndex: 0 })
  },

  onCloseBind() {
    this.setData({ showBind: false })
  },

  onBindCodeInput(e) {
    this.setData({ bindCode: e.detail.value.toUpperCase() })
  },

  onElderChange(e) {
    this.setData({ bindElderIndex: Number(e.detail.value) })
  },

  onBindSubmit() {
    const code = this.data.bindCode.trim()
    if (!code) return wx.showToast({ title: '请输入绑定码', icon: 'none' })
    if (this.data.binding) return

    const elder = this.data.elders[this.data.bindElderIndex]
    this.setData({ binding: true })

    api.device.bind(code, elder ? elder._id : '', `药盒 ${code}`)
      .then(() => {
        wx.showToast({ title: '绑定成功', icon: 'success' })
        this.setData({ showBind: false, binding: false })
        this.load()
      })
      .catch(() => this.setData({ binding: false }))
  },

  onUnbind(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '解绑药盒',
      content: '解绑后该药盒上的用药计划会全部停用，历史服药记录仍会保留。',
      confirmColor: '#D9534F',
      success: r => {
        if (!r.confirm) return
        api.device.unbind(id).then(() => {
          wx.showToast({ title: '已解绑', icon: 'success' })
          this.load()
        }).catch(() => {})
      }
    })
  },

  // ── 药仓配置 ──────────────────────────────────

  onOpenBays(e) {
    const device = this.data.devices.find(d => d._id === e.currentTarget.dataset.id)
    if (!device) return

    const bays = device.bays && device.bays.length
      ? device.bays.map(b => ({ ...b }))
      : Array.from({ length: BAY_COUNT }, (_, i) => ({
          index: i, label: `${i + 1}号仓`, medicineName: '', customVoice: ''
        }))

    this.setData({ showBays: true, bayDevice: device, bayList: bays })
  },

  onCloseBays() {
    this.setData({ showBays: false })
  },

  onBayMedicineInput(e) {
    const idx = Number(e.currentTarget.dataset.index)
    this.setData({ [`bayList[${idx}].medicineName`]: e.detail.value })
  },

  onBayVoiceInput(e) {
    const idx = Number(e.currentTarget.dataset.index)
    this.setData({ [`bayList[${idx}].customVoice`]: e.detail.value })
  },

  onSaveBays() {
    const device = this.data.bayDevice
    if (!device) return

    api.device.updateBays(device._id, this.data.bayList)
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'success' })
        this.setData({ showBays: false })
        this.load()
      })
      .catch(() => {})
  },

  // ── 开发调试：模拟设备上报，没有硬件也能验证全链路 ──
  //
  // ⚠️ 上线前必须删除这个功能，并且换掉服务端 DEVICE_TOKEN。
  // 客户端代码是可被反编译的，token 写在客户端等于公开。
  // 正式方案：设备端用密钥对上报内容签名，服务端验签（由肖開太设计）。

  onSimulate(e) {
    const device = this.data.devices.find(d => d._id === e.currentTarget.dataset.id)
    if (!device) return

    const bays = device.bays || []
    const items = bays.map(b => `${b.index + 1}号仓：${b.medicineName || '（空）'}`)

    wx.showActionSheet({
      itemList: items.length ? items : ['该药盒还没有配置药仓'],
      success: r => {
        if (r.tapIndex === undefined || !bays[r.tapIndex]) return
        this.reportSimulated(device.deviceId, bays[r.tapIndex].index)
      },
      fail: () => {}
    })
  },

  reportSimulated(deviceId, bayIndex) {
    wx.showLoading({ title: '上报中…' })
    api.record.report({
      deviceId,
      bayIndex,
      eventType: 'vision_confirmed',
      token: 'zhihyao-dev-token'
    }).then(data => {
      wx.hideLoading()
      if (data && data.ignored) {
        wx.showModal({
          title: '没有匹配的计划',
          content: data.reason + '\n请先到「用药」页给这个药仓添加计划。',
          showCancel: false
        })
        return
      }
      const labels = { on_time: '按时', early: '提前', late: '延迟', missed: '漏服' }
      if (data.duplicate) {
        wx.showToast({ title: `该时点已有记录（${labels[data.status] || data.status}）`, icon: 'none' })
        return
      }
      wx.showToast({
        title: `已记录：${labels[data.status] || data.status}`,
        icon: 'success'
      })
    }).catch(() => wx.hideLoading())
  },

  noop() {}
})
