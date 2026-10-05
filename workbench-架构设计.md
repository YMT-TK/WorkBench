# WorkBench 架构设计

> **状态**：v1.4 · 2026-10-05（平台能力 crate 化：根 workspace + `crates/wb-db` / `crates/wb-runtime`，应用壳只做编排）
> **地位**：本文件是 WorkBench 的**架构权威出处**——架构图、表结构、设计令牌表、签名/分发细节以本文为准。
> **与 AGENTS.md 的关系**：`AGENTS.md` 是**开发规约**（怎么做事）；本文是**架构设计**（做成什么样）。
> 两者冲突时以本文为准，并回头修订 `AGENTS.md`。
>
> **维护约定**：本文是**活文档**。每次架构级改动都在文末「附录 C · 修订记录」追加一行，
> ⛔ 不要静默改历史结论——推翻旧决策要走 §12 的 ADR 流程（新增一条 ADR 说明取代关系）。

---

## 1. 项目定位

一个**插件化单机桌面应用**：模块间低耦合、公共能力下沉、可持续扩展。

- **形态**：单机桌面工具（Tauri 2 外壳 + 本机 SQLite），不依赖常驻服务端。
- **两条业务主线**（远景）：
  1. **ELN 信息统计**——把散落的实验记录聚合成可看的卡片/统计；
  2. **实验规划辅助**——AI 助手参与实验排程与方案生成。
- **当下阶段**：先把「平台底座」做扎实（阶段一已完成），再逐个挂载工作模块（阶段二进行中）。

> 设计取向：**宁可平台层薄而稳，也不要业务模块各自为政**。所有模块共享同一套外壳、数据、日志、通知、加密与存储模型。

---

## 2. 设计原则

| # | 原则 | 含义 | 反面（禁止） |
|---|---|---|---|
| P1 | **前端不碰系统层** | 一切文件/库/原生操作经 `core/shared/api` → Rust commands | 前端直接 `fs`、直连 SQLite、拼绝对路径 |
| P2 | **插件互不可见** | Widget 之间 / 模块之间不 import | 跨模块 import 组件或 store |
| P3 | **入口来自清单** | 侧边栏与路由由注册表推导，自动发现 | 硬编码菜单项或路由条目 |
| P4 | **公共能力下沉** | 通用件放 `core/shared`，先查再写 | 把通用弹窗写进某个业务模块 |
| P5 | **变更即落库** | 无「保存」按钮；debounce 300ms 写库 | 攒在内存里等用户点保存 |
| P6 | **只增不改** | 表结构只追加 migration；迁移只复制不删除 | 手写 DROP / ALTER 覆盖历史 |
| P7 | **失败必须留痕** | 可降级，但不得无声失败 | `.catch(() => {})` 静默吞掉 |
| P8 | **安全默认** | 读不到配置时按「最保守」取值 | 读不到 `close_to_tray` 就当 `false` |

---

## 3. 总体架构

### 3.1 进程视图

```
┌──────────────────────────────────────────────────────────────┐
│ workbench.exe（单进程 · 单实例保护）                          │
│                                                              │
│  ┌────────────────────────┐      ┌────────────────────────┐  │
│  │ WebView2（前端）        │      │ Rust 侧（后端）         │  │
│  │  React 18 + TS          │ IPC  │  Tauri commands         │  │
│  │  Tailwind + CSS 令牌    │◄────►│  db / storage / crypto  │  │
│  │  插件宿主 / 布局引擎     │      │  tray / window_state    │  │
│  └────────────────────────┘      └───────────┬────────────┘  │
│                                               │              │
└───────────────────────────────────────────────┼──────────────┘
                                                │
        ┌───────────────────────────────────────┼────────────────────┐
        │                                       ▼                    │
        │  ┌──────────────────────┐   ┌──────────────────────┐       │
        │  │ <数据根目录>/         │   │ OS 凭据库             │       │
        │  │  workbench.db        │   │ (Windows Credential   │       │
        │  │  media/ backup/      │   │  Manager)             │       │
        │  │  keys/ logs/         │   │  主密钥 K              │       │
        │  └──────────────────────┘   └──────────────────────┘       │
        │        本机文件系统             操作系统级                   │
        └────────────────────────────────────────────────────────────┘
```

**唯一的跨层通道**：前端 ↔ Rust 的 `invoke`（经 `core/shared/api` 封装）。⛔ 前端没有任何绕过路径。

### 3.2 前端分层

```
src/
├─ app/                 应用壳（稳定）
│  ├─ registry.ts       模块注册表 + getHomeModuleId（默认落点唯一来源）
│  ├─ router.tsx        路由表（读 listModules）
│  ├─ layout/           AppLayout / Sidebar / TopBar / HeaderActions
│  ├─ theme/            ThemeProvider（切 data-theme）
│  └─ ErrorBoundary.tsx
├─ core/                核心框架（稳定，不随业务膨胀）
│  ├─ plugin-host/      注册表、生命周期、加载器
│  ├─ layout-engine/    网格拖拽排序 + 位置持久化
│  ├─ event-bus/        唯一跨模块通道
│  └─ shared/           api / components / hooks / utils
├─ modules/             一级功能模块（重）
│  ├─ data-center/      数据中心（pinned，默认落地页）
│  ├─ project-manager/  [阶段二]
│  ├─ audio-manager/    [阶段二]
│  └─ settings/         设置（system）
└─ widgets/             数据中心插件（轻）：weather / account / loan-reminder / todo
```

**依赖方向**：`app → modules → core/shared → core/*`。反向依赖一律禁止。

### 3.3 一次典型调用链

```
用户点「应用数据目录」
  → Settings.tsx DataLocationPanel
  → api.storageSetDir(dir, migrate)          [core/shared/api]
  → invoke("storage_set_dir", {...})         [IPC]
  → wb_runtime::storage_set_dir              [应用壳挂载的命令，实现在 wb-runtime]
  → wb_db::storage::set_override（写 storage.json）
  → 返回 Ok / Err(String)
  → notify("success" | "error") + 写日志      [前端统一收口]
```

### 3.4 仓库结构：平台能力（`crates/`）与应用壳（`src-tauri/`）

本仓库是**平台 / 框架**：后续项目在它之上开工，只换一份应用壳（开工工序见 `AGENTS.md` §21）。

```
<仓库根>/Cargo.toml          # [workspace] members = crates/wb-db, crates/wb-runtime, src-tauri
├─ crates/                   # 🔴 平台能力：与业务无关，可被新项目直接复用
│  ├─ wb-db/                 #   数据「在哪 / 怎么存」：目录布局 + 连接 + 迁移执行器
│  └─ wb-runtime/            #   平台「能做什么」：密钥 / 备份 / 迁移 / 跨机导入 / 托盘 / 窗口
└─ src-tauri/                # 应用壳：每个项目一份
                             #   （identifier / 图标 / capabilities / EULA / invoke_handler 清单）
```

**依赖方向只允许单向**：`src-tauri → wb-runtime → wb-db`。

🔴 **反向依赖不会报编译错误** —— 它只会在你想复用平台时才发现已经粘死。
自查判据一句话：**换个完全不相干的业务，这段代码还能原样用吗？** 不能 → 它属于 `src/modules/`，不属于 `crates/`。
（历史教训：`backup.rs` 曾调用命令层的 `get_setting_conn`，形成 `wb-runtime → 应用壳` 的反向依赖；
已把该原语下沉到 `wb-db::settings` 消除。）

⚠️ workspace 化带来三处**静默**陷阱，均已处理，改动时别踩回去（ADR-19）：

