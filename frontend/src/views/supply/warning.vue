<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>物资预警面板</h2>
        <p class="page-desc">与储备列表同一口径：按统一阈值与判定规则实时重算，实际储备量或过期状态变化后立即联动。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reload">刷新预警</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong :class="card.cls" class="stat-value">{{ card.value }}</strong>
      </article>
    </div>

    <h3 class="block-title">预警物资</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>物资编号</th><th>物资名称</th><th>物资类别</th><th>储备林场</th>
          <th>预警储备量</th><th>实际储备量</th><th>偏低线</th><th>预警状态</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in warningRows" :key="row.id">
          <td>{{ row.物资编号 }}</td>
          <td>{{ row.物资名称 }}</td>
          <td>{{ row.物资类别 }}</td>
          <td>{{ row.储备林场 }}</td>
          <td>{{ row.预警储备量 }}{{ row.单位 }}</td>
          <td>{{ row.实际储备量 }}{{ row.单位 }}</td>
          <td>{{ lowLine(row.预警储备量) }}{{ row.单位 }}</td>
          <td><span :class="['status-pill', statusClass(row.status)]">{{ row.status }}</span></td>
          <td class="row-actions">
            <template v-if="row.status !== '已过期'">
              <button class="link" type="button" @click="request(row.id)">发起补充</button>
              <button class="link" type="button" @click="confirm(row.id)">确认补充</button>
            </template>
            <span v-else class="muted-text">过期物资禁止补充</span>
          </td>
        </tr>
        <tr v-if="!warningRows.length">
          <td colspan="9" class="empty-state">当前没有偏低、需补充或已过期物资</td>
        </tr>
      </tbody>
    </table>

    <h3 class="block-title">补充待办（库存跌破预警线自动生成，同一物资只保留一条未完成待办）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>物资编号</th><th>物资名称</th><th>缺口数量</th><th>创建时间</th><th>状态</th><th>关联单号</th><th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="todo in todos" :key="todo.id">
          <td>{{ todo.物资编号 }}</td>
          <td>{{ todo.物资名称 }}</td>
          <td>{{ todo.缺口数量 }}</td>
          <td>{{ todo.创建时间 }}</td>
          <td>
            <span :class="['status-pill', todo.状态 === '待处理' ? 'pill-warn' : todo.状态 === '已完成' ? 'pill-ok' : 'pill-expired']">
              {{ todo.状态 }}
            </span>
          </td>
          <td>{{ todo.关联单号 || '—' }}</td>
          <td class="row-actions">
            <button v-if="todo.状态 === '待处理'" class="link" type="button" @click="confirm(todo.物资id)">确认补充入库</button>
            <span v-else class="muted-text">{{ todo.备注 }}</span>
          </td>
        </tr>
        <tr v-if="!todos.length">
          <td colspan="7" class="empty-state">暂无补充待办</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  confirmReplenish,
  listSupplies,
  listTodos,
  requestReplenish,
} from '@/domain/supply/service'
import { lowLine } from '@/domain/supply/rules'
import type { ReplenishTodo, SupplyRow } from '@/domain/supply/types'

const supplies = ref<SupplyRow[]>([])
const todos = ref<ReplenishTodo[]>([])
const message = ref('')
const messageOk = ref(false)

const warningRows = computed(() =>
  supplies.value.filter((row) => row.status === '偏低' || row.status === '需补充' || row.status === '已过期'),
)

const cards = computed(() => [
  { label: '偏低', value: supplies.value.filter((row) => row.status === '偏低').length, cls: 'pill-low' },
  { label: '需补充', value: supplies.value.filter((row) => row.status === '需补充').length, cls: 'pill-warn' },
  { label: '已过期', value: supplies.value.filter((row) => row.status === '已过期').length, cls: 'pill-expired' },
  { label: '待补充待办', value: todos.value.filter((todo) => todo.状态 === '待处理').length, cls: 'pill-warn' },
])

function statusClass(status: string): string {
  if (status === '偏低') {
    return 'pill-low'
  }
  if (status === '需补充') {
    return 'pill-warn'
  }
  return 'pill-expired'
}

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
  reload()
}

function request(id: number) {
  const result = requestReplenish(id)
  notify(result.ok, result.message)
}

function confirm(id: number) {
  const result = confirmReplenish(id)
  notify(result.ok, result.message)
}

function reload() {
  supplies.value = listSupplies()
  todos.value = listTodos()
}

onMounted(reload)
</script>
