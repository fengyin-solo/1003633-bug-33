<template>
  <div>
    <div class="panel-card">
      <p class="panel-title">统一判定规则</p>
      <p class="note">
        三处页面同一口径：① 到期日早于今天 → <b>已过期</b>（优先级最高，禁止补充与领用）；
        ② 实际储备量 ≥ 预警储备量 → <b>充足</b>；
        ③ 实际储备量 ≥ 预警储备量 × 0.5 → <b>偏低</b>；④ 更低 → <b>需补充</b>。
        实际盘点回写的数量为唯一库存依据；历史缺失预警值的物资按「原类别」默认阈值兼容。
      </p>
    </div>

    <div class="stat-row">
      <article class="stat-card"><span class="stat-label">预警物资</span><strong class="stat-value">{{ warnings.length }}</strong></article>
      <article class="stat-card"><span class="stat-label">需补充</span><strong class="stat-value">{{ need }}</strong></article>
      <article class="stat-card"><span class="stat-label">偏低</span><strong class="stat-value">{{ low }}</strong></article>
      <article class="stat-card"><span class="stat-label">已过期</span><strong class="stat-value">{{ expired }}</strong></article>
      <article class="stat-card"><span class="stat-label">待补充待办</span><strong class="stat-value">{{ openTodos.length }}</strong></article>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th>物资编号</th>
          <th>物资名称</th>
          <th>物资类别</th>
          <th>储备林场</th>
          <th>生效预警量</th>
          <th>实际储备量</th>
          <th>缺口数量</th>
          <th>到期日期</th>
          <th>预警状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in warnings" :key="row.id">
          <td>{{ row.物资编号 }}</td>
          <td>{{ row.物资名称 }}</td>
          <td>{{ row.物资类别 }}<span v-if="row.是否补值" class="hint-tag">类别补值</span></td>
          <td>{{ row.储备林场 }}</td>
          <td>{{ row.生效预警量 }}{{ row.单位 }}</td>
          <td>{{ row.实际储备量 }}{{ row.单位 }}</td>
          <td>{{ row.状态 === '已过期' ? '—' : `${row.生效预警量 - row.实际储备量}${row.单位}` }}</td>
          <td>{{ row.到期日期 }}{{ row.状态 === '已过期' ? '（已过期）' : '' }}</td>
          <td><span class="badge" :class="badgeClass(row.状态)">{{ row.状态 }}</span></td>
        </tr>
        <tr v-if="!warnings.length">
          <td colspan="9" class="empty-state">暂无预警物资，库存全部充足且在有效期内</td>
        </tr>
      </tbody>
    </table>

    <p class="subhead">补充待办（库存变化时同一事务自动创建/关闭）</p>
    <table class="data-table">
      <thead>
        <tr><th>物资编号</th><th>类型</th><th>内容</th><th>状态</th><th>创建时间</th><th>关闭时间</th></tr>
      </thead>
      <tbody>
        <tr v-for="todo in todos" :key="todo.id">
          <td>{{ todo.物资编号 }}</td>
          <td>{{ todo.类型 }}</td>
          <td :class="todo.状态 === '已完成' ? 'todo-done' : ''">{{ todo.内容 }}</td>
          <td>
            <span class="badge" :class="todo.状态 === '待处理' ? 'need' : 'ok'">{{ todo.状态 }}</span>
          </td>
          <td>{{ todo.创建时间 }}</td>
          <td>{{ todo.关闭时间 ?? '—' }}</td>
        </tr>
        <tr v-if="!todos.length">
          <td colspan="6" class="empty-state">暂无补充待办</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { listWarnings, listTodos } from '@/data/supply/service'
import type { ItemView } from '@/data/supply/rules'
import type { SupplyStatus, SupplyTodo } from '@/data/supply/types'

defineEmits<{ (event: 'changed'): void }>()

const warnings = ref<ItemView[]>([])
const todos = ref<SupplyTodo[]>([])

const need = computed(() => warnings.value.filter((row) => row.状态 === '需补充').length)
const low = computed(() => warnings.value.filter((row) => row.状态 === '偏低').length)
const expired = computed(() => warnings.value.filter((row) => row.状态 === '已过期').length)
const openTodos = computed(() => todos.value.filter((todo) => todo.状态 === '待处理'))

function badgeClass(status: SupplyStatus): string {
  return { 充足: 'ok', 偏低: 'low', 需补充: 'need', 已过期: 'expired' }[status]
}

onMounted(() => {
  warnings.value = listWarnings()
  todos.value = listTodos(true)
})
</script>