| 陷阱 | 症状 | 处置 |
|---|---|---|
| 构建产物位置 | 产物落到**仓库根** `target/`，未被忽略 → 近 GB 的未跟踪文件混进 `git status` | `.gitignore` 忽略 `/target`（旧 `src-tauri/target/` 保留兼容） |
| `[profile.release]` 位置 | 留在 `src-tauri/Cargo.toml` 里，cargo 只打一行 warning 然后**忽略**它 —— `opt-level="z"`/`lto`/`strip` 全失效 | 移到**根** `Cargo.toml` |
| `indexmap` 特征 | `schemars 0.8.22` 报「struct takes 3 generic arguments but 2 were supplied」 | 钉在 `wb-db` 的 **`[build-dependencies]`**（host 图；见 AGENTS §21.5 / ADR-19） |

---

## 4. 两层插件模型

| 层级 | 是什么 | 注册方式 | 数据 |
|---|---|---|---|
| **Widget 插件（轻）** | 数据中心里的卡片，**无路由** | `widgets/<id>/manifest.ts` 末尾 `registerWidget` | `plugins.enabled/sort/config` |
| **功能模块（重）** | 侧边栏一级导航页，**独立路由 + 独立表** | `modules/<id>/`，文件末尾 `registerModule` | 自建 `xxx_` 前缀表 |

**铁律**：数据中心（模块壳）**绝不 import 任何具体 Widget**，只读注册表渲染。加 Widget 不动数据中心代码。

### 4.1 自动发现（关键机制）

两处装载点用 Vite 的 `import.meta.glob`，**新增模块/插件不需要改任何清单文件**：

```ts
// src/modules/index.ts
import.meta.glob("./*/*.tsx", { eager: true });
// src/widgets/index.ts
import.meta.glob("./*/manifest.ts", { eager: true });
```

- **约定：目录名 = 注册 id**（如 `modules/audio-manager/` → id `audio-manager`）。
- dev 期注册表**自动审计**：目录下没有调用 `registerModule` 的，控制台打 `[registry] …` 警告，防止静默遗漏。
- `import.meta.glob` 的类型来自 `src/vite-env.d.ts` 的 `/// <reference types="vite/client" />`，⛔ 不可删。

### 4.2 默认落点唯一来源

```ts
getHomeModuleId()  // app/registry.ts：pinned → 第一个 system → 第一个
```

路由 index / 404、隐藏模块的安全落点、面包屑兜底**都读它**。
⛔ 别处不得写死 `"/data-center"`；换主界面只改该模块的 `pinned`。

---

## 5. 核心框架

| 组件 | 位置 | 职责 | 关键约束 |
|---|---|---|---|
| **event-bus** | `core/event-bus/` | 跨模块唯一的通信通道（`emit/on`） | ⛔ 禁止模块间直接 import |
| **layout-engine** | `core/layout-engine/` | 网格排布 + `ResizeObserver` 容器宽度重算 + 持久化 | 展示顺序唯一来源 = `app_settings: layout:<scope>`（含隐藏项，重开可回原位） |
| **shared/api** | `core/shared/api/` | `invoke` 封装 + `isTauri()` | 前端唯一碰后端入口 |
| **shared/components** | `core/shared/components/` | `Card` / `Switch` / `Toast` / `EmptyState` / `LoadingState` / `ErrorState` / `CommandPalette` / `WidgetCard` | 新页面**一律复用**，禁止再写一套 |
| **shared/hooks** | `core/shared/hooks/` | `useAppSetting`（内置跨实例同步）/ `useHeaderActions` / `useGridLayout` / `useEvent` | 设置读写**必须**走 `useAppSetting` |
| **shared/utils** | `core/shared/utils/` | `reportError` / `safeLog` / `errorDetail` / 格式化 | 失败必须留痕（P7） |

---

## 6. 数据层

### 6.1 引擎与并发（单边锁）

- **引擎**：SQLite + `rusqlite`（Rust 同步 API），单文件 `workbench.db`。
- **连接模型**：`Mutex<Connection>` **单写者**——所有命令经 `State<DbState>` 取连接，写操作天然互斥。
- **PRAGMA**：`journal_mode=WAL`（一写多读并发）、`busy_timeout=5000`（外部占用时不无限重试）、`foreign_keys=ON`。
- **进程层保障**：Tauri `single-instance`——第二个实例转发参数给已运行实例后退出，确保同一 `workbench.db` **只有一个进程持有写**。
- ⛔ 禁止多线程各开连接乱写；⛔ 禁止为单机工具引入 MySQL / Postgres / 常驻服务（若未来接既有 ELN 的 MySQL，只新增「同步到服务端」命令，本地库仍是 SQLite）。

### 6.2 迁移（migration）

- 版本号存 `PRAGMA user_version`；脚本表在 `crates/wb-db/src/db/mod.rs` 的 `MIGRATIONS` 常量里追加。
- 文件命名 `NNNN_name.sql`，**追加式**：新迁移永远加在末尾，⛔ 绝不修改已发布脚本。
- 每个迁移在**事务内原子提交**，失败即回滚，`user_version` 不前进。
- **升级不清数据**：只增量建表/加列，不 DROP 他人表；新模块只加自己前缀的表。

### 6.3 表结构

**已落地（`0001_init.sql`）**

```sql
-- 应用级 KV 设置（主题、侧边栏收起、隐藏模块、日志级别…）
CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,          -- 统一存 TEXT，复杂值自行 JSON 序列化
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 插件注册表：widget 与 module 统一登记
CREATE TABLE plugins (
    id         TEXT PRIMARY KEY,       -- 如 "weather" / "audio-manager"
    kind       TEXT NOT NULL DEFAULT 'widget',   -- 'widget' | 'module'
    enabled    INTEGER NOT NULL DEFAULT 1,       -- 0=隐藏 1=显示
    sort       INTEGER NOT NULL DEFAULT 0,       -- 排序权重，越大越靠前
    config     TEXT NOT NULL DEFAULT '{}',       -- 插件私有配置（JSON）
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- 布局快照
CREATE TABLE layouts (
    id         TEXT PRIMARY KEY,       -- 布局实例标识
    scope      TEXT NOT NULL DEFAULT 'data-center',
    snapshot   TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
```

**规划中（`0002_op_log.sql`）**——按 AGENTS §9-7 / §11「用户可见操作日志」，与调试日志**分离存储**：

```sql
CREATE TABLE op_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,          -- unix 秒
    level   TEXT NOT NULL,             -- 'info' | 'warning' | 'error'
    module  TEXT NOT NULL,             -- 模块 id / 'core'
    action  TEXT NOT NULL,             -- 动作标识，如 'storage.migrate'
    message TEXT NOT NULL,             -- 面向用户的文案
    detail  TEXT                       -- 可选 JSON（技术细节；⛔ 禁放敏感信息）
);
CREATE INDEX idx_op_log_ts ON op_log(ts DESC);
```

**未来模块表（前缀物理隔离，随模块落地细化）**

| 前缀 | 归属 | 草案 |
|---|---|---|
| `proj_` | 项目管理 | `proj_projects(id, name, path UNIQUE, …)` —— 路径字段设 `UNIQUE` 防重复入库 |
| `audio_` | 音频管理 | `audio_items(id, path UNIQUE, mode 'reference'\|'import', …)` |

> **命名一致性**：目录名 = 注册 id = 表前缀，三者对齐。

### 6.4 持久化原则

