import type { EntryRow } from '@/data/types'

/** 防火物资统一状态：储备列表、预警面板、领用清单都以此为准，不再各写一份。 */
export type SupplyStatus = '充足' | '偏低' | '需补充' | '已过期'

/**
 * 物资行。预警储备量/实际储备量统一为数值；历史数据里的字符串脏值在迁移阶段兜底。
 * 阈值来源记录预警值的来历，便于追溯补值。
 */
export type SupplyRow = EntryRow & {
  物资编号: string
  物资名称: string
  物资类别: string
  规格型号: string
  储备林场: string
  单位: string
  预警储备量: number
  实际储备量: number
  有效期至: string
  过期: boolean
  阈值来源: '原始值' | '类别补值' | '默认补值'
}

export type LedgerType = '领用扣减' | '补充入库' | '盘点调整'

/** 库存与领用之间的流水：每次实物数量变化只写一条，重复领用靠 token 幂等不会产生第二条。 */
export type LedgerEntry = {
  id: number
  类型: LedgerType
  单号: string
  token: string
  时间: string
  物资id: number
  物资编号: string
  物资名称: string
  数量: number
  变动前: number
  变动后: number
  领用人: string
  用途: string
  备注: string
}

export type TodoStatus = '待处理' | '已完成' | '已取消'

/** 补充待办：实际储备量跌破预警线时生成，同一物资同时最多一条未完成待办。 */
export type ReplenishTodo = {
  id: number
  物资id: number
  物资编号: string
  物资名称: string
  缺口数量: number
  创建时间: string
  状态: TodoStatus
  关联单号: string
  完成时间: string
  备注: string
}

export type SupplyDB = {
  supplies: SupplyRow[]
  ledger: LedgerEntry[]
  todos: ReplenishTodo[]
  tokens: string[]
}
