// 云函数：notify
// 作用：把 alerts 集合里的预警，通过微信订阅消息推送到子女手机。
//
// 两条入口：
//   1. 定时触发器：每 5 分钟扫一次未推送的预警（config.json 里配置）
//   2. 手动调用：action = 'sendPending' / 'sendNow'，便于调试
//
// ┌─────────────────────────────────────────────────────────────┐
// │ 使用前必须完成两步，否则发不出去：                            │
// │ 1. 小程序后台 → 订阅消息 → 申请模板，拿到 templateId 填到下面  │
// │ 2. 按模板实际字段名，改 buildTemplateData() 里的映射           │
// └─────────────────────────────────────────────────────────────┘

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

// ══ 配置区：申请到模板后改这里 ══════════════════════════════

// 模板 ID（小程序后台 → 订阅消息 → 我的模板 →「服药提醒」）
const TEMPLATE_ID = process.env.NOTIFY_TEMPLATE_ID || 'aN68Y67LW9U8UXyLLKF17rYc5c5yEbCHUJ9yPUZFQlk'

// 点击通知后跳转到小程序的哪个页面
const TARGET_PAGE = 'pages/index/index'

// 小程序版本：developer 开发版 / trial 体验版 / formal 正式版
// 中期检查阶段用 developer（自己扫码能看到），发布后改成 formal
const MINIPROGRAM_STATE = process.env.MINIPROGRAM_STATE || 'developer'

/**
 * 把一条 alert 映射成模板字段。
 *
 * 对应「服药提醒」模板（健康管理类目，模板编号 39246）。
 * 字段名是照抄后台「详细内容」里的 {{xxx.DATA}}，不要凭感觉改：
 *
 *   服药时间   {{time2.DATA}}         类型 time
 *   服用药物   {{thing3.DATA}}        类型 thing       上限 20 字
 *   药箱名称   {{thing4.DATA}}        类型 thing       上限 20 字
 *   服药剂量   {{short_thing5.DATA}}  类型 short_thing 上限 5 字  ← 注意不是 thing
 *   温馨提醒   {{thing6.DATA}}        类型 thing       上限 20 字
 *
 * 推送效果：
 *   服药时间：2026年9月24日 16:30
 *   服用药物：苯磺酸氨氯地平片
 *   药箱名称：爸妈的药盒
 *   服药剂量：1片
 *   温馨提醒：检测到漏服
 *
 * ⚠️ 两条硬规则，踩了就直接报 47003：
 *   1. 字段名必须与后台显示完全一致（微信按「类型 + 序号」自动编号，
 *      thing 和 short_thing 会分开计数，所以是 time2 / thing3 / short_thing5 这种跳号）
 *   2. 模板里勾了的字段，每一个都必须有值，缺一个整条发不出去，
 *      所以下面的取值全部带兜底文案
 */
function buildTemplateData(alert, whenText) {
  return {
    time2:        { value: whenText },                                        // 服药时间
    thing3:       { value: truncate(alert.medicineName || '用药提醒', 20) },   // 服用药物
    thing4:       { value: truncate(alert.deviceName || '智能药盒', 20) },     // 药箱名称
    short_thing5: { value: truncate(alert.dosageText || '按医嘱', 5) },        // 服药剂量（限 5 字）
    thing6:       { value: truncate(alert.title || '请关注', 20) }             // 温馨提醒
  }
}

/** 订阅消息的 thing 类型限 20 字，超了会直接报错 */
function truncate(s, n) {
  const str = String(s || '')
  return str.length > n ? str.slice(0, n - 1) + '…' : str
}

// ══ 主体逻辑 ════════════════════════════════════════════════

exports.main = async (event = {}) => {
  // 定时触发器传进来的 event 形如 { Type: 'Timer', TriggerName: 'notifyTimer' }
  const action = event.action || (event.Type === 'Timer' ? 'sendPending' : '')

  try {
    switch (action) {
      case 'sendPending':
        return await sendPending(event)
      case 'sendNow':
        return await sendNow(event)
      case 'addQuota':
        return await addQuota(event)
      case 'getQuota':
        return await getQuota()
      // 调试用：打印账号下所有模板的字段结构，用于核对 buildTemplateData 的 key
      case 'getTemplates':
        return await getTemplates()
      // 调试用：给调用者自己发一条样例通知，验证全链路
      case 'testSend':
        return await testSend()
      default:
        return { code: 400, msg: `未知 action: ${action}` }
    }
  } catch (err) {
    console.error('[notify]', action, err)
    return { code: 500, msg: err.message }
  }
}