- 写操作经 Rust DAO **立刻落库**，返回成功才算成功；**无「保存」按钮**。
- 改 tag / 备注 / 设置项 → `debounce 300ms` 写库。
- 拖拽排序 / 显隐切换 → 即时写 `plugins.sort / enabled`。
- ⚠️ `app_settings` 里的 `db_path` 是历史写法，**已废弃**；数据目录的唯一来源是 `storage.json`（§7.2），避免两处配置打架。

---

## 7. 存储与目录模型 ★

> **目标**：用户**只需要改一个「数据根目录」**，其下所有内容按固定相对路径自动跟随。
> 实现：`crates/wb-db/src/storage.rs`（解析）+ `crates/wb-runtime/src/commands/storage.rs`（命令层）。

### 7.1 根目录与相对布局

```
<数据根目录>/
├─ workbench.db              # 主库（WAL 模式另生成 -wal / -shm）
├─ media/                    # 媒体文件（导入式；引用式只存外部路径）
│   └─ audio/                #   音频模块
├─ backup/                   # 备份产物（自动 + 手动）
│   └─ backup_20261004_230000.db
├─ keys/                     # 密钥相关的**用户侧文件**
│   ├─ master-key.wbkey      #   口令加密的可移植密钥（§8.4）
│   └─ master-key-backup-*.txt
└─ logs/                     # 运行日志（本应用目录；见 §7.5）
```

**两个「不跟随根目录」的例外**（有意为之，不是遗漏）

| 文件 | 实际位置 | 为什么不动 |
|---|---|---|
| `storage.json` | **默认目录**（`app_data_dir/WorkBench`） | 它是「根目录指向哪」的**引导配置**；跟着根目录走就会「配置指向自己」，一改路径即永久失联（§7.2） |
| `window.json` | 同上（`app_data_dir/WorkBench`） | 窗口几何描述的是**这台机器 + 这块屏**，不是这份数据；换盘搬迁不该把窗口尺寸一起搬走 |

> 其余内容（db / media / backup / keys / logs）一律跟随根目录 —— 这才是「只改一个地方」的实际含义。

**约定**

- 相对路径一律由 `storage::data_root(app)` 派生，⛔ `media/` `backup/` `keys/` `logs/` 的拼接只允许出现在 `storage.rs`。
- 子目录**按需惰性创建**（第一次用到才 `create_dir_all`），不在启动时无脑铺一堆空目录。
- 用户可自定义根目录；**子目录结构不可自定义**——这正是「只改一个地方」的代价与收益。

### 7.2 引导配置 `storage.json`

```json
{ "dataDir": "D:\\WorkBenchData" }   // 缺省 / 空串 = 用默认目录
```

- **默认根目录**：`app_data_dir()/WorkBench`（Windows 即 `%APPDATA%/com.workbench.app/WorkBench`）。
- 🔴 **引导文件必须留在默认目录**，不能跟着自定义目录走：否则用户一改路径，下次启动就找不到这份配置，等于失去回退能力（「配置指向自己」的经典死锁）。
- 空串 / 缺省 / 文件损坏 → **回落默认目录**（安全默认，P8）。

### 7.3 生效时机与迁移向导

