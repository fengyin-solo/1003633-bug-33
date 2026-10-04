import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { initSupplyStore } from './data/supply/store'
import './styles/global.css'

// 初始化物资库存域，并把统一判定的状态镜像到通用存储，运营概览口径保持一致。
initSupplyStore()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
