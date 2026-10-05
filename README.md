# WorkBench · 插件化桌面工作台

一个基于 **Tauri 2** 的本地优先（local-first）单机桌面工作台。设计上有两条主线：

- **两层插件模型** —— 平台只管外壳、数据与约定，功能以「轻量 Widget 卡片」和「重量功能模块」两种形态挂载进来；
- **数据完全可托管、也可安全带走** —— 全部内容收在一个「数据根目录」下，密钥与数据分离，换机靠「备份包 + 口令加密的密钥文件」两样东西复刻。

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
| 加密 | AES-256-GCM 字段级加密，主密钥托管在操作系统凭据库 |
| 口令派生 | Argon2id（用于 `.wbkey` 可移植密钥文件） |
| 系统对话框 | `tauri-plugin-dialog`（跨机导入选文件 / 目录） |

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
- 默认落点唯一来源 `getHomeModuleId()`（`pinned → 第一个 system → 第一个`），路由 index/404、隐藏模块安全落点、面包屑兜底都读它

---

## 数据放在哪：一个根目录 + 固定相对布局

**用户唯一可配置的就是「数据根目录」**，其下所有内容按固定相对路径自动跟随：

```
<数据根目录>/
├─ workbench.db      # 主库（WAL 模式另生成 -wal / -shm）
├─ media/            # 媒体文件（导入式；引用式只存外部路径）
│   └─ audio/        #   音频模块
├─ backup/           # 备份快照（手动 + 自动，见下）
├─ keys/             # 密钥相关的用户侧文件（.wbkey）
└─ logs/             # 运行日志（workbench.log，超 5MB 滚动，保留最近 10 份）
```

两个**有意不跟随**根目录的例外（不是遗漏）：

| 文件 | 实际位置 | 为什么不动 |
|---|---|---|
| `storage.json` | **默认目录**（`app_data_dir/WorkBench`） | 它是「根目录指向哪」的**引导配置**；跟着根目录走就变成「配置指向自己」，一改路径永久失联 |
| `window.json` | 同上 | 窗口几何描述的是**这台机器 + 这块屏**，不是这份数据；换盘搬迁不该把窗口尺寸一起搬走 |

- 子目录**惰性创建**（第一次用到才 `create_dir_all`），不在启动时无脑铺一堆空目录。
- 🔴 子目录名与拼接**只允许出现在 `src-tauri/src/storage.rs`**；其余代码一律调
  `db_path` / `media_dir` / `backup_dir` / `keys_dir` / `logs_dir`（含日志目录，见下）。
- ⚠️ 改根目录**重启后生效**——数据库连接在 `setup` 阶段就打开了，无法热切换；前端据 `pendingDir != runningDir` 提示「需重启」。
- 日志目录同样跟随根目录（`lib.rs::log_dir` → `storage::logs_dir`），所以**改根目录后日志也要重启才跟着走**。

---

## 密钥与安全：锁与钥匙分离

威胁模型是「**设备丢失 / 文件被拷走后泄露**」，不是多用户并发。设计取向：数据可以被拷走，但没有钥匙就解不开。

- **加密**：AES-256-GCM **字段级**（会员密码 / Git Token / API Key 等经 `secure_set_setting` 写入的值），
  密文格式 `base64(nonce ‖ ciphertext)`。明文与主密钥都不出 Rust 侧。
- **媒体文件不加密**（体积大、无密级），也不进 SQLite。
- **主密钥 K**（32 字节随机）存 **Windows 凭据管理器**（`WorkBench` / `master-key`，DPAPI）。
  ⛔ 绝不明文入库、绝不写进明文配置文件。
- 凭据库**不是保险箱**：管理员**重置**密码、重装系统 / 换机、手工删除、清理/安全软件「清理凭据」都会让它失效。
  所以必须有冗余副本 —— 这正是 `.wbkey` 存在的第一个理由。

### `.wbkey`：口令加密的可移植密钥文件

一个机制同时解决两件事：**凭据库失效时的冗余备份** + **跨机迁移的载体**。纯文本格式，便于人工辨认与传递：

```
WBKEY/1
salt:    <base64 · 16 字节>
nonce:   <base64 · 12 字节>
mem:     65536            # Argon2id m(KiB)
time:    3                # Argon2id t
para:    1                # Argon2id p
data:    <base64 · AES-256-GCM 密文>
fp:      <hex · 8 字节，明文指纹，用于自校验>
created: <unix 秒>
```

```
wrapping_key = Argon2id(passphrase, salt, m=64MiB, t=3, p=1) → 32 字节
data         = AES-256-GCM(wrapping_key, nonce, K)
fp           = SHA256(K)[0..8]        # 明文存，泄不出 K
```

