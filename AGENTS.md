# AGENTS.md — 桌面工作台（WorkBench）开发规定

> **用途**：本文件是 AI 辅助开发与人类协作的**唯一规则源头（single source of truth）**。
> 任何 AI 在本仓库内写代码、加模块、改结构之前，**必须先读并遵守本文件**。
> 配套设计文档：`workbench-架构设计.md`（架构图、表结构、令牌表、签名/分发细节的权威出处）。
>
> 若本文件与设计文档冲突，**以 `workbench-架构设计.md` 为准**，并回头修订本文件。

---

## 0. 项目一句话

一个**插件化单机桌面应用**：模块间低耦合、公共能力下沉、可持续扩展。
用卡片化「数据中心」承载轻量 Widget，用侧边栏一级页承载重型功能模块。

---

## 1. 技术栈（锁死，不要擅自替换）

| 层 | 技术 | 备注 |
|---|---|---|
| 壳/运行时 | **Tauri 2** | 桌面壳、原生能力、打包、更新 |
| 前端 | **React + TypeScript** | UI 与状态 |
| 样式 | **Tailwind CSS** + CSS 变量（设计令牌） | 组件只写语义类名，不写死颜色 |
| 本地库 | **SQLite**（`rusqlite`，Rust 同步） | 单文件 `workbench.db` |
| 原生能力 | Rust commands（`crates/wb-runtime/src/commands/`） | 文件/ffmpeg/git/settings |
| 音视频 | **ffmpeg**（sidecar，`binaries/ffmpeg.exe`） | 随包分发 |

**禁止**：为单机工具引入 MySQL / Postgres / 常驻服务进程（见设计文档 6.1）。
**若未来接既有服务端**：新增「同步到服务端」命令即可，本地库仍是 SQLite，互不影响。

---

## 2. 核心架构：两层插件模型（必须理解）

| 层级 | 是什么 | 注册方式 | 例子 |
|---|---|---|---|
| **Widget 插件（轻）** | 数据中心里的卡片，声明式注册，无路由 | `widgets/<name>/manifest.ts` + 注册表加一行 | 天气 / 会员账户 / 还款提醒 / 待办 |
| **功能模块（重）** | 侧边栏一级导航页，独立路由 + 独立数据表 | `modules/<name>/` 建目录 + 路由注册 | 项目管理 / 音频管理 / 设置 |

**铁律**：
- 数据中心（模块壳）**绝不 import 任何具体 Widget 插件**，只读插件注册表渲染。
  → 加 Widget 不动数据中心代码。
- 设置本身是一个**功能模块**（`modules/settings/`），走侧边栏齿轮入口，与项目管理等同级，无特殊「切换」逻辑。

---

## 3. 模块化规约（七条铁律，违反即返工）

> 每条含：✅ 必须 / ⛔ 禁止 / 📌 示例。AI 写代码前对照自检。

### 规约 1 — 新增 Widget 插件
- ✅ 在 `src/widgets/<id>/` 建目录，含 `manifest.ts`（id/名称/默认尺寸/设置项 schema/图标）与 `index.tsx`（组件本体）。
- ✅ 在 `manifest.ts` 末尾调用 `registerWidget(...)` 自注册；`src/widgets/index.ts` 用
  `import.meta.glob("./*/manifest.ts", { eager: true })` **自动发现并装载**，**不需要再改任何清单文件**。
- ✅ 数据中心自动出现该卡片，配置弹窗里自动支持开关/排序/参数。
- ⛔ 不要在数据中心代码里写任何具体插件的 import 或特判。

### 规约 2 — 新增功能模块
- ✅ 在 `src/modules/<id>/` 建目录（**目录名 = 模块 id**），实现文件末尾调用 `registerModule(...)` 自注册。
- ✅ `src/modules/index.ts` 用 `import.meta.glob("./*/*.tsx", { eager: true })` 自动装载全部模块，
  **不再维护手写 import 清单**（此前漏加一行就会「模块写了但不出现」）。
- ✅ 路由表（`app/router.tsx`）与侧边栏（`app/layout/Sidebar.tsx`）都只读 `listModules()`，入口天然一致。
- ✅ **默认落点唯一来源 = `getHomeModuleId()`**（`app/registry.ts`）：按 `pinned → 第一个 system → 第一个` 推导。
  路由 index/404、隐藏模块的安全落点、面包屑兜底都读它。
- ⛔ 不要手写侧边栏菜单项列表或路由条目——入口必须来自模块清单，不能硬编码。
- ⛔ **不要在别处写死 `"/data-center"` 之类具体模块 id**：以后换主界面只改该模块的 `pinned` 一处即可。
- ⚠️ 顶层「架构说明」类文案（如设置-关于）也要从 `listModules()` 推导，不要罗列模块名——否则加模块后必然过时。
- ⚠️ dev 期注册表会**自动审计**：目录下没有调用 `registerModule` 的，控制台会打
  `[registry] …` 警告点名，防止静默遗漏。

### 规约 3 — 跨模块通信只走 event-bus
- ✅ 模块间用 `core/event-bus.ts` 的 `emit` / `on` 通信。
- 📌 例：项目管理执行 git commit → `emit('project.committed', {...})` → 数据中心概览卡片 `on('project.committed')` 刷新计数。
- ⛔ **禁止模块间直接 import**（包括跨模块 import 组件、函数、store）。

### 规约 4 — 公共逻辑先查 `core/shared`
- ✅ 任何公共能力先查 `core/shared/{api,components,hooks,utils}`，已有则复用。
- ✅ 确实没有，才新增到 `shared`（而非某个模块内部）。
- ⛔ **禁止把公共逻辑写进某个业务模块**（如把通用弹窗写在 `project-manager` 里）。

### 规约 5 — 前端不直接碰系统层
- ✅ 一切文件/数据库/原生操作，经 `core/shared/api`（invoke 封装）调用 Rust commands。
- ✅ 权限校验、路径校验集中在 **Rust 侧**（`crates/wb-runtime/src/commands/`）。
- ⛔ 前端不得直接读 `fs`、直连 SQLite、拼原生路径。

### 规约 6 — 插件互不可见
- ✅ Widget 之间**不 import、不互相通信**。
- ✅ 需要共享数据（如天气位置）：由插件自己在 `plugins.config` 存取，或通过事件广播。
- ⛔ 禁止 Widget A 依赖 Widget B。

### 规约 7 — 平台能力与业务模块的分界 🔴
> 本仓库是**平台 / 框架**，后续要在它之上开新项目（§21）。所以「平台」与「业务」必须能在目录上一眼分清。

- ✅ 平台能力（与业务无关）只放两处：
  - **`crates/wb-db/`** —— 数据位置与连接：`storage.rs`（数据目录布局唯一出处）、
    `db/`（连接 + 迁移执行器 + `app_settings` / `plugins` / `layouts` 三张平台表）、
    `settings.rs`（设置读写原语，连接级）。
  - **`crates/wb-runtime/`** —— 平台运行时：`crypto` / `fsutil` / `backup` / `transfer` /
    `migrate` / `window_state` / `tray`，以及 `commands/`（这些能力的命令门面）。
- ✅ 业务功能只放 `src/modules/<id>/` + `src/widgets/<id>/`，以及**自己的表**（`proj_` / `audio_` …）。
- ⛔ **`crates/**` 与 `src/core/**` 里不许出现业务名词**（`proj_` / `audio_` / 具体业务字段）。
  判据一句话：**换个完全不相干的业务，这段代码还能原样用吗？** 不能，就说明它放错层了。
- 🔴 **依赖方向只允许单向**：`src-tauri`（应用壳）→ `crates/wb-runtime` → `crates/wb-db`。
  ⛔ 反向依赖（`wb-db` 引用 `wb-runtime`，或 `crates/**` 反向引用某个业务模块）一旦出现，
  平台就再也抽不出来了。**这条比编译错误更危险，因为它根本不报错。**
  📌 历史教训：`backup.rs` 曾引用 `commands::get_setting_conn`（运行时反向依赖命令层），
  已把该原语下沉到 `wb-db::settings` 消除。
- ⛔ 业务模块之间不许互相 import（规约 3）；业务模块不许被 `crates/**` 引用。
- 📌 新增平台能力的落点：与「**数据在哪 / 怎么存**」有关 → `wb-db`；与「**能做什么**」有关 → `wb-runtime`。

---

## 4. 目录结构与命名

