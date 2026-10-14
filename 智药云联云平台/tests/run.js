// 云函数本地测试
// 运行：node tests/run.js
//
// 作用：不部署、不联网，直接验证云函数的业务逻辑。
// 重点覆盖最容易出错的两块——时区判定和依从性计分。

const path = require('path')
const Module = require('module')

// 把 require('wx-server-sdk') 重定向到本地替身
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'wx-server-sdk') {
    return path.join(__dirname, 'wx-server-sdk-stub.js')
  }
  return origResolve.call(this, request, ...rest)
}

const stub = require('./wx-server-sdk-stub')
const recordFn = require('../cloudfunctions/record/index.js')
const analyticsFn = require('../cloudfunctions/analytics/index.js')
const planFn = require('../cloudfunctions/plan/index.js')
const notifyFn = require('../cloudfunctions/notify/index.js')

// 设备令牌现在必须由环境变量提供，代码里【故意没有默认值】——
// 本仓库是公开的，写死的字面量等于把线上凭证公开出去。
// 测试这里显式设一个，模拟"云端已经配好环境变量"的正常状态。
const DEVICE_TOKEN = 'test-device-token'
process.env.DEVICE_TOKEN = DEVICE_TOKEN

const OPENID = 'test-openid'
const TOKEN = DEVICE_TOKEN

// ── 断言工具 ──────────────────────────────────────────────
let pass = 0, fail = 0
const failures = []

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✗ ${name}\n      期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

/** 静音 console.error/warn：用于预期会失败的用例，避免错误堆栈刷屏 */
async function quiet(fn) {
  const origErr = console.error
  const origWarn = console.warn
  console.error = () => {}
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    console.error = origErr
    console.warn = origWarn
  }
}

// ── 时间辅助 ──────────────────────────────────────────────
/** 北京时间 "YYYY-MM-DD HH:mm" → 真实 UTC 时刻 */
function bj(y, mo, d, h, mi) {
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, 0))
}

function bjTodayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

// ── 测试数据 ──────────────────────────────────────────────
function seedBase() {
  stub.__reset()
  stub.__setOpenid(OPENID)

  stub.__seed('devices', [{
    _id: 'dev1',
    deviceId: 'BOX001',
    ownerOpenid: OPENID,
    elderId: 'elder1',
    name: '测试药盒',
    bays: [
      { index: 0, label: '1号仓', medicineName: '氨氯地平', customVoice: '' },
      { index: 1, label: '2号仓', medicineName: '二甲双胍', customVoice: '' }
    ],
    battery: 88,
    lastSeenAt: new Date()
  }])

  stub.__seed('plans', [{
    _id: 'plan1',
    deviceId: 'dev1',
    bayIndex: 0,
    medicineName: '苯磺酸氨氯地平片',
    dosageText: '1片',
    perDose: 1,
    times: ['08:00', '20:00'],
    dailyConsumption: 2,
    mealRelation: '饭后',
    stock: 30,
    active: true,
    ownerOpenid: OPENID
  }])
}

function report(eventType, instant) {
  return recordFn.main({
    action: 'report',
    deviceId: 'BOX001',
    bayIndex: 0,
    eventType,
    token: TOKEN,
    timestamp: instant.toISOString()
  })
}

