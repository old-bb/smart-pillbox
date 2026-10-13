# 智药云联 · 云平台

「银发守护·智药云联」项目的云端平台与子女端小程序。
项目编号：202610042210　｜　技术栈：微信小程序 + 微信云开发（Serverless）

---

## 一、这是什么

老人端的智能药盒负责**提醒与采集**，本平台负责**存储、分析与呈现**：

```
┌──────────────┐   上报服药事件    ┌─────────────────┐   子女查看    ┌──────────┐
│ 智能药盒      │ ───────────────▶ │  云函数（Node）  │ ───────────▶ │ 小程序端  │
│ Orange Pi 4  │                  │  云数据库        │              │ 子女手机  │
│ + 摄像头     │ ◀─────────────── │  （文档型）      │ ◀─────────── │          │
└──────────────┘   下发用药计划    └─────────────────┘   配置计划    └──────────┘
```

**当前阶段**：云平台 v1.0（中期检查交付物）
**不做**：O2O 购药对接、药师在线咨询、数据 B 端输出（计划书里排在后期）

---

## 二、目录结构

```
智药云联云平台/
├── project.config.json          微信开发者工具项目配置
├── README.md                    本文件
├── cloudfunctions/              云函数（服务端，Node.js）
│   ├── login/                   登录 / 用户初始化
│   ├── elder/                   老人档案 CRUD
│   ├── device/                  药盒设备绑定与管理
│   ├── plan/                    用药计划 CRUD
│   ├── record/                  服药记录查询 / 设备事件上报
│   ├── dashboard/               首页看板聚合数据
│   ├── analytics/               依从性评分 / 库存预警 / 提醒列表
│   ├── notify/                  订阅消息推送（含 5 分钟定时触发器）
│   └── init/                    数据库集合初始化（一次性）
├── tests/                       本地测试（不需要联网、不消耗云资源）
│   ├── run.js                   测试用例入口
│   └── wx-server-sdk-stub.js    云数据库的内存替身
└── miniprogram/                 小程序（子女端）
    ├── app.js / app.json / app.wxss
    ├── utils/
    │   ├── constants.js         常量与枚举
    │   ├── format.js            日期 / 文案格式化
    │   ├── api.js               云函数调用封装
    │   ├── chart.js             趋势图绘制（canvas 2d）
    │   └── subscribe.js         订阅消息授权
    └── pages/
        ├── index/               首页看板
        ├── records/             服药记录
        ├── plans/               用药计划管理
        ├── device/              药盒设备管理
        └── profile/             我的
```

---

## 三、部署步骤（照做即可）

### 步骤 1：注册小程序并拿到 AppID

1. 访问 https://mp.weixin.qq.com/ ，注册**个人**小程序（免费，无需企业主体）
2. 注册完成后，在「开发 → 开发管理 → 开发设置」里找到 **AppID**，复制备用
   ⚠️ 一定要注册正式小程序拿 AppID。**测试号不支持云开发。**

### 步骤 2：导入项目

1. 下载安装「微信开发者工具」（稳定版即可）
2. 打开工具 → 导入项目 → 目录选择本文件夹（`智药云联云平台/`）
3. AppID 填步骤 1 拿到的，后端服务选「**微信云开发**」

### 步骤 3：开通云开发环境

1. 工具顶部点「云开发」按钮 → 开通（选**按量付费**，用免费额度，不产生费用）
2. 环境创建完成后，在「云开发控制台 → 设置 → 环境 ID」复制**环境 ID**
3. 打开 `miniprogram/app.js`，把第 8 行的 `YOUR_ENV_ID` 替换成这个环境 ID：

```js
globalData: {
  env: 'YOUR_ENV_ID',   // ← 改成你的环境 ID，形如 zhihyao-1a2b3c4d
  ...
}
```

### 步骤 4：上传云函数

依次右键 `cloudfunctions/` 下的每个文件夹 → 「**上传并部署：云端安装依赖**」

要上传的 9 个：`login`、`elder`、`device`、`plan`、`record`、`dashboard`、`analytics`、`notify`、`init`

> `notify` 带定时触发器（`config.json` 里配的，每 5 分钟跑一次）。
> 上传后在云开发控制台 → 云函数 → `notify` → 「触发器」确认它建好了。

> 如果右键没有这个选项，检查 `project.config.json` 里的 `cloudfunctionRoot` 是否指向 `cloudfunctions/`。

