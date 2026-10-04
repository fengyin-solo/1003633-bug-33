<template>
  <section class="page" data-module="supply">
    <header class="page-head">
      <div>
        <h2>物资储备管理</h2>
        <p class="page-desc">状态统一按「实际储备量 / 预警储备量 / 过期标记」判定，冲突时以实际盘点为准；预警值缺失按物资类别自动补值。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="exportCountSheet">导出盘点表</button>
        <button class="btn" type="button" @click="triggerReceipt">导入盘点回执</button>
        <button class="btn" type="button" @click="exportRows">导出物资储备清单</button>
        <input ref="receiptInput" type="file" accept=".csv" class="hidden-file" @change="onReceiptPicked" />
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '预警储备量'">
              {{ row[column] }}
              <span v-if="row['阈值来源'] !== '原始值'" class="tag warn" :title="`历史缺失预警值，按${row['物资类别']}类别补值`">
                {{ row['阈值来源'] }}
              </span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>
            <span :class="['status-pill', statusClass(row.status)]">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action.name"
              class="link"
              type="button"
              @click="runRowAction(action, row)"
            >
              {{ action.name }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无物资储备数据</td>
        </tr>
      </tbody>
    </table>

    <div v-if="lastDiffs.length" class="diff-panel">
      <div class="diff-head">
        <strong>最近一次盘点差异（{{ lastDiffs.length }} 项）</strong>
        <button class="btn" type="button" @click="downloadLastDiffs">下载差异文件</button>
      </div>
      <table class="data-table">
        <thead>
          <tr>
            <th>物资编号</th><th>物资名称</th><th>账面数量</th><th>实盘数量</th><th>差异</th><th>盘点后状态</th><th>关联单号</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="diff in lastDiffs" :key="diff.物资编号">
            <td>{{ diff.物资编号 }}</td>
            <td>{{ diff.物资名称 }}</td>
            <td>{{ diff.账面数量 }}</td>
            <td>{{ diff.实盘数量 }}</td>
            <td :class="diff.差异 < 0 ? 'error-text' : diff.差异 > 0 ? 'gain-text' : ''">{{ diff.差异 > 0 ? `+${diff.差异}` : diff.差异 }}</td>
            <td>{{ diff.盘点后状态 }}</td>
            <td>{{ diff.单号 }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="countTarget" class="modal-mask" @click.self="closeCount">
      <div class="modal-card">
        <h3>盘点登记 · {{ countTarget.物资名称 }}</h3>
        <p class="page-desc">以实际盘点为准，保存后库存、预警状态与补充待办在同一事务更新，失败整体回退。</p>
        <dl class="count-grid">
          <div><dt>账面实际储备量</dt><dd>{{ countTarget.实际储备量 }} {{ countTarget.单位 }}</dd></div>
          <div><dt>预警储备量</dt><dd>{{ countTarget.预警储备量 }} {{ countTarget.单位 }}</dd></div>
          <div><dt>有效期至</dt><dd>{{ countTarget.有效期至 || '—' }}</dd></div>
        </dl>
        <label class="filter-item">
          <span>盘点实际数量</span>
          <input v-model.number="countQty" type="number" min="0" :placeholder="`单位：${countTarget.单位}`" />
        </label>
        <label class="filter-item">
          <span>盘点后有效期（可选，填写后按新日期重算过期）</span>
          <input v-model="countExpiry" type="date" />
        </label>
        <p v-if="countError" class="error-text">{{ countError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeCount">取消</button>
          <button class="btn primary" type="button" @click="saveCount">保存盘点结果</button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条物资储备记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="okMessage" class="ok-text">{{ okMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  downloadDifferences,
  exportCountSheet as exportCountSheetFile,
  importReceiptQueued,
  recordCount,
} from '@/domain/supply/service'
import type { CountDiff } from '@/domain/supply/service'
import type { EntryRow } from '@/data/types'
import type { SupplyRow } from '@/domain/supply/types'

const meta = moduleMeta('supply')
const columns = ['物资编号', '物资名称', '物资类别', '规格型号', '储备林场', '单位', '预警储备量', '实际储备量', '有效期至', '物资状态']
const filterFields = columns.slice(0, 3)

const rows = ref<SupplyRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const okMessage = ref('')
const filters = ref<Record<string, string>>({})
const lastDiffs = ref<CountDiff[]>([])
const receiptInput = ref<HTMLInputElement | null>(null)

const statusSummary = computed(() =>
  (['充足', '偏低', '需补充', '已过期'] as const).map((status) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

const statCards = computed(() => [
  { label: '物资种类', value: rows.value.length },
  { label: '偏低种类', value: rows.value.filter((row) => row.status === '偏低').length },
  { label: '需补充种类', value: rows.value.filter((row) => row.status === '需补充').length },
  { label: '过期种类', value: rows.value.filter((row) => row.status === '已过期').length },
])

function statusClass(status: string): string {
  if (status === '充足') {
    return 'pill-ok'
  }
  if (status === '偏低') {
    return 'pill-low'
  }
  if (status === '需补充') {
    return 'pill-warn'
  }
  return 'pill-expired'
}

/** 过期物资不允许补充；库存充足不允许重复发起/确认补充。 */
function availableActions(row: SupplyRow): { name: string }[] {
  const actions: { name: string }[] = []
  if (row.status !== '已过期') {
    if (row.status === '偏低' || row.status === '需补充') {
      actions.push({ name: '发起补充' }, { name: '确认补充' })
    }
  }
  if (row.status !== '已过期') {
    actions.push({ name: '标记过期' })
  }
  actions.push({ name: '盘点登记' })
  return actions
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportCountSheet() {
  exportCountSheetFile()
  okMessage.value = '盘点表已导出，填写「盘点实际储备量」列后可作为回执导入'
}

function triggerReceipt() {
  receiptInput.value?.click()
}

async function onReceiptPicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  errorMessage.value = ''
  okMessage.value = '回执解析中…'
  try {
    const content = await file.text()
    const result = await importReceiptQueued(content)
    if (!result.ok || !result.data) {
      errorMessage.value = result.message
      okMessage.value = ''
      return
    }
    lastDiffs.value = result.data.diffs
    okMessage.value = result.message
    reload()
  } catch {
    errorMessage.value = '回执文件读取失败'
    okMessage.value = ''
  }
}

function downloadLastDiffs() {
  downloadDifferences(lastDiffs.value)
}

// ---------- 盘点登记弹层 ----------

const countTarget = ref<SupplyRow | null>(null)
const countQty = ref<number | null>(null)
const countExpiry = ref('')
const countError = ref('')

function openCount(row: SupplyRow) {
  countTarget.value = row
  countQty.value = row.实际储备量
  countExpiry.value = ''
  countError.value = ''
}

function closeCount() {
  countTarget.value = null
  countError.value = ''
}

function saveCount() {
  if (!countTarget.value) {
    return
  }
  const result = recordCount({
    supplyId: countTarget.value.id,
    实盘数量: Number(countQty.value),
    新有效期: countExpiry.value,
  })
  if (!result.ok) {
    countError.value = result.message
    return
  }
  okMessage.value = result.message
  closeCount()
  reload()
}

function runRowAction(action: { name: string }, row: EntryRow) {
  errorMessage.value = ''
  okMessage.value = ''
  if (action.name === '盘点登记') {
    openCount(row as SupplyRow)
    return
  }
  const result = applyAction(meta.key, Number(row.id), action.name)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  okMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items as unknown as SupplyRow[]
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '物资储备列表读取失败'
  }
}

onMounted(reload)
</script>
