// 图表绘制
//
// 依从性趋势图：单序列（每日得分），所以按规范用「折线 + 面积」，
// 不加图例（标题已经说明画的是什么），只在端点标数值 ——
// 每个点都标数字会变成一团噪音，反而没人读。
//
// 画在 canvas 2d 上。小程序里 canvas 有两点容易踩：
//   1. 被 wx:if 隐藏的节点查不到，所以 canvas 必须常驻渲染
//   2. 必须按 devicePixelRatio 放大，否则高分屏上糊成一片

const COLOR = {
  line: '#2E7D6F',          // 品牌主色，数据用色
  area: 'rgba(46, 125, 111, 0.10)',  // 面积是一层淡淡的水洗，不是实心块
  grid: '#EDEFF2',          // 离表面只差一档的灰，发丝级
  surface: '#FFFFFF',
  textMuted: '#9AA0A6',
  textSecondary: '#4B5563'
}

// 左留白给 y 轴刻度，下留白给日期标签
const PAD = { top: 20, right: 16, bottom: 28, left: 32 }

/**
 * 画依从性趋势图。
 * @param {object} ctx       页面实例（Page 直接传 this 即可）
 * @param {string} canvasId  canvas 的 id
 * @param {Array}  trend     [{ date: '2026-09-24', score: 50|null, total, missed }]
 * @returns {Promise<boolean>} 是否绘制成功
 */
function drawTrend(ctx, canvasId, trend) {
  if (!Array.isArray(trend) || trend.length === 0) return Promise.resolve(false)

  return queryCanvas(ctx, canvasId).then(info => {
    if (!info) {
      console.warn('[chart] 找不到 canvas 节点', canvasId)
      return false
    }
    try {
      render(info.node, info.width, info.height, trend)
      return true
    } catch (err) {
      console.error('[chart] 绘制失败', err)
      return false
    }
  })
}

/**
 * 查询 canvas 节点。
 * 优先用组件内查询（Page 实例也支持），但个别基础库版本对 Page 传 .in()
 * 支持不好，查不到就退回全局查询 —— 宁可多查一次，也不要白屏。
 */
function queryCanvas(ctx, canvasId) {
  return new Promise(resolve => {
    let q
    try {
      q = ctx ? wx.createSelectorQuery().in(ctx) : wx.createSelectorQuery()
    } catch (e) {
      q = wx.createSelectorQuery()
    }

    q.select('#' + canvasId).fields({ node: true, size: true }).exec(res => {
      if (res && res[0] && res[0].node) {
        resolve(res[0])
        return
      }
      wx.createSelectorQuery()
        .select('#' + canvasId)
        .fields({ node: true, size: true })
        .exec(res2 => resolve(res2 && res2[0] && res2[0].node ? res2[0] : null))
    })
  })
}

function render(canvas, cssW, cssH, trend) {
  const dpr = getPixelRatio()
  // 设置尺寸会重置画布状态（含 transform），所以每次都要重新 scale
  canvas.width = cssW * dpr
  canvas.height = cssH * dpr

  const c = canvas.getContext('2d')
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  c.clearRect(0, 0, cssW, cssH)

  const plotW = cssW - PAD.left - PAD.right
  const plotH = cssH - PAD.top - PAD.bottom
  const n = trend.length

  const xOf = i => (n === 1 ? PAD.left + plotW / 2 : PAD.left + (plotW * i) / (n - 1))
  const yOf = v => PAD.top + plotH * (1 - v / 100)

  drawGrid(c, plotW, yOf)

  // 只画有数据的天。没记录的那天 score 为 null，
  // 直接连过去会凭空造出一个不存在的低点。
  const pts = []
  trend.forEach((d, i) => {
    if (d.score === null || d.score === undefined) return
    pts.push({ x: xOf(i), y: yOf(d.score), score: d.score, i })
  })

  if (pts.length >= 2) {
    // 面积：从第一个点连到底边，再连到最后一个点
    c.beginPath()
    c.moveTo(pts[0].x, yOf(0))
    for (const p of pts) c.lineTo(p.x, p.y)
    c.lineTo(pts[pts.length - 1].x, yOf(0))
    c.closePath()
    c.fillStyle = COLOR.area
    c.fill()

    // 折线：2px，圆角连接
    c.beginPath()
    c.moveTo(pts[0].x, pts[0].y)
    for (let k = 1; k < pts.length; k++) c.lineTo(pts[k].x, pts[k].y)
    c.strokeStyle = COLOR.line
    c.lineWidth = 2
    c.lineJoin = 'round'
    c.lineCap = 'round'
    c.stroke()
  }

  // 数据点：直径 8px，套一圈 2px 表面色，压在线上也看得清
  for (const p of pts) {
    c.beginPath()
    c.arc(p.x, p.y, 4, 0, Math.PI * 2)
    c.fillStyle = COLOR.line
    c.fill()
    c.lineWidth = 2
    c.strokeStyle = COLOR.surface
    c.stroke()
  }

  drawXLabels(c, trend, xOf, plotH)
  drawEndLabel(c, pts, cssW)
}

/** y 轴三条刻度线（0 / 50 / 100），发丝级实线，永远不用虚线 */
function drawGrid(c, plotW, yOf) {
  c.font = '10px sans-serif'
  c.textAlign = 'right'
  c.textBaseline = 'middle'

  for (const v of [0, 50, 100]) {
    // 半像素对齐：1px 线落在整数坐标上会跨两行像素，糊成 2px
    const y = Math.round(yOf(v)) + 0.5

    c.beginPath()
    c.moveTo(PAD.left, y)
    c.lineTo(PAD.left + plotW, y)
    c.strokeStyle = COLOR.grid
    c.lineWidth = 1
    c.stroke()

    c.fillStyle = COLOR.textMuted
    c.fillText(String(v), PAD.left - 6, y)
  }
}

/** x 轴日期：MM-DD，居中在各自的数据点下方 */
function drawXLabels(c, trend, xOf, plotH) {
  c.font = '10px sans-serif'
  c.textAlign = 'center'
  c.textBaseline = 'top'
  c.fillStyle = COLOR.textMuted

  trend.forEach((d, i) => {
    const label = String(d.date).slice(5)   // '2026-09-24' → '09-24'
    c.fillText(label, xOf(i), PAD.top + plotH + 8)
  })
}

/** 只在最后一个数据点上标数值。文字用文本色，不用数据色。 */
function drawEndLabel(c, pts, cssW) {
  if (pts.length === 0) return

  const last = pts[pts.length - 1]
  const text = String(last.score)

  c.font = 'bold 11px sans-serif'
  c.textAlign = 'center'
  c.textBaseline = 'bottom'

  // 靠右时把标签往左收，避免被裁掉
  const x = Math.min(Math.max(last.x, PAD.left + 10), cssW - PAD.right - 10)
  const y = last.y - 8

  c.fillStyle = COLOR.surface
  const w = c.measureText(text).width
  c.fillRect(x - w / 2 - 3, y - 13, w + 6, 15)

  c.fillStyle = COLOR.textSecondary
  c.fillText(text, x, y)
}

function getPixelRatio() {
  try {
    if (wx.getWindowInfo) return wx.getWindowInfo().pixelRatio || 1
    return wx.getSystemInfoSync().pixelRatio || 1
  } catch (e) {
    return 1
  }
}

module.exports = { drawTrend }