- 🔴 **KDF 参数写进文件头**而不是写死在校验端：日后提高 Argon2 强度不会让旧文件失效。
- 文件被拷走，**没有口令依然解不开**；口令足够强时其安全强度不低于凭据库。
- ⛔ **不提供主密钥明文导出**：明文导出＝把锁和钥匙放同一个抽屉，直接否掉整个威胁模型。
- 导出/导入只发生在设置页，且**必须由用户提供口令**。

### 密钥指纹：防「换机静默作废老数据」🔴

`app_settings: crypto.key_fingerprint = SHA256(K)[0..8]`（明文 hex，泄不出 K）。启动时按三态判定：

| 库中指纹 | 凭据库密钥 | 判定 | 行为 |
|---|---|---|---|
| 无 | 无 | 首次运行 | 正常；**首次写入敏感字段时**才显式建钥并落指纹 |
| 无 | 有 | 新库 + 旧密钥 | 采用已有 K，补记指纹 |
| 有 | 一致 | 正常 | 放行 |
| 有 | **不一致** | 密钥不匹配 | ⛔ **拒绝加密/解密**，提示导入正确密钥 |
| 有 | **无** | 密钥缺失 | ⛔ **拒绝生成新密钥**，提示「此数据来自另一台机器，请先导入密钥」 |

最后一行是关键：换成另一台机器打开旧库时，本机凭据库里没有 K —— 若此刻静默 `get_or_create_key()`，
会生成一把全新密钥 K′，把旧机器加过的密文**全部作废**，并变成半新半旧的乱局。
为此 `crypto` 只保留两条路径：`load_key()`（**只读**，缺失返回 `None`）与 `create_and_store_key()`（**显式**创建），
不再有「看一眼就顺手创建」的接口。

⛔ **敏感字段（token / 密码 / 主密钥 / 口令）绝不写日志** —— 包括调试日志、崩溃日志与错误提示的技术细节。

---

## 备份 · 迁移 · 跨机复刻

这三个词指向三件不同的事，别混：

| 概念 | 是什么 | 入口 |
|---|---|---|
| **备份** | 数据快照；**产物同时就是跨机载体**，不另造「导出包」 | 设置 → 存储 → ③ 备份与恢复 |
| **迁移** | **同一台机器**换数据根目录（不是跨机功能） | 设置 → 存储 → ① 数据位置 |
| **跨机复刻** | 公司电脑 → 家里笔记本 | 设置 → 存储 → ④ 跨机导入 |

### 备份 = 一个目录（不是压缩包）

```
<根目录>/backup/backup_<YYYYMMDD_HHMMSS>/
├─ workbench.db          # 已 wal_checkpoint(TRUNCATE) 归并 WAL 的完整库
├─ workbench.db-wal      # 归并后通常为空，流程上仍带上
├─ media/                # 递归复制
└─ manifest.json         # WBBACKUP/1：时间 / 源目录 / db 哈希 / media 文件数 / **密钥指纹**
```

选目录而不是 zip：不引额外依赖、用户可以直接打开看、也能手工拷贝。先在 `.staging-*` 临时目录里建好再「转正」，
中途失败不留半个快照；时间戳撞车加序号，**绝不覆盖已有快照**；每个文件复制后回读比对 SHA-256。

- **自动备份**：`backup.auto = off | on_start` + 保留份数 `backup.keep`（默认 5），启动时在后台线程执行并清理最老的。
  `prerestore_` 快照不参与自动清理。
- **恢复**三步，顺序不可换：
  1. **校验密钥指纹**：manifest 里的 `key_fingerprint` 与本机比对，不匹配**直接拒绝**并提示导入对应 `.wbkey`；
  2. **先留退路**：自动创建一个 `prerestore_<时间戳>` 快照，保住「恢复前」的状态；
  3. **就位**：主库写入 `workbench.db.restore-pending`（**不直接覆盖运行中的库**），返回 `needRestart = true`。
     🔴 由**启动早期、无任何连接时**先删 `-wal`/`-shm` 再换库 —— 否则旧 WAL 回放到新库就是库损坏。
- ⚠️ **备份与数据在同一块盘**（都在根目录下），盘损坏 / 目录误删会一起没。设置页明确提示把快照复制到 U 盘或网盘。
- 🔴 **备份包不含密钥**（密钥在 OS 凭据库，从没进过数据目录）。

### 迁移（同一台机器换数据根目录）

