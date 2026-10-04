import type { SupplyItem, SupplyStatus } from './types'

// 统一阈值与判定规则：储备列表、预警面板、领用清单三处只认这一份，不再各算各的。
// 实际储备量 < 预警储备量 即偏低；低于预警线的 LOW_RATIO 倍判定为需补充。
export const LOW_RATIO = 0.5
// 历史物资预警值缺失且类别也未登记时使用的兜底预警值。
export const FALLBACK_WARNING = 10

// 各物资类别的默认预警储备量与计量单位：历史缺失预警值的物资按「原类别」兼容补值。
export const CATEGORY_RULES: Record<string, { warning: number; unit: string }> = {
  灭火机具: { warning: 30, unit: '台' },
  防护装备: { warning: 80, unit: '套' },
  通信设备: { warning: 15, unit: '台' },
  水源器材: { warning: 100, unit: '件' },
  照明设备: { warning: 20, unit: '台' },
  应急给养: { warning: 200, unit: '份' },
  医疗急救: { warning: 40, unit: '箱' },
}

export const SUPPLY_STATUSES: SupplyStatus[] = ['充足', '偏低', '需补充', '已过期']

export type ItemView = SupplyItem & {
  单位: string
  生效预警量: number
  是否补值: boolean
  状态: SupplyStatus
  距到期天数: number | null
}

function toDay(value: string): number {
  // 按 UTC 日解析，避免时区把到期日前后挪一天。
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, (month ?? 1) - 1, day ?? 1) / 86400000
}

function todayDay(now: Date): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000
}

export function categoryWarning(category: string): number {
  return CATEGORY_RULES[category]?.warning ?? FALLBACK_WARNING
}

export function categoryUnit(category: string): string {
  return CATEGORY_RULES[category]?.unit ?? '件'
}

/** 生效预警量：物资自带值优先；历史缺失值按原类别默认值兼容。 */
export function effectiveWarning(item: Pick<SupplyItem, '预警储备量' | '物资类别'>): number {
  const value = item.预警储备量
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value
  }
  return categoryWarning(item.物资类别)
}

export function daysToExpire(item: Pick<SupplyItem, '到期日期'>, now: Date = new Date()): number | null {
  if (!item.到期日期) {
    return null
  }
  const today = todayDay(now)
  const expire = toDay(item.到期日期)
  if (!Number.isFinite(expire)) {
    return null
  }
  return expire - today
}

export function isExpired(item: Pick<SupplyItem, '到期日期'>, now: Date = new Date()): boolean {
  const days = daysToExpire(item, now)
  return days !== null && days < 0
}

/**
 * 统一状态判定（冲突时以实际盘点为准：盘点回写后的实际储备量是唯一输入）：
 * 1. 到期日早于今天 -> 已过期（最高优先级，过期不能补充、不能领用）；
 * 2. 实际储备量 >= 生效预警量 -> 充足；
 * 3. 实际储备量 >= 生效预警量 × LOW_RATIO -> 偏低；
 * 4. 再低 -> 需补充。
 */
export function resolveStatus(
  item: Pick<SupplyItem, '实际储备量' | '预警储备量' | '物资类别' | '到期日期'>,
  now: Date = new Date(),
): SupplyStatus {
  if (isExpired(item, now)) {
    return '已过期'
  }
  const warning = effectiveWarning(item)
  const actual = item.实际储备量
  if (actual >= warning) {
    return '充足'
  }
  if (actual >= warning * LOW_RATIO) {
    return '偏低'
  }
  return '需补充'
}

/** 是否短缺（偏低或需补充都进入预警面板并产生补充待办）。 */
export function isShort(status: SupplyStatus): boolean {
  return status === '偏低' || status === '需补充'
}

export function decorateItem(item: SupplyItem, now: Date = new Date()): ItemView {
  return {
    ...item,
    单位: item.单位 || categoryUnit(item.物资类别),
    生效预警量: effectiveWarning(item),
    是否补值: item.预警值补值 === true,
    状态: resolveStatus(item, now),
    距到期天数: daysToExpire(item, now),
  }
}
