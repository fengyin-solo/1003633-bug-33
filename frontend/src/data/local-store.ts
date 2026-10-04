import { SEED_ROWS } from '@/data/seed'
import { gapQuantity, normalizeSupply } from '@/domain/supply/rules'
import type { EntryRow } from '@/data/types'
import type { LedgerEntry, ReplenishTodo, SupplyDB, SupplyRow } from '@/domain/supply/types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 任意来源的一行物资 → 统一形态，预警缺失值在这里按类别补齐。 */
function toSupplyRow(raw: EntryRow): SupplyRow {
  const normalized = normalizeSupply(raw as unknown as Record<string, unknown>)
  return {
    ...raw,
    单位: normalized.单位,
    预警储备量: normalized.预警储备量,
    实际储备量: normalized.实际储备量,
    有效期至: normalized.有效期至,
    过期: normalized.过期,
    阈值来源: normalized.阈值来源,
    status: normalized.status,
    pending: normalized.pending,
    abnormal: normalized.abnormal,
  } as SupplyRow
}

function seedSupply(): SupplyDB {
  const rows = (SEED_ROWS.supply ?? []).map(toSupplyRow)
  // 示例数据里跌破预警线的物资，播种时就挂上未完成的补充待办，保证库存/预警/待办口径一致。
  const todos: ReplenishTodo[] = []
  let todoId = 1
  for (const row of rows) {
    if (row.pending) {
      todos.push({
        id: todoId++,
        物资id: row.id,
        物资编号: row.物资编号,
        物资名称: row.物资名称,
        缺口数量: Math.max(0, row.预警储备量 - row.实际储备量),
        创建时间: nowStamp(),
        状态: '待处理',
        关联单号: '',
        完成时间: '',
        备注: '示例数据初始化待办',
      })
    }
  }
  return { supplies: rows, ledger: [], todos, tokens: [] }
}

/** 旧版本（v1）数据迁移：物资行整体替换为归一化后的旧数据，流水/待办从无到有。 */
function migrateSupply(legacy: unknown): SupplyDB {
  const legacyRows = Array.isArray(legacy) ? (legacy as EntryRow[]) : []
  const supplies = legacyRows.map(toSupplyRow)
  // 旧数据里跌破预警线的物资挂上未完成补充待办，迁移后库存/预警/待办口径一致。
  const todos: ReplenishTodo[] = []
  let todoId = 1
  for (const row of supplies) {
    if (row.pending) {
      todos.push({
        id: todoId++,
        物资id: row.id,
        物资编号: row.物资编号,
        物资名称: row.物资名称,
        缺口数量: gapQuantity(row.实际储备量, row.预警储备量),
        创建时间: nowStamp(),
        状态: '待处理',
        关联单号: '',
        完成时间: '',
        备注: '历史数据迁移生成待办',
      })
    }
  }
  return { supplies, ledger: [], todos, tokens: [] }
}

type Stored = {
  version: 2
  entries: Record<string, EntryRow[]>
  supply: SupplyDB
}

function buildInitial(): Stored {
  const entries: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(SEED_ROWS)) {
    if (key === 'supply') {
      continue
    }
    entries[key] = clone(rows)
  }
  return { version: 2, entries, supply: seedSupply() }
}

function readStorage(): Stored {
  const fallback = buildInitial()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    writeStorage(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Stored | Record<string, EntryRow[]>
    if (parsed && (parsed as Stored).version === 2 && (parsed as Stored).supply) {
      const stored = parsed as Stored
      // 防御：历史脏值/手工改库后，读出来再统一一次，保证状态永远跟随实际盘点值。
      stored.supply.supplies = stored.supply.supplies.map(toSupplyRow)
      stored.supply.ledger ??= []
      stored.supply.todos ??= []
      stored.supply.tokens ??= []
      return stored
    }
    // v1：以模块 key 平铺的旧结构，物资模块迁移到新结构，其余模块照旧合并。
    const legacy = parsed as Record<string, EntryRow[]>
    const initial = buildInitial()
    for (const key of Object.keys(initial.entries)) {
      if (Array.isArray(legacy[key])) {
        initial.entries[key] = clone(legacy[key])
      }
    }
    initial.supply = migrateSupply(legacy.supply)
    writeStorage(initial)
    return initial
  } catch {
    writeStorage(fallback)
    return fallback
  }
}

function writeStorage(data: Stored): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  }
}

let cache: Stored | null = null

function db(): Stored {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  // 看板仍按模块平铺汇总：物资模块从 v2 的领域库里投影成 EntryRow[]。
  return { ...db().entries, supply: db().supply.supplies as unknown as EntryRow[] }
}

export function listRows(key: string): EntryRow[] {
  if (key === 'supply') {
    return db().supply.supplies as unknown as EntryRow[]
  }
  return db().entries[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  if (key === 'supply') {
    // 物资口径统一在领域服务里维护，通用入口写进来也要先归一化，避免绕过判定规则。
    mutateSupply((draft) => {
      draft.supplies = rows.map(toSupplyRow)
    })
    return
  }
  const current = db()
  current.entries = { ...current.entries, [key]: rows }
  cache = current
  writeStorage(current)
}

export function resetRows(key: string): EntryRow[] {
  if (key === 'supply') {
    const fresh = seedSupply()
    mutateSupply((draft) => {
      draft.supplies = fresh.supplies
      draft.ledger = []
      draft.todos = fresh.todos
      draft.tokens = []
    })
    return db().supply.supplies as unknown as EntryRow[]
  }
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

// ---------- 物资领域：库存、流水、待办共用一个库，事务里一起改 ----------

/**
 * 原子事务：在草稿上完成扣减/补库/待办/流水的全部改动，
 * 任何一步抛错都不会写回 localStorage，整体回退。
 */
export function mutateSupply<T>(fn: (draft: SupplyDB) => T): T {
  const current = db()
  const draft: SupplyDB = clone(current.supply)
  const result = fn(draft)
  // 提交前再归一化一次：状态永远由实际储备量与过期标记决定。
  draft.supplies = draft.supplies.map(toSupplyRow)
  const next: Stored = { ...current, supply: draft }
  cache = next
  writeStorage(next)
  return result
}

export function readSupply(): SupplyDB {
  return db().supply
}

export function nextLedgerId(ledger: LedgerEntry[]): number {
  return ledger.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

export function nextTodoId(todos: ReplenishTodo[]): number {
  return todos.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

export function supplyStamp(): string {
  return nowStamp()
}
