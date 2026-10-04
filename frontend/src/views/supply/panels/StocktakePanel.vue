<template>
  <div>
    <div class="panel-card">
      <p class="panel-title">发起盘点</p>
      <div class="form-grid">
        <div class="form-field">
          <label>盘点林场</label>
          <select v-model="forest">
            <option value="">全部林场</option>
            <option v-for="item in facets.forests" :key="item" :value="item">{{ item }}</option>
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn primary" type="button" @click="create">生成盘点单并导出差异文件</button>
        <span class="note">
          导出的 CSV 可现场填写「盘点数量、备注、回执人、回执说明」；再通过「导入回执」上传，
          系统按实际盘点数量回写库存（冲突以盘点为准），库存/预警/待办同一事务更新，任一行校验失败整体回退。
        </span>
      </div>
    </div>

    <p v-if="message" :class="messageOk ? 'success-text' : 'error-text'" style="margin: 6px 0">{{ message }}</p>

    <div v-for="order in orders" :key="order.id" class="panel-card">
      <div class="form-actions" style="margin-top: 0">
        <strong>{{ order.盘点单号 }}</strong>
        <span class="badge" :class="order.状态 === '已回执' ? 'ok' : 'low'">{{ order.状态 }}</span>
        <span class="note">{{ order.盘点林场 }} · 盘点日期 {{ order.盘点日期 }}</span>
        <span v-if="order.回执时间" class="note">
          回执：{{ order.回执人 }} · {{ order.回执时间 }}<template v-if="order.回执说明"> · {{ order.回执说明 }}</template>
        </span>
        <span style="flex: 1"></span>
        <button class="btn" type="button" @click="download(order.id)">下载差异文件</button>
        <label class="btn file-label">
          导入回执
          <input type="file" accept=".csv,text/csv" @change="onFile($event)" />
        </label>
      </div>
      <table class="data-table" style="margin-top: 8px">
        <thead>
          <tr><th>物资编号</th><th>物资名称</th><th>账面数量</th><th>盘点数量</th><th>差异数量</th><th>备注</th></tr>
        </thead>
        <tbody>
          <tr v-for="line in order.明细" :key="line.物资编号">
            <td>{{ line.物资编号 }}</td>
            <td>{{ line.物资名称 }}</td>
            <td>{{ line.账面数量 }}</td>
            <td>{{ line.盘点数量 ?? '待盘点' }}</td>
            <td>
              <span v-if="line.差异数量 === null">—</span>
              <span v-else :class="line.差异数量 === 0 ? 'success-text' : line.差异数量 > 0 ? 'success-text' : 'error-text'">
                {{ line.差异数量 > 0 ? `+${line.差异数量}` : line.差异数量 }}
              </span>
            </td>
            <td>{{ line.备注 || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="!orders.length" class="empty-state">暂无盘点单，先发起一次盘点</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { useSessionStore } from '@/stores/session'
import { downloadTextFile } from '@/data/supply/csv'
import {
  createStocktake,
  exportStocktake,
  importStocktakeReceipt,
  listStocktakes,
  supplyFacets,
} from '@/data/supply/service'
import type { StocktakeOrder } from '@/data/supply/types'

const emit = defineEmits<{ (event: 'changed'): void }>()
const store = useSessionStore()

const forest = ref('')
const orders = ref<StocktakeOrder[]>([])
const facets = ref<{ categories: string[]; forests: string[] }>({ categories: [], forests: [] })
const message = ref('')
const messageOk = ref(false)

function reload() {
  orders.value = listStocktakes()
  facets.value = supplyFacets()
}

function create() {
  const result = createStocktake(forest.value, store.operator)
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok && result.data) {
    const exported = exportStocktake(result.data.id)
    if (exported.ok && exported.data) {
      downloadTextFile(exported.data.filename, exported.data.content)
    }
    emit('changed')
    reload()
  }
}

function download(id: number) {
  const result = exportStocktake(id)
  if (result.ok && result.data) {
    downloadTextFile(result.data.filename, result.data.content)
  } else {
    message.value = result.message
    messageOk.value = false
  }
}

async function onFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) {
    return
  }
  try {
    const content = await file.text()
    const result = importStocktakeReceipt(content, store.operator)
    message.value = result.message
    messageOk.value = result.ok
    if (result.ok) {
      emit('changed')
      reload()
    }
  } catch {
    message.value = '回执文件读取失败'
    messageOk.value = false
  }
}

onMounted(reload)
</script>