### 步骤 5：初始化数据库

1. 在云开发控制台 → 云函数 → 找到 `init` → 「云端测试」，参数填 `{}`，点运行
2. 看到返回 `code: 0` 即成功，会自动创建 8 个集合

### 步骤 6：设置数据库权限（重要）

云开发控制台 → 数据库 → 逐个集合 → 权限设置 → 选「**所有用户不可读写**」

**8 个集合全部设成这个。** 原因：服药数据属于个人健康信息，受《个人信息保护法》约束。
所有读写都经云函数（服务端）完成，客户端一次都没直连过数据库，所以直接关掉是安全且语义准确的。
（控制台和服务端始终有完整读写权限，云函数不受影响。）

> 这条设计对应计划书里肖開太负责的「数据安全与隐私保护」章节，
> 中期答辩时可以作为技术亮点说明。

### 步骤 7：跑起来

回到开发者工具，点击「编译」。用微信扫码预览即可。

**没有真实药盒也能测**：`device` 云函数的 `bind` 动作支持绑定测试设备，
上报事件用 `record` 云函数的 `report` 动作（见第五节）。

---

## 四、数据库设计

### 集合一览

| 集合 | 说明 | 关键字段 |
|---|---|---|
| `users` | 用户（子女） | `_openid`、`nickName`、`avatarUrl` |
| `elders` | 老人档案 | `_openid`、`name`、`age`、`conditions[]` |
| `devices` | 药盒设备 | `deviceId`、`bindCode`、`elderId`、`battery`、`online` |
| `plans` | 用药计划 | `deviceId`、`bayIndex`、`medicineName`、`times[]`、`stock` |
| `records` | 服药记录 | `deviceId`、`planId`、`scheduledAt`、`status`、`actualAt` |
| `medicines` | 药品字典 | `name`、`spec`、`usage`、`cautions` |
| `alerts` | 预警消息 | `elderId`、`type`、`level`、`read`、`notified` |
| `subscriptions` | 订阅消息授权额度 | `_openid`、`templateId`、`quota` |

### 关键枚举

**药仓编号 `bayIndex`**：`0` ~ `5`，对应药盒上从上到下的 6 个仓（基础版 4 仓用 `0`~`3`）

**记录状态 `records.status`**：

| 值 | 含义 | 计分 |
|---|---|---|
| `on_time` | 按时服用（计划时间 ±30 分钟内） | 1.0 |
| `late` | 延迟服用（当天补服，但超时） | 0.5 |
| `missed` | 漏服（当天无记录） | 0 |
| `extra` | 计划外服用 | 不计入分母 |

**预警类型 `alerts.type`**：`missed_dose`（漏服）、`low_stock`（库存不足）、`device_offline`（设备离线）

### 索引建议

数据量上来后在云开发控制台手动添加：

- `records`：`deviceId` + `scheduledAt`（联合索引，倒序）
- `plans`：`deviceId` + `active`
- `alerts`：`elderId` + `read`

---

## 五、云函数 API

所有云函数统一返回 `{ code, msg, data }`，`code === 0` 表示成功。
除 `login` 外，全部通过 `event.action` 区分动作。

### login
```js
wx.cloud.callFunction({ name: 'login' })
// → { code: 0, data: { openid } }
```

### elder — 老人档案
```js
{ action: 'list' }                                    // 列表
{ action: 'save', data: { _id?, name, age, gender, conditions: [] } }
{ action: 'delete', id }
```

### device — 药盒设备
```js
{ action: 'list' }                                    // 我的设备
{ action: 'bind', bindCode: 'ABC123', elderId }       // 绑定
{ action: 'unbind', id }
{ action: 'updateBays', id, bays: [{ index, medicineName, customVoice }] }
```

### plan — 用药计划
```js
{ action: 'list', deviceId }
{ action: 'save', data: { _id?, deviceId, bayIndex, medicineName, dosage,
                          times: ['08:00'], mealRelation, stock, dailyConsumption } }
{ action: 'delete', id }
```

### record — 服药记录
```js
{ action: 'list', deviceId?, startDate?, endDate?, page, pageSize }
{ action: 'report', deviceId, bayIndex, eventType, timestamp }   // 设备上报
```

`eventType` 取值：`lid_open`（开盖）、`taken`（取药）、`vision_confirmed`（视觉确认已取走）