预检（绝对路径 + 写可写性探针）→ 复制主库三件套 + `media/` + `keys/` 并逐文件回读比对 → 重指向。
任一失败**整体回滚**（只删本次新建的文件，目标目录原有文件一个不碰）且**不写 `storage.json`**——半份数据比不搬家更糟。

- 🔴 **目标目录里已有 `workbench.db` → 一律拒绝**，且拒绝发生在**任何写操作之前**：连可写性探针都不写，目标目录零痕迹。
  旧实现用 `overwrite=false` 静默跳过同名文件却照样重指向，表现是「提示已复制并通过校验，重启后打开的却是目标里的旧库」——
  这种**假成功**比报错更有欺骗性，宁可拒绝。
- 判据是「**有没有主库**」而不是「目录是否非空」：目录里只有 `media/` / `keys/` 时没有歧义，照常可搬。
- ⚪ **不做「在新目录初始化空库」**：点「迁移」的语义是**搬数据**，悄悄初始化一份空库会让人以为数据丢了。
- 只复制不删除，旧目录原样保留，用户可自行清理或回退。

### 跨机复刻：两样东西 + 固定顺序

用户手上必须是**两样**：备份包目录 + `.wbkey`（备份包不含密钥，缺一不可）。
顺序**由程序强制**，不靠人记：

| # | 动作 | 命令 | 副作用 |
|---|---|---|---|
| 1 | 读外部备份包：它要求哪把钥匙、装了什么 | `import_inspect` | ✅ 只读 |
| 2 | 只读 `.wbkey` 明文头（`fp` / `created`）→ 判断文件选对没有 | `wbkey_inspect` | ✅ 只读，**不需口令** |
| 3 | 完整预检：解密钥 + 比对指纹 + 给出判定 | `import_precheck` | ✅ 只读 |
| 4 | 装密钥（与库中指纹冲突时需显式勾选确认） | `key_import_wbkey(path, pass, replace)` | 写凭据库 |
| 5 | 校验复制备份包到 `backup/<id>` 并登记 | `import_adopt` | 写 `backup/` |
| 6 | 恢复数据（留 `prerestore_` 快照 + 写待替换文件） | `backup_restore` | 待重启 |

- 🔴 **先只读预检、再动手**：若先登记再发现钥匙不对，用户磁盘上会多出一份**永远解不开**的备份包，还得自己去删。
  只读预检把「失败」的代价压到零。
- 🔴 **第 2 步不需要口令**：`fp` / `created` 在 `.wbkey` 里本来就是明文，所以「选错文件」不用先输一遍口令才知道。
- **判定四态**：

  | 判定 | 含义 | 界面行为 |
  |---|---|---|
  | `no_key_needed` | 备份包没有声明加密字段 | 放行，跳过密钥步 |
  | `ready` | 指纹匹配、本机无冲突密钥 | 放行 |
  | `replaces_local_key` | 匹配，但本机**库中指纹**是另一把 | **必须勾选确认**才能继续 |
  | `mismatch` | 这个密钥不是这份数据用的 | **拦住**，只允许回上一步换文件 |

- 🔴 **硬冲突的判据是「库中指纹」而非凭据库里那把钥匙**：有指纹 = 本机已有数据锁在旧密钥下，替换就是作废它们；
  **没有**指纹时（凭据库里躺着一把孤儿密钥）只给软提醒、不阻断。
- 🔴 **`replace` 默认 false**：普通「导入密钥」入口永远传 false，因此**永远不会静默顶掉一把在用的钥匙**；
  只有本向导在用户勾选确认后才传 true。
- ⛔ **不做「就地恢复、不登记」**：源可能是 U 盘，拔了就没了。复制进 `backup/` 之后它才是一份本机资产，
  也才会出现在备份列表里、被保留策略管到。
- ⛔ **「立即备份」不顺手导出 `.wbkey`**：导出必须由用户提供口令。若备份按钮自动带出一份密钥文件，
  等于把锁和日常快照塞进同一个抽屉，也会把「设口令」这一环悄悄跳过。两样东西**分开生成、一起带走**。
- 选文件走**系统对话框**（从 U 盘 / 下载目录里挑东西时，手输完整路径是最容易出错的一环）；
  界面**直接列出「换机要带走的两个位置」**，不让人去各段里自己找路径。

---

## 已实现的平台能力

**系统级底座**

- 单实例保护：再次启动只会唤出已有窗口，不会开第二个进程
- 窗口尺寸 / 位置持久化，含「最小化哨兵坐标」与「屏幕外坐标」防护（跨多显示器校验重叠面积）
- 应用日志：`tauri-plugin-log` 落盘 + 轮转，目录跟随数据根目录
- SQLite 单写者（`Mutex<Connection>`）+ WAL + `busy_timeout`，结构变更只追加 migration
- 字段级加密 + 凭据库托管 + 密钥指纹三态防护 + `.wbkey` 可移植备份

