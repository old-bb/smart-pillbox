// 服药记录
const api = require('../../utils/api')
const { STATUS_MAP, SOURCE_MAP } = require('../../utils/constants')
const fmt = require('../../utils/format')

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'on_time', label: '按时' },
  { key: 'late', label: '延迟' },
  { key: 'missed', label: '漏服' }
]

Page({
  data: {
    loading: true,
    filters: FILTERS,
    activeFilter: '',
    groups: [],      // 按日期分组
    total: 0,
    hasMore: false,
    page: 1,
    // 依从性统计
    adherence: null
  },

  onShow() {
    this.reload()
  },

  onPullDownRefresh() {
    this.reload().then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore) this.loadPage(this.data.page + 1)
  },

  reload() {
    this.setData({ loading: true, page: 1 })
    return Promise.all([
      this.fetchRecords(1, true),
      api.analytics.adherence(30).catch(() => null)
    ]).then(([, adh]) => {
      this.setData({ loading: false, adherence: adh })
    }).catch(() => {
      this.setData({ loading: false })
    })
  },

  fetchRecords(page, replace) {
    return api.record.list({
      page,
      pageSize: 30,
      status: this.data.activeFilter || undefined
    }).then(data => {
      const merged = replace ? data.list : this.mergeUnique(this._rawList || [], data.list)
      this._rawList = merged
      this.setData({
        groups: this.groupByDate(merged),
        total: data.total,
        hasMore: data.hasMore,
        page
      })
    })
  },

  loadPage(page) {
    return this.fetchRecords(page, false)
  },

  mergeUnique(a, b) {
    const seen = new Set(a.map(r => r._id))
    return a.concat(b.filter(r => !seen.has(r._id)))
  },

  /** 按日期分组，同一天内按时点倒序 */
  groupByDate(list) {
    const map = {}
    for (const r of list) {
      const d = r.dateStr || fmt.formatDate(r.scheduledAt)
      if (!map[d]) map[d] = []
      const st = STATUS_MAP[r.status] || STATUS_MAP.upcoming
      map[d].push({
        ...r,
        timeText: fmt.formatTime(r.scheduledAt, false),
        statusLabel: st.label,
        statusTag: st.tag,
        sourceLabel: SOURCE_MAP[r.source] || '',
        diffLabel: r.diffMinutes ? fmt.diffText(r.diffMinutes) : '',
        actualText: r.actualAt ? fmt.formatTime(r.actualAt, false) : ''
      })
    }
    return Object.keys(map)
      .sort((a, b) => b.localeCompare(a))
      .map(date => ({
        date,
        dateLabel: fmt.friendlyDate(date),
        items: map[date].sort((a, b) => b.timeText.localeCompare(a.timeText))
      }))
  },

  onFilterTap(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.activeFilter) return
    this._rawList = []
    this.setData({ activeFilter: key, page: 1 })
    this.fetchRecords(1, true)
  }
})
