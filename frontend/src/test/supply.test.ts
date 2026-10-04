/**
 * 领域逻辑 Node 冒烟测试：用 esbuild 直接运行（npm run test:supply）。
 * 不进 tsconfig/vite 构建，仅验证库存-预警-待办的数据流。
 */

// ---- 浏览器环境垫片 ----
class LocalStorageShim {
  private map = new Map<string, string>()
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
}
;(globalThis as { window?: unknown; localStorage?: unknown; document?: unknown; URL?: unknown }).window = {
  localStorage: new LocalStorageShim(),
}
;(globalThis as { localStorage?: unknown }).localStorage = new LocalStorageShim()
;(globalThis as { document?: unknown }).document = {
  createElement: () => ({ click() {}, href: '', download: '' }),
  body: { appendChild() {}, removeChild() {} },
}
;(globalThis as { URL?: unknown }).URL = { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }

import {
  listSupplies,
  listTodos,
  listLedger,
  submitRequisition,
  submitRequisitionQueued,
  requestReplenish,
  confirmReplenish,
  markExpired,
  recordCount,
  importReceipt,
  COUNT_SHEET_HEADER,
  downloadDifferences,
} from '@/domain/supply/service'
import { normalizeSupply, deriveStatus } from '@/domain/supply/rules'
import { toCsv } from '@/utils/csv'
import type { CountDiff } from '@/domain/supply/service'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

// 1. 种子数据：统一状态判定
const supplies = listSupplies()
check('共 8 条示例物资', supplies.length === 8, `实际 ${supplies.length}`)
const torch = supplies.find((s) => s.物资编号 === 'SUPP-0008')!
check('缺失预警值按「照明设备」类别补值 12', torch.预警储备量 === 12 && torch.阈值来源 === '类别补值', `得到 ${torch.预警储备量}/${torch.阈值来源}`)
check('补值后状态重算为偏低(11<12 且 >=10)', torch.status === '偏低', torch.status)
const medkit = supplies.find((s) => s.物资编号 === 'SUPP-0007')!
check('过期物资即使数量充足也判已过期', medkit.status === '已过期', medkit.status)

// 2. 状态边界规则
check('边界：实际==预警 判充足', deriveStatus({ 实际储备量: 20, 预警储备量: 20, 过期: false }) === '充足')
check('边界：19/20 判偏低', deriveStatus({ 实际储备量: 19, 预警储备量: 20, 过期: false }) === '偏低')
check('边界：16/20 偏低线(16) 判偏低', deriveStatus({ 实际储备量: 16, 预警储备量: 20, 过期: false }) === '偏低')
check('边界：15/20 判需补充', deriveStatus({ 实际储备量: 15, 预警储备量: 20, 过期: false }) === '需补充')

// 3. 历史脏值迁移兼容
const dirty = normalizeSupply({ 物资类别: '未知新类别', 预警储备量: '坏数据', 实际储备量: 'abc', status: '需补充' })
check('未知类别+坏预警值 → 默认补值 30', dirty.预警储备量 === 30 && dirty.阈值来源 === '默认补值', `${dirty.预警储备量}/${dirty.阈值来源}`)
check('坏实际值按 0 处理，状态=需补充', dirty.实际储备量 === 0 && dirty.status === '需补充', dirty.status)
const knownCat = normalizeSupply({ 物资类别: '防护装备', 实际储备量: 5 })
check('已知类别缺失预警值按类别补 40', knownCat.预警储备量 === 40 && knownCat.阈值来源 === '类别补值')
const kept = normalizeSupply({ 物资类别: '防护装备', 预警储备量: '99', 实际储备量: '100' })
check('原始值是数字字符串时保留', kept.预警储备量 === 99 && kept.阈值来源 === '原始值')

// 4. 过期物资不可领用、不可补充
const beforeLedger = listLedger().length
const expiredReq = submitRequisition({ token: 't-expired', supplyId: medkit.id, 数量: 1, 领用人: '张三', 用途: 'x' })
check('过期物资领用被拒绝', expiredReq.ok === false)
check('拒绝领用不写流水', listLedger().length === beforeLedger)
check('过期物资发起补充被拒绝', requestReplenish(medkit.id).ok === false)
check('过期物资确认补充被拒绝', confirmReplenish(medkit.id).ok === false)

