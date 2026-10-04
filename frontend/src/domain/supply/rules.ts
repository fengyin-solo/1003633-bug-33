import type { SupplyRow, SupplyStatus } from './types'

/**
 * 统一阈值：历史缺失预警值的物资按「原类别」兼容补值；
 * 类别也对不上时用全局兜底值，保证每条物资都有可判定的阈值。
 */
export const DEFAULT_THRESHOLD = 30
export const LOW_RATIO = 0.8

export const CATEGORY_THRESHOLDS: Record<string, number> = {
  灭火机具: 20,
  防护装备: 40,
  通信设备: 8,
  照明设备: 12,
  水源器材: 15,
  宿营物资: 10,
  其他物资: DEFAULT_THRESHOLD,
}

/** 偏低线 = 预警值 × 80%：低于预警线但还在 80% 以上判「偏低」，更低判「需补充」。 */
export function lowLine(threshold: number): number {
  return Math.round(threshold * LOW_RATIO)
}

export function thresholdFor(category: string): number {
  return CATEGORY_THRESHOLDS[category] ?? DEFAULT_THRESHOLD
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value)
  }
  const parsed = Number.parseFloat(String(value ?? '').trim())
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : -1
}

/** 唯一状态入口：冲突时以实际盘点（实际储备量、过期标记）为准。 */
export function deriveStatus(row: Pick<SupplyRow, '实际储备量' | '预警储备量' | '过期'>): SupplyStatus {
  if (row.过期) {
    return '已过期'
  }
  if (row.实际储备量 < row.预警储备量) {
    return row.实际储备量 < lowLine(row.预警储备量) ? '需补充' : '偏低'
  }
  return '充足'
}

/** 看板/列表通用字段 pending、abnormal 也按统一规则派生。 */
export function isPending(status: SupplyStatus): boolean {
  return status === '偏低' || status === '需补充'
}

export type Normalized = Pick<
  SupplyRow,
  '单位' | '预警储备量' | '实际储备量' | '有效期至' | '过期' | '阈值来源' | 'status' | 'pending' | 'abnormal'
>

/**
 * 把任意来源（示例数据、旧版本 localStorage、导入回执）的一条物资归一成统一形态。
 * 预警值缺失或不是有效数字时：先按原类别补，类别无配置再用全局默认值。
 */
export function normalizeSupply(raw: Record<string, unknown>, categoryFallback = '其他物资'): Normalized {
  const category = String(raw['物资类别'] ?? categoryFallback).trim() || categoryFallback
  const rawThreshold = toNumber(raw['预警储备量'])
  let threshold: number
  let source: SupplyRow['阈值来源']
  if (rawThreshold >= 0) {
    threshold = rawThreshold
    source = '原始值'
  } else if (CATEGORY_THRESHOLDS[category] !== undefined) {
    threshold = CATEGORY_THRESHOLDS[category]
    source = '类别补值'
  } else {
    threshold = DEFAULT_THRESHOLD
    source = '默认补值'
  }
  const actualRaw = toNumber(raw['实际储备量'])
  const actual = actualRaw >= 0 ? actualRaw : 0
  const expired = raw['过期'] === true || String(raw['status'] ?? '') === '已过期'
  const status = deriveStatus({ 实际储备量: actual, 预警储备量: threshold, 过期: expired })
  return {
    单位: String(raw['单位'] ?? '件'),
    预警储备量: threshold,
    实际储备量: actual,
    有效期至: String(raw['有效期至'] ?? ''),
    过期: expired,
    阈值来源: source,
    status,
    pending: isPending(status),
    abnormal: status === '已过期',
  }
}

/** 一次补充的建议数量：按预警值整批补足，保证补完状态回到「充足」。 */
export function replenishQuantity(actual: number, threshold: number): number {
  if (actual >= threshold) {
    return 0
  }
  // 缺口不足一个预警批量时，仍按一个预警批量补货，避免刚补完又掉回预警线。
  return Math.max(threshold, threshold - actual)
}

/** 未完成的补充待办：实际储备量与预警线之间的缺口。 */
export function gapQuantity(actual: number, threshold: number): number {
  return Math.max(0, threshold - actual)
}