```
src/
├─ app/                # 应用壳：路由表、主布局、主题
├─ core/               # 核心框架（稳定，不随业务膨胀）
│  ├─ plugin-host/     # 注册表、生命周期、加载器
│  ├─ layout-engine/   # 网格拖拽排序、位置持久化
│  ├─ event-bus.ts     # 唯一跨模块通道
│  └─ shared/          # api / components / hooks / utils
├─ modules/            # 一级功能模块（data-center/project-manager/audio-manager/settings）
└─ widgets/            # 数据中心插件（weather/account/loan-reminder/todo…）

crates/                # 🔴 平台能力：与业务无关，可被新项目直接复用（§21）
├─ wb-db/              # 数据「在哪 / 怎么存」
│  └─ src/
│     ├─ storage.rs    #   数据根目录 + 固定相对布局（§20）
│     ├─ settings.rs   #   app_settings 读写原语（连接级，供运行时复用）
│     └─ db/           #   DbState / DbPathState / 迁移执行器 / migrations/
└─ wb-runtime/         # 平台「能做什么」
   └─ src/
      ├─ crypto/       #   AES-GCM 字段加密 + .wbkey 口令封装 + 指纹（§7 / §8）
      ├─ fsutil.rs     #   带 SHA-256 校验的复制 + 回滚（备份与迁移共用）
      ├─ backup.rs     #   快照 / 恢复 / 自动备份（§7.4）
      ├─ migrate.rs    #   换数据根目录的搬迁内核（§7.3）
      ├─ transfer.rs   #   跨机导入内核（§7.6）
      ├─ tray.rs       #   系统托盘 + 关闭到托盘（§19）
      ├─ window_state.rs  # 窗口 bounds 持久化（§14）
      └─ commands/     #   上述能力的 #[tauri::command] 门面

src-tauri/             # 应用壳：每个项目一份，新项目从模板生成（§21）
├─ src/lib.rs          #   编排：初始化顺序 + invoke_handler 命令清单
├─ src/main.rs
├─ tauri.conf.json     #   identifier / 产品名 / 图标 / NSIS（每项目必改）
├─ capabilities/       #   原生权限（每项目按需）
└─ icons/ · EULA.txt
binaries/ffmpeg.exe     # sidecar 随包分发
```

**命名约定**
- Widget / 模块目录用**短横线 kebab-case**（如 `loan-reminder`）。
- 平台 crate 用 `wb-` 前缀（`wb-db` / `wb-runtime`），与业务模块一眼可分。
- 数据表加**模块前缀物理隔离**：`proj_`（项目管理）、`audio_`（音频）、`app_`（应用级）。
- 注册表 id 与目录名、表前缀保持一致，避免歧义。

---

## 5. 数据存储规约（SQLite）

**文件位置**：默认 `app_data_dir\WorkBench\workbench.db`，可在「设置 → 存储」里把**数据根目录**改到任意绝对路径（§20）。
- 🔴 **用户唯一可配的是「根目录」**，其下按固定相对布局展开（设计文档 §7.1）：
  `workbench.db` / `media/`（媒体） / `backup/`（备份） / `keys/`（密钥文件） / `logs/`（日志）。
  ⛔ 子目录名与拼接只允许出现在 `crates/wb-db/src/storage.rs`，别处一律调 `db_path / media_dir / backup_dir / keys_dir / logs_dir`。