- **改目录重启后生效**：数据库连接在 `setup` 阶段就打开了，无法热切换。命令返回后设置页用 `pendingDir != runningDir` 判定并提示「需重启」。
- **迁移向导**（`storage_set_dir(dir, migrate)`）分三步，任一失败回滚：
  1. **预检**：目标为绝对路径 + `create_dir_all` + 写探针文件验证可写性——宁可现在报错，也别等重启后才发现写不进去；
  2. **复制 + 校验**：先 `PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 归并进主库，再复制 `.db` / `-wal` / `-shm` 三件套，**以及 `media/` 与 `keys/`**，逐文件回读比对 SHA-256（共用 `fsutil::copy_*_verified`）；
  3. **重指向**：写 `storage.json`。
- 🔴 **校验失败 = 整体回滚**：删掉本次新建的文件（凭 `CopyOutcome.created` 清单，目标目录里原有文件一个不碰），并且**不写 `storage.json`**——即不重指向。半份数据比不搬家更糟。
- ⛔ **为什么必须带上 `media/` 与 `keys/`**：只搬主库的话媒体文件会静默丢失，换机后只剩一堆「文件已移动」的灰条目；
  `keys/` 里的 `.wbkey` 是用户资产，同样属于这份数据。
- ⛔ **只复制不删除**，旧目录原样保留，用户可自行清理或回退（与项目「保守迁移」偏好一致）。
- 🔴 **目标目录里已有 `workbench.db` → 直接拒绝**（ADR-18）：不搬文件、不建目录、**不写 `storage.json`**。
  这时「该以哪一份为准」没有安全答案 —— 静默跳过会骗人（提示「已复制并通过校验」，重启后打开的
  却是目标目录里的旧库），覆盖可能毁掉目标那份。拒绝是唯一不会造成损失的选择。
  ▸ 判定用「有没有 `workbench.db`」而非「目录是否非空」：目录里只有 `media/` / `keys/` 时没有歧义，照常可以搬。
- ⚪ **不做「在新目录重新初始化一份空库」**：用户点「迁移」的语义是**搬数据**，悄悄初始化一份空库
  会让人以为数据丢了。真要重新开始，那是「重置数据」，应是另一个入口 + 二次确认。

### 7.4 备份与恢复 ★

**快照结构**——一个**目录**（不是压缩包，避免额外依赖，也方便用户直接打开看、手工拷）：

```
<根目录>/backup/backup_<YYYYMMDD_HHMMSS>/   # UTC，与日志滚动命名同一套时间口径
├─ workbench.db          # 已 wal_checkpoint(TRUNCATE) 归并 WAL 的完整库
├─ workbench.db-wal      # 归并后通常为空，流程上仍带上
├─ media/                # 递归复制
└─ manifest.json         # WBBACKUP/1：时间、源目录、db 大小与哈希、media 文件数、**密钥指纹**
```

- **一键备份** `backup_create()`：checkpoint → 复制（逐文件回读校验 SHA-256，共用 `fsutil`）→ 写 manifest。
  先在 `.staging-*` 临时目录里建好再「转正」，中途失败不留半个快照。秒级时间戳撞车就加序号，**绝不覆盖已有快照**。
- **自动备份** `app_settings: backup.auto = off | on_start` + `backup.keep`（默认 5）：
  启动时在后台线程执行并清理最老的（⛔ 不持有数据库连接，§5.x）。`prerestore_` 快照不参与自动清理。
- 🔴 **恢复** `backup_restore(id)` 三步，**顺序不可换**：
  1. **校验密钥指纹**：manifest 里的 `key_fingerprint` 与本机会话密钥指纹比对，不匹配**直接拒绝**并提示导入对应 `.wbkey`；
  2. **先留退路**：自动创建一个 `prerestore_<时间戳>` 快照（保住「恢复前」的状态）；
  3. **就位**：主库写入 `workbench.db.restore-pending`（**不直接覆盖运行中的库**，理由见 ADR-15），`media/` 可立即覆盖。
  返回 `needRestart = true`，前端提示重启。
- 🔴 **备份包同时是跨机迁移载体**（ADR-14）：公司电脑 → 家里笔记本用的就是这份快照，不另造「导出包」。
- 🔴 **备份包不含密钥**（`workbench.db` 里也没有）：密钥在 OS 凭据库。所以换机必须**备份包 + `.wbkey` 两样一起带走**，
  到新机器后顺序固定：**先导入密钥 → 再恢复数据 → 重启**。顺序反了也不会毁数据——指纹不匹配时恢复会被拒绝并说明要哪把钥匙。
- ⚠️ **备份与数据同一块盘**（都在根目录下）：盘损坏 / 目录误删会一起没。设置页明确提示用户把快照复制到 U 盘或网盘。
- **JSON 导出**：核心表导出 JSON，便于跨机 / 跨大版本迁移。

### 7.5 日志目录

| | 位置 | 说明 |
|---|---|---|
| **旧** | `%APPDATA%\com.workbench.app\WorkBench\logs\`（应用） + `%LOCALAPPDATA%\com.workbench.app\logs\`（插件默认） | **不跟随根目录**——`tauri-plugin-log` 在启动时按 `app_data_dir` 算死了路径 |
| **现** | `<根目录>/logs/`（`storage::logs_dir`） | 已改为 `TargetKind::Folder` 指向根目录下 `logs/`，与其余内容一致 |

> 已于 v1.1 修复（`lib.rs::log_dir` → `storage::logs_dir`）。注意：根目录一旦改动，**日志也要重启后才跟着走**
> —— 与数据库同样的「重启生效」语义。前端日志（webview 侧）经插件落到同一目录，可凭 `[webview::…]` 前缀区分来源。
> ⚠️ 默认根目录下路径与旧写法完全相同，因此默认情况下无感知变化。

**用户可见形态**：设置 → 存储 →「运行日志」给出 `<根目录>/logs` 的绝对路径、已有文件列表与「打开目录」按钮。
🔴 **不做日志浏览页面**（ADR-16）：日志本身就是给人排查的文件，把地址给出来即可。
命名：当前文件 `workbench.log`，超过 5MB 滚动为 `workbench_<YYYY-MM-DD_HH-MM-SS>.log`，保留最近 10 份。


### 7.6 跨机导入向导 ★

**场景**：公司电脑 → 家里笔记本。用户手上是**两样**东西 —— 备份包目录（§7.4 的产物）+ `.wbkey`（§8.4）。
备份包里**不含密钥**，所以这两样缺一不可。

**固定顺序（由程序强制，不靠用户记）**：

| # | 动作 | 命令 | 副作用 |
|---|---|---|---|
| 1 | 读外部备份包：它要求哪把钥匙、装了些什么 | `import_inspect` | ✅ 只读 |
| 2 | 只读 `.wbkey` 的**明文头**（`fp` / `created`）→ 判断「文件选对没有」 | `wbkey_inspect` | ✅ 只读，**不需要口令** |
| 3 | 完整预检：解密钥 + 比对指纹 + 给判定 | `import_precheck` | ✅ 只读 |
| 4 | 装密钥（与库中指纹冲突时需显式确认） | `key_import_wbkey(path, pass, replace)` | 写凭据库 |
| 5 | 校验复制备份包进 `<根目录>/backup/<id>` 并登记 | `import_adopt` | 写 `backup/` |
| 6 | 恢复数据（留 `prerestore_` 快照 + 写待替换文件） | `backup_restore` | 写待替换文件 |

- 🔴 **先只读预检、再动手**（ADR-17）：若先登记再发现钥匙不对，用户磁盘上会多出一份**永远解不开**的
  备份包，还得自己去删。只读预检把「失败」的代价压到零。
- 🔴 **第 2 步不需要口令**：`fp` / `created` 在 `.wbkey` 里本来就是明文，所以「选错文件」这件事
  不用先输一遍口令才知道。
- **判定四态**（`ImportVerdict`）：

  | 判定 | 含义 | 界面行为 |
  |---|---|---|
  | `no_key_needed` | 备份包没有声明加密字段 | 直接放行，跳过密钥步 |
  | `ready` | 指纹匹配、本机无冲突密钥 | 放行 |
  | `replaces_local_key` | 匹配，但本机**库中指纹**是另一把 | **必须勾选确认**才能继续 |
  | `mismatch` | 这个密钥不是这份数据用的 | **拦住**，只允许回上一步换文件 |

- 🔴 **硬冲突的判据是「库中指纹」而非凭据库里那把钥匙**：有指纹 = 本机已有数据锁在旧密钥下，
  替换就是把它们作废。**没有**指纹时（凭据库里躺着一把孤儿密钥）只给软提醒、不阻断 ——
  没有密文依赖它。
- 🔴 **`replace` 默认 false**：普通「导入密钥」入口永远传 false，因此**永远不会静默顶掉一把在用的钥匙**；
  只有本向导在用户勾选确认后才传 true。
- ⛔ **不做「就地恢复、不登记」**：源可能是 U 盘，拔了就没了。复制进 `backup/` 之后它才是一份本机资产，
  也才会出现在备份列表里、被保留策略管到。
- 选文件走系统对话框（`tauri-plugin-dialog`，capability `dialog:default`）：从 U 盘 / 下载目录里挑东西时，
  手输完整路径是最容易出错的一环。
- **界面直接列出「换机要带走的两个位置」**（备份包目录 + `<keys>/master-key.wbkey` 的绝对路径），
  都从 `storage_info` 的固定布局推出来。用户的心智模型是「点备份 → 程序告诉我存哪儿 → 拷走 → 到新机器点导入」，
  那就不能让他去 ①②③ 三段里各找一次路径。
- ⛔ **「立即备份」不顺手导出 `.wbkey`**：密钥在 OS 凭据库，导出必须由用户提供口令（§8.4）。
  若备份按钮自动带出一份密钥文件，等于把锁和日常快照塞进同一个抽屉，也会把「口令」这一环悄悄跳过。
  两样东西**分开生成、一起带走**——界面的职责是把两个路径讲清楚，而不是替用户合二为一。
- **入口**：设置 → 存储 →「④ 跨机导入」。它和「② 密钥与安全」里的导入按钮是**两个入口一个内核**：
  后者恒不替换在用密钥，前者在用户确认后可以。

---

## 8. 安全与密钥模型 ★

### 8.1 威胁模型

**个人单机工具**。主要风险是「**设备丢失 / 文件被拷走后泄露**」，不是多用户并发。
因此设计取向是：**锁与钥匙分离**——数据可以被拷走，但没有钥匙就解不开。

### 8.2 加密方案（方案 A：字段级加密）

- **算法**：AES-256-GCM，**字段级**（不是整库加密）。
- **加密对象**：会员密码、Git Token、API Key 等敏感字段（经 `secure_set_setting` 写入的值）。
- **不加密**：音频等媒体文件（体积大、无密级），不进 SQLite。
- **密文格式**：`base64(nonce(12) ‖ ciphertext)`，可直接当文本字段存进 SQLite。
- **接口**：前端只能过 `secure_set_setting` / `secure_get_setting`；**明文与主密钥都不出 Rust 侧**。
- 可选升级：**SQLCipher 整库加密（方案 B）**——仅当要求「db 拷走也打不开」时启用。

### 8.3 主密钥的存放（首要位置）

- 主密钥 **K = 32 字节随机**，由 `Aes256Gcm::generate_key(OsRng)` 生成。
- **首要存 OS 凭据库**：Windows 凭据管理器，`service = "WorkBench"`，`account = "master-key"`。
- ⛔ 绝不明文入库、绝不写进明文配置文件。
- **凭据库的真实可靠性**（必须如实告知用户）：

  | 情况 | 后果 |
  |---|---|
  | 正常「修改 Windows 密码」 | ✅ 安全，DPAPI 会自动重新加密 |
  | 管理员**重置**密码（不知旧密码） | ❌ DPAPI 主密钥失效 → 凭据解不开 |
  | 重装系统 / 换机 / 用户配置文件损坏或被重建 | ❌ 凭据不在新环境里 |
  | 用户在「凭据管理器」里手动删除 | ❌ 秒删，无回收站 |
  | 清理 / 优化 / 安全软件「清理凭据」 | ❌ 静默消失 |

  → 结论：**凭据库不是保险箱**，只是「比明文文件安全」的托管处。**必须配冗余副本**（§8.4）。

### 8.4 可移植密钥文件 `.wbkey`（冗余副本 · 跨机迁移载体）

> 这一个机制同时解决两个需求：**① 凭据库丢了能恢复；② 公司电脑 → 个人笔记本能继续用**。

**文件格式**（纯文本，便于人工辨认与邮件/U 盘传递）：

```
WBKEY/1
salt:    <base64 · 16 字节>
nonce:   <base64 · 12 字节>
mem:     65536            # Argon2id m(KiB)
time:    3                # Argon2id t
para:    1                # Argon2id p
data:    <base64 · AES-256-GCM 密文>
fp:      <hex · 8 字节，明文指纹，用于校验>
created: <unix 秒>
```

> ⚠️ **KDF 参数写进文件**而不是写死在校验端：日后提高 Argon2 强度不会让旧文件失效
> （导入时按文件里记的参数派生）。`fp` 打在最后，导入时会自校验，兼作「文件被改过」的兜底。

**派生与加密**

```
wrapping_key = Argon2id(passphrase, salt, m=64MiB, t=3, p=1) → 32 字节
data         = AES-256-GCM(wrapping_key, nonce, K)
fp           = SHA256(K)[0..8]        # 明文存，泄不出 K
```

- **导出**：用户设口令 → 生成 `.wbkey`，默认落在 `<根目录>/keys/`。
- **导入**：选文件 + 输口令 → 解出 K → 写入本机凭据库 → 与库中指纹比对（§8.5）。
- **安全性**：文件被拷走，**没有口令依然解不开**；口令足够强时，其安全强度不低于凭据库。
  ⛔ 这与「明文密钥文件」有本质区别——**不要把 K 的明文写进数据目录**，那等于把锁和钥匙放同一个抽屉。

### 8.5 密钥指纹与「静默生成」防护 🔴

> **事故场景（必须避免）**：笔记本上打开从公司电脑拷来的 `workbench.db`。
> 笔记本凭据库里**没有** K → 程序若在此时静默 `get_or_create_key()` → **生成一把全新密钥 K′**
> → 公司电脑加过的所有密文 **全部解不开**，且新写入的用 K′，变成半新半旧的乱局。

**防护设计**

- `app_settings` 存 `crypto.key_fingerprint`（明文 hex = `SHA256(K)[0..8]`），首次生成密钥时写入（此时库中尚无密文）。
- `crypto` 模块**拆成两条路径**，不再有「看一眼就顺手创建」的接口：
  - `load_key() -> Result<Option<Key>>`：**只读**，不创建；
  - `create_and_store_key() -> Result<Key>`：**显式**创建并写凭据库 + 记指纹。
- 启动时（`db::init` 之后）解析三态：

  | 库中有指纹 | 凭据库有密钥 | 判定 | 行为 |
  |---|---|---|---|
  | ❌ | ❌ | **首次运行** | 正常；首次写入敏感字段时创建 K 并记指纹 |
  | ❌ | ✅ | 新库 + 旧密钥 | 采用已有 K，补记指纹 |
  | ✅ | ✅ 且指纹一致 | **正常** | 放行 |
  | ✅ | ✅ 但**指纹不一致** | ⚠️ 密钥不匹配 | **拒绝加密/解密**，提示「密钥与数据不匹配，请导入正确密钥」 |
  | ✅ | ❌ | ⚠️ **密钥缺失** | **拒绝生成新密钥**，提示「此数据来自另一台机器，请先导入密钥（.wbkey）」 |

- 前端「设置 → 存储 → 密钥与安全」据三态显示不同横幅，并给出「导入密钥」入口。

### 8.6 跨机迁移流程（公司电脑 → 个人笔记本）

> ⚠️ **本节描述的流程已由 §7.6「跨机导入向导」取代（ADR-17）**，保留仅为沿革说明。
> **实际操作请走：设置 → 存储 → ④ 跨机导入。** 使用备份包（§7.4）而不是手工拷 `workbench.db`。

**旧流程（已弃用）**

```
【公司电脑】
  1. 设置 → 存储 → 密钥与安全 → 导出密钥 → 设口令 → 得到 master-key.wbkey
  2. 拷贝两个东西到 U 盘 / 自己的网盘：
       · <根目录>/workbench.db   （连同 -wal / -shm）
       · <根目录>/keys/master-key.wbkey

