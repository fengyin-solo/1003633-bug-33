/** 物资库存域类型：储备、预警、领用、待办、盘点共用同一份数据结构。 */

export type SupplyStatus = '充足' | '偏低' | '需补充' | '已过期'

export type SupplyItem = {
  id: number
  物资编号: string
  物资名称: string
  物资类别: string
  规格型号: string
  储备林场: string
  单位: string
  /** 预警储备量：历史数据可能缺失（null），缺失时按「物资类别」的类别阈值兼容。 */
  预警储备量: number | null
  /** 预警储备量是否由类别默认值补值得来（true 表示原值缺失）。 */
  预警值补值: boolean
  实际储备量: number
  /** 到期日期（YYYY-MM-DD）：早于判定日即为已过期。 */
  到期日期: string
}

export type RequisitionStatus = '已发放' | '已撤销' | '已驳回'

export type RequisitionRecord = {
  id: number
  /** 领用流水号：同一流水号重复提交只扣一次（幂等键，也是并发去重键）。 */
  领用流水号: string
  物资编号: string
  领用单位: string
  领用人: string
  领用数量: number
  /** 扣减前实际储备量。 */
  扣减前数量: number
  /** 扣减后实际储备量；未扣减（重复提交命中）时为 null。 */
  扣减后数量: number | null
  状态: RequisitionStatus
  备注: string
  领用时间: string
}

export type TodoStatus = '待处理' | '已完成'

export type SupplyTodo = {
  id: number
  物资编号: string
  类型: '补充'
  内容: string
  状态: TodoStatus
  创建时间: string
  关闭时间: string | null
}

export type StocktakeStatus = '待回执' | '已回执'

export type StocktakeLine = {
  物资编号: string
  物资名称: string
  账面数量: number
  盘点数量: number | null
  差异数量: number | null
  备注: string
}

export type StocktakeOrder = {
  id: number
  盘点单号: string
  盘点林场: string
  盘点日期: string
  状态: StocktakeStatus
  明细: StocktakeLine[]
  回执说明: string
  回执时间: string | null
  回执人: string
}

export type SupplyDB = {
  version: number
  items: SupplyItem[]
  requisitions: RequisitionRecord[]
  todos: SupplyTodo[]
  stocktakes: StocktakeOrder[]
  seq: number
}

export type ServiceResult<T = undefined> = {
  ok: boolean
  message: string
  data?: T
}
