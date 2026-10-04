<template>
  <div>
    <p class="status-legend">
      <span class="legend-item">判定规则：已过期优先；实际 ≥ 预警为充足，≥ 预警 × 0.5 为偏低，再低为需补充</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>关键字</span>
        <input v-model="filters.keyword" placeholder="编号/名称/型号" />
      </label>
      <label class="filter-item">
        <span>物资类别</span>
        <select v-model="filters.物资类别">
          <option value="">全部类别</option>
          <option v-for="cat in facets.categories" :key="cat" :value="cat">{{ cat }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>储备林场</span>
        <select v-model="filters.储备林场">
          <option value="">全部林场</option>
          <option v-for="forest in facets.forests" :key="forest" :value="forest">{{ forest }}</option>
        </select>
      </label>
      <label class="filter-item">
        <span>状态</span>
        <select v-model="filters.状态">
          <option value="">全部状态</option>
          <option v-for="status in statuses" :key="status" :value="status">{{ status }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th>物资编号</th>
          <th>物资名称</th>
          <th>物资类别</th>
          <th>规格型号</th>
          <th>储备林场</th>
          <th>预警储备量</th>
          <th>实际储备量</th>
          <th>到期日期</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.id">
          <td>{{ row.物资编号 }}</td>
          <td>{{ row.物资名称 }}</td>
          <td>{{ row.物资类别 }}</td>
          <td>{{ row.规格型号 }}</td>
          <td>{{ row.储备林场 }}</td>
          <td>
            <input class="inline-input" :value="warningDraft(row.id)" :placeholder="String(row.生效预警量)" @input="setWarningDraft(row.id, ($event.target as HTMLInputElement).value)" />
            <button class="link" type="button" @click="saveWarning(row.id)">保存</button>
            <span v-if="row.是否补值" class="hint-tag" title="历史缺失预警值，按原物资类别默认值兼容补值；留空保存仍走类别补值">类别补值</span>
          </td>
          <td>
            <input class="inline-input" :value="actualDraft(row.id)" @input="setActualDraft(row.id, ($event.target as HTMLInputElement).value)" />
            <button class="link" type="button" @click="saveActual(row.id)">保存</button>
          </td>
          <td>
            {{ row.到期日期 }}
            <span v-if="row.距到期天数 !== null && row.距到期天数 >= 0 && row.距到期天数 <= 30" class="hint-tag">
              {{ row.距到期天数 === 0 ? '今日到期' : `${row.距到期天数}天后到期` }}
            </span>
          </td>
          <td><span class="badge" :class="badgeClass(row.状态)">{{ row.状态 }}</span></td>
          <td class="row-actions">
            <template v-if="row.状态 === '已过期'">
              <button class="link" type="button" @click="renew(row.物资编号)">重新登记有效期</button>
              <button class="link" type="button" :disabled="true" title="已过期物资不能补充">补充（已禁用）</button>
            </template>
            <template v-else>
              <button class="link" type="button" @click="start(row.物资编号)">发起补充</button>
              <button class="link" type="button" @click="confirm(row.物资编号)">确认补充</button>
              <button class="link" type="button" @click="expire(row.物资编号)">标记过期</button>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="10" class="empty-state">没有符合条件的物资</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rows.length }} 条物资记录，状态随实际储备量实时重算</span>
      <span v-if="message" :class="messageOk ? 'success-text' : 'error-text'">{{ message }}</span>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

import {
  listSupplyItems,
  markExpired,
  renewItem,
  startReplenish,
  confirmReplenish,
  supplyFacets,
  updateItemQuantity,
  type SupplyFilter,
} from '@/data/supply/service'
import type { ItemView } from '@/data/supply/rules'
import type { ServiceResult, SupplyStatus } from '@/data/supply/types'

const emit = defineEmits<{ (event: 'changed'): void }>()

const statuses: SupplyStatus[] = ['充足', '偏低', '需补充', '已过期']
const rows = ref<ItemView[]>([])
const facets = ref<{ categories: string[]; forests: string[] }>({ categories: [], forests: [] })
const filters = reactive<SupplyFilter>({ keyword: '', 物资类别: '', 储备林场: '', 状态: '' })
const actualDrafts = reactive<Record<number, string>>({})
const warningDrafts = reactive<Record<number, string>>({})
const message = ref('')
const messageOk = ref(false)

function badgeClass(status: SupplyStatus): string {
  return { 充足: 'ok', 偏低: 'low', 需补充: 'need', 已过期: 'expired' }[status]
}

function reload() {
  rows.value = listSupplyItems(filters)
  facets.value = supplyFacets()
  for (const row of rows.value) {
    if (actualDrafts[row.id] === undefined) {
      actualDrafts[row.id] = String(row.实际储备量)
    }
    if (warningDrafts[row.id] === undefined) {
      warningDrafts[row.id] = row.是否补值 ? '' : String(row.生效预警量)
    }
  }
}

function resetFilters() {
  filters.keyword = ''
  filters.物资类别 = ''
  filters.储备林场 = ''
  filters.状态 = ''
  reload()
}

function actualDraft(id: number): string {
  return actualDrafts[id] ?? ''
}
function warningDraft(id: number): string {
  return warningDrafts[id] ?? ''
}
function setActualDraft(id: number, value: string) {
  actualDrafts[id] = value
}
function setWarningDraft(id: number, value: string) {
  warningDrafts[id] = value
}

function notify(result: ServiceResult) {
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok) {
    emit('changed')
    reload()
  }
}

function saveActual(id: number) {
  notify(updateItemQuantity(id, '实际储备量', actualDrafts[id] ?? ''))
}

function saveWarning(id: number) {
  notify(updateItemQuantity(id, '预警储备量', warningDrafts[id] ?? ''))
}

function start(code: string) {
  notify(startReplenish(code))
}

function confirm(code: string) {
  const value = window.prompt(`确认补充数量（物资编号 ${code}）`, '10')
  if (value === null) {
    return
  }
  notify(confirmReplenish(code, value))
}

function expire(code: string) {
  if (window.confirm(`确认将 ${code} 标记为过期？过期后不能补充、领用。`)) {
    notify(markExpired(code))
  }
}

function renew(code: string) {
  const value = window.prompt(`重新登记有效期（${code}），格式 YYYY-MM-DD；留空默认一年后`, '')
  if (value === null) {
    return
  }
  notify(renewItem(code, value.trim()))
}

onMounted(reload)
</script>