// 5. 并发领用只扣一次（Promise.all + 同 token）
const suit = listSupplies().find((s) => s.物资编号 === 'SUPP-0003')!
const stockBefore = suit.实际储备量
const ledgerBefore = listLedger().filter((l) => l.类型 === '领用扣减').length
const token = 'LY-CONCURRENT-1'
const results = await Promise.all([
  submitRequisitionQueued({ token, supplyId: suit.id, 数量: 5, 领用人: '李四', 用途: '巡护' }),
  submitRequisitionQueued({ token, supplyId: suit.id, 数量: 5, 领用人: '李四', 用途: '巡护' }),
])
const suitAfter = listSupplies().find((s) => s.id === suit.id)!
check('两次并发都返回 ok', results.every((r) => r.ok))
check('库存只扣一次 18→13', suitAfter.实际储备量 === stockBefore - 5, `实际 ${suitAfter.实际储备量}`)
const requisitionsAfter = listLedger().filter((l) => l.类型 === '领用扣减')
check('扣减记录只生成一条', requisitionsAfter.length === ledgerBefore + 1, `实际 ${requisitionsAfter.length}`)

// 5b. 已处理 token 再提交同样幂等
const dup = submitRequisition({ token, supplyId: suit.id, 数量: 5, 领用人: '李四', 用途: '巡护' })
check('已处理 token 再次提交不扣减', dup.ok === true && listSupplies().find((s) => s.id === suit.id)!.实际储备量 === stockBefore - 5)

// 6. 领用超库存 → 失败回退（流水不增、库存不变）
const overstock = submitRequisition({ token: 'LY-OVER-1', supplyId: suit.id, 数量: 9999, 领用人: '王五', 用途: 'x' })
check('超库存领用失败', overstock.ok === false)
check('失败后库存不变（整体回退）', listSupplies().find((s) => s.id === suit.id)!.实际储备量 === stockBefore - 5)

// 7. 领用跌破线 → 同事务生成待办；继续领用不重复建
const radio = listSupplies().find((s) => s.物资编号 === 'SUPP-0005')! // 库存15 阈值8
const r1 = submitRequisition({ token: 'LY-RADIO-1', supplyId: radio.id, 数量: 10, 领用人: '赵六', 用途: '值守' })
check('领用到阈值以下成功', r1.ok && r1.data?.变动后 === 5)
check('跌破预警线自动生成 1 条补充待办', listTodos('待处理').filter((t) => t.物资id === radio.id).length === 1)
submitRequisition({ token: 'LY-RADIO-2', supplyId: radio.id, 数量: 1, 领用人: '赵六', 用途: '值守' })
check('继续领用不重复建待办', listTodos('待处理').filter((t) => t.物资id === radio.id).length === 1)

// 8. 确认补充：入库 + 关待办 + 状态回充足
const replenished = confirmReplenish(radio.id)
check('确认补充成功', replenished.ok, replenished.message)
const radioAfter = listSupplies().find((s) => s.id === radio.id)!
check('补充后库存 >= 预警值', radioAfter.实际储备量 >= radioAfter.预警储备量, `${radioAfter.实际储备量}/${radioAfter.预警储备量}`)
check('补充后状态回充足', radioAfter.status === '充足', radioAfter.status)
check('补充待办已关闭并关联单号', listTodos().filter((t) => t.物资id === radio.id).every((t) => t.状态 === '已完成' && t.关联单号.startsWith('RC-')))

// 9. 标记过期：终止待办
const extinguisher = listSupplies().find((s) => s.物资编号 === 'SUPP-0004')! // 需补充、种子有未完成待办
check('标记过期成功', markExpired(extinguisher.id).ok)
const extAfter = listSupplies().find((s) => s.id === extinguisher.id)!
check('过期后状态为已过期', extAfter.status === '已过期')
check('过期后原补充待办被终止', listTodos('待处理').filter((t) => t.物资id === extinguisher.id).length === 0)

// 10. 盘点：以实盘为准，盘盈关待办，盘亏建待办
const c1 = recordCount({ supplyId: 2, 实盘数量: 60 }) // SUPP-0002 45→60
check('盘盈登记成功', c1.ok, c1.message)
const s2 = listSupplies().find((s) => s.id === 2)!
check('盘盈后状态=充足且预警联动', s2.status === '充足' && s2.实际储备量 === 60, s2.status)
check('盘盈关闭旧待办', listTodos('待处理').filter((t) => t.物资id === 2).length === 0)
check('盘点写调整流水(+15)', listLedger().some((l) => l.类型 === '盘点调整' && l.物资id === 2 && l.数量 === 15))
recordCount({ supplyId: 2, 实盘数量: 30 }) // → 需补充
const s2b = listSupplies().find((s) => s.id === 2)!
check('盘亏后状态联动=需补充', s2b.status === '需补充', s2b.status)
check('盘亏自动新建补充待办', listTodos('待处理').filter((t) => t.物资id === 2).length === 1)
check('负数盘点被拒绝', recordCount({ supplyId: 2, 实盘数量: -3 }).ok === false)
check('拒绝后库存保持 30', listSupplies().find((s) => s.id === 2)!.实际储备量 === 30)
const ledgerBeforeCount = listLedger().length
const same = recordCount({ supplyId: 2, 实盘数量: 30 })
check('账实相符不写流水', same.ok && listLedger().length === ledgerBeforeCount)