【个人笔记本】
  3. 设置 → 存储 → 导入密钥 → 选 master-key.wbkey + 输口令  → 写入本机凭据库
  4. 用拷来的 workbench.db 覆盖本机库（或先改根目录指向它）
  5. 重启 → 指纹校验通过 → 敏感字段正常解密
```

**为什么要改成向导**：① 「先密钥、后数据」的顺序原来只写在页面说明里，靠用户自己记；
② 「手工覆盖 `workbench.db`」在应用运行时做是危险的（旧库的 `-wal`/`-shm` 会回放，见 ADR-15）；
③ 没有预检 —— 钥匙选错也要走完全程才发现。向导把这三件事都变成**程序强制**：
只读预检 → 装密钥 → 登记备份包 → 恢复（§7.6）。

> ⚠️ **仍然有效的纪律**：公司电脑上的程序**不要当作长期唯一副本** —— 设备被收走 / 重装 / 策略清理都会带走凭据库。
> 到新机器后按固定顺序走；即便顺序反了也不会毁数据（指纹不匹配时恢复会被拒绝，并说明要哪把钥匙）。

### 8.7 与日志的红线

⛔ **敏感字段（token / 密码 / 主密钥 / 口令）绝不写日志**——包括调试日志、操作日志、崩溃日志与错误提示的技术细节。

---

## 9. UI 平台层与设计令牌

### 9.1 外壳结构

```
AppLayout
├── Sidebar        模块清单驱动；三组固定顺序：主界面(pinned) → 工作模块 → 系统
│                  可收起（208 ↔ 56，**默认收起**，存 app_settings: sidebar_collapsed）
└── (TopBar + main)
    ├── TopBar     模块名（加粗）+ 功能描述（小一号）/ 模块动作槽 / 命令面板 / 主题快切
    └── main       overflow-auto，页面内容在此滚动
```

- 🔴 **页面不自带标题栏**：模块名与描述统一由 `TopBar` 呈现。面包屑**只保留「模块图标 + 模块名 + 描述」**，⛔ 不加产品名前缀。
- 模块专属操作按钮经 `useHeaderActions(node)` 注册到顶栏（node 必须 `useMemo` 稳定引用）。
- 顶栏用 `data-tauri-drag-region` 拖窗，**依赖 capability `core:window:allow-start-dragging`**。
- 被隐藏模块的当前页会被 `AppLayout` 重定向到安全落点（优先数据中心）并 `notify('info')`。

### 9.2 设计令牌表

`src/styles/tokens.css` 每个色令牌**双写**：`--x`（hex）+ `--x-rgb`（通道）。
⚠️ 只写 hex 会让 `bg-surface/60`、`ring-accent/30` 这类**透明度类静默失效**（哑类，不报错）。

| 令牌 | Light | Dark | 用途 |
|---|---|---|---|
| `bgApp` | `#fafcff` | `#0f1419` | 应用底色 |
| `bgSidebar` | `#f1f4f7` | `#161c24` | 侧边栏 / 次级块 |
| `surface` | `#ffffff` | `#1e2630` | 卡片面 |
| `textPrimary` | `#0a1317` | `#e6edf3` | 主文本 |
| `textSecondary` | `#1c1e21` | `#b0bac5` | 次文本 |
| `textMuted` | `#8595a4` | `#6b7886` | 弱化文本 / 提示 |
| `accent` | `#0064e0` | `#0064e0` | 主色 / 链接 / info 通知 |
| `border` | `#dee3ea` | `#2a323c` | 边框 / 分隔线 |
| `success` | `#31944c` | `#3fb45e` | 成功通知 |
| `warning` | `#f2a918` | `#f5b63c` | 警告通知 |
| `danger` | `#d93636` | `#ff6b6b` | 错误通知 |
| `--radius-card` | `16px` | `16px` | 卡片圆角 |

