// 首页看板
const api = require('../../utils/api')
const chart = require('../../utils/chart')
const { STATUS_MAP, SOURCE_MAP, levelOf } = require('../../utils/constants')
const fmt = require('../../utils/format')

Page({
  data: {
    loading: true,
    empty: false,
    error: '',
    date: '',
    dateLabel: '',
    devices: [],
    slots: [],
    progress: 0,
    done: 0,
    total: 0,
    next: null,
    adherence: null,
    adherenceLevel: null,
    alerts: []
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load(true).then(() => wx.stopPullDownRefresh())
  },

  load(isRefresh) {
    if (!isRefresh) this.setData({ loading: true, error: '' })

    // 先补写漏服记录，保证看板数据完整；失败不阻塞主流程
    return api.record.syncMissed(7)
      .catch(() => null)
      .then(() => api.dashboard.summary())
      .then(data => {
        if (data.empty) {
          this.setData({ loading: false, empty: true, error: '' })
          return
        }

        const slots = (data.today.slots || []).map(s => {
          const st = STATUS_MAP[s.status] || STATUS_MAP.upcoming
          return {
            ...s,
            // wx:key 需要唯一值：同一计划一天可能有多个时点
            key: `${s.planId}_${s.time}`,
            statusLabel: st.label,
            statusTag: st.tag,
            sourceLabel: s.source ? (SOURCE_MAP[s.source] || '') : ''
          }
        })

        const next = data.today.next
          ? {
              ...data.today.next,
              sourceLabel: data.today.next.source ? (SOURCE_MAP[data.today.next.source] || '') : ''
            }
          : null

        this.setData({
          loading: false,
          empty: false,
          error: '',
          date: data.date,
          dateLabel: fmt.friendlyDate(data.date) + ' ' + data.date,
          devices: data.devices || [],
          slots,
          done: data.today.done,
          total: data.today.total,
          progress: data.today.progress,
          next,
          adherence: data.adherence,
          adherenceLevel: data.adherence ? levelOf(data.adherence.score) : null,
          alerts: (data.alerts || []).map(a => ({
            ...a,
            timeText: fmt.fromNow(a.createdAt)
          }))
        }, () => {
          // 等 setData 落地、canvas 节点真的在 DOM 里了再画，
          // 否则 createSelectorQuery 查不到节点
          const trend = data.adherence && data.adherence.trend
          if (trend && trend.length) {
            chart.drawTrend(this, 'trendCanvas', trend)
          }
        })
      })
      .catch(err => {
        // 请求失败时不要渲染成「空看板」，否则会被误认为是数据问题
        this.setData({
          loading: false,
          error: (err && err.message) || '加载失败'
        })
      })
  },

  onRetry() {
    this.load()
  },

  /** 手动补录：老人服了药但没按确认键 */
  onManualFill(e) {
    const { planId, time } = e.currentTarget.dataset
    wx.showModal({
      title: '确认补录',
      content: `确认 ${time} 的这次用药已经服用？补录会记入服药记录并扣减库存。`,
      success: res => {
        if (!res.confirm) return
        api.record.saveManual({ planId, dateStr: this.data.date, time })
          .then(() => {
            wx.showToast({ title: '已补录', icon: 'success' })
            this.load(true)
          })
          .catch(() => {})
      }
    })
  },

  goPlans() {
    wx.switchTab({ url: '/pages/plans/plans' })
  },

  goDevice() {
    wx.switchTab({ url: '/pages/device/device' })
  },

  goRecords() {
    wx.switchTab({ url: '/pages/records/records' })
  }
})