### dashboard — 首页看板
```js
{ action: 'summary', elderId }
// → { code: 0, data: { todayPlans, todayRecords, adherence, alerts, device } }
```

### analytics — 统计分析
```js
{ action: 'adherence', elderId, days }     // days: 7 | 30
{ action: 'checkStock', deviceId }          // 库存检查并生成预警
{ action: 'alerts', elderId, onlyUnread }
{ action: 'readAlert', id }
```

### notify — 订阅消息推送
```js
{ action: 'sendPending' }              // 扫描未推送的预警并发送（定时器每5分钟自动调）
{ action: 'sendNow', alertId }         // 手动发一条，调试用
{ action: 'addQuota', accepted: [] }   // 用户授权后累加推送额度
{ action: 'getQuota' }                 // 查询剩余额度
```

### init — 初始化
```js
{}   // 创建全部集合，可重复执行（幂等）
```

---

## 六、依从性评分算法

对应计划书 2.3.2 节「构建用药依从性评分模型」。

对统计周期内的每一个「应服时点」（由 `plans.times` 展开生成），与 `records` 比对：

```
得分 = (按时次数 × 1.0 + 提前次数 × 0.8 + 延迟次数 × 0.5) / 应服总次数 × 100
```

**判定规则**：
- `on_time`：实际服药时间在计划时间 **±30 分钟**内
- `early`：早于计划时间 30 分钟以上
- `late`：在计划时间之后、当天 24:00 之前服下
- `missed`：当天 24:00 仍无记录
- `extra`：计划外服用，**不计入分母**

对应源码 `cloudfunctions/analytics/index.js` 的权重表：

```js
const SCORE_WEIGHT = {
  on_time: 1.0,
  early: 0.8,
  late: 0.5,
  missed: 0,
  extra: null   // null = 不计入分母
}
```

**分级**：`≥90 优秀` / `75~89 良好` / `60~74 一般` / `<60 需关注`

> 说明：权重的依据是——延迟服药仍有一定疗效，但风险高于按时服用；
> 漏服则完全无疗效。中期阶段采用这个简化模型，
> 后续可引入计划书里提到的「漏服风险预测模型」做加权。

---

## 七、库存预警算法

对应计划书 3.1.2 节「即时配送闭环设计」的第一步。

```
剩余天数 = plans.stock / plans.dailyConsumption
```

每次 `taken` 事件上报时，`stock` 自动减去当日单次用量。
当 **剩余天数 ≤ 7** 时，生成 `low_stock` 预警，推送到子女端首页。

---

## 八、订阅消息推送配置

推送要真正发得出去，还差下面这几步。**申请模板要走审核，周期不可控，越早申请越好。**

### 1. 申请模板

小程序后台 → 「**订阅消息**」→ 公共模板库 → 搜「用药」「服药」类关键词，选用合适的模板。

⚠️ 大概率只能选到**一次性订阅**。长期订阅对服务类目有要求，个人主体基本拿不到。

> **一次性订阅的规则**：用户每授权一次，开发者获得 **1 次**推送机会。额度用完就得让用户再授权。
> 所以「我的」页面里做了额度提醒，低于 2 次会变黄提示补充。

申请通过后记下两样东西：**模板 ID** 和 **字段名**（形如 `thing1` / `time2`）。

### 2. 填模板 ID（两处）

- `miniprogram/utils/subscribe.js` → `TEMPLATE_IDS`
- `cloudfunctions/notify/index.js` → `TEMPLATE_ID`

### 3. 改字段映射

打开 `cloudfunctions/notify/index.js` 的 `buildTemplateData()`，
把它返回的 key 改成你模板的**真实字段名**。字段名对不上会直接报 `47003`。

字段类型规则：

| 类型 | 含义 | 限制 |
|---|---|---|
| `thing` | 文本 | **20 字以内**，超了报错（代码里已做截断） |
| `time` | 时间 | `YYYY-MM-DD HH:mm` |
| `number` | 数字 | — |
| `phrase` | 枚举短语 | 必须与模板定义完全一致 |

代码里已经写好了一个默认映射（`thing1` 标题 / `thing2` 内容 / `time3` 时间），
如果你的模板是这个组合，改完 ID 就能直接用。

### 4. 验证