**阴影令牌**（明暗两套值，深色下更重）：`--shadow-card` / `--shadow-card-hover` / `--shadow-float`，
Tailwind 映射为 `shadow-card / shadow-card-hover / shadow-float`。⛔ 组件里不要写死 `shadow-2xl` 或 rgba。

### 9.3 通知等级

| 等级 | 令牌 | 典型场景 | 自动消失 |
|---|---|---|---|
| `success` | `success` | 保存成功 / 导入完成 / 备份完成 | 3s |
| `info` | `accent` | 普通提示 / 信息变更 | 3s |
| `warning` | `warning` | 文件失效 / 需确认的风险操作 | 5s |
| `error` | `danger` | 命令失败 / 写库失败 | 不自动消失 |

---

## 10. 打包 / 签名 / 分发 / 更新

### 10.1 安装包（NSIS）

- **命令**：`CARGO_INCREMENTAL=0 npx tauri build`（先停 `dev:app`，避免抢 CPU）。
- **产物**：`target/release/bundle/nsis/WorkBench_0.1.1_x64-setup.exe`（lzma，约 1.8 MB）；
  exe 本体 `target/release/workbench.exe` 约 4.2 MB。
  ⚠️ workspace 化后两者都在**仓库根** `target/` 下（原为 `src-tauri/target/`，见 §3.4 / ADR-19）。
- **`bundle.targets` 收敛为 `["nsis"]`**：MSI(WiX) 界面几乎无法定制，要出 MSI 时单独跑 `--bundles msi`。
- **定制项**（`tauri.conf.json` → `bundle.windows.nsis`）：`installMode: "both"`、`languages` + `displayLanguageSelector`、
  `installerIcon` / `uninstallerIcon`、`headerImage`(150×57) / `sidebarImage`(164×314)、`compression: lzma`、`startMenuFolder`。
- 🔴 **MUI 位图必须是 24bit BMP 且尺寸严格**（150×57 / 164×314），PNG 会直接打包失败。
  由 `scripts/gen-nsis-assets.py` 从 `icons/icon.png` 生成。
- ⚠️ `installMode: "both"` **恒需管理员权限**（必弹 UAC）；要静默装用户目录就改 `currentUser`。
- ⚠️ `bundle.publisher` **不会**写进安装器 CompanyName（实测为空），需要时走 `installerHooks`。

### 10.2 安装协议页

- `bundle.licenseFile` 指向 `src-tauri/EULA.txt`（**与仓库授权解耦**，改文案不影响 LICENSE）。
- 🔴 `EULA.txt` 必须是 **UTF-8 with BOM**：NSIS 的 `LicenseData` 会探测 BOM；**无 BOM 会按系统 ANSI 解码 → 中文乱码**。
- 🔴 `.gitattributes` 给 `EULA.txt` 指定 `text eol=crlf`（协议页在 richedit 里靠 CRLF 换行）。

### 10.3 签名 / 更新 / 分发

- **更新**：`tauri-plugin-updater` + **ED25519** 签名（`tauri signer generate`）；
  公钥入 `tauri.conf.json` 的 `updater.pubkey`，**私钥仅存 CI Secret / 环境变量，绝不入库**。
- **代码签名**（消除 SmartScreen）：Windows Authenticode（OV/EV）；无证书也可分发（仅首次提示）。
- **数据兼容**：升级后 migration 自动迁移旧库，`media/` 随根目录保留。

### 10.4 图标工作流

1. `ImageGen` 出 1024×1024 候选（⚠️ 输出文件名 = prompt 前缀 + 秒级时间戳，同秒同前缀会互相覆盖）。
2. `scripts/ai-icons-to-ico.py --src <目录>`：自动裁边（含**四角泛洪识别**去白底圆角）→ 方形化 → 留白 6%
   → 导出 16/24/32/48/64/128/256 七档 `.ico` + `preview-sheet.png` 小尺寸对比。
3. `--pick "<文件名子串>" --dest src-tauri/icons` 写回（自动备份旧图到 `.workbuddy/icon-backup/`），
   同时导出 `public/app-icon.png`(256, 透明)。
4. 🔴 **应用内品牌位必须与 .ico 同源**：`Sidebar.tsx` 顶部图标、设置-关于页、`index.html` favicon 都用 `public/app-icon.png`。
5. 🔴 **换图标必须强制重建**：tauri-build 不会因 `icons/` 变化自动重跑，需 `touch src-tauri/tauri.conf.json`；
   验证用**字节比对**（`open(exe,'rb').read().find(ico[200:456])`），别只看编译日志。

---

## 11. 阶段路线与状态

### 阶段一 · 系统级（基础设施）—— ✅ 10/10 完成

脚手架 / core 框架 / 数据库层 / 单实例 / 主题令牌 / 通知 / 日志与异常 / 窗体适配 / 加密基础 / 侧边栏与路由守卫。

### 阶段二 · 功能级（工作台模块）—— 进行中

| # | 项 | 状态 |
|---|---|---|
| 11 | 数据中心模块壳 | ✅ |
| 12 | 第一个 Widget（天气） | ✅ |
| 13 | 设置模块（外观 / 通用 / 存储 / 模块 / 关于） | ✅ 含密钥可移植化、备份与恢复、迁移向导、跨机导入向导；操作日志**已决定不做**（ADR-16） |
| 14 | 项目管理模块（`proj_` + git 命令） | ⬜ |
| 15 | 音频管理模块（`audio_` + ffmpeg sidecar） | ⬜ |
| 16 | 其余 Widget（会员账户 / 还款提醒 / 待办） | ⬜ |

### 分支策略

`main` 只放**平台底座 / 外壳 / 插件模型 / 规约**；具体完整功能项目另建分支（如 `feat/project-manager`）。

---

## 12. 决策记录（ADR）