**数据管理**

- 一个数据根目录统管 db / media / backup / keys / logs，子目录惰性创建
- 备份快照（手动 + 启动时自动）、恢复（指纹校验 + 退路快照 + 待替换文件）
- 同机迁移向导（SHA-256 校验 + 整体回滚 + 拒绝已含主库的目标目录）
- 跨机导入向导（只读预检 → 装密钥 → 登记备份包 → 恢复，顺序由程序强制）

**桌面行为**

- **系统托盘**：右键菜单（显示 / 隐藏 / 退出），左键单击直接唤回窗口
- **关闭到托盘**：点右上角 ✕ 默认只把窗口收进托盘，真退出只在托盘菜单（可在设置中关闭）

**界面与交互**

- 主题：浅色 / 深色 / 跟随系统，令牌驱动
- 命令面板：`Ctrl+K` 快速跳转任意模块
- 侧边栏：按「主界面 / 工作模块 / 系统」分组，可收起，隐藏模块时内容区自动跳安全落点
- 统一外层 header：面包屑呈现「模块名（加粗）+ 功能描述」，模块专属操作注册到顶栏动作槽
- 数据中心：插件卡片支持拖拽排序、显示开关、参数配置，全部落库
- 设置模块五个子页（见下），存储页四段

---

## 目录结构