- 默认：`app_data_dir\WorkBench\`
- 可配置：引导文件 `app_data_dir\WorkBench\storage.json` 写 `{"dataDir": "D:\\..."}`；空/缺省 = 回到默认
- 便携：检测到 exe 同目录 `portable/` 则用相对路径（**未实现**，后续迭代）

**核心表（应用级）**
- `app_settings(key TEXT PK, value TEXT(JSON))` — 主题/KV
- `plugins(id TEXT PK, enabled INTEGER, sort INTEGER, config TEXT(JSON))` — 注册/开关/排序/私有配置
- `layouts(id INTEGER PK, name TEXT, grid TEXT(JSON))` — 布局快照

**模块表**：`proj_*` / `audio_*` 等，各自加前缀，物理隔离。

**变更纪律**
- ✅ 所有结构变更走 **migrations**（`db/migrations/0001_init.sql`…，版本化、追加文件）。
- ✅ 升级**不清用户数据**：migration 只增量，不 DROP 他人表。
- ✅ 新模块只加自己前缀的表，永不改别人的表。
- ✅ 路径类字段设 `UNIQUE` 防重复入库（如 `proj_projects.path`）。

**持久化原则（无「保存」按钮，变更即落库）**
- 写操作经 Rust DAO **立刻落库**，返回成功才算成功。
- 改 tag/备注/设置项 → `debounce 300ms` 写库。
- 拖拽排序 / 隐藏切换 → 即时写 `plugins.sort / enabled`。

**文件入库两策略**
- 引用式（默认）：只存路径字符串，文件留原处；加载时校验存在性，失效项标灰提示「文件已移动」。
- 导入式：复制到 `media/<module>/` 再存库（占用空间但完全托管）。

**迁移 / 备份 / 导出**
- 🔴 备份与迁移共用 `crates/wb-runtime/src/fsutil.rs` 的**带校验复制**：每个文件复制后回读比对 SHA-256，
  不一致即删目标并报错；迁移还按「本次新建清单」整体回滚，且**不改写配置**（§20.2）。
- 路径修改走「迁移向导」：**先复制 + hash 校验 → 再重指向 → 最后才清旧**，任一环节失败回滚。
  ⛔ 必须连 `media/` 与 `keys/` 一起搬 —— 只搬主库会让媒体文件静默丢失。
- 🔴 **目标目录里已有 `workbench.db` → 拒绝迁移**（ADR-18）：不搬文件、不建目录、不写 `storage.json`。
  静默跳过会骗人（提示成功、重启后是目标里的旧库），覆盖可能毁掉目标那份。
- 🔴 **别做「在新目录初始化空库」**：用户点「迁移」的语义是搬数据，悄悄初始化会让人以为数据丢了。
- 一键备份：`<根目录>/backup/backup_<UTC时间戳>/` 目录快照 = `workbench.db` + `media/` + `manifest.json`。
- 🔴 **备份包同时是跨机迁移载体**（公司电脑 → 家里笔记本），**不另造「导出包」概念**（ADR-14）。
- 🔴 **备份包不含密钥**：manifest 只记 `SHA256(K)[0..8]` 指纹（明文、不敏感）；恢复前比对本机密钥，
  不匹配**直接拒绝**并提示导入对应的 `.wbkey`。换机顺序固定：**先导入密钥 → 再恢复数据 → 重启**（ADR-14）。
- 🔴 **换机走「跨机导入」向导**（设置 → 存储 → ④ 跨机导入，§7.6 / ADR-17）：把「备份包 + `.wbkey`」
  一次选进来，顺序由程序强制。预检 `import_inspect` / `wbkey_inspect` / `import_precheck` **全是只读**，
  指纹不符时磁盘零改动。判定 `replaces_local_key` 必须用户**勾选确认**才继续；
  `key_import_wbkey` 的 `replace` 默认 false —— 普通导入入口**永不替换在用密钥**。
- 🔴 恢复不直接覆盖运行中的库：写成 `workbench.db.restore-pending`，由启动早期
  `db::apply_pending_restore` 在**没有任何连接时**先删 `-wal`/`-shm` 再换库（ADR-15）——
  否则属于旧库的 WAL 被回放到换过的库上，就是库损坏。
- 自动备份：`app_settings: backup.auto = off | on_start` + `backup.keep`（默认 5）；
  启动时在后台线程执行并清理最老的（不持有数据库连接，§5.x）。
- ⚠️ 备份默认**与数据同一块盘**（都在根目录下）：盘坏了会一起没。UI 必须提示用户把快照复制出去。
- JSON 导出：核心表可导出 JSON，便于跨机/跨大版本迁移。

### 5.x 并发与锁（单边锁）

> 关注点：避免同时修改 `workbench.db` 文件。SQLite **自带文件级锁**（shared/reserved/pending/exclusive），但须在架构上落实以下几点，否则仍会 `SQLITE_BUSY` / 数据竞争 / 写坏。

- ✅ **进程级单实例（最关键的「单边锁」）**：Tauri 启用 single-instance 模式——第二个启动的实例把参数转发给已运行实例并退出，确保同一 `workbench.db` 只有一个进程持有写。这是防止「同时修改」最有效的进程层保障。
- ✅ **应用内并发写串行化**：rusqlite 连接默认不跨线程共享。采用**单一写者连接**或**连接池 + 写队列**（所有写经一个任务串行提交），读可用独立连接。⛔ 禁止多线程各开连接乱写。
- ✅ **开启 WAL 模式**（`PRAGMA journal_mode=WAL`）：一个写与多个读可并发，桌面响应更佳。注意 WAL 会产生 `-wal` / `-shm` 附属文件——**备份 / 迁移复制时必须连同这两个文件一起复制**（设计文档 6.3），否则数据不完整。
- ✅ **捕获 `SQLITE_BUSY`**：外部进程（如用户用 DB Browser 打开 db）占用时写会失败；应捕获并 `notify('error', '数据库正被其他程序占用')`，而非静默失败或无限重试。
- ✅ **长任务不占连接**：ffmpeg 等耗时任务不长期持有 DB 写连接；任务状态走内存 + 异步短事务回写，避免锁持有过长。
- ✅ **短事务 + 启动期 migration**：写操作包在最小粒度事务里尽快提交释放锁；migration 在启动早期、无并发写时单线程执行。

---

## 6. 主题与设计令牌

- 实现：CSS 变量承载令牌 + React `ThemeProvider` 切 `<html data-theme="light|dark">`；当前主题存 `app_settings(theme)`，并跟随系统 `prefers-color-scheme`。
- Tailwind：`theme.extend.colors` 映射到 CSS 变量（`bg-app` / `text-primary` …），**组件只写语义类名，不写死颜色**。
- 令牌表（Light / Dark 双值，详见设计文档第七节）：`bgApp / bgSidebar / surface / textPrimary / textSecondary / textMuted / accent / border / success / warning`。
- ⛔ 禁止在组件里硬编码 hex 颜色；要换肤就改令牌。

---

## 7. 安全与加密

威胁模型：个人单机工具，主要风险是「设备丢失/文件被拷走后泄露」，非多用户并发。

- ✅ 默认**字段级加密（方案 A）**：仅敏感字段（会员密码、Git Token、API Key）做 AES-GCM，主密钥存 OS 凭据库（keyring `windows-native`）。
- ✅ 音频/媒体文件**不加密**（体积大、无密级），不进 SQLite。
- ⛔ **密钥只存 OS 钥匙串，绝不明文入库或写配置文件**。
- ⛔ **不提供主密钥明文导出**：导出只能是口令加密的 `.wbkey`（明文导出＝把锁和钥匙放同一个抽屉）。
- ✅ **口令加密的可移植密钥文件 `.wbkey`**（设计文档 §8.4）：一个文件同时解决「凭据库失效时的冗余副本」与「公司电脑 → 个人笔记本的迁移载体」。口令经 Argon2id 派生 wrapping key，再 AES-256-GCM 封装主密钥；文件被拷走没口令也解不开。
- 🔴 **密钥指纹防护（设计文档 §8.5）**：`app_settings: crypto.key_fingerprint = SHA256(K)[0..8]`。
  三态判定在 `commands::resolve_key`（**唯一出处**）：
  | 库中指纹 | 凭据库密钥 | 行为 |
  |---|---|---|
  | 无 | 无 | 首次运行；**写**敏感字段时才显式建钥（`create_and_store_key`），并落指纹 |
  | 无 | 有 | 采用已有密钥并补记指纹 |
  | 有 | 有且一致 | 放行 |
  | 有 | 有但**不一致** | ⛔ 拒绝加解密，提示「密钥与数据不匹配，请导入密钥」 |
  | 有 | **无** | ⛔ **拒绝静默生成新密钥**，提示「此数据来自另一台机器，请先导入密钥」 |
  ⛔ `crypto` 只有 `load_key()`（只读）与 `create_and_store_key()`（显式创建）两条路径，
  不再提供「看一眼就顺手创建」的接口 —— 否则换机会把已有密文全部作废。
- 可选升级 **SQLCipher 整库加密（方案 B）**：仅当要求「db 拷走也打不开」时启用。

---

## 8. 签名 / 更新 / 分发

- 更新：`tauri-plugin-updater` + **ED25519** 密钥签名（`tauri signer generate`），公钥入 `tauri.conf.json` 的 `updater.pubkey`，私钥仅存 CI Secret/环境变量，**绝不入库**。
- 安装包：**NSIS（推荐）** 支持选路径 + 中文 EULA + 必须勾选同意；Windows 中文用系统雅黑，RTF 许可存 UTF-8 防乱码。另打 zip/便携版跳过弹窗（数据走 `portable/`）。
- 代码签名（消除 SmartScreen）：Windows Authenticode 证书（OV/EV），个人无证书也可分发（仅首次提示）。
- 数据兼容：升级后 `migrations` 自动迁移旧库，媒体随 `media/` 保留。

---

## 9. 开发路线（系统级 → 功能级）

> **总原则：先划分系统级与功能级，先把系统级（功能搭建）完成，再考虑工作台的工作模块。**
> 系统级 = 所有模块共用的骨架与跨模块能力；功能级 = 挂在骨架上的具体工作模块（数据中心 / 项目管理 / 音频管理 / 设置 / Widget）。
> 完成阶段一前不急于做业务模块；阶段一的输出是一个能跑、带通知/日志/主题/自适应/单实例的空壳 + 数据库。

### 阶段一 · 系统级（基础设施 / 功能搭建）

- [x] 1. 脚手架：Tauri 2 + React + TS + Tailwind 初始化；目录骨架（`app/` `core/` `modules/` `widgets/` `src-tauri/`）。
- [x] 2. core 框架：`plugin-host`（注册表/生命周期）、`event-bus`（emit/on）、`shared`（api/components/hooks/utils）、`layout-engine`（网格排布 + ResizeObserver 容器宽度重算 + 布局持久化）。
- [x] 3. 数据库层：rusqlite 连接 + migration 执行器（`PRAGMA user_version` 版本化） + **WAL + busy_timeout + `Mutex<Connection>` 单写者（见 5.x 单边锁）** + `app_settings` / `plugins` / `layouts` 基础表 + 4 个命令（get/set_setting、list/update_plugin）。
- [x] 4. 单实例保护：Tauri single-instance，确保同一 db 只有一个进程写（单边锁的进程层保障）；第二实例参数经 `secondary-instance` 事件转发给前端。
- [x] 5. 主题与令牌：CSS 变量 + `ThemeProvider` + 跟随系统；已补 `danger` 令牌（错误通知用）。
- [x] 6. 通知系统（§10）：`<ToastProvider>` + `notify()`，四级等级（success/info/warning/error）。
- [x] 7. 错误日志与异常处理（§11）：`ErrorBoundary` + `tauri-plugin-log`（写 `<数据根目录>/logs/`，5MB 滚动、保留 10 份）+ panic 崩溃兜底（`crash-*.log`）+ 前端统一 `reportError`（技术细节入日志、用户见友好文案）。**用户可见「操作日志」页面待阶段二设置模块落地。**
- [x] 8. 窗体尺寸与分辨率适配（§14）：`window_bounds` 持久化（`window.json`）、最小尺寸 860×560、按内容区宽度的响应式断点（ResizeObserver）、相对单位 + 令牌间距。
- [x] 9. 安全与加密基础（§7）：AES-256-GCM 字段级加解密 + 主密钥存 OS 凭据库（keyring, windows-native）+ `secure_set/get_setting` 命令 + 密钥导出备份；密钥绝不明文入库/写配置。
- [x] 10. 侧边栏框架 + 路由守卫（§15）：模块清单驱动渲染、`hidden_modules` 隐藏/显示联动、当前页隐藏自动跳数据中心 + `notify('info')`、系统模块（数据中心/设置）常驻。

### 阶段二 · 功能级（工作台工作模块）

> 系统级完成后，按需逐个挂载工作模块。每个模块自带前缀表 + 路由 + Rust 命令。

- [x] 11. 数据中心模块（模块壳）：读注册表渲染 Widget；配置面板支持显示开关（`plugins.enabled`）、排序（布局引擎 `layout:data-center`，含隐藏项保留位置）、插件参数（`plugins.config` + `settingsSchema`）。见 §18.7。
- [x] 12. 第一个 Widget（天气）：跑通「注册 → 渲染 → 开关/排序/参数持久化」闭环，验证插件模型。
- [ ] 13. 设置模块：外观/通用/存储（数据位置 + 密钥与安全 + 备份与恢复 + 运行日志）/音频/模块/关于 子菜单，全部绑定 `app_settings` + 命令层（含迁移向导 §7.3、备份 §7.4）。
  **已完成**：子页骨架、隐私→存储合并、密钥可移植化（`.wbkey` + 指纹）、数据根目录 + 固定相对布局、
  一键/自动备份 + 恢复（manifest 记指纹、恢复前校验）、迁移向导 hash 校验（连 `media/`+`keys/` 一起搬）、
  运行日志位置提示；**待做**：音频页。
- [ ] 14. 项目管理模块（`proj_` 表 + git 命令）。
- [ ] 15. 音频管理模块（`audio_` 表 + ffmpeg sidecar）。
- [ ] 16. 其余 Widget（会员账户 / 还款提醒 / 待办）按需补充。

> 每完成一项，把对应 `[ ]` 改为 `[x]` 并在提交信息注明；阶段一全部完成前不进入阶段二的业务模块。

> **当前状态（2026-10-04）：阶段一 10/10 全部完成。**
> 编译验证：Rust 侧 `cargo check` 干净通过（0 error / 0 warning）；前端 `npm run build` 干净通过（tsc 0 错误 + vite 打包成功）。
> 已知限制：沙箱无 GUI，未能真机 `tauri dev` 验证窗口；阶段一结束时的前端模块壳（数据中心 / 设置 / 项目管理 / 音频管理）为占位实现，属阶段二。

### 阶段一落地要点（供后续参考）

| 主题 | 实现位置 | 关键约定 |
|---|---|---|
| 数据库 | `crates/wb-db/src/db/mod.rs` + `db/migrations/*.sql` | `PRAGMA user_version` 版本化，追加式迁移；WAL + busy_timeout；`Mutex<Connection>` 单写者 |
| 命令层 | `crates/wb-runtime/src/commands/mod.rs` | `Result<T, String>`；前端一律经 `src/core/shared/api` 调用 |
| 日志 | `src-tauri/src/lib.rs` | `tauri-plugin-log` → `<数据根目录>/logs/`；panic → `crash-*.log` |
| 加密 | `crates/wb-runtime/src/crypto/mod.rs` | AES-256-GCM；主密钥存 OS 凭据库（keyring windows-native） |
| 窗体 | `crates/wb-runtime/src/window_state.rs` + `tauri.conf.json` | bounds 存 `WorkBench/window.json`；`minWidth/minHeight` = 860×560 |
| 布局引擎 | `src/core/layout-engine/` | 拖拽排序 → `app_settings: layout:<scope>`，debounce 300ms |
| 通知 | `src/core/shared/components/Toast.tsx` | 模块级 `notify()`，与 event-bus 解耦 |
| 错误上报 | `src/core/shared/utils/errors.ts` | `reportError(err, 友好文案)`；全局兜底在 `main.tsx` 安装 |

---

## 10. 通知系统（In-App Notifications）【设计文档未覆盖，本仓库补充】

> 统一的「项目内通知」机制，常见表现为**右下角 toast**，用于操作成功/失败/提醒等轻反馈。

- **集中管理**：`core/shared/components` 提供 `<ToastProvider>` + 全局 `notify(level, message, opts)` API。业务模块 / Widget **禁止自己再实现一套弹窗**，一律走 `notify`。
- **通知等级**（与设计令牌对齐，颜色不写死）：

  | 等级 | 令牌/颜色 | 典型场景 | 自动消失 |
  |---|---|---|---|
  | `success` | `success`（绿） | 保存成功、导入完成、备份完成 | 3s |
  | `info` | `accent`（蓝） | 普通提示、同步完成、信息变更 | 3s |
  | `warning` | `warning`（黄） | 文件失效、即将到期、需确认的风险操作 | 5s |
  | `error` | 建议新增 `danger`（红） | 命令失败、写库失败、网络异常 | 不自动消失 / 8s 可手动关 |

- **行为规约**：
  - 多条**堆叠**，同屏最多 3~4 条，超出排队；
  - 支持可选操作按钮（如「撤销」「重试」「查看」）；
  - 无障碍：容器 `role="status"` + `aria-live="polite"`（error 用 `assertive`），保证屏幕阅读器可读；
  - toast 是**非模态**，不阻断主流程；需要用户决策的用 `core/shared` 的确认弹窗（模态）。
- **与 event-bus 解耦**：通知由调用方直接 `notify()` 触发。跨模块事件（如 `project.committed`）若需提示，由监听方决定是否 `notify`，**不在事件载荷里内嵌 UI**。

---

## 11. 错误日志与异常处理【设计文档未覆盖，本仓库补充】

- **分层日志**：
  - **前端运行时**：React `ErrorBoundary` 兜底渲染，避免整页白屏；未捕获异常归集到日志服务。
  - **Rust 侧**：用 `log` + `tauri-plugin-log`（或 env_logger），按 `error/warn/info/debug` 写入 `data/logs/`（位置见设计文档 9.4）。
  - **日志位置（用户可见）**：设置 → 存储 →「运行日志」给出 `<根目录>/logs` 的绝对路径、已有文件列表与「打开目录」按钮；文件由 `tauri-plugin-log` 写入，当前 `workbench.log`，超过 5MB 滚动为 `workbench_<YYYY-MM-DD_HH-MM-SS>.log`（**按生成时间保存**），保留最近 10 份。
    🔴 **不建用户可见的操作日志页面、也不加「高级」子页**（ADR-16）：日志本身就是给人排查用的文件，把地址给出来、让人自己打开看即可 —— 再造一个页面等于把日志文件重抄一遍到 UI 里。
- **日志规约**：
  - 文件按日 / 大小滚动（`workbench-YYYYMMDD.log`），保留最近 N 份，避免无限膨胀；
  - 记录要素：时间戳、级别、模块/命令、消息、必要上下文；
  - ⛔ **敏感字段（token / 密码 / 密钥）绝不写日志**（与加密规约 7 一致）；
  - 前台对用户的提示只给友好文案，技术细节进日志 + 可选「复制错误详情」。
- **错误传播**：Rust command 返回 `Result<T, String>`（或自定义错误枚举），前端统一 `try/catch` → 失败即 `notify('error', 友好文案)` + 写日志。
- **崩溃兜底**：Tauri panic 钩子捕获 → 写 `data/logs/crash-*.log`，下次启动检测并提示用户「上报 / 忽略」（遥测需隐私声明，默认关）。

---

## 12. 其他待补充考量清单（设计文档尚未覆盖）

> 以下按「价值 / 归属 / 优先级」列出常见桌面应用能力缺口。**优先级**：🔴 本期必做（基础体验）｜🟡 建议做（体验加分）｜⚪ 可延后（未来迭代）。
> AI 动工前，对 🔴 项须落地，🟡 项按需，⚪ 项记录在案即可。

### A. 健壮性与 UX
- ✅ **空状态 / 加载态 / 失败重试**（已落地 2026-10-04）：`core/shared/components/States.tsx` 提供
  `EmptyState` / `LoadingState` / `SkeletonCard` / `ErrorState(带重试)`，新页面一律复用，禁止裸转圈或白屏。
- 🔴 **输入与数据校验**：前端 `zod`/`valibot` schema + Rust 侧二次校验；Widget 设置项由 manifest schema 驱动表单。
- 🟡 **软删除 / 回收站**：删除走 `deleted_at` 标记，避免误删不可逆（引用式文件删除前需确认）。
- 🟡 **撤销 / 重做**：布局拖拽、批量删除建议命令模式 + 历史栈（可先不做）。
- ✅ **全局搜索 / 命令面板**（已落地 2026-10-04）：`core/shared/components/CommandPalette.tsx`，
  `Ctrl/Cmd+K` 唤起、过滤、方向键 + 回车跳转；**已隐藏模块仍可调起**（贯彻 §15「藏入口非禁用」）。
  当前范围是模块跳转，跨模块内容检索（项目/音频）留待各模块有数据后扩展。

### B. 桌面专属能力（Tauri）🟡
- ✅ **系统托盘 + 最小化到托盘**（已落地 2026-10-04）：`crates/wb-runtime/src/tray.rs`，顶栏 ✕ 默认收进托盘、
  托盘左键单击还原、右键菜单「退出」才真正关进程（§19）。
- 全局快捷键（唤起窗口、快捷操作）。
- 开机自动启动（设置里开关）。
- 多窗口（如音频处理进度独立窗口）。
- 文件类型关联（双击文件用本应用打开）。

### C. 质量与工程 🟡/⚪
- 🟡 **测试策略**：单元（Rust/TS）+ 集成（command）+ E2E（Tauri）+ migration 回放测试。
- 🟡 **CI/CD**：构建 / 签名 / 发布 / updater 通道（设计文档 8 已有签名，补流水线编排）。
- ⚪ **帮助 / 反馈入口**：关于页或设置页放文档链接、反馈渠道。
- ⚪ **崩溃上报 / 遥测**：可选，需隐私声明且默认关闭。

### D. 可访问性与国际化 ⚪
- 无障碍 a11y：键盘可达、对比度、屏幕阅读器（与令牌体系配合）。
- i18n：当前中文优先；若考虑出海，提前抽文案到 i18n 资源（不阻塞当前开发）。

### E. 数据一致性 🟡
- 并发 / 竞态：多命令并发写库用事务 / 连接池串行化；ffmpeg 长任务进度用**进度事件**而非轮询。
- 网络同步（未来）：若接既有 ELN 的 MySQL，提前定义冲突解决策略（最后写入 / 版本向量 / 手动合并）。

---

## 14. 窗体尺寸与分辨率适配【设计文档未覆盖，本仓库补充】

> 桌面应用直接面对 1080p/2K/4K、125%~150% 系统缩放等复杂环境，窗口与布局须自适应，禁止写死尺寸导致破版或模糊。

- **窗口尺寸持久化**：记录并恢复上次窗口位置 / 尺寸（实现落在 `app_data_dir/WorkBench/window.json`，
  独立于数据库的 migration 体系，见 §14.2 的三条硬性防线）；首次启动给合理默认（如屏幕 60%，下限 1100×720）。
- **最小尺寸保护**：设 `min-width` / `min-height`（如 860×560），低于则不允许再缩，避免布局塌陷、组件重叠。
- **响应式断点（按内容区宽度，非屏幕）**：
  - 宽屏（≥1280）：侧边栏常驻展开 + 数据中心网格多列（如 4 列）；
  - 中屏（960~1279）：侧边栏可收起 + 网格 3 列；
  - 窄屏（<960）：侧边栏收为图标栏或抽屉式（overlay）+ 网格 2 列，必要时 1 列。
- **高 DPI / 系统缩放**：
  - 跟随系统 `devicePixelRatio`，UI 用相对单位（rem / % / flex / grid）+ 设计令牌间距（8 基准栅格），**禁止写死 px 布局**导致 125%/150% 缩放下溢出或模糊；
  - 1px 边框 / 分隔线用 `border` 令牌保证清晰；图标用矢量 SVG 或 2x 资源；
  - 监听 Tauri `scaleFactor` 变化，实时重算拖拽网格列数。
- **最大化 / 全屏**：最大化不破坏网格；退出恢复之前尺寸。超大屏内容区设 `max-width` 居中或网格封顶列数，不无限拉宽。
- **布局引擎联动**：拖拽网格须响应容器尺寸变化——列数随内容区宽度重算，已放置 Widget 重排但不丢位置。

### 14.2 窗口 bounds 持久化的三条硬性防线 🔴

> 症状对照：**「进程在跑、日志一切正常，但点托盘图标 / 任务栏怎么都调不出窗口」** ——
> 九成是 `window.json` 存了坏坐标，启动时把窗口还原到了屏幕外。

实现见 `crates/wb-runtime/src/window_state.rs`。三条防线缺一不可：

1. **最小化期间禁止落盘**。Windows 会把最小化窗口挪到 `(-32000, -32000)`、尺寸也变成图标尺寸
   （实测被写成 `235x128`）。`Resized` / `Moved` 事件在最小化时会带着这组哨兵值触发，
   `save()` 必须先 `is_minimized()` / `is_visible()` 过滤掉。
2. **落盘与还原都要校验矩形落在某块显示器上**。用 `available_monitors()` 求交集，重叠 < 80px 视为
   「看不见」；坏值一律丢弃（并删掉文件）+ `center()` 居中。显示器拔掉、分辨率变化同理。
3. **最大化状态单独记 `maximized` 标志位**。最大化时 `outer_position/outer_size` 返回的是
   最大化矩形（实测 `(-9,-9) 1938x1038` @1920x1080），当正常尺寸存下去会让下次启动出现
   「占满屏幕但没最大化」的怪窗口。最大化时只更新标志位，正常尺寸沿用上一次的值。

配套约定：
- **位置用 `outer_position()`、尺寸必须用 `inner_size()`**。还原时的 `set_position()` 对应外层位置，
  而 `set_size()` 底层是 `set_inner_size()`（`tauri-runtime-wry` 里 `WindowMessage::SetSize` → `set_inner_size`）。
  存 `outer_size()`（含标题栏/边框，实测差 18×47px）再按内层尺寸还原 → **每重启一次窗口涨一圈**，必须成对。
- `tray::show_main()` 是**唯一**的唤窗路径（托盘点击、第二实例启动都走它），顺序固定为
  **`show()` → `unminimize()` → `ensure_on_screen()` → `set_focus()`**。
  ⛔ 不能把 `ensure_on_screen()` 提到 `unminimize()` 之前——最小化时读到的是哨兵坐标，
  会把正常最小化的窗口误判成「跑到屏幕外」而无脑居中。
- 启动时 `log_bounds()` 会把最终几何信息与 `visible_on_screen` 写进日志；
  排查「窗口不见了」先看这行。

---

## 15. 侧边栏菜单项隐藏/显示与内容区联动【设计文档未覆盖，本仓库补充】

> 先区分两种「侧边栏变化」，二者机制不同：
> - **整体收起 / 展开（collapse）**：侧边栏变窄为图标栏、内容区变宽——纯布局变化，不涉及路由，由 `app_settings: sidebar_collapsed` 控制。**默认收起（`true`）**，用户展开后持久化其选择。
> - **单项隐藏 / 显示（hide/show）**：从入口集合中移除 / 恢复某个功能模块——涉及路由可达性与内容区跳转，**本节重点**。

### 分组与置顶（pinned）
- 侧边栏分三组，顺序固定：**主界面**（`pinned: true`）→ **工作模块**（业务）→ **系统**（`system: true`，除 pinned）。
- 数据中心 `pinned: true` 且 `order: 10` → 渲染为主界面分组首项，同时是应用默认落地页（路由 `/` 与未知路径均重定向到它）。

### 语义与持久化
- ✅ 「隐藏菜单项」= **隐藏侧边栏入口，不等于卸载模块 / 删除数据**。模块路由、数据、Widget 仍在，仅入口不可见。
- ✅ 可见性持久化：存 `app_settings`（如 `hidden_modules` 数组）；重启保持。
- ⛔ 本节针对**侧边栏「功能模块」入口**的显隐；Widget 卡片显隐走 `plugins.enabled`（数据中心内部），不影响侧边栏。

### 内容区联动规则（核心）
- 🔴 **当前所在页被隐藏 → 禁止停留在已隐藏模块页面**（否则导航断裂）。规则：
  - 当前激活路由对应的模块被隐藏时，**自动跳转安全默认页**（数据中心 / 第一个可见模块），并 `notify('info', '「X」已从侧边栏隐藏')`；
  - 路由守卫拦截对已隐藏模块的直接访问（除非经命令面板显式唤起，见下）。
- ✅ 侧边栏是导航、内容区是路由出口：二者经路由状态联动；隐藏入口只改变「可直达集合」，**不改变已加载数据**。
- ✅ 过渡：侧边栏项显隐、内容区跳转用 CSS transition，避免内容区跳变 / 白闪。

### 边界情况
- ⛔ **全部模块隐藏 → 至少保留数据中心（或兜底空状态页）**，不允许空侧边栏导致无入口。
- ✅ 隐藏后再显示：入口恢复，原数据 / 布局完好无损。
- 🟡 **命令面板（Ctrl/Cmd+K）唤起已隐藏模块**：建议**允许**（隐藏只是收起入口，非禁用），但侧边栏不列出；若产品定位为「彻底禁用」，需新增语义（先按「仅隐藏入口」实现，后续再定）。

---

## 16. 给 AI 的协作提示（必读）

- **动手前**：读完本文件 + `workbench-架构设计.md`；不确定结构时先问，不要臆造目录。
- **加东西先问「它属于哪一层」**：是 Widget 还是模块？公共还是私有？决定放 `widgets/` 还是 `modules/` 还是 `core/shared/`。
- **复用优先**：写任何组件/工具前，先 grep `core/shared` 看是否已存在同款。
- **不要破坏隔离**：跨模块 import、Widget 互引、前端直连系统层——这三类是高频返工点，写完自检。
- **迁移即增量**：改表结构只新增 migration 文件，绝不手写 DROP/ALTER 覆盖历史。
- **命名一致性**：目录名 = 注册表 id = 表前缀，三者对齐。
- **改完必须真机跑一次**：编译通过 ≠ 能运行。改前端/窗口/命令后，用 `npm run dev:app` 起真机，并按下文 §17 的「3 分钟验证清单」确认，不要只靠 `tsc`/`cargo check` 结案。

---

## 17. 真机运行与排障（本仓库补充，2026-10-04 实测落地）

> 起因：早期只能靠 `tsc`/`cargo check` 判断，出过「编译全绿但窗口白屏、数据一条都存不进去」的情况。
> 本节是**唯一可信的验收方式**，也是踩过的坑的固化。

### 17.1 启动方式：用 `npm run dev:app`，不要用 `npm run tauri dev`

```bash
npm run dev:app     # ✅ 本机可用：自动拉起 Vite + Tauri
```

⛔ `npm run tauri dev` 在本机会失败（与沙箱无关，管理员权限也复现）：

```
failed to run command `npm run dev` with `cmd /S /C`:
所有的管道范例都在使用中。 (os error 231)
```

原因：`tauri dev` 的 `beforeDevCommand` 经 `cmd /S /C` 派生子进程并接管 stdio 管道，本机管道创建失败。
绕行：`scripts/dev-app.mjs` 自己先起 Vite（`stdio: inherit`，不走管道），等 5173 就绪后再用
`tauri dev --config '{"build":{"beforeDevCommand":""}}'` 启动，效果等价。

### 17.2 必须给 WebView2 传 `--no-sandbox`（否则白屏 + IPC 全废）

已固化在 `src-tauri/tauri.conf.json` 的 `app.windows[0].additionalBrowserArgs`：

```
--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --no-sandbox
```

本机 WebView2（Edge 154 运行时）Chromium 沙箱无法初始化，**浏览器进程崩溃**，症状极具误导性：

| 现象 | 说明 |
|---|---|
| 窗口能开、标题正常、`tasklist` 有 `workbench.exe` | 看起来一切正常 |
| dev server 只收到 `/`、`/src/main.tsx`、`/@react-refresh` 3 个请求 | 模块图加载中断（非代码问题） |
| `app_settings` 一条都不写、前端日志为空 | **IPC 完全不可用**，被「静默降级」掩盖 |
| 日志出现 `[tauri_runtime_wry][ERROR] WebView2 error: ... 0x8007139F "没有注册类"` | `window.eval` 也失败，佐证浏览器进程已残 |

诊断依据：`%LOCALAPPDATA%\<identifier>\EBWebView\Crashpad\reports\*.dmp` 出现崩溃转储。
逐个参数实测：`--disable-gpu` 单独**无效**，`--no-sandbox` 单独**即可修复**。
⚠️ `--no-sandbox` 是安全降级，仅因本机沙箱不可用才启用；应用只加载本地内容，风险可控。若换机后一切正常，可尝试移除。

### 17.3 3 分钟验证清单（改完必跑）

1. `npm run dev:app`，等日志出现 `Running target\debug\workbench.exe`。
2. 看**前端日志**是否回流（证明 webview 真的跑起来了）：
   `%LOCALAPPDATA%\com.workbench.app\logs\WorkBench.log` 出现
   `ui booted · ipc ok · plugins=N`。
3. 读库确认 IPC 真能落盘（只读，安全）：
   `%APPDATA%\com.workbench.app\WorkBench\workbench.db` 的 `app_settings.ui_last_boot` 时间戳应为本次启动。
4. dev 期还会自动回报一次 UI 自检（见 17.4），可直接读到界面文本，判断是否白屏。

### 17.4 dev 期运行自检（`spawn_dev_self_check`）

「看不到窗口、也看不到 webview 控制台」是最难受的排障场景，因此 `src-tauri/src/lib.rs` 里有一个
`#[cfg(debug_assertions)]` 的自检：启动 8 秒后让 webview 把关键状态以 HTTP 请求回报给 Vite
（路径 `/__diag`，可在 dev server 日志里看到），内容含：

- `internals` / `invoke`：Tauri IPC 桥是否存在 → 判断命令层是否可用
- `rootChildren` / `bodyLen` / `text`：React 是否真的渲染、界面文本是什么 → 判断是否白屏

release 构建不编译该代码。

### 17.5 两个日志位置（别只看一个）

| 位置 | 来源 |
|---|---|
| `<数据根目录>\logs\workbench.log`（默认即 `%APPDATA%\com.workbench.app\WorkBench\logs\`） | `TargetKind::Folder`（我们的目录，含**前端**日志） |
| `%LOCALAPPDATA%\com.workbench.app\logs\WorkBench.log` | 插件默认的 OS 日志目录（仅 Rust 侧） |

前端日志会被标记来源，形如 `[webview::safeInfo@http://127.0.0.1:5173/src/...:12:10][INFO] ...`。

### 17.6 教训：静默降级会把致命问题藏起来

早期 `api` 调用全部 `.catch(() => {})` 静默降级，结果「界面正常、数据全废」毫无察觉。
现在 `src/main.tsx` 的 `bootstrapSelfCheck()` 会在启动时显式 `setSetting` + `listPlugins`，
**失败即 `notify('error')` + 写日志**。新增任何 IPC 调用时，遵守同样原则：
可降级，但**必须留痕**，不许无声失败。

配套：`api.isTauri()`（`core/shared/api`）用于区分「浏览器调试的预期降级」与「宿主内的真实故障」——
凡 `.catch` 里判断 `isTauri()`，是真实故障就必须 `reportError`，不得静默。

### 17.7 交互验证：dev 期端到端探针（`WB_E2E=1`）

`/__diag` 只能证明「渲染出来了」，证明不了交互。`scripts/e2e-probe.js` 会在真实 WebView 里
自动点一遍关键交互，并把断言结果回报到 Vite 终端（路径 `/__e2e?...`）：

```bash
# 1) 带探针启动 Vite（改了 vite.config.ts 需先清缓存，见 17.8）
WB_E2E=1 npm run dev > .workbuddy/e2e.log 2>&1 &
# 2) 另起 Tauri，跳过 beforeDevCommand，复用上面已就绪的 Vite
npx tauri dev --config '{"build":{"beforeDevCommand":""}}' > .workbuddy/tauri-dev.log 2>&1 &
# 3) 读结果 —— 别手工 grep 分块，用现成解析器
python scripts/probe-report.py .workbuddy/e2e.log
```

覆盖：侧边栏分组/入口、顶部栏、Ctrl+K 唤起+过滤+回车跳转、**设置页开关 → 侧边栏实时联动**、主题快切、
设置-存储页（根目录 + 固定相对布局 + 密钥状态与导出/导入入口 + 真点一次「立即备份」并清理）、
跨机导入向导（入口 / 弹窗骨架 / 可关闭 / 三个只读命令已注册）、迁移拒绝规则文案。探针只在 dev 阶段按 `WB_E2E=1` 注入，
**不进生产构建**，也不改动 `src/`；跑完会自动复原它改过的设置（如 `hidden_modules`）。新增交互请在该文件补断言。

🔴 **报告是分块上报的**：断言一多，整包 `encodeURIComponent` 塞进查询串会超过 Node 的请求头上限，
服务端直接回 **HTTP 431**，表现为「探针一条都没回报」。因此报告按 800 个**码点**切片，
每块单独 `encodeURIComponent`，发成 `/__e2e?c=<i>/<n>&d=<片段>`。

- ⛔ **必须切「原始 JSON」再逐块编码**。反过来（先编码再切片）会让某块以半个 `%E5` 结尾，
  Vite 内部 `decodeURI(req.url)` 抛 `Internal server error: URI malformed`，
  日志里一片 500 —— 数据其实没丢，但排查时极具误导性。
- 切码点（`Array.from`）而不是 `slice`，是为了不劈开代理对（emoji 会劈成孤立代理，`encodeURIComponent` 直接抛）。
- 解析：**用 `scripts/probe-report.py`**（把各块 `unquote` 后按序拼接再一次性 `json.loads`，
  顺带列出失败明细与全部断言清单）。手工 grep 只会看到一堆 `%E4`，且很容易把「缺块」误读成「通过」。
  该脚本会显式报出**缺失的块号**——缺块时拿到的 JSON 一定是残的，绝不能当结论。
  多个 `c=1/n` 轮次只取**最后一轮**（整页重载会重跑）。

> ⚠️ 探针脚本改完不会触发 HMR（它是经 `transformIndexHtml` 注入的，不在模块图里）。
> 想立刻重跑可以 `touch index.html` 触发整页重载 —— 但**别在刚改过 `src/` 之后立刻这么干**：
> 整页重载撞上 Vite 的模块失效窗口，可能出现「模块注册表少一个模块」的连锁假失败
> （表现为侧边栏少项 + 设置页整页空白，实际代码没问题）。要结论可信就**重启 `dev:app`**。

> ⚠️ 探针开头以「数据中心配置按钮出现」判定**应用挂载完成**，而不是只等 `<nav>` 存在：
> `<nav>` 可能在模块注册表就绪前就渲染出来，早读一次会让后面几十条断言连锁假失败。

### 17.8 坑：改 `vite.config.ts` 会触发批量删除保护

改动 Vite 配置后 Vite 会「Re-optimizing dependencies」，内部 `fs.rm(node_modules/.vite/deps)`（数十项）
命中本机批量删除保护：

```
Error: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":62,"threshold":50,"scope":"turn",...}
error when starting dev server:
```

绕行：**先手动清掉缓存再启动**（`rm -rf node_modules/.vite`），Vite 只需新建、无需删除：

```bash
rm -rf node_modules/.vite && npm run dev
```

---

## 18. UI 平台层约定（本仓库补充，2026-10-04 落地）

> 阶段一收尾时补齐的「外壳 / 状态 / 交互」基础设施。新增页面与模块**必须复用**这些件，不要再各写一套。

### 18.1 应用外壳（`app/layout/`）

```text
AppLayout
├── Sidebar        模块清单驱动，分「主界面 / 工作模块 / 系统」三组，可收起（宽度 208 ↔ 56，默认收起）
└── (TopBar + main)
    ├── TopBar     统一模块 header：模块名（加粗）+ 功能描述（小一号）/ 模块动作槽 / 命令面板 / 主题快切
    └── main       overflow-auto，页面内容在此滚动
```

- 🔴 **页面不再自带标题栏**：内层 `PageHeader`（`mb-5 flex items-start …`）已删除，模块名与功能描述统一由外层 `TopBar` 呈现，以节省内容区高度。
- 🔴 **面包屑只保留「我在哪」**：左侧是 `模块图标 + 模块名（text-sm 加粗）` 与 `功能描述（text-xs，小一号，取 ModuleManifest.description）`。
  ⛔ 不要再加产品名前缀（`WorkBench` / `>` 之类）——面包屑不是品牌栏，路径层级目前也只有一级，加了纯属噪音。
- 页面内容统一用 `PageContainer`（最大宽 1440 + 统一内边距）；⛔ 不要再写 `p-4` + 裸 `<h1>`。
- 模块专属操作按钮不要塞回内容区，改经 `useHeaderActions` 注册到顶栏（见 §18.6）。
- ⚠️ 顶栏用 `data-tauri-drag-region` 实现「空白处拖窗」，**依赖 capability 里的
  `core:window:allow-start-dragging`**；缺失时点/拖空白处会报
  `window.start_dragging not allowed. Permissions associated with this command: core:window:allow-start-dragging`。
  窗口类命令（set-theme/minimize/maximize/…）都必须显式写进 `src-tauri/capabilities/default.json`。
- 被隐藏模块的当前页会被 `AppLayout` 重定向到安全落点（优先数据中心），并 `notify('info')`。

### 18.2 通知 / 空态 / 加载 / 错误（`core/shared/components/`）

| 需求 | 用什么 | 禁止 |
|---|---|---|
| 操作结果提示 | `notify(level, msg, opts?)`（模块级函数，非 React 也能调） | 各模块自建弹窗 |
| 列表为空 | `EmptyState` | dashed 裸占位 |
| 加载中 | `LoadingState` / `SkeletonCard` | 裸转圈、白屏 |
| 加载失败 | `ErrorState`（**必须给 onRetry**） | 只 `console.error` |
| 卡片容器 | `Card` | 自写边框圆角 |
| 开关（role=switch） | `Switch`（`checked / onChange / ariaLabel`） | 各页自写 switch 按钮 |
| 数据中心插件卡片 | `WidgetCard`（含阴影/悬浮/入场动画） | 自写阴影或动效 |

### 18.3 🔴 设置跨组件必须走 `useAppSetting`

`useAppSetting(key, fallback)` 内置**同 key 跨实例实时同步**（内部订阅表），并向外 `emit('setting.changed')`。
因此「设置页改 `hidden_modules` → 侧边栏立刻更新」是自动的。

- ✅ 读写应用设置：`const [v, setV] = useAppSetting<T>(key, fallback)`
- ⛔ 不要绕过它直接 `api.setSetting` 再自己 setState —— 那样其他组件收不到通知（这正是早期缺陷）。
- 需要非 React 场景感知设置变化：`eventBus.on(SETTING_CHANGED, ...)` 或组件内 `useEvent(...)`。
- ⚠️ 只读场景（如只关心 `hidden_modules` 的守卫）也走该 hook，不要自己 `api.getSetting`。

### 18.4 设计令牌必须「hex + `-rgb`」成对新增

`src/styles/tokens.css` 每个色令牌双写：`--x`（hex，供 CSS）与 `--x-rgb`（通道，供 Tailwind
生成 `rgb(var(--x-rgb) / <alpha-value>)`）。

- ✅ 新增令牌：两个变量一起加，并在 `tailwind.config.ts` 用 `token("<name>")` 挂载。
- ⛔ 只加 hex 会让 `bg-surface/60`、`ring-accent/30` 这类**透明度类静默失效**（哑类，不报错）。
- ✅ **阴影也走令牌**：`--shadow-card / --shadow-card-hover / --shadow-float`（明暗两套值），
  Tailwind 映射为 `shadow-card / shadow-card-hover / shadow-float`。组件只用语义类，
  深色下阴影自动加重，不要在组件里写死 `shadow-2xl` 或 rgba。

### 18.5 图标统一用 lucide

模块清单 `icon` 直接给 lucide 组件（`ModuleIcon` 类型只约束 `size` / `className`）。
Widget 清单 `icon` 同理（`WidgetIcon`）。⛔ 不要再写 `() => <span>▦</span>` 这类 emoji/字符占位图标。

### 18.6 模块头部动作槽（`app/layout/HeaderActions`）

页面没有内层标题栏，模块若需在**顶栏**放操作按钮：

```tsx
const actions = useMemo(() => <button onClick={...}>配置</button>, [依赖]);
useHeaderActions(actions); // 渲染到 TopBar 右侧，模块卸载时自动清空
```

- ⚠️ node 必须用 `useMemo` 保持引用稳定（否则每次渲染重复登记，触发无谓重渲染）。
- 动作槽与内容区解耦：切模块时旧动作自动移除，不会残留到下一个页面。

### 18.7 数据中心插件配置（`modules/data-center/`）

- **展示顺序**：唯一来源是布局引擎（`app_settings: layout:data-center`）。配置面板与网格拖拽都调用
  `useGridLayout` 的 `move()`，两者天然一致；`layout` 里含**已隐藏项**，重新开启可回到原位。
- **显示状态**：`plugins.enabled`（0 隐藏 / 1 显示），由配置面板开关切换，变更即落库。
- **插件参数**：`plugins.config`(JSON)，表单由 `WidgetManifest.settingsSchema` 驱动
  （text/number/boolean/select），输入 debounce 400ms 写库；支持「恢复默认」。
- **卡片视觉**：`WidgetCard` 统一外壳（图标徽标 + 名称头 + 阴影 + hover 上浮高光 + 入场动画
  `animate-card-in`）。新增 Widget 用 manifest 注册即可，不必改数据中心。

> ⚠️ 动画用 `backwards` 填充（非 `both`/`forwards`）：forward 填充会让动画的 `transform`
> 覆盖 hover 的 `-translate-y-0.5`，导致悬浮效果失效。

---

## 19. 系统托盘与「关闭到托盘」【设计文档未覆盖，本仓库补充】

> 桌面应用最容易被骂的体验：用户想「先收起来」，手却点在右上角 ✕，进程直接没了，
> 未保存的现场一起没。对策是把 ✕ 的语义降级为「收进托盘」，真退出只留在托盘菜单里。

实现：`crates/wb-runtime/src/tray.rs`（Rust 侧全权处理，前端不需要任何权限声明）。

- **托盘图标**：`TrayIconBuilder::with_id("main-tray")`，图标复用 `app.default_window_icon()`，
  ⛔ 不要再引 `image-png` / `image-ico` 特性——编译期已内嵌解码好的 `Image`，直接用即可。
- **交互**：`show_menu_on_left_click(false)` + `TrayIconEvent::Click{Left, Up}` → 唤回窗口；
  右键菜单三项：`显示主窗口` / `隐藏到托盘` / `退出 WorkBench`。
- **关闭拦截**（`lib.rs` 的 `on_window_event`）：
  ```rust
  tauri::WindowEvent::CloseRequested { api, .. } => {
      if !tray::is_quitting() && tray::close_to_tray_enabled(&h) {
          api.prevent_close();
          tray::hide_main(&h);
      }
  }
  ```
- 🔴 **必须留一个「主动退出」标志**（`tray::QUITTING`）。没有它，托盘菜单里的 `app.exit(0)`
  也会被自己这套拦截逻辑拦下 —— 表现是**程序永远关不掉**。凡是要走真退出的路径
  （托盘菜单 / `commands::app_quit`）都必须先 `tray::mark_quitting()`。
- **设置项**：`app_settings: close_to_tray`（JSON `true`/`false`，默认 `true`）。
  Rust 侧读不到时**一律按 `true`**：安全默认，宁可多点一次托盘退出，也别误点 ✕ 丢现场。
- **与单实例配合**：窗口藏在托盘时再启动一次程序，single-instance 回调会 `show + unminimize + set_focus`
  把已有窗口唤回，不会开出第二个进程。
- **前端入口**：设置 → 通用（开关 + 「立即隐藏到托盘」）；命令 `app_hide_to_tray` / `app_quit`。

---

## 20. 数据目录与存储位置【设计文档未覆盖，本仓库补充】

> 「我的数据库到底存在哪？能不能放到 D 盘？」——必须有明确的、可改的答案。
> 🔴 完整的存储与目录模型见**设计文档 §7**（本文只记本仓库的落地约定）。

实现：`crates/wb-db/src/storage.rs`（路径解析）+ `crates/wb-runtime/src/commands/storage.rs`（命令层）。

### 20.1 根目录 + 固定相对布局

**用户唯一可配项 = 数据根目录**；其下一切按固定相对路径展开（设计文档 §7.1）：

```
<数据根目录>/
├─ workbench.db      # 主库
├─ media/            # 媒体文件（导入式；引用式只存外部路径）
├─ backup/           # 备份产物
├─ keys/             # 密钥用户侧文件（.wbkey / 导出备份）
└─ logs/             # 运行日志
```

- ⛔ 子目录名与拼接**只允许出现在 `storage.rs`**：`db_path / logs_dir / keys_dir / backup_dir / media_dir / media_module_dir`。
  别处一律调这些函数，不许手拼 `root.join("media")`。
- 子目录**按需惰性创建**（第一次用到才 `create_dir_all`），不在启动时铺一堆空目录。
- 子目录结构**不可自定义** —— 这正是「只改一个地方」的代价与收益。

### 20.2 行为约定

- **默认目录**：`app_data_dir()/WorkBench`（Windows 即 `%APPDATA%/com.workbench.app/WorkBench`）。
- **引导配置**：`<默认目录>/storage.json`，形如 `{ "dataDir": "D:\\WorkBenchData" }`；
  空串 / 缺省 / 文件损坏 → 回落默认目录。
- 🔴 **引导文件必须留在默认目录**，不能跟着自定义目录走：否则用户一改路径，下次启动就找不到这份配置，
  等于失去了回退能力（这正是「配置指向自己」的经典死锁）。
- **生效时机**：改目录**重启后生效**（数据库连接与日志目录都在 `setup` 阶段就定下了，无法热切换）。
  命令返回后设置页用 `pendingDir != runningDir` 判定并提示「需重启」。
- **搬迁策略**（`storage_set_dir(dir, migrate)`）：先 `PRAGMA wal_checkpoint(TRUNCATE)` 把 WAL 归并进主库，
  再复制 `.db` / `-wal` / `-shm` 三件套。⛔ **只复制不删除**，旧目录原样保留，用户可自行清理或回退；
  ⛔ 目标已存在同名库时**跳过复制**（覆盖 = 不可逆数据毁坏）。
- **可写性预检**：写 `storage.json` 之前先建目录并写一个探针文件验证可写，
  失败立刻报错，别等重启后才发现写不进去。
- **命令**：
  - `storage_info` —— 根目录 / 主库路径与大小 / 是否自定义 / 待生效目录 / **固定子目录清单（含占用）**；
  - `storage_set_dir`、`storage_open_dir`（打开目录走 `explorer` / `open` / `xdg-open`，不引额外插件）。
- ⚠️ `app_settings` 里的 `db_path` 不再使用（历史写法）；路径的**唯一来源**是 `storage.json`，
  避免两处配置互相打架。
- 🟡 待办：便携模式（exe 同级 `portable/`）、一键/自动备份（用 `storage::backup_dir`）。

---

## 21. 平台复用：新项目如何开工【2026-10-05 落地】

> 本仓库是**平台 / 框架**（§3 规约 7）。新项目不从零起 —— 复用平台能力，只换一份应用壳。

### 21.1 结构：一个 Cargo workspace + 一个前端工程

```
<仓库根>/Cargo.toml         # [workspace] members = ["crates/wb-db", "crates/wb-runtime", "src-tauri"]
├─ crates/wb-db             # 平台能力：数据「在哪 / 怎么存」
├─ crates/wb-runtime        # 平台能力：能做什么
└─ src-tauri/               # 应用壳（每个项目一份）
```

- 🔴 **根 `Cargo.toml` 是 workspace 的唯一出处**：`crates/*` 与 `src-tauri` 都是成员，
  所以在仓库根跑 `cargo check` / `cargo test` 就等于跑全平台。
- ⚠️ **构建产物路径随之改变**：目标目录是 **`<仓库根>/target/`**，不再是 `src-tauri/target/`。
  NSIS 安装包因此落在 `target/release/bundle/nsis/WorkBench_<版本>_x64-setup.exe`。
  `.gitignore` 必须忽略 `/target`（旧的 `src-tauri/target/` 可留着兼容）。

### 21.2 依赖方向（唯一允许的方向）

```
src-tauri  →  wb-runtime  →  wb-db
（应用壳）     （平台能力）     （数据位置与连接）
```

⛔ 反向依赖一律不允许。它**不会报编译错误**，只会在你想复用平台时才发现已经粘死。
🔴 扩展平台时自查一句：「这段代码与业务有关吗？」有关 → 它属于 `src/modules/`，不属于 `crates/`。

### 21.3 新项目要改的东西（全在应用壳里）

| 位置 | 改什么 |
|---|---|
| `src-tauri/tauri.conf.json` | `productName` / `identifier` / `version` / 图标 / NSIS 文案 |
| `src-tauri/capabilities/default.json` | 按需增删原生权限 |
| `src-tauri/icons/`、`EULA.txt` | 换成该项目的图标与许可 |
| `src-tauri/src/lib.rs` | `invoke_handler!` 挂哪些命令（平台命令从 `wb-runtime` 引） |
| `src/modules/<id>/` | 业务模块，自注册即可（规约 2） |
| `db/migrations/` | **追加**该项目的表（如 `proj_*`），⛔ 不动平台三表 |

### 21.4 🔴 跨 crate 命令的坑：**函数与命令宏必须同在 crate 根**

`#[tauri::command]` 作用在 `pub fn` 上时，除了函数本身还会生成一个
**`#[macro_export]` 的 `__cmd__<函数名>` 宏** —— `generate_handler!` 正是靠它派发请求的。
写 `wb_runtime::get_setting` 时，它会被展开成：

```rust
wb_runtime::__cmd__get_setting!(wb_runtime::get_setting, invoke)
```

**两条路径都得解析得到**。而 `#[macro_export]` 只把宏放在**定义它的那个 crate 的根**，
所以 `commands::storage::storage_info` 这类路径必然**找不到宏**。

⛔ 试过的两条死路（都报 `cannot determine resolution for the import`）：
在命令模块里 `pub use crate::{__cmd__xxx}`（绝对路径）或 `pub use super::super::{__cmd__xxx}`（相对路径）——
**macro-expanded 的 `macro_export` 宏在同一个 crate 内根本没法被 `use` 引用**（rust issue #52234）。

✅ 唯一可行：**让函数也待在 crate 根**，与宏同处一地。

```rust
// crates/wb-runtime/src/lib.rs
pub use commands::{
    app_quit, get_setting, set_setting, list_plugins, update_plugin, /* … */
};
pub use commands::storage::{storage_info, storage_open_dir, storage_set_dir};
```

应用侧**写完整 crate 路径**（命令名只取路径末段，IPC 名不受影响）：

```rust
.invoke_handler(tauri::generate_handler![
    wb_runtime::get_setting,
    wb_runtime::storage_info,
    // …
])
```

⚠️ 别写成 `use wb_runtime::get_setting;` 再用短名 —— `use` 只把**函数**带进来，
那条 `__cmd__` 宏不在作用域里，照样报「找不到宏」。

📌 新增平台命令时：在 `crates/wb-runtime/src/commands/**` 里照常写 `#[tauri::command] pub fn`，
再到 `crates/wb-runtime/src/lib.rs` 的根再导出清单里**顺手补一行**。

### 21.5 新增依赖的落点

- 只有平台能力需要的（`aes-gcm` / `argon2` / `keyring` / `rusqlite` …）→ 写进 **`crates/*/Cargo.toml`**。
- 只有应用壳需要的（`tauri-plugin-*` 等）→ 写进 `src-tauri/Cargo.toml`。
- ⛔ 别把业务依赖塞进平台 crate —— 那等于替所有未来项目做了决定。

#### 特例：`indexmap`（⛔ 别删、别升级）

它**不是**任何 crate 真正要用的依赖，而是为 **`schemars 0.8.22`** 钉住的：
`schemars` 里写着 `pub type Map<K, V> = indexmap::IndexMap<K, V>`，只有 **indexmap 1.8.2 + 启用 `std`**
时 `S` 才有 `= RandomState` 默认参数，否则报「struct takes 3 generic arguments but 2 were supplied」。

- 版本与特性写在**根 `Cargo.toml`** 的 `[workspace.dependencies]`（`=1.8.2`, `features = ["std"]`）。
- 引入点在 **`crates/wb-db` 的 `[build-dependencies]`**，⚠️ **不能**写进 `[dependencies]`：
  `schemars` 属于 proc-macro 的 **host 依赖图**，而 `resolver = "2"` 下 target 与 host 的特性
  **不统一** —— 实测挂在 `[dependencies]` 里完全无效。放在最下游的 `wb-db` 是为了让
  `cargo check -p wb-db` / `-p wb-runtime` / `-p workbench` 这类**子集构建**也带上它。

#### 特例：`[profile.release]` 必须在根

cargo 会**忽略非根包**里的 profile 定义
（`warning: profiles for the non root package will be ignored`）。
留在 `src-tauri/Cargo.toml` 里等于 `opt-level="z"` / `lto` / `codegen-units=1` / `strip` / `panic="abort"`
**全部失效**，安装包会明显变大。

### 21.6 🔴 平台与业务的提交纪律

平台更新能不能回流到各个项目，**全看提交有没有按目录分开**。

**边界表**（新项目的继承策略）：

| 目录 | 归属 | 新项目怎么办 |
|---|---|---|
| `crates/wb-db/**`、`crates/wb-runtime/**` | 🟦 平台 | ✅ 原样继承 |
| `src/core/**`、`src/app/**` | 🟦 平台 | ✅ 原样继承 |
| `src/modules/settings/**`、`src/modules/data-center/**` | 🟦 平台（基础设施模块） | ✅ 继承，可按需裁剪 |
| 根 `Cargo.toml` / `.gitignore` / `.gitattributes` / `scripts/**` | 🟦 平台 | ✅ 继承 |
| `src-tauri/**` | 🟨 应用壳 | ⚠️ 继承后**必改**（产品名 / identifier / 图标 / 命令清单） |
| `src/modules/<业务>/**`、`src/widgets/<业务>/**` | 🟧 业务 | ⛔ 不带过去 |
| 业务表迁移（`00xx_<业务>.sql`） | 🟧 业务 | ⛔ 不带过去 |

- 🔴 **平台改动必须独立成 commit，不与业务改动混在一起。**
  判据：`git show --stat <commit>` 里只出现 🟦 那几行的路径。
- 🔴 **为什么**：项目吸收平台更新靠 `git cherry-pick <平台提交>`。平台改动一旦和业务改动
  混进同一个提交，就得手工剥离 —— 现实中几乎没人这么干，结果就是「干脆不升级」，
  平台在各项目里各自漂移，最后彻底无法合并。**这条纪律一破，模板复用就等于没有。**
- 📌 提交信息前缀：平台改动用 `refactor(platform):` / `fix(platform):` / `feat(platform):`；
  业务改动用 `feat(<模块>):`。看前缀就知道能不能 cherry-pick。
- ⛔ 平台目录里不许出现业务名词（§3 规约 7）—— 与提交纪律是**同一件事的两面**：
  目录分不清，提交自然也分不清。

### 21.7 版本与分支策略

- ⛔ **不要**给每个项目开一条长期分支。业务模块要**同时存在**（数据中心插件模型就是多模块共存），
  分支之间互斥、合并必冲突；平台修一个 bug 还得在 N 个分支里各改一遍。
- ✅ 正确的做法：**本仓库 = 平台仓库**；新项目**另开仓库**、用**模板**生成，靠 remote 回流。

| 动作 | 做法 |
|---|---|
| 标记一个可复用版本 | `git tag -a v0.1.1 -m "…"`；`main` 始终保持在可发布状态 |
| 新项目开工 | `gh repo create <proj> --template YMT-TK/WorkBench --private` |
| 接入平台上游 | `git remote add upstream ssh://git@ssh.github.com:443/YMT-TK/WorkBench.git` |
| 吸收平台更新 | `git fetch upstream && git merge upstream/main` |
| 只挑某个平台修复 | `git cherry-pick <平台 commit>`（靠 §21.6 的前缀识别） |

- 🔴 **每个新项目要记下自己基于哪个平台 tag**（如 `v0.1.1`）—— 平台升级才不会意外破坏已有项目。
  给旧项目补平台修复走 `release/0.1` 分支 hotfix，再往前 merge，而不是直接在旧的线上改。
- ⚠️ **新仓库 clone 后，本机的 `core.sshCommand` 不跟着走**（443 + 自定义 `known_hosts` 属本地配置，
  不进版本库）→ 新项目要重设一次。
- 📌 **暂时不抽私有包**：Rust 侧 Cargo 虽原生支持 git 依赖（`{ git = "…", tag = "v0.1.1" }`，无需私有 registry），
  但要先把 `crates/` 拆成独立仓库，代价是改一个平台 API 得跨两个仓库提交两次。
  前端 UI 迭代频率远高于 Rust，打包会变成「每改一处都发版」。
  **判据：等有第 2~3 个项目、且平台 API 稳定了再抽 —— 只有一个消费者时，拆开只剩摩擦。**
