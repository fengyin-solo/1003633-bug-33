import {
  mutateSupply,
  nextLedgerId,
  nextTodoId,
  readSupply,
  supplyStamp,
} from '@/data/local-store'
import { downloadFile, parseCsv, toCsv } from '@/utils/csv'
import {
  deriveStatus,
  gapQuantity,
  isPending,
  replenishQuantity,
} from './rules'
import type {
  LedgerEntry,
  LedgerType,
  ReplenishTodo,
  SupplyDB,
  SupplyRow,
  SupplyStatus,
} from './types'

export type ServiceResult<T = undefined> = { ok: boolean; message: string; data?: T }

// ---------- 读取：储备列表、预警面板、领用清单共用同一份数据 ----------

export function listSupplies(): SupplyRow[] {
  return readSupply().supplies
}

export function listTodos(status?: ReplenishTodo['状态']): ReplenishTodo[] {
  const todos = readSupply().todos
  return status ? todos.filter((item) => item.状态 === status) : todos
}

export function listLedger(type?: LedgerType): LedgerEntry[] {
  const ledger = readSupply().ledger
  return type ? ledger.filter((item) => item.类型 === type) : ledger
}

// ---------- 并发控制：异步导入/连点提交全部串行化，配合 token 幂等 ----------

let chain: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => T | Promise<T>): Promise<T> {
  const run = chain.then(() => task())
  // 单个任务失败不能冲断后面的任务链。
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function orderNo(prefix: 'LY' | 'RC' | 'PD', id: number): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
  return `${prefix}-${day}-${String(id).padStart(3, '0')}`
}

function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function today(): string {
  return formatDate(new Date())
}

/** 内部流水的幂等键：时间戳 + 随机串，同一秒内多次操作也不会撞键。 */
function opToken(kind: string, supplyId: number, stamp: string): string {
  const rand = Math.random().toString(16).slice(2, 10)
  return `${kind}-${supplyId}-${stamp.replace(/[-: ]/g, '')}-${rand}`
}

type TodoChange = 'create' | 'close' | 'cancel' | null

/**
 * 库存变动后的统一对账：库存、预警、待办必须在同一事务里保持一致。
 * - 跌破预警线且没有未完成待办 → 建待办
 * - 回到预警线以上 → 关闭未完成待办
 */
function reconcileTodos(
  draft: SupplyDB,
  supply: SupplyRow,
  stamp: string,
  linkedOrder: string,
  mode: TodoChange,
  note: string,
): void {
  const status = deriveStatus(supply)
  const open = draft.todos.filter((item) => item.物资id === supply.id && item.状态 === '待处理')
  if (status === '已过期') {
    for (const todo of open) {
      todo.状态 = '已取消'
      todo.完成时间 = stamp
      todo.备注 = '物资已过期，补充流程终止'
    }
    return
  }
  if (isPending(status)) {
    if (open.length === 0 && mode === 'create') {
      draft.todos.push({
        id: nextTodoId(draft.todos),
        物资id: supply.id,
        物资编号: supply.物资编号,
        物资名称: supply.物资名称,
        缺口数量: gapQuantity(supply.实际储备量, supply.预警储备量),
        创建时间: stamp,
        状态: '待处理',
        关联单号: '',
        完成时间: '',
        备注: note,
      })
    }
    return
  }
  if (mode === 'close' || mode === 'cancel') {
    for (const todo of open) {
      todo.状态 = mode === 'cancel' ? '已取消' : '已完成'
      todo.完成时间 = stamp
      todo.关联单号 = linkedOrder
      todo.备注 = note
    }
  }
}

function addLedger(
  draft: SupplyDB,
  entry: Omit<LedgerEntry, 'id' | '单号'> & { 单号?: string },
): LedgerEntry {
  const id = nextLedgerId(draft.ledger)
  const prefix = entry.类型 === '领用扣减' ? 'LY' : entry.类型 === '补充入库' ? 'RC' : 'PD'
  const full: LedgerEntry = { ...entry, id, 单号: entry.单号 || orderNo(prefix, id) }
  draft.ledger.push(full)
  return full
}