// 11. 盘点回执导入：同事务落库、坏行整体回退
const sheet = toCsv([
  COUNT_SHEET_HEADER,
  ...buildSheetRowsFromSupplies(),
])
const headerLine = sheet.split('\r\n')[0]
check('盘点表含必填列', headerLine.includes('物资编号') && headerLine.includes('盘点实际储备量'))

const importContent = [
  headerLine,
  sheetRow('SUPP-0001', '33'), // 36→33 仍充足
  sheetRow('SUPP-0005', '2'), // 当前充足 → 需补充
].join('\r\n')
const importRes = importReceipt(importContent)
check('回执导入成功', importRes.ok, importRes.message)
check('导入后 SUPP-0001=33', listSupplies().find((s) => s.物资编号 === 'SUPP-0001')!.实际储备量 === 33)
const s5 = listSupplies().find((s) => s.物资编号 === 'SUPP-0005')!
check('导入后 SUPP-0005=2 且状态联动=需补充', s5.实际储备量 === 2 && s5.status === '需补充', `${s5.实际储备量}/${s5.status}`)
check('差异结果含两项', importRes.data!.diffs.length === 2)
check('导入项数=2，账实不符=2', importRes.data!.imported === 2 && importRes.data!.changed === 2)
const diffHeader = diffFileHeader(importRes.data!.diffs)
check('差异文件含差异/状态/单号列', ['差异', '盘点后状态', '关联单号'].every((col) => diffHeader.includes(col)))

// 坏回执：未知物资 → 全部回退
const badReceipt = [headerLine, sheetRow('SUPP-0001', '10'), 'UNKNOWN,不存在,,,,,,,7'].join('\r\n')
check('坏回执导入失败', importReceipt(badReceipt).ok === false)
check('失败整体回退：SUPP-0001 仍 33', listSupplies().find((s) => s.物资编号 === 'SUPP-0001')!.实际储备量 === 33)
check('负数实盘量被拒绝', importReceipt([headerLine, sheetRow('SUPP-0001', '-1')].join('\r\n')).ok === false)
check('回退后 SUPP-0001 仍 33', listSupplies().find((s) => s.物资编号 === 'SUPP-0001')!.实际储备量 === 33)
const partial = [headerLine, sheetRow('SUPP-0001', ''), sheetRow('SUPP-0002', '50')].join('\r\n')
const partialRes = importReceipt(partial)
check('未盘点行跳过，其余导入', partialRes.ok && partialRes.data?.imported === 1, partialRes.message)
check('跳过行库存不变(33)', listSupplies().find((s) => s.物资编号 === 'SUPP-0001')!.实际储备量 === 33)
check('SUPP-0002 导入为 50 并回充足', listSupplies().find((s) => s.物资编号 === 'SUPP-0002')!.status === '充足')

// ---- helpers ----
function buildSheetRowsFromSupplies(): (string | number)[][] {
  return listSupplies().map((row) => [
    row.物资编号, row.物资名称, row.物资类别, row.储备林场, row.单位,
    row.预警储备量, row.实际储备量, row.有效期至, '',
  ])
}
function sheetRow(code: string, counted: string): string {
  const row = buildSheetRowsFromSupplies().find((cells) => cells[0] === code)!
  row[row.length - 1] = counted
  return row.join(',')
}
function diffFileHeader(diffs: CountDiff[]): string {
  let captured = ''
  const orig = (globalThis as { Blob?: unknown }).Blob
  ;(globalThis as { Blob?: unknown }).Blob = class {
    constructor(parts: unknown[]) {
      captured = String(parts[0])
    }
  }
  try {
    downloadDifferences(diffs)
  } finally {
    ;(globalThis as { Blob?: unknown }).Blob = orig
  }
  return captured.split('\r\n')[0]
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  process.exit(1)
}