```
src/                          # 前端
├─ app/                       # 应用外壳
│  ├─ registry.ts             #   模块注册表 + 默认落点 getHomeModuleId()
│  ├─ router.tsx              #   路由表（由注册表生成）
│  ├─ ErrorBoundary.tsx       #   渲染错误兜底
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
│  ├─ settings/               #   设置：壳 + panels/**（见下）
│  ├─ project-manager/        #   项目管理（占位空壳，阶段二）
│  └─ audio-manager/          #   音频管理（占位空壳，阶段二）
├─ widgets/                   # Widget 卡片插件（轻插件）
│  ├─ index.ts                #   自动装载（import.meta.glob）
│  └─ weather/                #   天气卡片（插件模型验证样板）
└─ styles/                    # 设计令牌（tokens.css / global.css）

src/modules/settings/         # 设置模块（视图与请求编排分开）
├─ Settings.tsx               #   壳：子页清单 + 分发（~86 行）
├─ components/                #   SettingRow / SectionTitle / Note
└─ panels/                    #   每个子页一个文件
   ├─ AppearancePanel.tsx     #   ① 外观
   ├─ GeneralPanel.tsx        #   ② 通用
   ├─ ModulesPanel.tsx        #   ④ 模块
   ├─ AboutPanel.tsx          #   ⑤ 关于
   └─ storage/                #   ③ 存储（四段 + 运行日志条目）
      ├─ StoragePanel.tsx     #     组合与加载
      ├─ DataLocationPanel.tsx#     ① 数据位置 + 迁移
      ├─ KeySecurityPanel.tsx #     ② 密钥与安全
      ├─ BackupPanel.tsx      #     ③ 备份与恢复
      ├─ ImportPanel.tsx      #     ④ 跨机导入（入口）
      ├─ ImportWizard.tsx     #        向导状态与请求编排
      ├─ ImportStageViews.tsx #        向导四阶段视图
      ├─ useStorageData.ts    #     统一加载 + 单一 reload
      └─ keyState.ts          #     密钥三态 → 界面横幅

src-tauri/src/                # Rust 后端
├─ lib.rs                     #   应用入口：插件注册、setup、命令注册
├─ commands/                  #   前端唯一可调用的命令层
│  ├─ mod.rs                  #     设置 / 插件 / 密钥命令
│  ├─ storage.rs              #     数据根目录与迁移编排
│  ├─ migrate.rs              #     迁移内核（拒绝规则 + 回滚）
│  ├─ backup.rs               #     备份 / 恢复 / 快照列表
│  └─ transfer.rs             #     跨机导入 4 个命令
├─ db/                        #   SQLite 连接 + migration 执行器 + migrations/
├─ crypto/                    #   AES-256-GCM + OS 凭据库 + .wbkey
├─ storage.rs                 #   根目录解析 + 相对布局（唯一定义处）
├─ fsutil.rs                  #   带校验复制（复制后回读比对 SHA-256）+ 回滚清单
├─ backup.rs                  #   快照内核：目录结构 + manifest（WBBACKUP/1）
├─ transfer.rs                #   跨机导入内核：预检判定 + 规范化 + 登记
├─ tray.rs                    #   系统托盘 +「关闭到托盘」
└─ window_state.rs            #   窗口尺寸/位置持久化（含坏坐标防护）

scripts/
├─ dev-app.mjs                # 真机一键启动器（绕开 tauri dev 的管道问题）
├─ e2e-probe.js               # dev 期端到端探针（真 WebView 内自动点击验证）
├─ probe-report.py            # 解析探针分块报告（先报缺块，再列断言）
├─ ai-icons-to-ico.py         # AI 生图 PNG → 多尺寸 .ico（裁边 / 去白底圆角 / 预览图）
├─ gen-nsis-assets.py         # 生成 NSIS 所需的 24bit BMP 位图（header 150×57 / sidebar 164×314）
├─ make-icon-compare.py       # 旧 / 新图标对比图（含小尺寸可读性行）
└─ gen-icons.py               # 纯 Python 手绘图标生成（零第三方依赖，AI 生图之前的方案）
```

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
WB_E2E=1 npm run dev:app > .workbuddy/e2e.log 2>&1
python scripts/probe-report.py .workbuddy/e2e.log
```

启动后探针会在真实 WebView 中自动点击走一遍关键路径（面包屑、侧边栏联动、命令面板、
插件配置开关、存储页各段读出真实路径、备份增删、迁移拒绝文案、跨机导入向导四段 UI 等），
把断言报告**分块**回传到 dev server 日志，再由 `probe-report.py` 解析（它会先报「缺块」再列断言，
自动只取最后一轮，避免把残缺的 JSON 当成结论）。

**编译期与前端构建发现不了的问题，只有真机运行才会暴露**——交互改动请务必跑一遍，新增交互请补断言。

---

## 打包与发布

```bash
CARGO_INCREMENTAL=0 npx tauri build     # 先停 dev:app
```

- 产物：`src-tauri/target/release/bundle/nsis/WorkBench_0.1.0_x64-setup.exe`（lzma，约 1.8 MB）
- `bundle.targets` 收敛为 `["nsis"]`（要 MSI 时单独 `--bundles msi`）
- NSIS 定制：`installMode: "both"`（⚠️ 恒需管理员权限、安装时必弹 UAC）+ 中英双语语言选择器 +
  自定义 header / sidebar 位图（由 `scripts/gen-nsis-assets.py` 生成，必须是 24bit BMP 且尺寸严格）
- 安装协议页取 `src-tauri/EULA.txt`（**UTF-8 with BOM + CRLF**，与仓库 `LICENSE` 解耦）

---

## 开发路线

| 阶段 | 内容 | 状态 |
|---|---|---|
| 阶段一 · 系统级 | 脚手架 / core 框架 / 数据库 / 单实例 / 主题令牌 / 通知 / 日志 / 窗体适配 / 加密基础 / 侧边栏与路由守卫 | ✅ 10/10 |
| 阶段二 · 功能级 | 数据中心模块壳、天气 Widget、设置模块（外观 / 通用 / 存储 / 模块 / 关于，含密钥可移植化、备份、迁移、跨机导入） | ✅ 已完成 |
| | 项目管理（`proj_` + git 命令集成）、音频管理（`audio_` + ffmpeg sidecar）、其余 Widget（会员账户 / 还款提醒 / 待办） | 🚧 未开工（当前为占位空壳） |
| 后续 | 便携模式（exe 同级 `portable/`）、MSI 包、自动更新、代码签名、全局快捷键 | ⚪ 规划中 |

---

## 文档

| 文件 | 定位 |
|---|---|
| **[`workbench-架构设计.md`](./workbench-架构设计.md)** | 架构权威出处——**做成什么样**。架构图、表结构、设计令牌表、密钥与存储模型、ADR 决策记录 |
| **[`AGENTS.md`](./AGENTS.md)** | 开发规约——**怎么做事**。技术栈红线、六条模块化铁律、目录命名、数据/主题/安全约定、真机排障手册 |

两者冲突时以 `workbench-架构设计.md` 为准，并回头修订 `AGENTS.md`。**动手改代码前请先读它们。**

---

## 分支约定

- `main`：**平台主线**，只放平台底座、外壳、插件模型与规约
- 功能分支：具体的完整功能项目另建分支开发，例如 `feat/project-manager`、`feat/audio-manager`

---

## 许可

本项目采用 [Apache License 2.0](./LICENSE) 授权，完整条款见仓库根目录的 `LICENSE` 文件。