| # | 决策 | 理由 | 替代方案与被否原因 |
|---|---|---|---|
| ADR-1 | **SQLite 单文件 + `Mutex<Connection>` 单写者 + 单实例保护** | 单机工具最简可靠的并发模型；文件级锁 + 进程级锁双保险 | 引入服务端数据库：为单机工具徒增部署与依赖 |
| ADR-2 | **模块 / 插件靠 `import.meta.glob` 自动发现** | 消除「写了模块但忘记加 import」的静默遗漏；新增零成本 | 手写清单文件：漏一行就白干，且易与目录漂移 |
| ADR-3 | **默认落点唯一来源 `getHomeModuleId()`** | 换主界面只改 `pinned` 一处；避免多处硬编码 `"/data-center"` | 各写各的默认路由：改一处漏三处 |
| ADR-4 | **引导文件 `storage.json` 固定在默认目录** | 防止「配置指向自己」的死锁，保住回退能力 | 引导文件随自定义目录走：一改路径就永久失联 |
| ADR-5 | **密钥首要存 OS 凭据库，不落数据目录** | 锁与钥匙分离；「设备被拷走」时数据仍不可解 | 明文密钥文件放数据目录：拷目录即等于拿到钥匙，加密形同虚设 |
| ADR-6 | **新增 `.wbkey` 口令加密副本（本轮）** | 凭据库会因密码重置 / 换机 / 清理而失效；且跨机迁移必须有载体 | ① 只靠手动导出：用户常忘，等于无备份；② 明文副本：安全性下降到 ADR-5 被否的水平 |
| ADR-7 | **`crypto` 拆分为 `load_key` / `create_and_store_key` 两条路径（本轮）** | 杜绝「看一眼就顺手建密钥」引发的跨机数据报废 | 保留 `get_or_create_key` 单一入口：换机静默生成新钥，密文全废 |
| ADR-8 | **`bundle.targets` 收敛为 `["nsis"]`** | NSIS 界面可深度定制（中文/协议页/安装范围），MSI 几乎不可定制 | 保留 `"all"`：每次打包多出一个无用且不可定制的 MSI |
| ADR-9 | **安装协议页用 `EULA.txt` 而非 `LICENSE`** | 免责声明与开源授权解耦，改一处不影响另一处，也避免法律口径自相矛盾 | 直接写 `../LICENSE`：想加风险提示就得动许可证文件 |
| ADR-10 | **窗口位置用 `outer_position()`，尺寸用 `inner_size()`（成对还原）** | `tauri-runtime-wry` 的 `set_size` 底层是 `set_inner_size`；混用会导致每重启一次窗口涨一圈 | 统一用 outer：实测差 18×47px，累积膨胀 |
| ADR-11 | **「数据」与「隐私」合并为单一「存储」页（v1.1）** | 两者本质都是「数据放在哪」；拆两页会让人以为有两个独立目录要管。合并后**唯一可配项就是数据根目录** | 保持两页：用户要在两处分别理解路径，且主密钥本无路径可配，放在「隐私」里纯属误导 |
| ADR-12 | **日志目录跟随数据根目录（v1.1）** | 其余内容（db/media/backup/keys）都跟随根目录，日志例外会让「搬迁数据」缺少一半现场 | 保持日志钉在 `app_data_dir`：换盘后排查现场与数据分离，备份也漏掉日志 |
| ADR-13 | **不提供主密钥明文导出（v1.1）** | 明文导出＝把锁和钥匙放同一个抽屉，直接否掉 §8.1 的威胁模型；`.wbkey` 已同时覆盖备份与迁移 | 保留明文 base64 导出：用户图省事，一旦文件外泄则全部敏感字段失守 |
| ADR-14 | **备份包即跨机迁移载体，manifest 记录密钥指纹并在恢复前校验（v1.2）** | 一份东西两用：跨机迁移与本机回滚本质是同一份数据快照。manifest 里的 `SHA256(K)[0..8]` 是明文、不敏感，却能把「换机后数据解不开」从**事后才发现**提前到**恢复前就拦截** | ① 另建「导出数据包」流程：与备份逻辑高度重复，日后必然行为不一致；② 恢复时不校验指纹：用户走完全程才发现敏感字段全废 |
| ADR-15 | **恢复写成 `workbench.db.restore-pending`，由启动早期换库（v1.2）** | 进程持有连接时覆盖库文件，旁边还留着**属于旧库的** `-wal`/`-shm`，SQLite 一旦回放就是库损坏；且 Windows 上被打开的文件删不掉改不了名。「待替换文件 + 启动早期交换」把这个动作挪到**没有任何连接**的窗口 | 直接 `fs::copy` 覆盖运行中的库：把数据完整性押在 SQLite 的内部校验上，且失败即不可逆 |
| ADR-17 | **跨机导入做成一体化向导，且先只读预检再动手（v1.3）** | 「先导入密钥 → 再恢复数据」原本只写在页面的一段说明文字里，顺序靠用户记；做成向导后顺序由程序强制。预检阶段全部只读，指纹不符就在**磁盘零改动**的状态下停住 | ① 只补「导入外部备份包」、保留两步：改动更小，但顺序仍然靠人守；② 先登记后校验：失败时用户磁盘上会多出一份永远解不开的备份包 |
| ADR-18 | **迁移遇到已含 `workbench.db` 的目标目录一律拒绝（v1.3）** | 原实现用 `overwrite=false` 静默跳过同名文件，然后照样把配置指向目标 —— 表现是「提示已复制并通过校验，重启后打开的却是目标里的旧库」。这种表面成功最有欺骗性，宁可拒绝 | ① 覆盖式迁移：可能毁掉目标那份，还得额外处理空间不足；② 在新目录初始化空库：会让用户以为数据丢了 |
| ADR-16 | **不做用户可见的操作日志页，只提示日志保存地址（v1.2）** | 已有 `op_log` 表规划，但它要求给「增删改 / 迁移 / 备份」逐一埋点才不是空页面。日志文件的价值在于**完整现场**，再造一个 UI 等于把日志重抄一遍（还必然抄不全）。把地址给用户、让他自己打开看，成本与收益比更划算 | 建 `op_log` 表 + 日志页：埋点散落各处易漏，页面信息量又远不如原始日志 |
| ADR-19 | **平台能力抽成 `crates/wb-db` + `crates/wb-runtime`，应用壳只依赖它们（v1.4）** | 新项目要复用平台，就得有一条**物理上看得见**的边界和一条单向依赖。抽成 crate 后越界会**立刻**在依赖图上现形；而只写在文档里的边界，没有任何机制拦得住 —— 等某个业务模块长到几千行、`core/shared` 里塞满业务名词时，就再也抽不出来了。同时把 workspace 的三处静默副作用（target 路径 / profile 位置 / indexmap 特征）一并固化 | ① 继续单 crate：改动最小，但边界只活在文档里，拦不住越界，且越晚抽成本越高；② 拆成独立仓库 + 版本引用：边界更硬，但要处理跨仓依赖与发布节奏，而平台「很少更新」的特点让这种隔离收益有限 |

---

## 13. 已知限制与待办

### 已知限制

1. **本项目为单机工具**，无服务端；跨机复刻靠「备份包 + `.wbkey`」经导入向导完成（§7.6），无自动冲突合并。
2. **凭据库不是绝对可靠**（§8.3 表格），故必须有 `.wbkey` 冗余副本。
3. ✅ 日志目录已跟随根目录（v1.1，§7.5）。
4. `bundle.publisher` 不会写进安装器 CompanyName（§10.1）。

### 待办（按优先级）