/** 扫描未推送的预警并逐条发送 */
async function sendPending(event) {
  if (TEMPLATE_ID === 'YOUR_TEMPLATE_ID') {
    return { code: 0, data: { skipped: true, reason: '还没填模板 ID' } }
  }

  const limit = Math.min(Number(event.limit) || 50, 200)

  // 只处理最近 24 小时的，避免积压的老告警一次性轰炸用户
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const res = await db.collection('alerts')
    .where({
      notified: _.neq(true),
      createdAt: _.gte(since)
    })
    .orderBy('createdAt', 'asc')
    .limit(limit)
    .get()

  const result = { total: res.data.length, sent: 0, skipped: 0, failed: 0, details: [] }

  for (const alert of res.data) {
    const r = await sendOne(alert)
    if (r.ok) {
      result.sent++
      await db.collection('alerts').doc(alert._id).update({
        data: { notified: true, notifiedAt: db.serverDate() }
      })
    } else if (r.reason === 'no_quota' || r.reason === 'rejected') {
      // 没额度或被拒：标记为已处理，不再重试，避免每 5 分钟白跑一次
      result.skipped++
      await db.collection('alerts').doc(alert._id).update({
        data: { notified: true, notifiedAt: db.serverDate(), notifyError: r.reason }
      })
    } else {
      result.failed++
      result.details.push({ id: alert._id, err: r.err })
    }
  }

  console.log('[notify] sendPending', JSON.stringify(result))
  return { code: 0, data: result }
}

/** 发送单条预警 */
async function sendOne(alert) {
  const openid = alert.ownerOpenid
  if (!openid) return { ok: false, reason: 'no_openid' }

  // 先查额度，没额度就不用调接口了
  const quota = await getQuotaOf(openid, TEMPLATE_ID)
  if (quota <= 0) {
    console.log('[notify] 无剩余订阅额度', openid)
    return { ok: false, reason: 'no_quota' }
  }

  const whenText = formatBjTime(alert.createdAt)

  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      templateId: TEMPLATE_ID,
      page: TARGET_PAGE,
      miniprogramState: MINIPROGRAM_STATE,
      lang: 'zh_CN',
      data: buildTemplateData(alert, whenText)
    })

    // 一次性订阅：发送成功即消耗一次额度
    await decQuota(openid, TEMPLATE_ID)
    return { ok: true }
  } catch (err) {
    const code = err.errCode || err.errcode
    console.warn('[notify] 发送失败', code, err.errMsg || err.message)

    // 43101：用户拒收。额度已失效，清零避免反复重试
    if (code === 43101) {
      await resetQuota(openid, TEMPLATE_ID)
      return { ok: false, reason: 'rejected' }
    }
    return { ok: false, reason: 'error', err: `${code}: ${err.errMsg || err.message}` }
  }
}

/** 手动发一条指定预警，调试用 */
async function sendNow(event) {
  if (!event.alertId) return { code: 400, msg: '缺少 alertId' }
  const res = await db.collection('alerts').doc(event.alertId).get().catch(() => null)
  if (!res || !res.data) return { code: 404, msg: '预警不存在' }

  const r = await sendOne(res.data)
  if (r.ok) {
    await db.collection('alerts').doc(event.alertId).update({
      data: { notified: true, notifiedAt: db.serverDate() }
    })
  }
  return { code: r.ok ? 0 : 500, data: r }
}

/**
 * 调试用：尝试列出账号下的订阅消息模板。
 *
 * ⚠️ 实测不可用。该接口通过云调用会返回
 *    -501001 invalid wx openapi access_token
 *    推测微信没有把它开放给云调用通道。
 *
 * 字段名请改从后台界面获取：
 *    小程序后台 → 订阅消息 → 我的模板 → 点开模板
 *    模板内容里 {{thing1.DATA}} 这种，取 .DATA 前面的词
 *
 * 保留这个函数只是留个记录，避免以后有人再走一遍弯路。
 */
async function getTemplates() {
  try {
    const res = await cloud.openapi.subscribeMessage.getTemplateList({})
    const list = (res.data || []).map(t => ({
      templateId: t.templateId,
      title: t.title,
      // 这一行就是答案：把 {{}} 里的字段名照抄过来
      content: t.content,
      example: t.example
    }))
    return { code: 0, data: { count: list.length, list, current: TEMPLATE_ID } }
  } catch (err) {
    return {
      code: 500,
      msg: `调用失败：${err.errCode || ''} ${err.errMsg || err.message}`,
      hint: '确认 config.json 里已声明 subscribeMessage.getTemplateList 权限，且云函数已重新上传'
    }
  }
}

