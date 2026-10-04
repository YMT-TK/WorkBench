# WorkBench · 插件化桌面工作台

一个基于 **Tauri 2** 的本地优先（local-first）单机桌面工作台。核心是一套**两层插件模型**：
轻量的 Widget 卡片插件负责「信息聚合」，重量的功能模块负责「业务能力」，
平台只管外壳、数据与约定，具体功能全部以插件/模块的形式挂载进来。

> 本仓库是**程序平台仓库**（平台底座 + 外壳 + 插件模型 + 开发规约）。
> 具体的完整功能项目请另建分支开发，不要把业务代码堆在主线。

---

## 技术栈

| 层 | 选型 |
|---|---|
| 应用框架 | Tauri 2（Rust 内核 + WebView2 前端） |
| 前端 | React 18 + TypeScript 5 + Vite 5 |
| 样式 | Tailwind CSS 3（设计令牌，hex + `-rgb` 双写以支持透明度） |
| 图标 | lucide-react |
| 路由 | react-router-dom（HashRouter） |
| 数据库 | SQLite（`rusqlite`，WAL + 单写者 + 版本化 migration） |
| 加密 | AES-256-GCM，密钥托管在操作系统 keyring |

---

## 核心架构：两层插件模型

```
                 ┌─────────────────────────────────────────┐
                 │            WorkBench 平台               │
                 │  外壳 / 注册表 / 事件总线 / 数据 / 主题   │
                 └───────────────┬─────────────────────────┘
                                 │
        ┌────────────────────────┴────────────────────────┐
        │                                                 │
   Widget 插件（轻）                                功能模块（重）
   数据中心里的卡片                                  侧边栏的一级入口
   manifest.ts 声明式注册                           独立路由 + 独立页面
   开关 / 排序 / 参数可配                           独占数据表与领域逻辑
```

**两条铁律：**

1. **数据中心不 import 任何具体插件**——它只读插件注册表，遍历渲染。新增卡片不需要动数据中心的代码。
2. **模块之间禁止直接 import**——跨模块通信只走 `core/event-bus.ts` 的 `emit` / `on`。

**注册表 = 自动发现。** 侧边栏菜单、路由表、命令面板、数据中心卡片列表**全部**由两张注册表驱动，
没有任何硬编码的模块名或插件名。装载点用 Vite 的 `import.meta.glob` 自动发现，
新增模块/插件只需「建目录 + 在自己的文件里调 `registerModule` / `registerWidget`」，**不需要改任何清单文件**。

- 模块注册表：`src/app/registry.ts`
- 插件注册表：`src/core/plugin-host/registry.ts`
- 约定：**目录名 = 注册 id**

---

## 目录结构

```
src/                          # 前端
├─ app/                       # 应用外壳
│  ├─ registry.ts             #   模块注册表 + 默认落点 getHomeModuleId()
│  ├─ router.tsx              #   路由表（由注册表生成）
│  ├─ layout/                 #   Sidebar / TopBar / AppLayout / HeaderActions
│  └─ theme/                  #   主题 Provider（浅 / 深 / 跟随系统）
├─ core/                      # 平台能力（与具体业务无关）
│  ├─ event-bus.ts            #   跨模块通信唯一通道
│  ├─ layout-engine/          #   拖拽网格布局（列数随容器宽度重算）
│  ├─ plugin-host/            #   Widget 插件模型（registry / types）
│  └─ shared/                 #   api / components / hooks / utils 公共库
├─ modules/                   # 功能模块（重插件，一级入口）
│  ├─ index.ts                #   自动装载（import.meta.glob）
│  ├─ data-center/            #   数据中心（系统级，插件卡片区 + 配置面板）
│  ├─ settings/               #   设置（外观 / 通用 / 数据 / 模块 / 关于）
│  ├─ project-manager/        #   项目管理（阶段二）
│  └─ audio-manager/          #   音频管理（阶段二）
├─ widgets/                   # Widget 卡片插件（轻插件）
│  ├─ index.ts                #   自动装载（import.meta.glob）
│  └─ weather/                #   天气卡片（插件模型验证样板）
└─ styles/                    # 设计令牌（tokens.css / global.css）

src-tauri/src/                # Rust 后端
├─ lib.rs                     #   应用入口：插件注册、setup、命令注册
├─ commands/                  #   前端唯一可调用的命令层（settings / storage …）
├─ db/                        #   SQLite 连接 + migration 执行器 + migrations/
├─ crypto/                    #   AES-256-GCM + OS keyring
├─ tray.rs                    #   系统托盘 +「关闭到托盘」
├─ storage.rs                 #   数据目录解析与迁移
└─ window_state.rs            #   窗口尺寸/位置持久化

scripts/
├─ dev-app.mjs                # 真机一键启动器（绕开 tauri dev 的管道问题）
├─ e2e-probe.js               # dev 期端到端探针（真 WebView 内自动点击验证）
└─ gen-icons.py               # 纯 Python 生成 PNG/ICO 图标，无第三方依赖
```