| 优先级 | 项 | 归属 |
|---|---|---|
| ✅ | 存储页合并（数据 + 隐私 → 存储） | v1.1 完成 |
| ✅ | 密钥可移植化 + 指纹检测 | v1.1 完成 |
| ✅ | 日志目录跟随根目录 | v1.1 完成 |
| ✅ | 一键备份 + 自动备份 + 恢复（manifest 指纹校验） | v1.2 完成，§7.4 |
| ✅ | 迁移向导升级（SHA-256 校验 + 整体回滚 + 搬 `media/`+`keys/`） | v1.2 完成，§7.3 |
| ✅ | 日志位置提示（不做日志页，ADR-16） | v1.2 完成，§7.5 |
| ✅ | 迁移拒绝非空目标（含 `workbench.db`） | v1.3 完成，§7.3 / ADR-18 |
| ✅ | 跨机导入向导（备份包 + .wbkey 一次收进来） | v1.3 完成，§7.6 / ADR-17 |
| ✅ | 设置模块拆分（`Settings.tsx` 1082 行 → 壳 + `panels/**`） | v1.3 完成 |
| ✅ | 平台能力 crate 化（`crates/wb-db` + `crates/wb-runtime`）+ 根 workspace | v1.4 完成，§3.4 / ADR-19 |
| ⚪ | 前端抽包（`@wb/core` + `@wb/shell`，供多前端工程复用） | 后续（AGENTS §21 第四步） |
| ⚪ | 脚手架 `templates/app` + `scripts/new-app.mjs`（一条命令开新项目） | 后续（AGENTS §21 第四步） |
| ⚪ | `op_log` 表 + 操作日志页 | **已决定不做**（ADR-16） |
| 🟡 | 便携模式（exe 同级 `portable/`） | 后续 |
| ⚪ | MSI 包 / 自动更新 / 代码签名 | 后续 |
| ⚪ | 全局快捷键 / 开机自启 / 文件类型关联 | 后续 |

---

## 附录 A · 关键文件索引

| 关注点 | 文件 |
|---|---|
| 开发规约（怎么做事） | `AGENTS.md` |
| 本设计文档（做成什么样） | `workbench-架构设计.md` |
| 前端入口 / 自检 | `src/main.tsx` `src/app/registry.ts` `src/app/router.tsx` |
| 应用外壳 | `src/app/layout/` |
| 后端 API 封装 | `src/core/shared/api/index.ts` |
| 仓库结构（平台 crate / 应用壳 / 依赖方向） | 根 `Cargo.toml`（`[workspace]`）· `crates/wb-db/` · `crates/wb-runtime/` · `src-tauri/`（§3.4） |
| 数据库层 | `crates/wb-db/src/db/mod.rs` + `db/migrations/*.sql` |
| 存储目录解析 | `crates/wb-db/src/storage.rs` + `crates/wb-runtime/src/commands/storage.rs` |
| 迁移（换根目录） | `crates/wb-runtime/src/migrate.rs` + `commands/storage.rs`（编排） |
| 备份与恢复 | `crates/wb-runtime/src/backup.rs` + `crates/wb-runtime/src/commands/backup.rs` |
| 跨机导入（备份包 + 密钥） | `crates/wb-runtime/src/transfer.rs` + `crates/wb-runtime/src/commands/transfer.rs` |
| 设置子页 | `src/modules/settings/panels/**`（壳在 `Settings.tsx`，参考线：单文件 ≤ ~300 行） |
| 加密与密钥 | `crates/wb-runtime/src/crypto/mod.rs`（含 `.wbkey` 导出/导入 + 单元测试） |
| 命令层（设置/插件/密钥/存储） | `crates/wb-runtime/src/commands/mod.rs`（`resolve_key` 是密钥策略唯一出处） |
| 命令再导出（跨 crate 的必需项） | `crates/wb-runtime/src/lib.rs` 尾部（原因见 AGENTS §21.4） |
| 托盘 / 窗口 / 日志 | `crates/wb-runtime/src/tray.rs` / `window_state.rs` / `src-tauri/src/lib.rs` |
| 打包配置 | `src-tauri/tauri.conf.json` + `scripts/gen-nsis-assets.py` |
| 图标生成 | `scripts/ai-icons-to-ico.py` |
| 真机探针 | `scripts/e2e-probe.js` |

## 附录 B · 术语

| 词 | 含义 |
|---|---|
| **Widget 插件** | 数据中心里的卡片，无路由，声明式注册 |
| **功能模块** | 侧边栏一级导航页，独立路由 + 独立表 |
| **数据根目录** | 用户唯一可配的存储位置，其下按固定相对布局展开 |
| **主密钥 K** | 32 字节 AES-256-GCM 密钥，解密敏感字段的唯一钥匙 |
| **`.wbkey`** | 口令加密的可移植密钥文件，兼作冗余备份与跨机迁移载体 |
| **密钥指纹** | `SHA256(K)[0..8]`，明文存于库中，用于检测密钥与数据是否匹配 |
| **跨机导入** | 把「备份包 + `.wbkey`」一次收进本机的向导流程（§7.6） |
| **单边锁** | 进程级单实例 + 应用内单写者连接，确保同一 db 只有一个写入方 |
| **平台 crate** | `crates/wb-db` / `crates/wb-runtime` —— 与业务无关、可被新项目直接复用的能力（§3.4） |
| **应用壳** | `src-tauri/` —— 每个项目一份：identifier / 图标 / capabilities / EULA / 命令清单（§3.4） |

## 附录 C · 修订记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-05 | v1.4 | ① 平台能力 crate 化（§3.4，ADR-19）：建根 workspace；`storage/db` 抽到 `crates/wb-db`，`crypto/fsutil/backup/transfer/migrate/window_state/tray` + 命令层抽到 `crates/wb-runtime`；`src-tauri` 只剩 `lib.rs` 编排 + 配置 + 图标。② 消除反向依赖：`get_setting_conn` / `set_setting_conn` 从命令层下沉到 `wb-db::settings`。③ 固化 workspace 三处静默副作用：`.gitignore` 忽略根 `/target`、`[profile.release]` 移到根、`indexmap` 特征钉在 `wb-db` 的 `[build-dependencies]`（host 图）。④ 跨 crate 命令的再导出方案定为「函数与 `__cmd__` 宏同在 crate 根」（AGENTS §21.4） |
| 2026-10-05 | v1.3.1 | 文档一致性修正（无代码改动）：① §8.6 跨机流程标注为已被 §7.6 导入向导取代 —— 原文仍在描述「手工拷贝 `workbench.db` 并覆盖本机库」的旧做法；② §11 设置模块状态由「进行中」改为完成；③ §13 已知限制改为指向 §7.6；④ 修复本表 v1.2 / v1.3 两行的结构错位 |
| 2026-10-05 | v1.3 | ① 跨机导入向导（§7.6，ADR-17）：只读预检 → 装密钥 → 登记备份包 → 恢复，判定四态含 `replaces_local_key` 的显式确认；新增 `transfer.rs` 与 4 个命令。② 迁移拒绝已含 `workbench.db` 的目标目录（§7.3，ADR-18），迁移逻辑拆到 `commands/migrate.rs`。③ 接入 `tauri-plugin-dialog` 选文件。④ 设置模块拆分（1082 行 → 壳 + `panels/**`） |
| 2026-10-05 | v1.2 | 备份 / 恢复 / 迁移校验落地（§7.3 / §7.4）；备份包即跨机载体；恢复走待替换文件；日志只提示位置不做页面。新增 ADR-14 / ADR-15 / ADR-16 |
| 2026-10-04 | v1.1 | 落地存储与密钥模型：① 根目录 + 固定相对布局（`storage` 子目录解析函数）；② 日志目录跟随根目录（§7.5）；③ `.wbkey` 口令加密导出/导入 + 密钥指纹三态防护（ADR-6 / ADR-7 落地，`crypto` 拆 `load_key` / `create_and_store_key`）；④ 「数据」+「隐私」合并为「存储」页；⑤ 取消主密钥明文导出（ADR-13）。新增 ADR-11 ~ ADR-13；`.wbkey` 增加 `mem/time/para/created` 字段 |
| 2026-10-04 | v1.0 | 首版。补齐 AGENTS.md 引用的架构权威出处；确立存储与密钥模型（§7 / §8），新增 ADR-1 ~ ADR-10 |
