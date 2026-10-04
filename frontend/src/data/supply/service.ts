import { commitSupply, getSupplyDB } from './store'
import { toCsv, parseCsv } from './csv'
import {
  decorateItem,
  isExpired,
  isShort,
  resolveStatus,
  type ItemView,
} from './rules'
import type {
  RequisitionRecord,
  ServiceResult,
  StocktakeLine,
  StocktakeOrder,
  SupplyItem,
  SupplyStatus,
  SupplyTodo,
} from './types'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function dateText(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function dateTimeText(date: Date): string {
  return `${dateText(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function shiftDays(base: Date, days: number): string {
  const next = new Date(base)
  next.setDate(next.getDate() + days)
  return dateText(next)
}

function findItem(draft: { items: SupplyItem[] }, code: string): SupplyItem | undefined {
  return draft.items.find((item) => item.物资编号 === code.trim())
}

function todoContent(item: SupplyItem, view: Pick<ItemView, '生效预警量' | '单位'>): string {
  return `${item.物资名称}（${item.物资编号}）实际储备 ${item.实际储备量}${view.单位}，低于预警线 ${view.生效预警量}${view.单位}，请发起补充`
}

/**
 * 待办与库存状态同生共灭：短缺则挂补充待办（内容随盘点数量刷新），补足或过期则关闭。
 * 与库存修改处于同一事务，避免预警更新了、待办还挂着的不一致。
 */
function syncTodos(draft: { items: SupplyItem[]; todos: SupplyTodo[] }, now: Date): void {
  for (const item of draft.items) {
    const view = decorateItem(item, now)
    const open = draft.todos.find((todo) => todo.物资编号 === item.物资编号 && todo.状态 === '待处理')
    if (isShort(view.状态)) {
      if (open) {
        open.内容 = todoContent(item, view)
      } else {
        draft.todos.push({
          id: draft.todos.length === 0 ? 1 : Math.max(...draft.todos.map((todo) => todo.id)) + 1,
          物资编号: item.物资编号,
          类型: '补充',
          内容: todoContent(item, view),
          状态: '待处理',
          创建时间: dateTimeText(now),
          关闭时间: null,
        })
      }
    } else if (open) {
      open.状态 = '已完成'
      open.关闭时间 = dateTimeText(now)
    }
  }
}

// ---------- 储备列表 / 预警面板 ----------

export type SupplyFilter = {
  keyword?: string
  物资类别?: string
  储备林场?: string
  状态?: SupplyStatus | ''
}

export function listSupplyItems(filter: SupplyFilter = {}): ItemView[] {
  const now = new Date()
  const keyword = (filter.keyword ?? '').trim()
  return getSupplyDB()
    .items.map((item) => decorateItem(item, now))
    .filter((view) => {
      if (filter.物资类别 && view.物资类别 !== filter.物资类别) {
        return false
      }
      if (filter.储备林场 && view.储备林场 !== filter.储备林场) {
        return false
      }
      if (filter.状态 && view.状态 !== filter.状态) {
        return false
      }
      if (keyword) {
        return [view.物资编号, view.物资名称, view.物资类别, view.规格型号, view.储备林场]
          .some((value) => value.includes(keyword))
      }
      return true
    })
}

export function listWarnings(): ItemView[] {
  const rank: Record<SupplyStatus, number> = { 已过期: 0, 需补充: 1, 偏低: 2, 充足: 3 }
  return listSupplyItems()
    .filter((view) => view.状态 !== '充足')
    .sort((a, b) => rank[a.状态] - rank[b.状态] || a.物资编号.localeCompare(b.物资编号))
}

export function supplyFacets(): { categories: string[]; forests: string[] } {
  const items = getSupplyDB().items
  return {
    categories: [...new Set(items.map((item) => item.物资类别))].sort(),
    forests: [...new Set(items.map((item) => item.储备林场))].sort(),
  }
}

export function supplyStats() {
  const views = getSupplyDB().items.map((item) => decorateItem(item))
  const count = (status: SupplyStatus) => views.filter((view) => view.状态 === status).length
  return {
    total: views.length,
    short: views.filter((view) => isShort(view.状态)).length,
    expired: count('已过期'),
    low: count('偏低'),
    need: count('需补充'),
    enough: count('充足'),
  }
}

/** 修改实际储备量或预警储备量：落库后状态由统一规则重算，预警面板立即更新。 */
export function updateItemQuantity(
  id: number,
  field: '实际储备量' | '预警储备量',
  rawValue: string,
): ServiceResult {
  const trimmed = rawValue.trim()
  try {
    commitSupply((draft) => {
      const item = draft.items.find((entry) => entry.id === id)
      if (!item) {
        throw new Error(`没有找到编号 ${id} 的物资`)
      }
      if (field === '实际储备量') {
        const value = Number(trimmed)
        if (!/^\d+$/.test(trimmed) || value < 0) {
          throw new Error('实际储备量必须是非负整数')
        }
        item.实际储备量 = value
      } else {
        if (trimmed === '') {
          // 允许清空：历史缺值场景，回到「按类别兼容补值」。
          item.预警储备量 = null
          item.预警值补值 = true
        } else {
          const value = Number(trimmed)
          if (!/^\d+$/.test(trimmed) || value <= 0) {
            throw new Error('预警储备量必须是正整数')
          }
          item.预警储备量 = value
          item.预警值补值 = false
        }
      }
      syncTodos(draft, new Date())
    })
    return { ok: true, message: '储备量已更新，预警状态与补充待办已同步重算' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '更新失败，已回退' }
  }
}

// ---------- 补充流转 ----------

export function startReplenish(code: string): ServiceResult {
  try {
    commitSupply((draft) => {
      const item = findItem(draft, code)
      if (!item) {
        throw new Error(`没有找到物资编号 ${code}`)
      }
      if (isExpired(item)) {
        throw new Error('该物资已过期，不能补充，请先重新登记有效期')
      }
      const status = resolveStatus(item)
      if (status === '充足') {
        throw new Error('库存充足，无需补充')
      }
      syncTodos(draft, new Date())
    })
    return { ok: true, message: '已登记补充申请，待办中可跟踪' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '发起补充失败' }
  }
}

export function confirmReplenish(code: string, rawQuantity: string): ServiceResult {
  const quantity = Number(rawQuantity)
  if (!/^\d+$/.test(rawQuantity.trim()) || quantity <= 0) {
    return { ok: false, message: '补充数量必须是正整数' }
  }
  try {
    commitSupply((draft) => {
      const item = findItem(draft, code)
      if (!item) {
        throw new Error(`没有找到物资编号 ${code}`)
      }
      // 过期物资仍可补充是历史缺陷：统一规则下过期必须先恢复有效期，入口直接拦住。
      if (isExpired(item)) {
        throw new Error('该物资已过期，不能补充，请先重新登记有效期')
      }
      item.实际储备量 += quantity
      syncTodos(draft, new Date())
    })
    return { ok: true, message: `补充入库 ${quantity} 件，库存、预警与待办已同一事务落库` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '补充失败，已回退' }
  }
}

export function markExpired(code: string): ServiceResult {
  try {
    commitSupply((draft) => {
      const item = findItem(draft, code)
      if (!item) {
        throw new Error(`没有找到物资编号 ${code}`)
      }
      item.到期日期 = shiftDays(new Date(), -1)
      syncTodos(draft, new Date())
    })
    return { ok: true, message: '已标记过期，该物资将无法补充或领用' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '标记失败' }
  }
}

/** 重新登记有效期（默认一年后），恢复后才能继续补充、领用。 */
export function renewItem(code: string, expireDate?: string): ServiceResult {
  try {
    const nextDate = expireDate && /^\d{4}-\d{2}-\d{2}$/.test(expireDate)
      ? expireDate
      : shiftDays(new Date(), 365)
    commitSupply((draft) => {
      const item = findItem(draft, code)
      if (!item) {
        throw new Error(`没有找到物资编号 ${code}`)
      }
      item.到期日期 = nextDate
      syncTodos(draft, new Date())
    })
    return { ok: true, message: `有效期已重新登记至 ${nextDate}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '登记失败' }
  }
}

