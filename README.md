# 森林防火巡护管理系统

面向森林火险监测、巡护任务调度、防火设施维护与应急响应指挥的林区防火管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 巡护任务 | `patrol` | 巡护任务 | 任务编号、巡护区域、巡护路线 |
| 火险监测 | `firewatch` | 火险监测点 | 监测点编号、监测区域、火险等级 |
| 瞭望台管理 | `lookout` | 瞭望台 | 瞭望台编号、所在山头、海拔高度 |
| 防火隔离带 | `firebreak` | 防火隔离带 | 隔离带编号、所属林区、起止坐标 |
| 扑火队伍 | `fireteam` | 扑火队伍 | 队伍编号、队伍名称、所属林场 |
| 消防装备 | `equipment` | 消防装备 | 装备编号、装备名称、装备类型 |
| 气象观测 | `weather` | 气象观测记录 | 记录编号、观测站点、观测时间 |
| 火情报告 | `firereport` | 火情报告 | 报告编号、起火地点、起火时间 |
| 无人机巡查 | `drone` | 无人机巡查任务 | 任务编号、飞行区域、飞行路线 |
| 防火宣传 | `campaign` | 防火宣传活动 | 活动编号、宣传主题、宣传方式 |
| 防火检查站 | `checkpoint` | 防火检查站 | 站点编号、站点位置、值守人员 |
| 值勤排班 | `duty` | 值勤排班表 | 排班编号、值勤日期、值勤时段 |
| 物资储备 | `supply` | 防火物资 | 物资编号、物资名称、物资类别、预警/实际储备量 |
| 物资预警面板 | `supply/warning` | 防火物资预警与补充待办 | 预警储备量、偏低线、缺口数量、待办状态 |
| 物资领用清单 | `supply/requisition` | 领用单与库存台账 | 领用单号、扣减数量、变动前后库存 |
| 林区道路 | `forestroad` | 林区道路 | 道路编号、道路名称、起点位置 |
| 防火林带 | `firebelt` | 防火林带 | 林带编号、林带名称、所属林区 |
| 应急演练 | `drill` | 应急演练 | 演练编号、演练主题、参演队伍 |
| 焚烧审批 | `burnpermit` | 用火审批单 | 审批编号、申请单位、用火类型 |
| 林木生长 | `treegrowth` | 林木生长记录 | 记录编号、样地编号、林分类型 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `forest-fire-patrol:entries` 这一项，或调用 `resetModule(模块)`。

## 物资库存与领用口径（supply 领域）

防火物资的库存、预警、领用、盘点集中在 `frontend/src/domain/supply/`，与通用模块的状态流转分开：

- **统一判定规则**（`domain/supply/rules.ts`）：状态只由「实际储备量 / 预警储备量 / 过期标记」派生，
  储备列表、预警面板、领用清单共用同一计算，不再各写一份。`实际 < 预警×80%` 判「偏低」，
  更低判「需补充」，过期标记优先判「已过期」；冲突时以实际盘点为准。
- **历史缺失预警值兼容补值**：迁移时对缺失或非数字的预警储备量，按物资原类别阈值补齐
  （`CATEGORY_THRESHOLDS`），类别未登记时用全局默认值，行上以「阈值来源」标注（原始值/类别补值/默认补值）。
- **同一事务落库**（`data/local-store.ts` 的 `mutateSupply`）：领用扣减、预警状态重算、
  补充待办创建/关闭、库存流水在草稿上一次性提交，任何一步抛错整体回退。
- **并发领用只扣一次**：领用单携带幂等 token，重复或并发提交命中后不重复扣减、不重复写流水；
  异步提交再经串行队列排队。
- **盘点**：支持单行盘点登记；列表页可「导出盘点表」（含账面量的 CSV 模板）、
  「导入盘点回执」（填写实盘量后整批同事务落库，任一行非法整体回退）、「下载盘点差异文件」。
- 本地存储结构带 `version: 2`，旧版平铺数据首次打开自动迁移。

物资领域的冒烟测试（Node + esbuild，无需浏览器）：

```bash
cd frontend
npm run test:supply      # 统一阈值、事务、幂等、盘点导入导出
npm run test:migration   # 旧版脏数据迁移与按类别补值
npm run test:bugs        # 三个线上问题的回归场景
```
