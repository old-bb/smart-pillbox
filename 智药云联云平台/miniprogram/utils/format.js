// 格式化工具

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** Date | number | string → "MM-DD HH:mm"（北京时间） */
function formatTime(input, withDate = true) {
  if (!input) return '--'
  const d = new Date(input)
  if (isNaN(d.getTime())) return '--'
  // 加上 8 小时得到北京时间；用 UTC 取值避免受手机时区影响
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  const time = `${pad2(bj.getUTCHours())}:${pad2(bj.getUTCMinutes())}`
  if (!withDate) return time
  return `${pad2(bj.getUTCMonth() + 1)}-${pad2(bj.getUTCDate())} ${time}`
}

/** Date | number | string → "2026-09-24"（北京时间） */
function formatDate(input) {
  if (!input) return '--'
  const d = new Date(input)
  if (isNaN(d.getTime())) return '--'
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  return `${bj.getUTCFullYear()}-${pad2(bj.getUTCMonth() + 1)}-${pad2(bj.getUTCDate())}`
}

/** "2026-09-24" → "今天" / "昨天" / "09-24" */
function friendlyDate(dateStr) {
  if (!dateStr) return ''
  const today = formatDate(new Date())
  if (dateStr === today) return '今天'

  const y = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const yesterday = formatDate(y)
  if (dateStr === yesterday) return '昨天'

  return dateStr.slice(5)
}

/** 相对时间："刚刚" / "5 分钟前" / "3 小时前" / "昨天 08:30" */
function fromNow(input) {
  if (!input) return '--'
  const d = new Date(input)
  if (isNaN(d.getTime())) return '--'

  const diff = Date.now() - d.getTime()
  if (diff < 0) return formatTime(input)
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  if (diff < 48 * 60 * 60 * 1000) return `昨天 ${formatTime(input, false)}`
  return formatTime(input)
}

/** 剩余天数 → 文案与紧急度 */
function stockText(remainingDays) {
  if (remainingDays === null || remainingDays === undefined) return { text: '未设置库存', level: 'none' }
  if (remainingDays <= 0) return { text: '已用完', level: 'high' }
  if (remainingDays <= 3) return { text: `仅剩 ${remainingDays} 天`, level: 'high' }
  if (remainingDays <= 7) return { text: `剩余 ${remainingDays} 天`, level: 'medium' }
  return { text: `剩余 ${remainingDays} 天`, level: 'ok' }
}

/** 电量 → 文案，区分未上报 */
function batteryText(battery) {
  if (battery === null || battery === undefined) return '未知'
  return `${battery}%`
}

/** 延迟分钟数 → "延迟 45 分钟" / "提前 1 小时 10 分" */
function diffText(diffMinutes) {
  if (diffMinutes === null || diffMinutes === undefined) return ''
  const abs = Math.abs(diffMinutes)
  const sign = diffMinutes > 0 ? '延迟' : '提前'
  if (abs < 60) return `${sign} ${abs} 分钟`
  const h = Math.floor(abs / 60)
  const m = abs % 60
  return m === 0 ? `${sign} ${h} 小时` : `${sign} ${h} 小时 ${m} 分`
}

module.exports = {
  pad2,
  formatTime,
  formatDate,
  friendlyDate,
  fromNow,
  stockText,
  batteryText,
  diffText
}