// ---------- 领用 ----------

export function listRequisitions(): RequisitionRecord[] {
  return [...getSupplyDB().requisitions].sort((a, b) => b.id - a.id)
}

export type RequisitionInput = {
  领用流水号: string
  物资编号: string
  领用单位: string
  领用人: string
  领用数量: string
  备注?: string
}

function requisitionDraft(input: RequisitionInput, now: Date): RequisitionRecord {
  const draft = getSupplyDB()
  const quantity = Number(input.领用数量)
  if (!input.领用流水号.trim()) {
    throw new Error('请填写领用流水号')
  }
  if (draft.requisitions.some((record) => record.领用流水号 === input.领用流水号.trim())) {
    throw new Error('DUPLICATE_SERIAL')
  }
  const item = findItem(draft, input.物资编号)
  if (!item) {
    throw new Error(`没有找到物资编号 ${input.物资编号}`)
  }
  if (isExpired(item, now)) {
    throw new Error('该物资已过期，禁止领用')
  }
  if (!/^\d+$/.test(String(input.领用数量).trim()) || quantity <= 0) {
    throw new Error('领用数量必须是正整数')
  }
  if (quantity > item.实际储备量) {
    throw new Error(`库存不足：当前 ${item.实际储备量}，本次申请 ${quantity}`)
  }
  if (!input.领用单位.trim() || !input.领用人.trim()) {
    throw new Error('请填写领用单位与领用人')
  }
  const before = item.实际储备量
  const record: RequisitionRecord = {
    id: draft.requisitions.length === 0 ? 1 : Math.max(...draft.requisitions.map((entry) => entry.id)) + 1,
    领用流水号: input.领用流水号.trim(),
    物资编号: item.物资编号,
    领用单位: input.领用单位.trim(),
    领用人: input.领用人.trim(),
    领用数量: quantity,
    扣减前数量: before,
    扣减后数量: before - quantity,
    状态: '已发放',
    备注: (input.备注 ?? '').trim(),
    领用时间: dateTimeText(now),
  }
  return record
}