// ---------- 领用：幂等 + 同事务扣减/预警/待办/流水 ----------

export type RequisitionInput = {
  token: string
  supplyId: number
  数量: number
  领用人: string
  用途: string
}

/**
 * 并发领用只扣一次：
 * 1. token 命中已处理单据 → 直接返回原结论，不再扣减、不写第二条扣减记录；
 * 2. 扣减、状态重算、待办生成、流水写入在 mutateSupply 单事务内完成，出错整体回退。
 */
export function submitRequisition(input: RequisitionInput): ServiceResult<LedgerEntry> {
  const token = input.token.trim()
  if (!token) {
    return { ok: false, message: '缺少领用单凭证（token），拒绝提交' }
  }
  if (readSupply().tokens.includes(token)) {
    return { ok: true, message: '该领用单已处理，未重复扣减库存' }
  }
  const qty = Math.trunc(Number(input.数量))
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, message: '领用数量必须是大于 0 的整数' }
  }
  if (!input.领用人.trim()) {
    return { ok: false, message: '请填写领用人' }
  }
  try {
    const entry = mutateSupply((draft) => {
      if (draft.tokens.includes(token)) {
        // 串行队列里前一个相同单据已落库：保持只扣一次。
        return null
      }
      const index = draft.supplies.findIndex((row) => Number(row.id) === input.supplyId)
      if (index < 0) {
        throw new Error(`没有找到编号为 ${input.supplyId} 的防火物资`)
      }
      const target = draft.supplies[index]
      if (target.过期) {
        throw new Error(`「${target.物资名称}」已过期，禁止领用`)
      }
      if (qty > target.实际储备量) {
        throw new Error(`「${target.物资名称}」实际储备量仅 ${target.实际储备量}${target.单位}，不足领用 ${qty}${target.单位}`)
      }
      const before = target.实际储备量
      target.实际储备量 = before - qty
      const stamp = supplyStamp()
      const ledger = addLedger(draft, {
        类型: '领用扣减',
        token,
        时间: stamp,
        物资id: target.id,
        物资编号: target.物资编号,
        物资名称: target.物资名称,
        数量: qty,
        变动前: before,
        变动后: target.实际储备量,
        领用人: input.领用人.trim(),
        用途: input.用途.trim(),
        备注: '',
      })
      reconcileTodos(draft, target, stamp, ledger.单号, 'create', '领用后跌破预警线，自动生成补充待办')
      draft.tokens.push(token)
      if (draft.tokens.length > 500) {
        draft.tokens.splice(0, draft.tokens.length - 500)
      }
      return ledger
    })
    if (!entry) {
      return { ok: true, message: '该领用单已处理，未重复扣减库存' }
    }
    return { ok: true, message: `领用成功：${entry.单号} 扣减 ${qty}，库存 ${entry.变动前} → ${entry.变动后}`, data: entry }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '领用失败，已整体回退' }
  }
}

/** 页面入口：连点/并发提交经队列串行，最终仍由 token 保证只扣一次。 */
export function submitRequisitionQueued(input: RequisitionInput): Promise<ServiceResult<LedgerEntry>> {
  return serialize(() => submitRequisition(input))
}

// ---------- 补充流程 ----------