1. 重新上传 `notify` 云函数
2. 小程序里进「我的」→ 开启提醒推送（授权）
3. 造一条预警：把某个计划的库存改小，再点一次「模拟上报」
4. 等最多 5 分钟（定时器周期），或直接在云开发控制台手动跑 `notify` 的 `sendPending`

---

## 九、上传体验版（发给评委用）

**中期检查不需要发布正式版。** 体验版功能完整，且不涉及类目资质审核。

1. 开发者工具点右上角「**上传**」，填版本号和备注
2. 小程序后台 → 版本管理 → 开发版本 → 找到刚上传的 → 点「**选为体验版**」
3. 生成体验版二维码，下载
4. 把二维码发给评委和老师 —— 他们扫码就能用自己的手机试

> ⚠️ 体验版推送消息时，要改 `notify/index.js` 里的 `MINIPROGRAM_STATE`。
> 三个值：`developer`（开发版，自己调试用） / `trial`（体验版） / `formal`（正式版）。
> 不改的话，体验版用户收不到推送。

---

## 十、本地测试

云函数可以直接在本地跑，**不需要联网、不消耗云开发额度、不用每次改代码都上传部署**。

```bash
cd 智药云联云平台
node tests/run.js
```

原理：`tests/wx-server-sdk-stub.js` 用内存对象实现了云数据库的核心接口
（`where` / `doc` / `add` / `get` / `count` / `update` / `remove` / `command` 等），
`tests/run.js` 启动时把 `require('wx-server-sdk')` 重定向到这个替身，
然后直接调用云函数的 `exports.main()`。

**当前覆盖 50 项**，重点是三处最容易错的地方：

- **时区判定**：北京时间 08:00 的药，在 UTC 环境里必须正确判定。
  测了 `08:05→按时`、`08:31→延迟`（边界）、`07:20→提前`（跨 UTC 日界）、
  以及 `19:50` 必须匹配到 20:00 而不是早上的时点。
- **依从性计分**：`3 按时 + 1 延迟 + 1 漏服 = 70 分`，以及账号间数据不能串。
- **设备心跳**：硬件端无 OPENID 时必须能上报成功（走 token 鉴权），
  且错误 token 被拒后不得改动设备状态。这一组是回归测试 ——
  `device` 云函数原先没有测试覆盖，导致心跳恒返回 401 的缺陷没被 CI 拦住。

另外覆盖了：库存扣减幂等、视觉确认升级、设备鉴权、越权拦截、同一药仓防冲突。

改完云函数先跑一遍再上传，能省掉大量"传上去才发现报错"的时间。

---

## 十一、开发进度

- [x] 数据库设计
- [x] 云函数：登录 / 档案 / 设备 / 计划 / 记录 / 看板 / 统计 / 推送
- [x] 小程序：首页看板、服药记录、用药计划、设备管理、我的
- [x] 依从性评分算法
- [x] 库存预警算法
- [x] 7 天依从性趋势图
- [x] 订阅消息推送（**待填模板 ID**，见第八节）
- [x] 补药引导（复制药名，一键下单需企业合作）
- [ ] 真实设备对接联调
- [ ] O2O 平台 API 对接（需企业资质）

### 已知限制

**美团买药 / 京东药急送的开放 API 不对个人开发者开放**，需要企业资质走商务合作。
当前版本的「去补药」做的是**复制药名**，下单仍在外卖 App 完成。
这个限制在中期报告书里应当如实说明 —— 比含糊过去好，因为它同时说明团队
搞清楚了业务边界，而不是没想到这一步。

---

## 十二、与硬件端对接

硬件端（Orange Pi 4 Pro）上报事件的三种方式，按推荐顺序：

**方式 1：云函数 HTTP 触发（推荐）**
在云开发控制台为 `record` 云函数配置 HTTP 访问路径，设备端直接 POST：

```bash
curl -X POST https://<你的环境ID>.service.tcloudbase.com/record \
  -H "Content-Type: application/json" \
  -d '{"action":"report","deviceId":"BOX001","bayIndex":0,"eventType":"voice_confirmed"}'
```

**方式 2：云调用**（若硬件端接入了微信生态）

**方式 3：手动录入**（开发调试阶段）
直接用小程序里的"补录"按钮，或调 `record.save` 动作。

⚠️ **安全提示**：方式 1 需要加设备鉴权（设备密钥签名），
不能让任何人拿到 URL 就能伪造服药记录。这部分由肖開太负责设计，
中期阶段可先用固定 token 占位。
