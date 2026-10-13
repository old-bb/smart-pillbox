// wx-server-sdk 的本地测试替身
// 用内存对象模拟云数据库，让云函数能在本地 node 里直接跑，
// 不消耗云开发额度，也不需要每次改代码都上传部署。
//
// 支持：where / doc / add / get / count / update / remove /
//       orderBy / limit / skip / command(inc,gte,lte,in,and) / serverDate

const store = {}
let idSeq = 0

function nextId() {
  idSeq += 1
  return `id_${String(idSeq).padStart(6, '0')}`
}

// ── command ──────────────────────────────────────────────
const command = {
  inc: (n) => ({ __op: 'inc', value: n }),
  gte: (v) => ({
    __op: 'range',
    gte: v,
    // 支持 _.gte(a).and(_.lte(b)) 的链式写法
    and(other) {
      return { __op: 'range', gte: v, lte: other.__val }
    }
  }),
  lte: (v) => ({ __op: 'lte', __val: v }),
  in: (arr) => ({ __op: 'in', value: arr })
}

/** 判断一条文档是否满足 where 条件 */
function match(doc, where) {
  for (const key of Object.keys(where)) {
    const cond = where[key]
    let val = doc[key]

    if (cond instanceof Date) {
      val = new Date(val).getTime()
      if (val !== cond.getTime()) return false
      continue
    }

    if (cond && typeof cond === 'object' && cond.__op) {
      const cmp = val instanceof Date ? val.getTime() : val
      const asNum = (x) => (x instanceof Date ? x.getTime() : x)

      if (cond.__op === 'inc') continue           // inc 只用于 update
      if (cond.__op === 'range') {
        if (cmp < asNum(cond.gte)) return false
        if (cond.lte !== undefined && cmp > asNum(cond.lte)) return false
      } else if (cond.__op === 'lte') {
        if (cmp > asNum(cond.__val)) return false
      } else if (cond.__op === 'in') {
        if (!cond.value.includes(val)) return false
      }
      continue
    }

    if (val !== cond) return false
  }
  return true
}

/** 应用 update 的 data，处理 inc 自增 */
function applyUpdate(doc, data) {
  for (const key of Object.keys(data)) {
    const v = data[key]
    if (v && typeof v === 'object' && v.__op === 'inc') {
      doc[key] = (Number(doc[key]) || 0) + v.value
    } else {
      doc[key] = v
    }
  }
}

// ── 查询构造器 ────────────────────────────────────────────
function makeQuery(name, where = {}, sort = null, lim = null, skp = 0) {
  return {
    where(w) {
      return makeQuery(name, { ...where, ...w }, sort, lim, skp)
    },
    orderBy(field, dir) {
      return makeQuery(name, where, { field, dir }, lim, skp)
    },
    limit(n) {
      return makeQuery(name, where, sort, n, skp)
    },
    skip(n) {
      return makeQuery(name, where, sort, lim, n)
    },
    async get() {
      let list = (store[name] || []).filter(d => match(d, where))
      if (sort) {
        list = list.slice().sort((a, b) => {
          const av = a[sort.field], bv = b[sort.field]
          const r = av > bv ? 1 : av < bv ? -1 : 0
          return sort.dir === 'desc' ? -r : r
        })
      }
      if (skp) list = list.slice(skp)
      if (lim !== null) list = list.slice(0, lim)
      return { data: JSON.parse(JSON.stringify(list)) }
    },
    async count() {
      return { total: (store[name] || []).filter(d => match(d, where)).length }
    },
    async update({ data }) {
      let updated = 0
      for (const doc of store[name] || []) {
        if (match(doc, where)) {
          applyUpdate(doc, data)
          updated += 1
        }
      }
      return { stats: { updated } }
    },
    async remove() {
      const before = (store[name] || []).length
      store[name] = (store[name] || []).filter(d => !match(d, where))
      return { stats: { removed: before - store[name].length } }
    }
  }
}

function makeCollection(name) {
  if (!store[name]) store[name] = []
  return {
    where: (w) => makeQuery(name).where(w),
    orderBy: (f, d) => makeQuery(name).orderBy(f, d),
    limit: (n) => makeQuery(name).limit(n),
    skip: (n) => makeQuery(name).skip(n),
    get: () => makeQuery(name).get(),
    count: () => makeQuery(name).count(),
    update: (a) => makeQuery(name).update(a),
    remove: () => makeQuery(name).remove(),

    doc(id) {
      return {
        async get() {
          const found = (store[name] || []).find(d => d._id === id)
          if (!found) throw new Error('document not found')
          return { data: JSON.parse(JSON.stringify(found)) }
        },
        async update({ data }) {
          const found = (store[name] || []).find(d => d._id === id)
          if (!found) throw new Error('document not found')
          applyUpdate(found, data)
          return { stats: { updated: 1 } }
        },
        async remove() {
          store[name] = (store[name] || []).filter(d => d._id !== id)
          return { stats: { removed: 1 } }
        }
      }
    },

    async add({ data }) {
      const _id = data._id || nextId()
      store[name].push({ ...data, _id })
      return { _id }
    }
  }
}

// ── 导出替身 ──────────────────────────────────────────────
const db = {
  collection: makeCollection,
  command,
  serverDate: () => new Date(),
  createCollection: async () => ({ ok: true })
}

let wxContext = { OPENID: 'test-openid', APPID: 'test-appid', UNIONID: '' }

module.exports = {
  init: () => {},
  DYNAMIC_CURRENT_ENV: 'dynamic',
  getWXContext: () => wxContext,
  database: () => db,

  // ── 测试辅助 ──
  __store: store,
  __reset() {
    for (const k of Object.keys(store)) delete store[k]
    idSeq = 0
    wxContext = { OPENID: 'test-openid', APPID: 'test-appid', UNIONID: '' }
  },
  __setOpenid(openid) {
    wxContext = { ...wxContext, OPENID: openid }
  },
  __seed(name, docs) {
    if (!store[name]) store[name] = []
    for (const d of docs) {
      store[name].push({ ...d, _id: d._id || nextId() })
    }
  }
}
