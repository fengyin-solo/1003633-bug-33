<template>
  <div>
    <div class="panel-card">
      <p class="panel-title">领用出库</p>
      <div class="form-grid">
        <div class="form-field">
          <label>领用流水号（重复提交只扣一次）</label>
          <input v-model="form.领用流水号" placeholder="如 REQ-20261004-001" />
        </div>
        <div class="form-field">
          <label>物资编号</label>
          <select v-model="form.物资编号">
            <option value="">请选择</option>
            <option v-for="item in items" :key="item.id" :value="item.物资编号" :disabled="item.状态 === '已过期'">
              {{ item.物资编号 }} {{ item.物资名称 }}（库存 {{ item.实际储备量 }}{{ item.单位 }}{{ item.状态 === '已过期' ? '，已过期' : '' }}）
            </option>
          </select>
        </div>
        <div class="form-field">
          <label>领用数量</label>
          <input v-model="form.领用数量" type="number" min="1" placeholder="正整数" />
        </div>
        <div class="form-field">
          <label>领用单位</label>
          <input v-model="form.领用单位" placeholder="如 青松林场巡护一队" />
        </div>
        <div class="form-field">
          <label>领用人</label>
          <input v-model="form.领用人" :placeholder="store.operator" />
        </div>
        <div class="form-field">
          <label>备注</label>
          <input v-model="form.备注" placeholder="选填" />
        </div>
      </div>
      <div class="form-actions">
        <button class="btn primary" type="button" :disabled="submitting" @click="submit">提交领用</button>
        <button class="btn" type="button" :disabled="submitting" @click="submitConcurrent">
          模拟同流水号并发 3 次
        </button>
        <span class="note">库存、扣减记录、预警与待办同一事务落库；过期物资禁止领用，超库存拒绝并回退。</span>
      </div>
    </div>

    <p v-if="message" :class="messageOk ? 'success-text' : 'error-text'" style="margin: 6px 0">{{ message }}</p>

    <table class="data-table">
      <thead>
        <tr>
          <th>领用流水号</th>
          <th>物资编号</th>
          <th>领用单位</th>
          <th>领用人</th>
          <th>领用数量</th>
          <th>扣减前库存</th>
          <th>扣减后库存</th>
          <th>状态</th>
          <th>领用时间</th>
          <th>备注</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="record in records" :key="record.id">
          <td>{{ record.领用流水号 }}</td>
          <td>{{ record.物资编号 }}</td>
          <td>{{ record.领用单位 }}</td>
          <td>{{ record.领用人 }}</td>
          <td>{{ record.领用数量 }}</td>
          <td>{{ record.扣减前数量 }}</td>
          <td>
            <template v-if="record.扣减后数量 === null">
              <span class="badge muted">未扣减</span>
            </template>
            <template v-else>{{ record.扣减后数量 }}</template>
          </td>
          <td><span class="badge" :class="record.状态 === '已发放' ? 'info' : 'muted'">{{ record.状态 }}</span></td>
          <td>{{ record.领用时间 }}</td>
          <td>{{ record.备注 || '—' }}</td>
        </tr>
        <tr v-if="!records.length">
          <td colspan="10" class="empty-state">暂无领用记录</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'

import { useSessionStore } from '@/stores/session'
import {
  enqueueRequisition,
  listRequisitions,
  listSupplyItems,
  simulateConcurrentRequisitions,
} from '@/data/supply/service'
import type { ItemView } from '@/data/supply/rules'
import type { RequisitionRecord } from '@/data/supply/types'
import type { RequisitionInput } from '@/data/supply/service'

const emit = defineEmits<{ (event: 'changed'): void }>()
const store = useSessionStore()

const items = ref<ItemView[]>([])
const records = ref<RequisitionRecord[]>([])
const submitting = ref(false)
const message = ref('')
const messageOk = ref(false)

function defaultSerial(): string {
  const now = new Date()
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const seq = String(records.value.length + 1).padStart(3, '0')
  return `REQ-${day}-${seq}`
}

const form = reactive<RequisitionInput>({
  领用流水号: '',
  物资编号: '',
  领用数量: '',
  领用单位: '',
  领用人: '',
  备注: '',
})

function reload() {
  items.value = listSupplyItems()
  records.value = listRequisitions()
}

function validate(): boolean {
  if (!form.领用流水号.trim()) {
    message.value = '请填写领用流水号'
    messageOk.value = false
    return false
  }
  return true
}

async function submit() {
  if (!validate()) {
    return
  }
  submitting.value = true
  message.value = ''
  try {
    const result = await enqueueRequisition({ ...form, 领用人: form.领用人 || store.operator })
    message.value = result.message
    messageOk.value = result.ok
    if (result.ok) {
      form.领用数量 = ''
      emit('changed')
      reload()
    }
  } finally {
    submitting.value = false
  }
}

async function submitConcurrent() {
  if (!validate()) {
    return
  }
  submitting.value = true
  message.value = '并发提交中……'
  messageOk.value = true
  try {
    // 同一输入对象引用的三份并发请求，模拟双击/重试同时到达。
    const summary = await simulateConcurrentRequisitions(
      { ...form, 领用人: form.领用人 || store.operator },
      3,
    )
    message.value =
      `并发 3 次：成功扣减 ${summary.deducted} 次，拒绝重复 ${summary.rejected} 次，库存只扣一次。` +
      summary.results.map((result) => result.message).join('｜')
    messageOk.value = summary.deducted === 1
    emit('changed')
    reload()
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  reload()
  form.领用流水号 = defaultSerial()
})
</script>