export function requestReplenish(supplyId: number): ServiceResult<ReplenishTodo> {
  try {
    const todo = mutateSupply((draft) => {
      const target = draft.supplies.find((row) => Number(row.id) === supplyId)
      if (!target) {
        throw new Error(`没有找到编号为 ${supplyId} 的防火物资`)
      }
      if (target.过期) {
        throw new Error(`「${target.物资名称}」已过期，不能发起补充`)
      }
      const open = draft.todos.find((item) => item.物资id === supplyId && item.状态 === '待处理')
      if (open) {
        return open
      }
      if (target.实际储备量 >= target.预警储备量) {
        throw new Error(`「${target.物资名称}」库存充足，无需发起补充`)
      }
      const created: ReplenishTodo = {
        id: nextTodoId(draft.todos),
        物资id: target.id,
        物资编号: target.物资编号,
        物资名称: target.物资名称,
        缺口数量: gapQuantity(target.实际储备量, target.预警储备量),
        创建时间: supplyStamp(),
        状态: '待处理',
        关联单号: '',
        完成时间: '',
        备注: '人工发起补充',
      }
      draft.todos.push(created)
      return created
    })
    return { ok: true, message: `已为「${todo.物资名称}」发起补充，缺口 ${todo.缺口数量}`, data: todo }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '发起补充失败' }
  }
}

export function confirmReplenish(supplyId: number): ServiceResult<LedgerEntry> {
  try {
    const entry = mutateSupply((draft) => {
      const target = draft.supplies.find((row) => Number(row.id) === supplyId)
      if (!target) {
        throw new Error(`没有找到编号为 ${supplyId} 的防火物资`)
      }
      if (target.过期) {
        throw new Error(`「${target.物资名称}」已过期，不能补充入库`)
      }
      if (target.实际储备量 >= target.预警储备量) {
        throw new Error(`「${target.物资名称}」库存已达预警线以上，无需确认补充`)
      }
      const qty = replenishQuantity(target.实际储备量, target.预警储备量)
      const before = target.实际储备量
      target.实际储备量 = before + qty
      const stamp = supplyStamp()
      const ledger = addLedger(draft, {
        类型: '补充入库',
        token: opToken('replenish', target.id, stamp),
        时间: stamp,
        物资id: target.id,
        物资编号: target.物资编号,
        物资名称: target.物资名称,
        数量: qty,
        变动前: before,
        变动后: target.实际储备量,
        领用人: '',
        用途: '按预警储备量整批补充',
        备注: '',
      })
      reconcileTodos(draft, target, stamp, ledger.单号, 'close', '补充入库，库存回到预警线以上')
      return ledger
    })
    return { ok: true, message: `补充入库：${entry.单号} 增加 ${entry.数量}，库存 ${entry.变动前} → ${entry.变动后}`, data: entry }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '确认补充失败，已整体回退' }
  }
}

export function markExpired(supplyId: number): ServiceResult {
  try {
    mutateSupply((draft) => {
      const target = draft.supplies.find((row) => Number(row.id) === supplyId)
      if (!target) {
        throw new Error(`没有找到编号为 ${supplyId} 的防火物资`)
      }
      if (target.过期) {
        throw new Error(`「${target.物资名称}」已是过期状态`)
      }
      target.过期 = true
      reconcileTodos(draft, target, supplyStamp(), '', 'cancel', '物资已过期，补充流程终止')
    })
    return { ok: true, message: '已标记过期，相关补充待办同步终止' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '标记过期失败' }
  }
}

// ---------- 盘点登记：以实际盘点为准 ----------

export type CountInput = {
  supplyId: number
  实盘数量: number
  新有效期?: string
}