/**
 * 调试用：给调用者自己发一条样例通知，验证「授权 → 发送 → 收到」整条链路。
 *
 * 需要先在小程序「我的」页面点过「开启提醒推送」拿到额度，
 * 否则会因为没额度而跳过 —— 这本身也是一次有效的额度机制验证。
 */
async function testSend() {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { code: 401, msg: '未登录' }

  // 注意：必须从云函数里调用，拿到的才是调用者的 openid
  const sample = {
    ownerOpenid: OPENID,
    medicineName: '苯磺酸氨氯地平片',
    dosageText: '1片',
    deviceName: '爸妈的药盒',
    title: '检测到漏服',
    type: 'missed_dose'
  }

  const r = await sendOne(sample)
  return {
    code: r.ok ? 0 : 500,
    data: r,
    hint: r.ok
      ? '已发送，去微信「服务通知」里看看收到没有'
      : (r.reason === 'no_quota'
          ? '没有推送额度，先去小程序「我的」页面点「开启提醒推送」'
          : '发送失败，看 data.err 里的错误码')
  }
}

// ── 订阅额度管理 ────────────────────────────────────────────
// 微信的一次性订阅消息：用户每授权一次，获得 1 次推送机会。
// 所以要在用户点「开启提醒」时累加额度，发送时扣减。

async function addQuota(event) {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { code: 401, msg: '未登录' }

  // 前端用 requestSubscribeMessage 一次可以勾选多个模板，
  // 每个 accept 的模板各得 1 次额度
  const accepted = Array.isArray(event.accepted) ? event.accepted : []
  if (accepted.length === 0) return { code: 400, msg: '没有成功授权的模板' }

  const col = db.collection('subscriptions')
  const found = await col.where({ _openid: OPENID, templateId: TEMPLATE_ID }).limit(1).get()

  if (found.data.length === 0) {
    await col.add({
      data: {
        _openid: OPENID,
        templateId: TEMPLATE_ID,
        quota: accepted.length,
        acceptedAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
  } else {
    await col.doc(found.data[0]._id).update({
      data: { quota: _.inc(accepted.length), updatedAt: db.serverDate() }
    })
  }

  return { code: 0, data: { quota: await getQuotaOf(OPENID, TEMPLATE_ID) } }
}

async function getQuota() {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { code: 401, msg: '未登录' }
  return { code: 0, data: { quota: await getQuotaOf(OPENID, TEMPLATE_ID) } }
}

async function getQuotaOf(openid, templateId) {
  const res = await db.collection('subscriptions')
    .where({ _openid: openid, templateId })
    .limit(1)
    .get()
  return res.data.length ? (Number(res.data[0].quota) || 0) : 0
}

async function decQuota(openid, templateId) {
  const res = await db.collection('subscriptions')
    .where({ _openid: openid, templateId })
    .limit(1)
    .get()
  if (!res.data.length) return
  await db.collection('subscriptions').doc(res.data[0]._id).update({
    data: { quota: _.inc(-1), updatedAt: db.serverDate() }
  })
}

async function resetQuota(openid, templateId) {
  const res = await db.collection('subscriptions')
    .where({ _openid: openid, templateId })
    .limit(1)
    .get()
  if (!res.data.length) return
  await db.collection('subscriptions').doc(res.data[0]._id).update({
    data: { quota: 0, updatedAt: db.serverDate() }
  })
}

// ── 时间格式化 ──────────────────────────────────────────────

/**
 * 订阅消息 time 类型的时间文案（北京时间）。
 *
 * 官方文档给的示例是「2019年10月1日 15:01」和「15:01」两种。
 * 这里用带日期的那个 —— 漏服提醒里「哪一天」是关键信息，
 * 只写时刻的话，昨天的漏服和今天的看起来一模一样。
 *
 * 万一收到 47003 且排查到是时间字段，把它换成纯时刻试试：
 *   return `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`
 */
function formatBjTime(input) {
  const d = input ? new Date(input) : new Date()
  if (isNaN(d.getTime())) return ''
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${bj.getUTCFullYear()}年${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日 ` +
         `${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`
}
