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

// 预置 v1 旧结构（含脏阈值、缺失阈值、用户改过但与数量冲突的状态）
;(window as unknown as { localStorage: LS }).localStorage.setItem(
  'forest-fire-patrol:entries',
  JSON.stringify({
    supply: [
      { id: 1, status: '偏低', pending: true, abnormal: false, 物资编号: 'SUPP-0001', 物资名称: '风力灭火机', 物资类别: '灭火机具', 规格型号: 'x', 储备林场: '青山', 预警储备量: '不是数字', 实际储备量: '35' },
      { id: 2, status: '充足', pending: false, abnormal: false, 物资编号: 'SUPP-0002', 物资名称: '防火服', 物资类别: '防护装备', 规格型号: 'x', 储备林场: '红山', 实际储备量: '10' },
      { id: 3, status: '充足', pending: false, abnormal: false, 物资编号: 'SUPP-0003', 物资名称: '神秘物资', 物资类别: '未登记类别', 规格型号: 'x', 储备林场: '云岭', 实际储备量: '0' },
    ],
  }),
)

const { listSupplies, listTodos } = await import('@/domain/supply/service')

let fail = 0
function expect(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ' ' + extra}`)
  if (!cond) {
    fail += 1
  }
}

const rows = listSupplies()
for (const r of rows) {
  console.log(`  ${r.物资编号} ${r.物资类别} 阈值=${r.预警储备量} 实际=${r.实际储备量} ${r.阈值来源} → ${r.status}`)
}
expect('迁移后仍是 3 条（按旧 id 覆盖种子）', rows.length === 3, `实际 ${rows.length}`)
const r1 = rows.find((r) => r.id === 1)!
expect('脏阈值按类别补值 20', r1.预警储备量 === 20 && r1.阈值来源 === '类别补值')
expect('实际 35 >= 20，旧状态偏低被实际盘点纠正为充足', r1.status === '充足', r1.status)
const r2 = rows.find((r) => r.id === 2)!
expect('缺失阈值按防护装备补 40，实际 10 判需补充（旧状态充足被纠正）', r2.预警储备量 === 40 && r2.status === '需补充', `${r2.预警储备量}/${r2.status}`)
const r3 = rows.find((r) => r.id === 3)!
expect('未登记类别走默认补值 30', r3.预警储备量 === 30 && r3.阈值来源 === '默认补值' && r3.status === '需补充', `${r3.预警储备量}/${r3.status}`)
const todos = listTodos('待处理').map((t) => t.物资id)
expect('迁移后待办与状态一致：id 2、3 有待办', todos.includes(2) && todos.includes(3) && !todos.includes(1), String(todos))

process.exit(fail > 0 ? 1 : 0)