export function recordCount(input: CountInput): ServiceResult<LedgerEntry | null> {
  const counted = Math.trunc(Number(input.实盘数量))
  if (!Number.isFinite(counted) || counted < 0) {
    return { ok: false, message: '实盘数量必须是不小于 0 的整数' }
  }
  try {
    const result = mutateSupply((draft) => {
      const target = draft.supplies.find((row) => Number(row.id) === input.supplyId)
      if (!target) {
        throw new Error(`没有找到编号为 ${input.supplyId} 的防火物资`)
      }
      const before = target.实际储备量
      const stamp = supplyStamp()
      if (input.新有效期 && input.新有效期.trim()) {
        target.有效期至 = input.新有效期.trim()
        target.过期 = target.有效期至 < today()
      }
      target.实际储备量 = counted
      let ledger: LedgerEntry | null = null
      if (before !== counted) {
        ledger = addLedger(draft, {
          类型: '盘点调整',
          token: opToken('count', target.id, stamp),
          时间: stamp,
          物资id: target.id,
          物资编号: target.物资编号,
          物资名称: target.物资名称,
          数量: counted - before,
          变动前: before,
          变动后: counted,
          领用人: '',
          用途: '人工盘点登记',
          备注: '以实际盘点为准',
        })
      }
      const nextStatus = deriveStatus(target)
      // 盘盈回预警线上 → 关闭待办；盘亏到线下且无待办 → 补建待办。
      const mode = isPending(nextStatus) ? 'create' : 'close'
      reconcileTodos(
        draft,
        target,
        stamp,
        ledger?.单号 ?? '盘点登记',
        mode,
        mode === 'create' ? '盘点后跌破预警线，自动生成补充待办' : '盘点后库存回到预警线以上，待办关闭',
      )
      return ledger
    })
    return {
      ok: true,
      message: result
        ? `盘点已登记：${result.单号}，库存 ${result.变动前} → ${result.变动后}`
        : '盘点数量与账面一致，无需调整',
      data: result,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '盘点登记失败，已整体回退' }
  }
}

// ---------- 盘点表导出、回执导入、差异文件 ----------

export const COUNT_SHEET_HEADER = [
  '物资编号',
  '物资名称',
  '物资类别',
  '储备林场',
  '单位',
  '预警储备量',
  '账面实际储备量',
  '有效期至',
  '盘点实际储备量',
]

export type CountDiff = {
  物资编号: string
  物资名称: string
  物资类别: string
  储备林场: string
  单位: string
  账面数量: number
  实盘数量: number
  差异: number
  预警储备量: number
  盘点后状态: SupplyStatus
  时间: string
  单号: string
}

export function exportCountSheet(): void {
  const rows: (string | number)[][] = [COUNT_SHEET_HEADER]
  for (const row of listSupplies()) {
    rows.push([
      row.物资编号,
      row.物资名称,
      row.物资类别,
      row.储备林场,
      row.单位,
      row.预警储备量,
      row.实际储备量,
      row.有效期至,
      '',
    ])
  }
  downloadFile(`防火物资盘点表-${today()}.csv`, toCsv(rows))
}

/** 盘点差异（回执）文件：导入后可下载，也可对当前库即时导出留档。 */
export function differencesToCsv(diffs: CountDiff[]): string {
  const rows: (string | number)[][] = [[
    '物资编号', '物资名称', '物资类别', '储备林场', '单位',
    '账面数量', '实盘数量', '差异', '预警储备量', '盘点后状态', '关联单号', '盘点时间',
  ]]
  for (const item of diffs) {
    rows.push([
      item.物资编号, item.物资名称, item.物资类别, item.储备林场, item.单位,
      item.账面数量, item.实盘数量, item.差异, item.预警储备量, item.盘点后状态, item.单号, item.时间,
    ])
  }
  return toCsv(rows)
}

export function downloadDifferences(diffs: CountDiff[]): void {
  downloadFile(`防火物资盘点差异-${today()}.csv`, differencesToCsv(diffs))
}

/**
 * 导入盘点回执：所有行在同一个事务里落库，任一行不合格整体回退。
 * 以回执里的实盘数量为实际盘点结果，冲突时以实际盘点为准。
 */