/**
 * 领用出库：校验、库存扣减、扣减记录、补充待办在同一事务内提交，失败整体回退。
 * 同一领用流水号即同一次领用——重复提交直接拒绝，不会产生第二条扣减记录。
 */
export function supplyRequisition(input: RequisitionInput): ServiceResult<RequisitionRecord> {
  const now = new Date()
  let record: RequisitionRecord
  try {
    record = requisitionDraft(input, now)
  } catch (error) {
    const message = error instanceof Error ? error.message : '领用校验失败'
    return { ok: false, message: message === 'DUPLICATE_SERIAL' ? '该领用流水号已发放，库存只扣一次，请勿重复提交' : message }
  }
  try {
    commitSupply((draft) => {
      const target = findItem(draft, input.物资编号)
      if (!target) {
        throw new Error(`没有找到物资编号 ${input.物资编号}`)
      }
      target.实际储备量 = record.扣减后数量 as number
      draft.requisitions.push({ ...record })
      syncTodos(draft, now)
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '领用落库失败，已整体回退', data: undefined }
  }
  return { ok: true, message: `领用成功，库存 ${record.扣减前数量} → ${record.扣减后数量}`, data: record }
}

// 并发串行化：即使多个领用请求同时到达，也排队进入同一事务，杜绝交错扣减。
let requisitionChain: Promise<unknown> = Promise.resolve()

export function enqueueRequisition(input: RequisitionInput): Promise<ServiceResult<RequisitionRecord>> {
  const run = requisitionChain.then(() => supplyRequisition(input))
  // 链路上已拒绝的重复请求不能打断后续请求。
  requisitionChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** 模拟同一流水号并发提交 n 次：用于在页面上验证只扣一次。 */
export async function simulateConcurrentRequisitions(
  input: RequisitionInput,
  copies: number,
): Promise<{ results: ServiceResult<RequisitionRecord>[]; deducted: number; rejected: number }> {
  const results = await Promise.all(
    Array.from({ length: copies }, () => enqueueRequisition({ ...input })),
  )
  const deducted = results.filter((result) => result.ok).length
  return { results, deducted, rejected: copies - deducted }
}

// ---------- 待办 ----------

export function listTodos(includeClosed = false): SupplyTodo[] {
  const todos = getSupplyDB().todos
  return (includeClosed ? todos : todos.filter((todo) => todo.状态 === '待处理'))
    .slice()
    .sort((a, b) => Number(b.状态 === '待处理') - Number(a.状态 === '待处理') || b.id - a.id)
}

export function openTodoCount(): number {
  return getSupplyDB().todos.filter((todo) => todo.状态 === '待处理').length
}

// ---------- 盘点差异：导出文件 / 导入回执 ----------

export function listStocktakes(): StocktakeOrder[] {
  return [...getSupplyDB().stocktakes].sort((a, b) => b.id - a.id)
}

export function createStocktake(forest: string, operator: string): ServiceResult<StocktakeOrder> {
  try {
    const created = commitSupply((draft) => {
      const now = new Date()
      const id = draft.stocktakes.length === 0 ? 1 : Math.max(...draft.stocktakes.map((entry) => entry.id)) + 1
      const order: StocktakeOrder = {
        id,
        盘点单号: `PD-${dateText(now).replace(/-/g, '')}-${pad(id)}`,
        盘点林场: forest.trim() || '全部林场',
        盘点日期: dateText(now),
        状态: '待回执',
        明细: draft.items
          .filter((item) => !forest.trim() || item.储备林场 === forest.trim())
          .map((item) => ({
            物资编号: item.物资编号,
            物资名称: item.物资名称,
            账面数量: item.实际储备量,
            盘点数量: null,
            差异数量: null,
            备注: '',
          })),
        回执说明: '',
        回执时间: null,
        回执人: operator,
      }
      draft.stocktakes.push(order)
      return order
    })
    return { ok: true, message: `盘点单 ${created.盘点单号} 已生成，可下载盘点后导入回执`, data: created }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '盘点单生成失败' }
  }
}

const STOCKTAKE_HEADER = ['盘点单号', '物资编号', '物资名称', '账面数量', '盘点数量', '差异数量', '备注', '回执人', '回执说明']

export function stocktakeFilename(order: StocktakeOrder): string {
  return `盘点差异-${order.盘点单号}.csv`
}

export function exportStocktake(orderId: number): ServiceResult<{ filename: string; content: string }> {
  const order = getSupplyDB().stocktakes.find((entry) => entry.id === orderId)
  if (!order) {
    return { ok: false, message: '没有找到该盘点单' }
  }
  const rows: (string | number | null)[][] = [STOCKTAKE_HEADER]
  order.明细.forEach((line, index) => {
    rows.push([
      order.盘点单号,
      line.物资编号,
      line.物资名称,
      line.账面数量,
      line.盘点数量,
      line.差异数量,
      line.备注,
      index === 0 ? order.回执人 : '',
      index === 0 ? order.回执说明 : '',
    ])
  })
  return { ok: true, message: '', data: { filename: stocktakeFilename(order), content: toCsv(rows) } }
}

type ReceiptLine = { code: string; counted: number; remark: string }

export type ReceiptSummary = {
  order: StocktakeOrder
  received: number
  diffLines: number
  totalDiff: number
}

export function importStocktakeReceipt(content: string, operator: string): ServiceResult<ReceiptSummary> {
  const rows = parseCsv(content)
  if (rows.length < 2) {
    return { ok: false, message: '回执文件没有数据行' }
  }
  const header = rows[0].map((cell) => cell.trim())
  const indexOf = (name: string) => header.indexOf(name)
  const required = ['盘点单号', '物资编号', '账面数量', '盘点数量']
  const missing = required.filter((name) => indexOf(name) === -1)
  if (missing.length > 0) {
    return { ok: false, message: `回执文件缺少列：${missing.join('、')}，请使用导出的盘点差异文件` }
  }
  const iOrder = indexOf('盘点单号')
  const iCode = indexOf('物资编号')
  const iBook = indexOf('账面数量')
  const iCounted = indexOf('盘点数量')
  const iRemark = indexOf('备注')
  const iReceiver = indexOf('回执人')
  const iReceipt = indexOf('回执说明')

  const orderNo = rows[1][iOrder]?.trim() ?? ''
  if (!orderNo) {
    return { ok: false, message: '回执文件缺少盘点单号' }
  }

  // 文件级校验先做完，任何一行不合法都不进事务——导入失败整体回退。
  const parsedLines: ReceiptLine[] = []
  const now = new Date()
  const db = getSupplyDB()
  const order = db.stocktakes.find((entry) => entry.盘点单号 === orderNo)
  if (!order) {
    return { ok: false, message: `盘点单号 ${orderNo} 不存在，请确认文件来源` }
  }
  if (order.状态 === '已回执') {
    return { ok: false, message: '该盘点单已有回执，不能重复导入' }
  }
  let receiptOperator = operator
  let receiptNote = ''
  for (const row of rows.slice(1)) {
    const code = row[iCode]?.trim() ?? ''
    if (!code) {
      continue
    }
    const line: StocktakeLine | undefined = order.明细.find((entry) => entry.物资编号 === code)
    if (!line) {
      return { ok: false, message: `物资编号 ${code} 不在盘点单 ${orderNo} 中` }
    }
    const bookValue = Number(row[iBook])
    if (bookValue !== line.账面数量) {
      return { ok: false, message: `${code} 账面数量被改动（文件 ${bookValue} / 系统 ${line.账面数量}），请重新导出后填写` }
    }
    const countedText = (row[iCounted] ?? '').trim()
    if (!/^\d+$/.test(countedText)) {
      return { ok: false, message: `${code} 的盘点数量必须是非负整数` }
    }
    if (iReceiver >= 0 && row[iReceiver]?.trim()) {
      receiptOperator = row[iReceiver].trim()
    }
    if (iReceipt >= 0 && row[iReceipt]?.trim()) {
      receiptNote = row[iReceipt].trim()
    }
    parsedLines.push({ code, counted: Number(countedText), remark: iRemark >= 0 ? (row[iRemark] ?? '').trim() : '' })
  }
  if (parsedLines.length !== order.明细.length) {
    const codes = new Set(parsedLines.map((line) => line.code))
    const lost = order.明细.filter((line) => !codes.has(line.物资编号)).map((line) => line.物资编号)
    return { ok: false, message: `回执缺少物资行：${lost.join('、')}` }
  }

  try {
    const summary = commitSupply<ReceiptSummary>((draft) => {
      const target = draft.stocktakes.find((entry) => entry.盘点单号 === orderNo)
      if (!target || target.状态 === '已回执') {
        // 并发导入第二张回执：事务内再挡一次。
        throw new Error('盘点单状态已变化，回执导入失败')
      }
      let diffLines = 0
      let totalDiff = 0
      for (const parsed of parsedLines) {
        const item = draft.items.find((entry) => entry.物资编号 === parsed.code)
        const line = target.明细.find((entry) => entry.物资编号 === parsed.code)
        if (!item || !line) {
          throw new Error(`${parsed.code} 明细缺失，导入整体回退`)
        }
        // 冲突时以实际盘点为准：盘点数量直接回写实际储备量，差异=盘点-账面。
        item.实际储备量 = parsed.counted
        line.盘点数量 = parsed.counted
        line.差异数量 = parsed.counted - line.账面数量
        line.备注 = parsed.remark
        if (line.差异数量 !== 0) {
          diffLines += 1
          totalDiff += line.差异数量
        }
      }
      target.状态 = '已回执'
      target.回执时间 = dateTimeText(now)
      target.回执人 = receiptOperator.trim() || operator
      target.回执说明 = receiptNote
      syncTodos(draft, now)
      return { order: { ...target }, received: parsedLines.length, diffLines, totalDiff }
    })
    return {
      ok: true,
      message: `回执已导入：${summary.received} 项，${summary.diffLines} 项有差异（净差异 ${summary.totalDiff}），库存按实际盘点回写`,
      data: summary,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '回执导入失败，已整体回退' }
  }
}