---

## 已实现的平台能力

**系统级底座**

- 单实例保护：再次启动只会唤出已有窗口，不会开第二个进程
- 窗口尺寸 / 位置持久化，含「最小化哨兵坐标」与「屏幕外坐标」防护
- 应用日志：`tauri-plugin-log` 落盘 + 轮转
- SQLite 单写者（`Mutex<Connection>`）+ WAL + `busy_timeout`，结构变更只追加 migration

**桌面行为**

- **系统托盘**：右键菜单（显示 / 隐藏 / 退出），左键单击直接唤回窗口
- **关闭到托盘**：点右上角 ✕ 默认只把窗口收进托盘，避免误点丢失工作现场（可在设置中关闭）
- 数据目录可配置：默认 `app_data_dir/WorkBench`，可改为任意绝对路径，搬迁只复制不删除

**界面与交互**

- 主题：浅色 / 深色 / 跟随系统，令牌驱动
- 命令面板：`Ctrl+K` 快速跳转任意模块
- 侧边栏：按「主界面 / 工作模块 / 系统」分组，可收起，隐藏模块时内容区自动跳安全落点
- 统一外层 header：面包屑呈现「模块名（加粗）+ 功能描述」，模块专属操作注册到顶栏动作槽
- 数据中心：插件卡片支持拖拽排序、显示开关、参数配置，全部落库
- 通知系统：分级 toast（info / success / warn / error）

---

## 开发

### 环境要求

- Node.js 20+
- Rust 工具链（stable）
- Windows 需要 WebView2 运行时（Win11 自带）

### 安装与运行

```bash
npm install          # 安装前端依赖

npm run dev:app      # 真机运行（推荐；一键启动 Vite + Tauri 窗口）
```

其他脚本：

```bash
npm run dev          # 只起 Vite 前端（浏览器调试，无桌面能力）
npm run typecheck    # TypeScript 类型检查
npm run build        # 类型检查 + 前端产物构建
npm run tauri build  # 打包发布版
```

> ⚠️ 本机实测 `npm run tauri dev` 会因 `beforeDevCommand` 经 cmd 派生而稳定报 `os error 231`，
> 因此统一用 `npm run dev:app`（见 `scripts/dev-app.mjs`）。
> 另外 WebView2 在本环境必须带 `--no-sandbox`（已写入 `tauri.conf.json`）。

### 真机端到端探针

```bash
WB_E2E=1 npm run dev:app
```

启动后探针会在真实 WebView 中自动点击走一遍关键路径（面包屑、侧边栏联动、命令面板、
插件配置开关、数据页读出真实库路径等），并把断言报告打到控制台。
**编译期与前端构建发现不了的问题，只有真机运行才会暴露**——交互改动请务必跑一遍。

---

## 开发路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| 阶段一 · 系统级 | 外壳、注册表、数据库、主题、通知、日志、窗体适配、托盘、数据目录 | ✅ 完成 |
| 阶段二 · 功能级 | 项目管理、音频管理等业务模块 | 🚧 进行中 |

---

## 开发规约

本仓库的开发约定集中在 **[`AGENTS.md`](./AGENTS.md)**，是所有 AI 协作与本仓库贡献者的**唯一规则源头**，包含：

- 技术栈红线与两层插件模型的六条铁律
- 目录结构与命名一致性
- 数据存储、主题令牌、安全加密的具体约定
- 通知等级、错误日志、窗体适配、侧边栏联动
- 真机运行与排障手册（含本机踩过的坑）
- UI 平台层约定、系统托盘、数据目录

**动手改代码前请先读它。** 违反铁律的改动一律返工。

---

## 分支约定

- `main`：**平台主线**，只放平台底座、外壳、插件模型与规约
- 功能分支：具体的完整功能项目另建分支开发，例如 `feat/project-manager`、`feat/audio-manager`

---

## 许可

本项目采用 [Apache License 2.0](./LICENSE) 授权，完整条款见仓库根目录的 `LICENSE` 文件。
