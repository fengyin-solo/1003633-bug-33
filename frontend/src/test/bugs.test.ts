class LS {
  m = new Map<string, string>()
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
}
globalThis.window = { localStorage: new LS() } as unknown as Window & typeof globalThis
;(globalThis as unknown as { localStorage: LS }).localStorage = new LS()

const svc = await import('@/domain/supply/service')

let fail = 0
function expect(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + extra}`)
  if (!cond) fail += 1
}

// 场景一：实际储备量修改后预警不更新 → 盘点改实际量，预警立即联动
svc.recordCount({ supplyId: 8, 实盘数量: 5 }) // 手电 11→5，阈值12，偏低线10 → 需补充
let s8 = svc.listSupplies().find((r) => r.id === 8)!
expect('BUG1 修复：实际量改到 5 后预警面板状态=需补充', s8.status === '需补充', s8.status)
expect('BUG1 修复：自动补出补充待办', svc.listTodos('待处理').some((t) => t.物资id === 8))
svc.recordCount({ supplyId: 8, 实盘数量: 30 }) // 盘盈回线上
s8 = svc.listSupplies().find((r) => r.id === 8)!
expect('BUG1 修复：盘盈回 30 后状态立即=充足、待办关闭', s8.status === '充足' && !svc.listTodos('待处理').some((t) => t.物资id === 8), s8.status)

// 场景二：过期物资仍可补充 → 已过期物资的补充/领用全部拒绝
expect('BUG2 修复：过期物资发起补充被拒', svc.requestReplenish(7).ok === false)
expect('BUG2 修复：过期物资确认补充被拒', svc.confirmReplenish(7).ok === false)
expect('BUG2 修复：过期物资领用被拒', svc.submitRequisition({ token: 'z1', supplyId: 7, 数量: 1, 领用人: 'x', 用途: 'y' }).ok === false)
// 未过期物资标记过期后也立刻不可补
expect('标记过期成功', svc.markExpired(1).ok)
expect('BUG2 修复：刚标记过期的物资也不能再补充', svc.confirmReplenish(1).ok === false)

// 场景三：重复领用重复显示扣减记录 → 同 token 重复提交只一条流水
const before = svc.listLedger('领用扣减').length
const stock = svc.listSupplies().find((r) => r.id === 3)!.实际储备量
await Promise.all([
  svc.submitRequisitionQueued({ token: 'dup-x', supplyId: 3, 数量: 2, 领用人: '钱七', 用途: '演练' }),
  svc.submitRequisitionQueued({ token: 'dup-x', supplyId: 3, 数量: 2, 领用人: '钱七', 用途: '演练' }),
  svc.submitRequisitionQueued({ token: 'dup-x', supplyId: 3, 数量: 2, 领用人: '钱七', 用途: '演练' }),
])
expect('BUG3 修复：三次并发只新增一条扣减记录', svc.listLedger('领用扣减').length === before + 1)
expect('BUG3 修复：库存只扣一次', svc.listSupplies().find((r) => r.id === 3)!.实际储备量 === stock - 2)

// 事务回退：非法领用不产生任何副作用
const ledgerCount = svc.listLedger().length
const r = svc.submitRequisition({ token: 'bad1', supplyId: 3, 数量: -9, 领用人: '', 用途: '' })
expect('非法领用失败', r.ok === false)
expect('失败后流水数量不变（整体回退）', svc.listLedger().length === ledgerCount)

// 盘点导出→回执→差异文件全链路
const { toCsv } = await import('@/utils/csv')
const sheet = toCsv([svc.COUNT_SHEET_HEADER, ...svc.listSupplies().filter((x) => x.id === 2).map((row) => [row.物资编号, row.物资名称, row.物资类别, row.储备林场, row.单位, row.预警储备量, row.实际储备量, row.有效期至, '50'])])
const importRes = svc.importReceipt(sheet)
expect('回执导入成功', importRes.ok, importRes.message)
expect('差异文件可生成（含差异与单号）', svc.differencesToCsv(importRes.data!.diffs).includes('账面数量') && importRes.data!.diffs[0].单号.startsWith('PD-'))

console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`)
process.exit(fail ? 1 : 0)