export function importReceipt(content: string): ServiceResult<{ imported: number; changed: number; diffs: CountDiff[] }> {
  const parsed = parseCsv(content)
  if (parsed.length < 2) {
    return { ok: false, message: '回执文件没有可导入的数据行' }
  }
  const header = parsed[0].map((cell) => cell.trim())
  const codeCol = header.indexOf('物资编号')
  const countCol = header.indexOf('盘点实际储备量')
  if (codeCol < 0 || countCol < 0) {
    return { ok: false, message: '回执缺少「物资编号」或「盘点实际储备量」列，请使用盘点表模板填写' }
  }

  type Plan = { target: SupplyRow; counted: number }
  const plans: Plan[] = []
  const seen = new Set<string>()
  const columnCount = header.length
  try {
    parsed.slice(1).forEach((cells, line) => {
      if (cells.length > columnCount) {
        throw new Error(`第 ${line + 2} 行列数（${cells.length}）多于表头（${columnCount}），请使用盘点表模板填写`)
      }
      const code = (cells[codeCol] ?? '').trim()
      const countText = (cells[countCol] ?? '').trim()
      if (!code && !countText) {
        return // 空行
      }
      if (!code) {
        throw new Error(`第 ${line + 2} 行缺少物资编号`)
      }
      if (!countText) {
        return // 列出了物资但未盘点，跳过
      }
      if (seen.has(code)) {
        throw new Error(`物资编号「${code}」在回执中重复出现`)
      }
      seen.add(code)
      const counted = Number.parseInt(countText, 10)
      if (!/^\d+$/.test(countText) || !Number.isFinite(counted) || counted < 0) {
        throw new Error(`第 ${line + 2} 行（${code}）盘点数量无效：${countText || '空'}`)
      }
      const target = listSupplies().find((row) => row.物资编号 === code)
      if (!target) {
        throw new Error(`第 ${line + 2} 行：系统中没有物资编号「${code}」`)
      }
      plans.push({ target, counted })
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '回执解析失败（未改动库存）' }
  }
  if (plans.length === 0) {
    return { ok: false, message: '回执中没有填写实盘数量，未导入任何记录' }
  }

  try {
    const outcome = mutateSupply((draft) => {
      const diffs: CountDiff[] = []
      const stamp = supplyStamp()
      for (const plan of plans) {
        const target = draft.supplies.find((row) => row.物资编号 === plan.target.物资编号)
        if (!target) {
          throw new Error(`物资「${plan.target.物资编号}」在事务中丢失`)
        }
        const before = target.实际储备量
        target.实际储备量 = plan.counted
        let ledgerNo = ''
        if (before !== plan.counted) {
          const ledger = addLedger(draft, {
            类型: '盘点调整',
            token: opToken('receipt', target.id, stamp),
            时间: stamp,
            物资id: target.id,
            物资编号: target.物资编号,
            物资名称: target.物资名称,
            数量: plan.counted - before,
            变动前: before,
            变动后: plan.counted,
            领用人: '',
            用途: '盘点回执导入',
            备注: '以实际盘点为准',
          })
          ledgerNo = ledger.单号
        }
        const nextStatus = deriveStatus(target)
        const mode = isPending(nextStatus) ? 'create' : 'close'
        reconcileTodos(
          draft,
          target,
          stamp,
          ledgerNo || '回执导入',
          mode,
          mode === 'create' ? '回执导入后按实际盘点重算预警' : '盘点后库存回到预警线以上',
        )
        const diff = plan.counted - before
        diffs.push({
          物资编号: target.物资编号,
          物资名称: target.物资名称,
          物资类别: target.物资类别,
          储备林场: target.储备林场,
          单位: target.单位,
          账面数量: before,
          实盘数量: plan.counted,
          差异: diff,
          预警储备量: target.预警储备量,
          盘点后状态: deriveStatus(target),
          时间: stamp,
          单号: ledgerNo || '账实相符',
        })
      }
      return { diffs }
    })
    const changed = outcome.diffs.filter((item) => item.差异 !== 0).length
    return {
      ok: true,
      message: `回执导入完成：共 ${plans.length} 项，账实不符 ${changed} 项；库存、预警、待办已在同一事务落库`,
      data: { imported: plans.length, changed, diffs: outcome.diffs },
    }
  } catch (error) {
    return { ok: false, message: `${error instanceof Error ? error.message : '回执导入失败'}（已整体回退，未改动库存）` }
  }
}

export function importReceiptQueued(content: string): Promise<ServiceResult<{ imported: number; changed: number; diffs: CountDiff[] }>> {
  return serialize(() => importReceipt(content))
}
