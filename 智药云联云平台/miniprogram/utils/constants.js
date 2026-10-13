// 全局常量与枚举

/** 药仓数量：基础版 4 仓，专业版 6 仓 */
const BAY_COUNT = 6

/** 服药状态 → 展示文案与标签样式 */
const STATUS_MAP = {
  on_time:  { label: '按时',   tag: 'tag-on_time' },
  early:    { label: '提前',   tag: 'tag-early' },
  late:     { label: '延迟',   tag: 'tag-late' },
  missed:   { label: '漏服',   tag: 'tag-missed' },
  upcoming: { label: '待服用', tag: 'tag-upcoming' },
  pending:  { label: '待确认', tag: 'tag-pending' }
}

/** 记录来源 → 文案。视觉确认是本项目的差异化能力，单独标出来 */
const SOURCE_MAP = {
  sensor:           '药盒感应',
  vision_confirmed: '视觉确认',
  manual:           '手动补录',
  auto:             '系统判定'
}

/** 预警类型 → 文案 */
const ALERT_TYPE_MAP = {
  missed_dose:    '漏服提醒',
  low_stock:      '库存不足',
  device_offline: '设备离线'
}

/** 服药时间与进餐关系 */
const MEAL_RELATIONS = ['饭前', '饭后', '随餐', '空腹', '睡前', '不限']

/** 常用慢性病标签，档案里做多选 */
const CONDITION_OPTIONS = [
  '高血压', '糖尿病', '冠心病', '高血脂',
  '脑梗后遗症', '慢性肾病', '关节炎', '青光眼'
]

/** 依从性分级 */
const ADHERENCE_LEVELS = [
  { min: 90, label: '优秀',   color: '#2E7D6F' },
  { min: 75, label: '良好',   color: '#4A9D8E' },
  { min: 60, label: '一般',   color: '#E8A33D' },
  { min: 0,  label: '需关注', color: '#D9534F' }
]

function levelOf(score) {
  if (score === null || score === undefined) return null
  return ADHERENCE_LEVELS.find(l => score >= l.min) || ADHERENCE_LEVELS[ADHERENCE_LEVELS.length - 1]
}

module.exports = {
  BAY_COUNT,
  STATUS_MAP,
  SOURCE_MAP,
  ALERT_TYPE_MAP,
  MEAL_RELATIONS,
  CONDITION_OPTIONS,
  ADHERENCE_LEVELS,
  levelOf
}
