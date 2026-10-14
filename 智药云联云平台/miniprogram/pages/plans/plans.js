// 用药计划管理
const api = require('../../utils/api')
const { MEAL_RELATIONS, BAY_COUNT } = require('../../utils/constants')
const fmt = require('../../utils/format')

function emptyForm() {
  return {
    _id: '',
    deviceId: '',
    bayIndex: -1,
    medicineName: '',
    perDose: 1,
    dosageText: '',
    times: ['08:00'],
    mealRelation: '饭后',
    stock: 30,
    note: ''
  }
}

Page({
  data: {
    loading: true,
    error: '',
    plans: [],
    devices: [],
    mealRelations: MEAL_RELATIONS,

    // 编辑面板
    showEditor: false,
    form: emptyForm(),
    bayOptions: [],
    submitting: false,
    dailyHint: 0,
    daysHint: '—'
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    this.setData({ loading: true, error: '' })
    return Promise.all([api.plan.list(), api.device.list()])
      .then(([plans, devices]) => {
        this.setData({
          loading: false,
          error: '',
          devices,
          // 传 devices 进去，此时 this.data.devices 还是旧值
          plans: plans.map(p => this.decorate(p, devices))
        })
      })
      .catch(err => {
        // 加载失败要显式报错，不能落进「还没有用药计划」的空状态
        this.setData({ loading: false, error: (err && err.message) || '加载失败' })
      })
  },

  onRetry() {
    this.load()
  },

  decorate(p, devices) {
    const st = fmt.stockText(p.remainingDays)
    const dev = (devices || []).find(d => d._id === p.deviceId)
    return {
      ...p,
      timesText: (p.times || []).join(' · '),
      stockText: st.text,
      stockLevel: st.level,
      deviceName: dev ? dev.name : ''
    }
  },

  // ── 编辑面板 ──────────────────────────────────

  onAdd() {
    if (this.data.devices.length === 0) {
      wx.showModal({
        title: '请先绑定药盒',
        content: '用药计划需要关联到具体的药盒和药仓',
        confirmText: '去绑定',
        success: r => { if (r.confirm) wx.switchTab({ url: '/pages/device/device' }) }
      })
      return
    }

    const device = this.data.devices[0]
    const form = emptyForm()
    form.deviceId = device._id

    this.setData({
      showEditor: true,
      form,
      bayOptions: this.buildBayOptions(form.deviceId, -1)
    }, () => this.recomputeHint())
  },

  onEdit(e) {
    const plan = this.data.plans.find(p => p._id === e.currentTarget.dataset.id)
    if (!plan) return

    this.setData({
      showEditor: true,
      form: {
        _id: plan._id,
        deviceId: plan.deviceId,
        bayIndex: plan.bayIndex,
        medicineName: plan.medicineName,
        perDose: plan.perDose || 1,
        dosageText: plan.dosageText || '',
        times: (plan.times || []).slice(),
        mealRelation: plan.mealRelation || '不限',
        stock: plan.stock || 0,
        note: plan.note || ''
      },
      bayOptions: this.buildBayOptions(plan.deviceId, plan.bayIndex)
    }, () => this.recomputeHint())
  },

  onCloseEditor() {
    this.setData({ showEditor: false })
  },

  /** 把设备的药仓转成可选列表，标记出已被其他计划占用的仓 */
  buildBayOptions(deviceId, currentBay) {
    const device = this.data.devices.find(d => d._id === deviceId)
    const bayCount = (device && device.bays && device.bays.length) || BAY_COUNT
    const opts = []

    for (let i = 0; i < bayCount; i++) {
      const occupying = this.data.plans.find(
        p => p.deviceId === deviceId && p.bayIndex === i && p.active && p.bayIndex !== currentBay
      )
      opts.push({
        index: i,
        label: `${i + 1} 号仓`,
        disabled: !!occupying,
        hint: occupying ? `已放 ${occupying.medicineName}` : ''
      })
    }
    return opts
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`form.${field}`]: e.detail.value }, () => this.recomputeHint())
  },

  /** 实时算「每日消耗 / 可支撑天数」，避免在 WXML 里做除法出现长小数 */
  recomputeHint() {
    const f = this.data.form
    const perDose = Number(f.perDose) || 0
    const daily = perDose * (f.times || []).length
    const stock = Number(f.stock) || 0
    const days = daily > 0 ? Math.floor(stock / daily) : 0

    this.setData({
      dailyHint: daily,
      daysHint: daily > 0 ? days : '—'
    })
  },

  onBaySelect(e) {
    const index = Number(e.currentTarget.dataset.index)
    const opt = this.data.bayOptions.find(o => o.index === index)
    if (!opt || opt.disabled) return

    const form = { ...this.data.form, bayIndex: index }
    // 药仓上已有药品名时自动带出，减少重复输入
    const device = this.data.devices.find(d => d._id === form.deviceId)
    if (device && device.bays && device.bays[index] && device.bays[index].medicineName) {
      if (!form.medicineName) form.medicineName = device.bays[index].medicineName
    }
    this.setData({ form })
  },

  onDeviceChange(e) {
    const idx = Number(e.detail.value)
    const device = this.data.devices[idx]
    if (!device) return

    const form = { ...this.data.form, deviceId: device._id, bayIndex: -1 }
    this.setData({ form, bayOptions: this.buildBayOptions(device._id, -1) })
  },

  onMealChange(e) {
    this.setData({ 'form.mealRelation': MEAL_RELATIONS[Number(e.detail.value)] })
  },

  // ── 服药时间 ──────────────────────────────────

  onTimeChange(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const times = this.data.form.times.slice()
    times[idx] = e.detail.value
    this.setData({ 'form.times': times })
  },

  onAddTime() {
    if (this.data.form.times.length >= 6) {
      wx.showToast({ title: '最多 6 个时间点', icon: 'none' })
      return
    }
    this.setData(
      { 'form.times': this.data.form.times.concat(['12:00']) },
      () => this.recomputeHint()
    )
  },

  onRemoveTime(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const times = this.data.form.times.slice()
    if (times.length <= 1) {
      wx.showToast({ title: '至少保留一个时间点', icon: 'none' })
      return
    }
    times.splice(idx, 1)
    this.setData({ 'form.times': times }, () => this.recomputeHint())
  },

  // ── 提交 ──────────────────────────────────────

  onSubmit() {
    const f = this.data.form
    if (f.bayIndex < 0) return wx.showToast({ title: '请选择药仓', icon: 'none' })
    if (!f.medicineName.trim()) return wx.showToast({ title: '请填写药品名称', icon: 'none' })
    if (this.data.submitting) return

    this.setData({ submitting: true })

    api.plan.save({
      _id: f._id || undefined,
      deviceId: f.deviceId,
      bayIndex: f.bayIndex,
      medicineName: f.medicineName.trim(),
      perDose: Number(f.perDose) || 1,
      dosageText: f.dosageText || `${Number(f.perDose) || 1}片`,
      times: f.times,
      mealRelation: f.mealRelation,
      stock: Number(f.stock) || 0,
      note: f.note
    }).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' })
      this.setData({ showEditor: false, submitting: false })
      this.load()
    }).catch(() => {
      this.setData({ submitting: false })
    })
  },

  onToggle(e) {
    const id = e.currentTarget.dataset.id
    const active = e.currentTarget.dataset.active
    api.plan.toggle(id, !active)
      .then(() => this.load())
      .catch(() => {})
  },

  onDelete(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '删除计划',
      content: '删除后该药品的提醒和统计都会停止，历史记录会保留。确定删除吗？',
      confirmColor: '#D9534F',
      success: r => {
        if (!r.confirm) return
        api.plan.remove(id).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' })
          this.load()
        }).catch(() => {})
      }
    })
  },

  /**
   * 补药入口。
   *
   * ⚠️ 计划书里写的是「一键下单，28分钟送药到家」，但美团买药 / 京东药急送
   *    的开放 API 不对个人开发者开放，需要企业资质走商务合作才能对接。
   *    中期阶段先用「复制药名」把最关键的一步（准确写出药品名）解决掉，
   *    用户粘到外卖 App 里搜，比手打药名可靠得多 —— 药名打错一个字的后果很严重。
   *
   *    等拿到企业主体和商务合作后，把这里换成 wx.navigateToMiniProgram。
   */
  onRestock(e) {
    const plan = this.data.plans.find(p => p._id === e.currentTarget.dataset.id)
    if (!plan) return

    const text = `${plan.medicineName} ${plan.dosageText || ''}`.trim()

    wx.showActionSheet({
      itemList: [`复制药名：${plan.medicineName}`, '怎么买？'],
      success: r => {
        if (r.tapIndex === 0) {
          wx.setClipboardData({
            data: text,
            success: () => {
              wx.showModal({
                title: '药名已复制',
                content: '打开美团 / 京东，粘贴搜索即可下单到父母家。\n\n注意核对规格和厂家，不同厂家的同名药含量可能不同。',
                showCancel: false,
                confirmText: '知道了'
              })
            }
          })
        } else {
          wx.showModal({
            title: '为什么不能一键下单',
            content: '外卖平台的售药接口不面向个人开发者开放，需要企业资质洽谈合作。\n\n当前版本先把最容易出错的环节（准确写出药品名）解决掉，下单仍在外卖 App 完成。',
            showCancel: false
          })
        }
      },
      fail: () => {}
    })
  },

  onMaskTap() {
    this.setData({ showEditor: false })
  },

  // 阻止面板内的点击冒泡到遮罩
  noop() {}
})
