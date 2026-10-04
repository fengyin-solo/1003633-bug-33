import { saveRows, storageKey } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import { supplySeed } from './seed'
import { categoryUnit, decorateItem, isShort } from './rules'
import type { SupplyDB, SupplyTodo } from './types'

// 物资库存域独立持久化：与通用条目存储一起在同一事务里提交。
const SUPPLY_DB_KEY = 'forest-fire-patrol:supply-db'
const DB_VERSION = 1
const SUPPLY_MODULE_KEY = 'supply'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function migrate(raw: SupplyDB): SupplyDB {
  const base = supplySeed()
  const db: SupplyDB = {
    version: DB_VERSION,
    items: Array.isArray(raw.items) ? raw.items : base.items,
    requisitions: Array.isArray(raw.requisitions) ? raw.requisitions : base.requisitions,
    todos: Array.isArray(raw.todos) ? raw.todos : base.todos,
    stocktakes: Array.isArray(raw.stocktakes) ? raw.stocktakes : base.stocktakes,
    seq: typeof raw.seq === 'number' ? raw.seq : base.seq,
  }
  // 历史缺失预警值的物资：按「原类别」兼容补值，并保留补值标记，列表里能看出来。
  for (const item of db.items) {
    const missing =
      item.预警储备量 === null ||
      item.预警储备量 === undefined ||
      !Number.isFinite(Number(item.预警储备量))
    if (missing) {
      item.预警储备量 = null
      item.预警值补值 = true
    } else {
      item.预警储备量 = Number(item.预警储备量)
      item.预警值补值 = item.预警值补值 === true
    }
    item.实际储备量 = Number(item.实际储备量) || 0
    if (!item.到期日期) {
      item.到期日期 = '2099-12-31'
    }
  }
  return db
}

let cache: SupplyDB | null = null

/** 与 service.syncTodos 同规则的初始化版：加载历史数据时补齐短缺待办。 */
function reconcileTodos(db: SupplyDB, now: Date = new Date()): void {
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')} 00:00`
  for (const item of db.items) {
    const view = decorateItem(item, now)
    const hasOpen = db.todos.some((todo) => todo.物资编号 === item.物资编号 && todo.状态 === '待处理')
    if (isShort(view.状态) && !hasOpen) {
      db.todos.push({
        id: db.todos.length === 0 ? 1 : Math.max(...db.todos.map((todo) => todo.id)) + 1,
        物资编号: item.物资编号,
        类型: '补充',
        内容: `${item.物资名称}（${item.物资编号}）实际储备 ${item.实际储备量}${categoryUnit(item.物资类别)}，低于预警线 ${view.生效预警量}${categoryUnit(item.物资类别)}，请发起补充`,
        状态: '待处理',
        创建时间: stamp,
        关闭时间: null,
      } satisfies SupplyTodo)
    }
  }
}

export function initSupplyStore(): SupplyDB {
  if (cache !== null) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = supplySeed()
    reconcileTodos(cache)
    syncMirror(cache)
    return cache
  }
  const raw = window.localStorage.getItem(SUPPLY_DB_KEY)
  if (!raw) {
    cache = supplySeed()
  } else {
    try {
      cache = migrate(JSON.parse(raw) as SupplyDB)
    } catch {
      cache = supplySeed()
    }
  }
  reconcileTodos(cache)
  persistSupply(cache)
  syncMirror(cache)
  return cache
}

export function getSupplyDB(): SupplyDB {
  return cache ?? initSupplyStore()
}

function persistSupply(db: SupplyDB): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(SUPPLY_DB_KEY, JSON.stringify(db))
  }
}

/** 把库存域结果镜像回通用条目存储，运营概览与三处页面看到的状态保持同一口径。 */
function buildMirror(db: SupplyDB): EntryRow[] {
  return db.items.map((item) => {
    const view = decorateItem(item)
    return {
      id: item.id,
      status: view.状态,
      pending: isShort(view.状态),
      abnormal: view.状态 === '已过期',
      物资编号: item.物资编号,
      物资名称: item.物资名称,
      物资类别: item.物资类别,
      规格型号: item.规格型号,
      储备林场: item.储备林场,
      预警储备量: view.生效预警量,
      实际储备量: item.实际储备量,
      物资状态: view.状态,
    }
  })
}

function syncMirror(db: SupplyDB): void {
  saveRows(SUPPLY_MODULE_KEY, buildMirror(db))
}

/**
 * 库存域事务：库存、预警（派生状态）、领用、待办在同一事务里落库。
 * mutator 内只改草稿；抛错则整体回退，存储与内存缓存都不变。
 */
export function commitSupply<T>(mutator: (draft: SupplyDB) => T): T {
  const current = getSupplyDB()
  const snapshot = clone(current)
  const draft = clone(current)
  let result: T
  try {
    result = mutator(draft)
  } catch (error) {
    cache = snapshot
    throw error
  }
  // 提交点：先写库存域，再镜像到通用存储；任一写入失败都回滚两边。
  try {
    persistSupply(draft)
    cache = draft
    syncMirror(draft)
  } catch (error) {
    try {
      persistSupply(snapshot)
    } catch {
      // 存储已不可写，保留内存快照由调用方提示。
    }
    cache = snapshot
    syncMirror(snapshot)
    throw error instanceof Error ? error : new Error('库存事务提交失败，已整体回退')
  }
  return result
}

// 供测试/排查使用：确认两个存储键同源。
export function supplyStorageKeys(): string[] {
  return [SUPPLY_DB_KEY, storageKey()]
}

// 通用存储可能先于库存域被读取（如运营概览），初始化后确保概览读到镜像。
export function refreshSupplyMirror(): void {
  syncMirror(getSupplyDB())
}
