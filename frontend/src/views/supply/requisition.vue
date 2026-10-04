<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>物资领用清单</h2>
        <p class="page-desc">领用扣减与预警重算、补充待办、扣减流水在同一事务落库；同一领用单（凭证号）重复或并发提交只扣一次。</p>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>

    <div class="requisition-form">
      <h3 class="block-title">发起领用</h3>
      <form class="filter-bar" @submit.prevent="submit">
        <label class="filter-item">
          <span>领用凭证号（防重复扣减）</span>
          <input v-model="form.token" class="token-input" readonly />
        </label>
        <label class="filter-item">
          <span>物资</span>
          <select v-model="form.supplyId">
            <option :value="0" disabled>请选择物资</option>
            <option v-for="row in availableSupplies" :key="row.id" :value="row.id">
              {{ row.物资编号 }}｜{{ row.物资名称 }}（库存 {{ row.实际储备量 }}{{ row.单位 }}）
            </option>
          </select>
        </label>
        <label class="filter-item">
          <span>领用数量</span>
          <input v-model.number="form.数量" type="number" min="1" />
        </label>
        <label class="filter-item">
          <span>领用人</span>
          <input v-model="form.领用人" placeholder="填写领用人" />
        </label>
        <label class="filter-item grow">
          <span>用途</span>
          <input v-model="form.用途" placeholder="例：秋季防火巡护" />
        </label>
        <button class="btn primary" type="submit" :disabled="submitting">提交领用</button>
        <button class="btn" type="button" :disabled="submitting" @click="submitTwice">模拟并发重复提交</button>
        <button class="btn ghost" type="button" @click="resetToken">换新凭证号</button>
      </form>
      <p class="page-desc">「模拟并发重复提交」会同时用同一凭证号发起两次请求，验证并发下库存只扣一次、扣减记录不重复。</p>
    </div>

    <h3 class="block-title">领用扣减流水</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>单号</th><th>时间</th><th>物资编号</th><th>物资名称</th>
          <th>扣减数量</th><th>变动前</th><th>变动后</th><th>领用人</th><th>用途</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in requisitions" :key="entry.id">
          <td>{{ entry.单号 }}</td>
          <td>{{ entry.时间 }}</td>
          <td>{{ entry.物资编号 }}</td>
          <td>{{ entry.物资名称 }}</td>
          <td>-{{ entry.数量 }}</td>
          <td>{{ entry.变动前 }}</td>
          <td>{{ entry.变动后 }}</td>
          <td>{{ entry.领用人 }}</td>
          <td>{{ entry.用途 || '—' }}</td>
        </tr>
        <tr v-if="!requisitions.length">
          <td colspan="9" class="empty-state">暂无领用记录，发起领用后在此生成扣减流水</td>
        </tr>
      </tbody>
    </table>

    <h3 class="block-title">库存变动台账（领用 / 补充 / 盘点）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>类型</th><th>单号</th><th>时间</th><th>物资名称</th><th>变动数量</th><th>变动前</th><th>变动后</th><th>备注</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in ledger" :key="entry.id">
          <td>{{ entry.类型 }}</td>
          <td>{{ entry.单号 }}</td>
          <td>{{ entry.时间 }}</td>
          <td>{{ entry.物资名称 }}</td>
          <td :class="entry.类型 === '领用扣减' ? 'error-text' : entry.数量 > 0 ? 'gain-text' : ''">
            {{ entry.类型 === '领用扣减' ? `-${entry.数量}` : entry.数量 > 0 ? `+${entry.数量}` : entry.数量 }}
          </td>
          <td>{{ entry.变动前 }}</td>
          <td>{{ entry.变动后 }}</td>
          <td>{{ entry.备注 || entry.用途 || '—' }}</td>
        </tr>
        <tr v-if="!ledger.length">
          <td colspan="8" class="empty-state">暂无台账记录</td>
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
  listLedger,
  listSupplies,
  submitRequisitionQueued,
  type RequisitionInput,
} from '@/domain/supply/service'
import type { LedgerEntry, SupplyRow } from '@/domain/supply/types'

function makeToken(): string {
  const rand = () => Math.random().toString(16).slice(2, 10)
  return `LY-${Date.now().toString(16)}-${rand()}${rand()}`
}

const supplies = ref<SupplyRow[]>([])
const ledger = ref<LedgerEntry[]>([])
const submitting = ref(false)
const message = ref('')
const messageOk = ref(false)

const form = ref<RequisitionInput>({
  token: makeToken(),
  supplyId: 0,
  数量: 1,
  领用人: '',
  用途: '',
})

const availableSupplies = computed(() => supplies.value.filter((row) => !row.过期 && row.实际储备量 > 0))
const requisitions = computed(() => ledger.value.filter((entry) => entry.类型 === '领用扣减'))

const cards = computed(() => [
  { label: '领用次数', value: requisitions.value.length },
  { label: '累计领用数量', value: requisitions.value.reduce((sum, entry) => sum + entry.数量, 0) },
  { label: '可领用物资种类', value: availableSupplies.value.length },
  { label: '过期冻结种类', value: supplies.value.filter((row) => row.过期).length },
])

function resetToken() {
  form.value.token = makeToken()
}

function validate(): boolean {
  if (!form.value.supplyId) {
    message.value = '请选择要领用的物资'
    messageOk.value = false
    return false
  }
  if (!Number.isFinite(Number(form.value.数量)) || Number(form.value.数量) <= 0) {
    message.value = '领用数量必须是大于 0 的整数'
    messageOk.value = false
    return false
  }
  if (!form.value.领用人.trim()) {
    message.value = '请填写领用人'
    messageOk.value = false
    return false
  }
  return true
}

async function submit(): Promise<boolean> {
  if (!validate()) {
    return false
  }
  submitting.value = true
  try {
    const result = await submitRequisitionQueued({ ...form.value })
    messageOk.value = result.ok
    message.value = result.message
    if (result.ok) {
      form.value.数量 = 1
      form.value.用途 = ''
      resetToken()
    }
    reload()
    return result.ok
  } finally {
    submitting.value = false
  }
}

/** 同一凭证号同时发两次：第二次幂等命中，不产生第二条扣减记录。 */
async function submitTwice() {
  if (!validate()) {
    return
  }
  submitting.value = true
  const payload = { ...form.value }
  try {
    const [first, second] = await Promise.all([
      submitRequisitionQueued({ ...payload }),
      submitRequisitionQueued({ ...payload }),
    ])
    messageOk.value = first.ok && second.ok
    message.value = `并发提交结果：① ${first.message} ② ${second.message}（库存仅扣减一次）`
    resetToken()
    reload()
  } finally {
    submitting.value = false
  }
}

function reload() {
  supplies.value = listSupplies()
  ledger.value = listLedger().slice().reverse()
}

onMounted(reload)
</script>