// ══════════════════════════════════════════════════════════
async function main() {

  section('一、时区与状态判定（核心）')

  // 计划 08:00，实际 08:05 → 按时
  seedBase()
  let r = await report('taken', bj(2026, 9, 24, 8, 5))
  check('08:05 服药 → on_time', r.data.status, 'on_time')
  check('  时间差 +5 分钟', r.data.diffMinutes, 5)

  // 08:00 计划，09:30 服药 → 延迟
  seedBase()
  r = await report('taken', bj(2026, 9, 24, 9, 30))
  check('09:30 服药 → late', r.data.status, 'late')

  // 08:00 计划，07:20 服药 → 提前（昨天 23:20 UTC，跨时区边界）
  seedBase()
  r = await report('taken', bj(2026, 9, 24, 7, 20))
  check('07:20 服药 → early', r.data.status, 'early')
  check('  时间差 −40 分钟', r.data.diffMinutes, -40)

  // 边界：正好 30 分钟算按时
  seedBase()
  r = await report('taken', bj(2026, 9, 24, 8, 30))
  check('08:30 服药（边界）→ on_time', r.data.status, 'on_time')

  // 边界：31 分钟算延迟
  seedBase()
  r = await report('taken', bj(2026, 9, 24, 8, 31))
  check('08:31 服药（边界）→ late', r.data.status, 'late')

  // 晚上 20:00 那次：19:50 → 按时，不能被误判到早上的时点
  seedBase()
  r = await report('taken', bj(2026, 9, 24, 19, 50))
  check('19:50 服药 → 匹配 20:00 时点', r.data.plannedTime, '20:00')
  check('  状态 on_time', r.data.status, 'on_time')

  section('二、库存扣减')

  seedBase()
  await report('taken', bj(2026, 9, 24, 8, 5))
  let plan = stub.__store.plans.find(p => p._id === 'plan1')
  check('服药一次后库存 30 → 29', plan.stock, 29)

  seedBase()
  await report('taken', bj(2026, 9, 24, 8, 5))
  await report('vision_confirmed', bj(2026, 9, 24, 8, 6))
  plan = stub.__store.plans.find(p => p._id === 'plan1')
  check('同一时点重复上报，库存只扣一次', plan.stock, 29)

  section('三、设备心跳')

  seedBase()
  stub.__store.devices[0].lastSeenAt = null
  await report('taken', bj(2026, 9, 24, 8, 5))
  let dev = stub.__store.devices.find(d => d._id === 'dev1')
  check('上报事件会刷新设备心跳', dev.lastSeenAt !== null, true)

  section('四、视觉确认升级')

  seedBase()
  await report('taken', bj(2026, 9, 24, 8, 5))
  let recs = stub.__store.records.filter(x => x.planId === 'plan1')
  check('传感器上报记为 sensor', recs[0].source, 'sensor')

  r = await report('vision_confirmed', bj(2026, 9, 24, 8, 6))
  check('视觉确认后标记升级', r.data.upgraded, true)
  recs = stub.__store.records.filter(x => x.planId === 'plan1')
  check('记录来源变为 vision_confirmed', recs[0].source, 'vision_confirmed')
  check('记录条数仍为 1（未新增）', recs.length, 1)

  section('五、异常输入')

  seedBase()
  r = await quiet(() => recordFn.main({
    action: 'report', deviceId: 'BOX001', bayIndex: 0,
    eventType: 'taken', token: 'wrong-token', timestamp: new Date().toISOString()
  }))
  check('错误 token 被拒绝', r.code, 403)

  seedBase()
  r = await recordFn.main({
    action: 'report', deviceId: 'NOT_EXIST', bayIndex: 0,
    eventType: 'taken', token: TOKEN, timestamp: new Date().toISOString()
  })
  check('未注册设备被拒绝', r.code, 404)

  seedBase()
  r = await recordFn.main({
    action: 'report', deviceId: 'BOX001', bayIndex: 5,
    eventType: 'taken', token: TOKEN, timestamp: new Date().toISOString()
  })
  check('空药仓上报被忽略', r.data.ignored, true)

  section('六、依从性评分')

  seedBase()
  const today = bjTodayStr()
  stub.__seed('records', [
    { ownerOpenid: OPENID, planId: 'plan1', dateStr: today, status: 'on_time', medicineName: 'A', scheduledAt: bj(2026, 9, 24, 8, 0) },
    { ownerOpenid: OPENID, planId: 'plan1', dateStr: today, status: 'on_time', medicineName: 'A', scheduledAt: bj(2026, 9, 24, 9, 0) },
    { ownerOpenid: OPENID, planId: 'plan1', dateStr: today, status: 'on_time', medicineName: 'A', scheduledAt: bj(2026, 9, 24, 10, 0) },
    { ownerOpenid: OPENID, planId: 'plan1', dateStr: today, status: 'late',    medicineName: 'A', scheduledAt: bj(2026, 9, 24, 11, 0) },
    { ownerOpenid: OPENID, planId: 'plan1', dateStr: today, status: 'missed',  medicineName: 'A', scheduledAt: bj(2026, 9, 24, 12, 0) }
  ])
  // 3×1.0 + 1×0.5 + 1×0 = 3.5 / 5 = 70
  let adh = await analyticsFn.main({ action: 'adherence', days: 7 })
  check('5 次用药得分 70', adh.data.score, 70)
  check('  按时 3 次', adh.data.byStatus.on_time, 3)
  check('  延迟 1 次', adh.data.byStatus.late, 1)
  check('  漏服 1 次', adh.data.byStatus.missed, 1)
  check('  分级为「一般」', adh.data.level.label, '一般')

  // 全部按时 = 100
  seedBase()
  stub.__seed('records', [
    { ownerOpenid: OPENID, planId: 'plan1', dateStr: today, status: 'on_time', medicineName: 'A', scheduledAt: bj(2026, 9, 24, 8, 0) },
    { ownerOpenid: OPENID, planId: 'plan1', dateStr: today, status: 'on_time', medicineName: 'A', scheduledAt: bj(2026, 9, 24, 9, 0) }
  ])
  adh = await analyticsFn.main({ action: 'adherence', days: 7 })
  check('全部按时得 100 分', adh.data.score, 100)
  check('  分级为「优秀」', adh.data.level.label, '优秀')

  // 只看自己的数据：别人的记录不能算进来
  seedBase()
  stub.__seed('records', [
    { ownerOpenid: OPENID, planId: 'plan1', dateStr: today, status: 'on_time', medicineName: 'A', scheduledAt: bj(2026, 9, 24, 8, 0) },
    { ownerOpenid: 'someone-else', planId: 'plan2', dateStr: today, status: 'missed', medicineName: 'B', scheduledAt: bj(2026, 9, 24, 8, 0) }
  ])
  adh = await analyticsFn.main({ action: 'adherence', days: 7 })
  check('不会统计到其他账号的记录', adh.data.totalCount, 1)
  check('  得分仍为 100', adh.data.score, 100)

  section('七、漏服补齐')

  seedBase()
  r = await recordFn.main({ action: 'syncMissed', days: 7 })
  // 7 天 × 每天 2 个时点（08:00 / 20:00）= 14，今天超时的那些也会补上
  check('补齐了历史漏服记录', r.data.created >= 12, true)
  const missedRecs = stub.__store.records.filter(x => x.status === 'missed')
  check('  记录状态均为 missed', missedRecs.every(x => x.status === 'missed'), true)
  check('  记录了正确的日期字段', !!missedRecs[0].dateStr, true)

  // 再跑一次不应该重复创建
  const before = stub.__store.records.length
  await recordFn.main({ action: 'syncMissed', days: 7 })
  check('重复执行不会产生重复记录', stub.__store.records.length, before)

  // 计划创建之前就过去的时点不能追溯判为漏服
  seedBase()
  stub.__store.plans[0].createdAt = new Date()   // 计划刚刚创建
  r = await recordFn.main({ action: 'syncMissed', days: 3 })
  check('新建计划不追溯过去的时点为漏服', r.data.created, 0)

  seedBase()
  stub.__store.plans[0].createdAt = new Date(Date.now() - 10 * 24 * 3600 * 1000)  // 10 天前创建
  r = await recordFn.main({ action: 'syncMissed', days: 3 })
  check('老计划照常补齐漏服', r.data.created > 0, true)

  section('八、权限隔离')

  seedBase()
  stub.__setOpenid('other-openid')
  r = await quiet(() => planFn.main({ action: 'delete', id: 'plan1' }))
  check('不能删除别人的计划', r.code, 403)

  seedBase()
  stub.__setOpenid('other-openid')
  r = await quiet(() => planFn.main({ action: 'save', data: { _id: 'plan1', medicineName: 'X' } }))
  check('不能修改别人的计划（即使参数不完整也应先拒绝）', r.code, 403)

  seedBase()
  stub.__setOpenid('other-openid')
  r = await quiet(() => planFn.main({
    action: 'save',
    data: { _id: 'plan1', deviceId: 'dev1', bayIndex: 0, medicineName: 'X', times: ['09:00'] }
  }))
  check('参数完整时同样拒绝越权修改', r.code, 403)

  section('九、业务规则')

  seedBase()
  stub.__setOpenid(OPENID)
  r = await planFn.main({
    action: 'save',
    data: { deviceId: 'dev1', bayIndex: 0, medicineName: '新药', times: ['09:00'] }
  })
  check('同一药仓不能建第二个计划', r.code, 400)

  seedBase()
  stub.__setOpenid(OPENID)
  r = await planFn.main({
    action: 'save',
    data: { deviceId: 'dev1', bayIndex: 1, medicineName: '二甲双胍', times: ['08:00', '12:00', '18:00'], perDose: 2, stock: 60 }
  })
  check('新计划创建成功', r.code, 0)
  const created = stub.__store.plans.find(p => p.bayIndex === 1)
  check('  每日消耗自动算出 = 2×3 = 6', created.dailyConsumption, 6)

  section('十、设备心跳（回归测试）')

  // 硬件端通过 HTTP 触发调用 device 云函数，设备没有 OPENID。
  // 曾经的问题：登录校验排在 switch 之前，导致心跳恒返回 401，
  // 设备 lastSeenAt 永不更新，小程序里药盒一直显示「离线」。
  const deviceFn = require('../cloudfunctions/device/index.js')

  seedBase()
  stub.__setOpenid('')                    // 模拟 HTTP 触发：无微信身份
  stub.__store.devices[0].lastSeenAt = null
  stub.__store.devices[0].online = false

  r = await deviceFn.main({ action: 'heartbeat', deviceId: 'BOX001', token: TOKEN, battery: 77 })
  check('硬件端无 OPENID 也能上报心跳', r.code, 0)
  check('  心跳更新了 lastSeenAt', stub.__store.devices[0].lastSeenAt !== null, true)
  check('  心跳更新了 online 标志', stub.__store.devices[0].online, true)
  check('  心跳更新了电量', stub.__store.devices[0].battery, 77)

  // 鉴权：token 错误必须被拒，且不得改动设备状态
  seedBase()
  stub.__setOpenid('')
  stub.__store.devices[0].lastSeenAt = null
  r = await quiet(() => deviceFn.main({ action: 'heartbeat', deviceId: 'BOX001', token: 'wrong-token' }))
  check('错误 token 被拒绝', r.code, 403)
  check('  被拒后 lastSeenAt 未被改动', stub.__store.devices[0].lastSeenAt, null)

  // 未注册设备
  seedBase()
  stub.__setOpenid('')
  r = await quiet(() => deviceFn.main({ action: 'heartbeat', deviceId: 'NOT-EXIST', token: TOKEN }))
  check('未注册设备被拒绝', r.code, 404)

  // 缺少 deviceId
  seedBase()
  stub.__setOpenid('')
  r = await deviceFn.main({ action: 'heartbeat', token: TOKEN })
  check('缺少 deviceId 被拒绝', r.code, 400)

  // 小程序端的登录校验不能被破坏
  seedBase()
  stub.__setOpenid('')
  r = await quiet(() => deviceFn.main({ action: 'list' }))
  check('未登录调用 list 仍被拒绝', r.code, 401)

  seedBase()
  stub.__setOpenid(OPENID)
  r = await deviceFn.main({ action: 'list' })
  check('已登录调用 list 正常', r.code, 0)

  // ══════════════════════════════════════════════════════════
  //  以下是回归测试：每条都对应一个真实出现过的缺陷，
  //  目的不是证明代码对，而是防止它再一次不对。
  // ══════════════════════════════════════════════════════════

  section('十、设备上报漏服（回归）')

  // 背景：硬件端在提醒超时后会发 eventType='missed'。
  // 云端原先没有这个分支，走 classify() 按时间差判定 ——
  // 超时上报发生在计划后约 2 分钟，落在 ±30 分钟窗口内，
  // 于是「漏服」被记成「按时」，还照扣库存、不产生预警。

  seedBase()
  r = await report('missed', bj(2026, 9, 24, 8, 2))
  check('超时 2 分钟上报漏服 → 记为 missed', r.data.status, 'missed')

  plan = stub.__store.plans.find(p => p._id === 'plan1')
  check('  漏服不扣库存（药没被取走）', plan.stock, 30)

  const deviceMissedRecs = stub.__store.records.filter(x => x.planId === 'plan1')
  check('  写入了一条记录', deviceMissedRecs.length, 1)
  check('  记录来源标记为 device', deviceMissedRecs[0].source, 'device')
  check('  没有实际服药的时刻', deviceMissedRecs[0].actualAt, null)

  const missedAlerts = (stub.__store.alerts || []).filter(a => a.type === 'missed_dose')
  check('  产生了漏服预警', missedAlerts.length, 1)
  check('  预警带药品名（订阅消息要用）', missedAlerts[0].medicineName, '苯磺酸氨氯地平片')
  check('  预警带药箱名（订阅消息要用）', missedAlerts[0].deviceName, '测试药盒')
  check('  预警未标记已推送', missedAlerts[0].notified, false)

  // 漏服不能被后来的「按时」上报覆盖
  seedBase()
  await report('missed', bj(2026, 9, 24, 8, 2))
  r = await report('taken', bj(2026, 9, 24, 8, 3))
  check('重复上报不覆盖已有的漏服记录', r.data.status, 'missed')
  check('  也不会重复扣库存',
        stub.__store.plans.find(p => p._id === 'plan1').stock, 30)

  // 依从性要如实反映漏服。
  // 注意这里必须用「今天」——adherence 只统计最近 7 天，
  // 用固定日期会因为落到窗口外而查不到记录（这个测试本身就是这么发现的）
  seedBase()
  const td = bjTodayStr().split('-').map(Number)
  await report('missed', bj(td[0], td[1], td[2], 8, 2))
  const adhMissed = await analyticsFn.main({ action: 'adherence', days: 7 })
  check('依从性把漏服计 0 分', adhMissed.data.score, 0)
  check('  漏服次数统计正确', adhMissed.data.byStatus.missed, 1)

  section('十一、推送鉴权（回归）')

  // 背景：notify.sendNow 原先既不校验登录、也不校验预警归属，
  // 任何登录用户拿到 alertId 就能给别人推送、扣掉对方的订阅额度。

  seedBase()
  stub.__seed('alerts', [{ _id: 'alert-victim', ownerOpenid: 'victim-openid', type: 'missed_dose' }])

  stub.__setOpenid('attacker-openid')
  r = await quiet(() => notifyFn.main({ action: 'sendNow', alertId: 'alert-victim' }))
  check('不能推送别人名下的预警', r.code, 403)

  stub.__setOpenid('')
  r = await quiet(() => notifyFn.main({ action: 'sendNow', alertId: 'alert-victim' }))
  check('未登录不能调用 sendNow', r.code, 401)

  // 定时器没有 OPENID，它调用 sendPending 必须放行
  stub.__setOpenid('')
  r = await quiet(() => notifyFn.main({ Type: 'Timer', TriggerName: 'notifyTimer' }))
  check('定时触发器调用 sendPending 放行', r.code === 0 || r.code === 500, true)

  section('十二、设备令牌未配置时拒绝一切（回归）')

  // 背景：环境变量没配时，代码原先会回退到公开仓库里的字面量
  // 'zhihyao-dev-token' —— 那等于把线上凭证写在明面上。
  // 现在必须 fail closed。

  const savedToken = process.env.DEVICE_TOKEN

  seedBase()
  delete process.env.DEVICE_TOKEN
  r = await quiet(() => report('taken', bj(2026, 9, 24, 8, 5)))
  check('未配置令牌时拒绝上报', r.code, 500)
  check('  且不写入任何记录',
        (stub.__store.records || []).length, 0)

  seedBase()
  delete process.env.DEVICE_TOKEN
  r = await quiet(() => deviceFn.main({
    action: 'heartbeat', deviceId: 'BOX001', token: '随便什么'
  }))
  check('未配置令牌时拒绝心跳', r.code, 500)

  // 恢复，后面的测试还要用
  process.env.DEVICE_TOKEN = savedToken

  section('十三、模拟上报走用户登录态（回归）')

  // 小程序里的「模拟上报」原先直接发设备令牌 ——
  // 但客户端代码能被反编译，等于把令牌公开。
  // 改成走 OPENID + 设备归属校验。

  seedBase()
  stub.__setOpenid(OPENID)              // seedBase 里 devices[0] 属于 OPENID
  r = await recordFn.main({
    action: 'simulateReport', deviceId: 'BOX001', bayIndex: 0,
    eventType: 'vision_confirmed'
  })
  check('设备主人可以模拟上报', r.code, 0)

  seedBase()
  stub.__setOpenid('someone-else')
  r = await quiet(() => recordFn.main({
    action: 'simulateReport', deviceId: 'BOX001', bayIndex: 0,
    eventType: 'vision_confirmed'
  }))
  check('不能给别人的设备模拟上报', r.code, 403)

  seedBase()
  stub.__setOpenid('')
  r = await quiet(() => recordFn.main({
    action: 'simulateReport', deviceId: 'BOX001', bayIndex: 0
  }))
  check('未登录不能模拟上报', r.code, 401)

  stub.__setOpenid(OPENID)

  // ── 汇总 ──
  console.log('\n' + '─'.repeat(50))
  console.log(`通过 ${pass} 项，失败 ${fail} 项`)
  if (fail > 0) {
    console.log('\n失败用例：')
    failures.forEach(f => console.log(`  - ${f}`))
    process.exit(1)
  }
  console.log('全部通过 ✓')
}

main().catch(err => {
  console.error('\n测试运行出错：', err)
  process.exit(1)
})
