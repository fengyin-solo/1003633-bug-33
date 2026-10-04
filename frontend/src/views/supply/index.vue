<template>
  <section class="page" data-module="supply">
    <header class="page-head">
      <div>
        <h2>物资储备管理</h2>
        <p class="page-desc">
          储备列表、预警面板、领用清单、盘点差异共用同一套阈值与状态规则；库存、预警、待办同一事务落库。
        </p>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <nav class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="tab-item"
        :class="{ active: active === tab.key }"
        type="button"
        @click="active = tab.key"
      >
        {{ tab.label }}
        <span v-if="tab.badge" class="tab-badge">{{ tab.badge }}</span>
      </button>
    </nav>

    <StockPanel v-if="active === 'stock'" @changed="reload" />
    <WarningPanel v-else-if="active === 'warning'" @changed="reload" />
    <RequisitionPanel v-else-if="active === 'requisition'" @changed="reload" />
    <StocktakePanel v-else @changed="reload" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import StockPanel from './panels/StockPanel.vue'
import WarningPanel from './panels/WarningPanel.vue'
import RequisitionPanel from './panels/RequisitionPanel.vue'
import StocktakePanel from './panels/StocktakePanel.vue'
import { openTodoCount, supplyStats, listWarnings } from '@/data/supply/service'

type TabKey = 'stock' | 'warning' | 'requisition' | 'stocktake'

const active = ref<TabKey>('stock')
const tick = ref(0)

function reload() {
  tick.value += 1
}

const stats = computed(() => {
  void tick.value
  const summary = supplyStats()
  return [
    { label: '物资种类', value: summary.total },
    { label: '充足', value: summary.enough },
    { label: '偏低', value: summary.low },
    { label: '需补充', value: summary.need },
    { label: '已过期', value: summary.expired },
    { label: '补充待办', value: openTodoCount() },
  ]
})

const tabs = computed(() => {
  void tick.value
  return [
    { key: 'stock' as TabKey, label: '储备列表', badge: 0 },
    { key: 'warning' as TabKey, label: '预警面板', badge: listWarnings().length },
    { key: 'requisition' as TabKey, label: '领用清单', badge: 0 },
    { key: 'stocktake' as TabKey, label: '盘点差异', badge: 0 },
  ]
})

onMounted(reload)
</script>
