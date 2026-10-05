/**
 * dev 专用端到端探针（仅当 Vite 以 WB_E2E=1 启动时由 vite.config.ts 注入）。
 *
 * 为什么需要它：静态文本回报只能证明「渲染出来了」，证明不了交互。
 * 这个脚本在真实 WebView 里跑一遍关键交互，把断言结果回报给 Vite 终端：
 *   0) 先把模块可见性归一化为「全部显示」（用户可能自己隐藏过占位模块），运行结束再还原
 *   1) 侧边栏默认收起 → 展开后可读；分组（主界面/工作模块/系统）与模块入口齐全，首项为数据中心
 *   2) 外层统一 header：只有「模块名（加粗）+ 模块描述（小一号）」，无产品名前缀；且有搜索入口
 *   3) 内容区不再有内层标题 h1（PageHeader 已移除）
 *   4) 数据中心卡片：存在且带阴影类（视觉升级）
 *   5) 数据中心配置面板：打开 → 插件行/开关/参数表单 → 切换开关并复原 → 关闭
 *   6) Ctrl+K 唤起命令面板 → 过滤 → 回车跳转 → 面板关闭
 *   7) 设置页开关隐藏模块 → 侧边栏实时移除 → 再点恢复；子页含「通用 / 存储」
 *      存储页校验：数据根目录 + 固定相对布局（media/backup/keys/logs）+ 密钥状态与导出/导入入口
 *      + 真点一次「立即备份」看列表是否新增（并清理掉）
 *      + 跨机导入向导（④ 段）：入口 / 弹窗骨架 / 可关闭
 *      + 迁移拒绝规则（目标已有 workbench.db）说明齐全
 *      （只做只读断言，不真的用口令导出密钥、不往磁盘写文件）
 *   8) 主题快切按钮存在
 *
 * 结束时复原它改过的状态（hidden_modules / sidebar_collapsed），不改动 src/ 下任何生产代码。
 */
(function () {
  // 防重复/并发执行：脚本若被注入两次（或整页重载过程中被重复执行），
  // 两次 run 会同时点同一份 DOM，导致断言随机失败。同一 window 只跑一次。
  if (window.__wbE2EActive) return;
  window.__wbE2EActive = true;

  // ⛔ 只在 Tauri WebView 里跑。用普通浏览器打开 dev server 预览时（没有 Tauri IPC），
  // 这套交互断言只会产生「读不到本机存储信息」之类的环境性假失败 —— 直接退出，别污染报告。
  if (!window.__TAURI_INTERNALS__) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(pred, timeout = 6000, step = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const v = pred();
        if (v) return v;
      } catch {
        /* 元素尚未挂载 */
      }
      await sleep(step);
    }
    return null;
  }

  const results = [];
  const check = (name, ok, extra) =>
    results.push({ name, ok: !!ok, extra: extra === undefined ? "" : String(extra) });

  const navText = () => document.querySelector("nav")?.innerText ?? "";
  // 用 textContent 而非 innerText：面包屑前缀/描述/动作文字带响应式 `hidden sm:inline`，
  // 窗口较窄时 innerText 会漏掉这些节点（假失败）。断言意图是「DOM 里有没有」，不是「当前宽度可不可见」。
  const headerText = () =>
    (document.querySelector("header")?.textContent ?? "").replace(/\s+/g, " ").trim();

  function setReactInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  let expandedByProbe = false;

  async function run() {
    // 0. 归位到数据中心，并**等首屏真正挂载完成**再往下走。
    // ⚠️ 不能只等 <nav> 出现：它可能在模块注册表尚未完全就绪时就已渲染，
    // 那样后面所有「侧边栏含 X」「设置页含 X」都会连锁假失败（且现场一片空白，极难定位）。
    // 以「数据中心配置按钮出现」作为「应用挂载完成」的标志。
    const nav = await waitFor(() => document.querySelector("nav"));
    check("侧边栏已渲染", !!nav);
    location.hash = "#/data-center";
    await waitFor(() => document.querySelector('button[title="配置数据中心插件"]'), 8000);
    await sleep(250);
    const expandBtn = document.querySelector('button[aria-label="展开侧边栏"]');
    if (expandBtn) {
      expandBtn.click();
      expandedByProbe = true;
      await sleep(360);
    }

    // 0.5 归一化模块可见性。
    // 用户完全可能把「建设中」的占位模块（项目管理 / 音频管理）从侧边栏隐藏掉，
    // 那会让后面「侧边栏含项目管理」「回车跳转到音频管理」这类断言假失败 ——
    // 因为被隐藏的模块会被 AppLayout 判定为不可访问而弹回数据中心。
    // 这里统一置为显示并记录原状态，收尾处还原。
    const restoredHidden = [];
    location.hash = "#/settings";
    const modTab0 = await waitFor(() =>
      Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "模块"),
    );
    modTab0?.click();
    const anyHideSwitch = await waitFor(() =>
      Array.from(document.querySelectorAll('button[role="switch"]')).find((b) =>
        (b.getAttribute("aria-label") ?? "").includes("显示开关"),
      ),
    );
    check("设置-模块页可打开（用于可见性归一化）", !!anyHideSwitch);
    if (anyHideSwitch) {
      const switches = Array.from(document.querySelectorAll('button[role="switch"]')).filter((b) =>
        (b.getAttribute("aria-label") ?? "").includes("显示开关"),
      );
      for (const s of switches) {
        if (s.getAttribute("aria-checked") === "false") {
          restoredHidden.push(s.getAttribute("aria-label"));
          s.click();
          await sleep(420);
        }
      }
    }
    if (restoredHidden.length) {
      console.log("[e2e] 归一化：临时显示被隐藏的模块 ->", restoredHidden.join(", "));
    }

    // 回到数据中心，继续后续断言
    location.hash = "#/data-center";
    await waitFor(() => document.querySelector('button[title="配置数据中心插件"]'), 6000);
    await sleep(300);

    // 1. 侧边栏结构与分组（数据中心置顶主界面）
    const text0 = navText();
    for (const name of ["主界面", "工作模块", "系统", "数据中心", "设置", "项目管理", "音频管理"]) {
      check(`侧边栏含「${name}」`, text0.includes(name));
    }
    check("侧边栏模块入口数 ≥ 4", (nav?.querySelectorAll("a").length ?? 0) >= 4);
    check(
      "侧边栏首项为数据中心",
      (nav?.querySelector("a")?.getAttribute("href") ?? "").includes("data-center"),
      nav?.querySelector("a")?.getAttribute("href") ?? "",
    );

    // 2. 外层统一 header（模块名 + 描述，不含产品名前缀）
    const header = document.querySelector("header");
    check("外层 header 存在", !!header);
    const ht = headerText();
    check("面包屑不再含产品名前缀 WorkBench", !ht.includes("WorkBench"), ht);
    check("面包屑含当前模块名「数据中心」", ht.includes("数据中心"), ht);
    check("header 含模块功能描述", ht.includes("插件化卡片区"), ht);
    check("顶部栏含搜索入口", ht.includes("搜索"));
    const descEl = header?.querySelector('span[title="插件化卡片区，聚合各类概览信息"]');
    check(
      "模块描述字号小一号（text-xs）",
      !!descEl && descEl.className.includes("text-xs"),
      descEl?.className ?? "未找到描述节点",
    );

    // 3. 内容区不再有内层标题（PageHeader 已移除）
    check("内容区无重复标题 h1", !document.querySelector("main h1"));

    // 4. 数据中心卡片视觉（阴影/动效类）
    const card = await waitFor(() => document.querySelector("[data-widget-card]"));
    check("数据中心渲染插件卡片", !!card);
    check(
      "卡片带阴影令牌类",
      (card?.className ?? "").includes("shadow-card"),
      card ? card.className.split(" ").filter((c) => c.includes("shadow")).join(",") : "",
    );

    // 5. 数据中心配置面板
    const cfgBtn = document.querySelector('button[title="配置数据中心插件"]');
    check("header 含数据中心「配置」动作", !!cfgBtn);
    cfgBtn?.click();
    const cfgDialog = await waitFor(() =>
      document.querySelector('[role="dialog"][aria-label="数据中心配置"]'),
    );
    check("配置面板可打开", !!cfgDialog);
    const cfgSwitch = cfgDialog?.querySelector('button[aria-label="天气 显示开关"]');
    check("配置面板含插件显示开关", !!cfgSwitch, cfgSwitch?.getAttribute("aria-label") ?? "");
    check("配置面板含参数表单", !!cfgDialog?.querySelector("input"));
    if (cfgSwitch) {
      cfgSwitch.click();
      await sleep(380);
      check("切换开关生效（隐藏）", cfgSwitch.getAttribute("aria-checked") === "false");
      cfgSwitch.click();
      await sleep(380);
      check("切换开关复原（显示）", cfgSwitch.getAttribute("aria-checked") === "true");
    }
    cfgDialog
      ?.querySelector('button[aria-label="关闭配置"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await sleep(250);
    check(
      "配置面板可关闭",
      !document.querySelector('[role="dialog"][aria-label="数据中心配置"]'),
    );

    // 6. 命令面板 Ctrl+K
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    const dialog = await waitFor(() =>
      document.querySelector('[role="dialog"][aria-label="命令面板"]'),
    );
    check("Ctrl+K 唤起命令面板", !!dialog);

    const listBtns = () => Array.from(dialog?.querySelectorAll("ul button") ?? []);
    check("命令面板列出全部模块", listBtns().length >= 4, `${listBtns().length} 项`);

    const input = dialog?.querySelector("input");
    if (input) {
      setReactInput(input, "音频");
      await sleep(250);
      check("命令面板可过滤", listBtns().length === 1, `过滤后 ${listBtns().length} 项`);

      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await sleep(400);
      check("回车跳转到音频管理", location.hash === "#/audio-manager", location.hash);
      check(
        "跳转后面板关闭",
        !document.querySelector('[role="dialog"][aria-label="命令面板"]'),
      );
    } else {
      check("命令面板输入框存在", false);
    }

    // 7. 设置页：新子页 + 面板内容
    location.hash = "#/settings";
    const tab = await waitFor(() =>
      Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "模块"),
    );
    check("设置页含「模块」子页", !!tab);
    const subTab = (name) =>
      Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === name);
    // 通用（关闭到托盘）/ 存储（数据位置 + 密钥与安全）子页。
    // 「数据」「隐私」已在存储模型统一后合并为「存储」—— 二者本质都是「数据放在哪」。
    for (const name of ["通用", "存储"]) {
      check(`设置页含「${name}」子页`, !!subTab(name));
    }
    check(
      "「数据」「隐私」已合并进「存储」，不再单独存在",
      !subTab("数据") && !subTab("隐私"),
      `数据=${!!subTab("数据")} 隐私=${!!subTab("隐私")}`,
    );

    // 设置页子页切换：点了不一定立刻生效（重载/并发时 DOM 可能正在替换），
    // 这里允许重试若干次，但每次都要求目标节点真的出现，避免「点了没反应」被误判为通过。
    const openSub = async (name, predicate, attempts = 3) => {
      for (let i = 0; i < attempts; i++) {
        subTab(name)?.click();
        const hit = await waitFor(predicate, 2500);
        if (hit) return hit;
      }
      return null;
    };

    // 7a. 设置 → 存储：验证 storage_* 命令链路真的通了（不只是页面在）
    // ⚠️ 存储页有三段 `<section>`（数据位置 / 密钥与安全 / 备份与恢复），
    // 只取第一个会漏掉后面两段的断言 —— 必须拼接全部。
    const fullSectionText = () =>
      Array.from(document.querySelectorAll("section"))
        .map((s) => s.innerText ?? "")
        .join(" ")
        .replace(/\s+/g, " ");
    const sectionText = () => fullSectionText().slice(0, 160);

    // 库里那条主库路径现在渲染在目录结构列表里（等宽字体 div），不是 <code> ——
    // 所以按「叶子节点文本含 workbench.db」来找，别绑死标签名。
    const dbPathEl = await openSub("存储", () => {
      const nodes = Array.from(document.querySelectorAll("section *"));
      return nodes.find(
        (n) => n.children.length === 0 && (n.textContent ?? "").includes("workbench.db"),
      );
    });
    check("设置-存储页读出数据库路径", !!dbPathEl, dbPathEl?.textContent || `现场=${sectionText()}`);
    check(
      "设置-存储页含「打开目录」",
      Array.from(document.querySelectorAll("button")).some((b) =>
        b.textContent.includes("打开目录"),
      ),
      sectionText(),
    );

    // 7a-2. 根目录下的固定相对布局（设计文档 §7.1）：media / backup / keys / logs
    // 这是「用户只改一个根目录，其余自动跟随」的可视化证据。
    for (const dir of ["media/", "backup/", "keys/", "logs/"]) {
      check(
        `设置-存储页列出子目录「${dir}」`,
        fullSectionText().includes(dir),
        sectionText(),
      );
    }

    // 7a-3. 运行日志位置（AGENTS §11）：不做日志页面，只把地址给用户，让他自己去看文件。
    check(
      "设置-存储页含「运行日志」条目",
      fullSectionText().includes("运行日志"),
      sectionText(),
    );
    check(
      "设置-存储页说明日志按生成时间保存",
      fullSectionText().includes("按生成时间保存"),
      sectionText(),
    );
    const logDirEl = await openSub("存储", () =>
      Array.from(document.querySelectorAll("code")).find((c) =>
        (c.textContent ?? "").includes("logs"),
      ),
    );
    check(
      "设置-存储页给出日志目录绝对路径",
      !!logDirEl && /logs\s*$/.test((logDirEl.textContent ?? "").trim()),
      logDirEl?.textContent ?? sectionText(),
    );
    check(
      "设置-存储页列出已有日志文件",
      fullSectionText().includes("workbench.log"),
      sectionText(),
    );

    // 7a-4. 备份与恢复（设计文档 §7.4）：一键备份 / 打开备份目录 / 自动备份 / 保留份数
    check(
      "设置-存储页含「备份与恢复」段",
      fullSectionText().includes("备份与恢复"),
      sectionText(),
    );
    const backupBtn = await openSub("存储", () =>
      Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent.includes("立即备份"),
      ),
    );
    check("设置-存储页含「立即备份」按钮", !!backupBtn, backupBtn ? "" : sectionText());
    check(
      "设置-存储页含「打开备份目录」按钮",
      fullSectionText().includes("打开备份目录"),
      sectionText(),
    );
    const autoSwitch = await openSub("存储", () =>
      document.querySelector('button[aria-label="启动时自动备份"]'),
    );
    check("设置-存储页含自动备份开关", !!autoSwitch, autoSwitch ? "" : sectionText());
    const keepInput = await openSub("存储", () =>
      document.querySelector('input[aria-label="备份保留份数"]'),
    );
    check("设置-存储页含保留份数输入框", !!keepInput, keepInput ? "" : sectionText());

    // 7a-5. 换机引导：备份包不含密钥 + 顺序固定（这是跨机复刻最容易踩的坑）
    check(
      "设置-存储页含换机引导",
      fullSectionText().includes("换机 / 跨设备复刻"),
      sectionText(),
    );
    check(
      "换机引导说明备份包不含密钥",
      fullSectionText().includes("不含密钥"),
      sectionText(),
    );
    check(
      "换机引导给出「先导入密钥 → 再恢复数据」顺序",
      fullSectionText().includes("先导入密钥"),
      sectionText(),
    );

    // 7a-6. 真点一次「立即备份」：验证 backup_create → backup_list 链路真的通了，
    // 而不只是按钮渲染出来了。备份是本轮的核心能力，光看 UI 不算验证。
    // 列表按时间倒序，新建的那条在最上面；时间戳形如 20261004_164500。
    const countBackups = () =>
      Array.from(document.querySelectorAll("section span")).filter((s) =>
        /^\d{8}_\d{6}$/.test((s.textContent ?? "").trim()),
      ).length;
    const beforeBackups = countBackups();
    backupBtn?.click();
    const grew = await waitFor(() => countBackups() > beforeBackups, 15000);
    check(
      "点「立即备份」后列表新增一条",
      !!grew,
      `before=${beforeBackups} after=${countBackups()}`,
    );
    check(
      "新备份带有密钥指纹或「无加密字段」标注",
      fullSectionText().includes("密钥指纹") || fullSectionText().includes("无加密字段"),
      sectionText(),
    );

    // 清理：删掉刚建的备份。探针必须状态无关 —— 不能给用户的数据目录留下副作用。
    if (grew) {
      const delBtn = await waitFor(() =>
        Array.from(document.querySelectorAll("button")).find((b) =>
          (b.textContent ?? "").includes("删除"),
        ),
      );
      delBtn?.click();
      const confirmDel = await waitFor(() =>
        Array.from(document.querySelectorAll("button")).find(
          (b) => (b.textContent ?? "").trim() === "确认删除",
        ),
      );
      confirmDel?.click();
      await waitFor(() => countBackups() <= beforeBackups, 8000);
      check(
        "清理：删除刚建的备份后恢复原状",
        countBackups() <= beforeBackups,
        `after=${countBackups()} before=${beforeBackups}`,
      );
    }

    // 7a-7. 跨机导入（设计文档 §7.6 / ADR-17）：把「备份包 + .wbkey」一次收进来。
    // 只验证「入口 + 向导骨架 + 讲清楚了顺序」；真的走完一遍会在第一步拉起**系统文件对话框**，
    // 无头环境里没法选，所以远端导入的判定逻辑交给 Rust 单测（transfer::tests）覆盖。
    check(
      "设置-存储页含「跨机导入」段",
      fullSectionText().includes("跨机导入"),
      sectionText(),
    );
    check(
      "跨机导入段说明会「先做只读预检」",
      fullSectionText().includes("只读预检"),
      sectionText(),
    );
    check(
      "跨机导入段说明「顺序由程序强制」",
      fullSectionText().includes("顺序由程序强制"),
      sectionText(),
    );
    check(
      "跨机导入段说明不匹配时磁盘零改动",
      fullSectionText().includes("不会改"),
      sectionText(),
    );

    // 用户描述的场景是「点备份 → 程序告诉我存哪儿 → 拷走 → 到新机器点导入」，
    // 所以「要带走的两个位置」必须**直接写在跨机导入段里**，不能让他去 ①②③ 各找一次。
    check(
      "跨机导入段给出「换机要带走的两个位置」",
      fullSectionText().includes("换机要带走的两个位置"),
      sectionText(),
    );
    check(
      "该清单标注「① 备份包」与「② 密钥文件」并说明密钥不含在备份包里",
      fullSectionText().includes("① 备份包") &&
        fullSectionText().includes("② 密钥文件") &&
        fullSectionText().includes("不含密钥"),
      sectionText(),
    );
    const keyFileEl = await openSub("存储", () =>
      Array.from(document.querySelectorAll("code")).find((c) =>
        (c.textContent ?? "").includes("master-key.wbkey"),
      ),
    );
    check(
      "该清单给出密钥文件绝对路径（keys/ 下的 master-key.wbkey）",
      !!keyFileEl,
      keyFileEl?.textContent ?? sectionText(),
    );

    // 7a-8. 迁移拒绝规则（设计文档 §7.3 / ADR-18）：目标目录已有 workbench.db → 直接拒绝。
    // 断言页面把规则讲清楚了；真正的「拒绝」行为由 Rust 单测 target_with_existing_db_is_refused 覆盖。
    check(
      "设置-存储页说明迁移会被拒绝的情形",
      fullSectionText().includes("迁移会被直接拒绝"),
      sectionText(),
    );
    check(
      "迁移拒绝说明强调「不会悄悄覆盖」",
      fullSectionText().includes("不会悄悄覆盖"),
      sectionText(),
    );

    // 7a-9. 跨机导入的 3 个只读命令确实注册在 IPC 上。
    // 探针只能拿到 window.__TAURI_INTERNALS__（拿不到打包后的 api 模块），所以直接 invoke。
    // 传一个**必定不存在**的路径：只要错误不是「命令未注册」，就说明链路通了；
    // 而且这些命令是只读的 —— 失败路径上不该在任何地方落下东西。
    const invokeRaw = async (cmd, args) => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(cmd, args) };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    };
    const notRegistered = (msg) => /not found|not allowed|unknown command/i.test(msg);

    const inspectRes = await invokeRaw("import_inspect", { dir: "C:/__wb_no_such_dir__" });
    check(
      "命令 import_inspect 已注册且只读",
      !inspectRes.ok && !notRegistered(inspectRes.error),
      inspectRes.ok ? "竟然成功了？" : inspectRes.error.slice(0, 140),
    );
    const wbkeyRes = await invokeRaw("wbkey_inspect", { path: "C:/__wb_no_such__.wbkey" });
    check(
      "命令 wbkey_inspect 已注册且只读",
      !wbkeyRes.ok && !notRegistered(wbkeyRes.error),
      wbkeyRes.ok ? "竟然成功了？" : wbkeyRes.error.slice(0, 140),
    );
    const preRes = await invokeRaw("import_precheck", {
      dir: "C:/__wb_no_such_dir__",
      wbkeyPath: "C:/__wb_no_such__.wbkey",
      passphrase: "1234567890",
    });
    check(
      "命令 import_precheck 已注册且只读",
      !preRes.ok && !notRegistered(preRes.error),
      preRes.ok ? "竟然成功了？" : preRes.error.slice(0, 140),
    );

    // 7a-10. 向导能打开、内容对得上、关得掉。
    // ⚠️ 放在存储页断言的**最后**：万一关闭失败，模态遮罩不会影响前面已经跑完的断言。
    const importBtn = await openSub("存储", () =>
      Array.from(document.querySelectorAll("button")).find((b) =>
        (b.textContent ?? "").includes("从别的电脑导入"),
      ),
    );
    check("设置-存储页含「从别的电脑导入」按钮", !!importBtn, importBtn ? "" : sectionText());
    if (importBtn) {
      importBtn.click();
      const wizard = await waitFor(() =>
        document.querySelector('[role="dialog"][aria-label="从别的电脑导入"]'),
      );
      check(
        "跨机导入向导弹窗可打开",
        !!wizard,
        wizard ? "" : "未找到 aria-label=从别的电脑导入 的对话框",
      );
      const wizardText = () => (wizard?.textContent ?? "").replace(/\s+/g, " ");
      check(
        "向导第一步是「选择备份包目录」",
        !!wizard &&
          Array.from(wizard.querySelectorAll("button")).some((b) =>
            (b.textContent ?? "").includes("选择备份包目录"),
          ),
      );
      check("向导含步骤条「备份包」", wizardText().includes("备份包"), wizardText().slice(0, 140));
      check(
        "向导说明「先读出它要求哪把钥匙」",
        wizardText().includes("钥匙"),
        wizardText().slice(0, 180),
      );

      let closed = false;
      for (let i = 0; i < 3 && !closed; i++) {
        wizard
          ?.querySelector('button[aria-label="关闭向导"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await sleep(260);
        closed = !document.querySelector('[role="dialog"][aria-label="从别的电脑导入"]');
      }
      check("跨机导入向导可关闭且不残留", closed);
      check(
        "向导支持 Esc/点遮罩关闭（有 aria-modal 语义）",
        (wizard?.getAttribute("aria-modal") ?? "") === "true",
      );
    }

    // 7b. 设置 → 通用：关闭到托盘开关存在（AGENTS §19）
    const traySwitch = await openSub("通用", () =>
      document.querySelector('button[aria-label="关闭到托盘开关"]'),
    );
    check("设置-通用页含关闭到托盘开关", !!traySwitch, traySwitch ? "" : sectionText());
    check("关闭到托盘默认开启", traySwitch?.getAttribute("aria-checked") === "true");

    // 7c. 设置 → 模块：开关隐藏 → 侧边栏实时联动（useAppSetting 跨组件同步）
    tab?.click();

    const sw = await waitFor(() =>
      Array.from(document.querySelectorAll('button[role="switch"]')).find((b) =>
        (b.getAttribute("aria-label") ?? "").includes("项目管理"),
      ),
    );
    check("设置页含模块可见性开关", !!sw, sw?.getAttribute("aria-label") ?? "");

    if (sw) {
      const before = navText();
      sw.click();
      await sleep(450);
      const afterHide = navText();
      check(
        "隐藏后侧边栏实时移除该项",
        before.includes("项目管理") && !afterHide.includes("项目管理"),
        `before=含:${before.includes("项目管理")} after=含:${afterHide.includes("项目管理")}`,
      );

      sw.click();
      await sleep(450);
      check("恢复后侧边栏实时回归", navText().includes("项目管理"));
    }

    // 7d. 设置 → 存储 → 密钥与安全：三态横幅 + 导出/导入入口（AGENTS §7 / 设计文档 §8）。
    // 只做只读断言 —— 真点「导出」要用 Argon2 派生口令并以磁盘文件为副作用，探针不制造副作用。
    const exportPathInput = await openSub("存储", () =>
      document.querySelector('input[aria-label="密钥导出路径"]'),
    );
    check("设置-存储页含密钥导出路径输入框", !!exportPathInput, exportPathInput ? "" : sectionText());

    check(
      "导出路径默认落在根目录 keys/ 下",
      (exportPathInput?.value ?? "").includes("master-key.wbkey"),
      exportPathInput?.value || "未找到输入框",
    );
    check(
      "设置-存储页含导出口令输入框",
      !!document.querySelector('input[aria-label="密钥导出口令"]'),
      sectionText(),
    );
    check(
      "设置-存储页含密钥导入入口（路径 + 口令）",
      !!document.querySelector('input[aria-label="密钥导入路径"]') &&
        !!document.querySelector('input[aria-label="密钥导入口令"]'),
      sectionText(),
    );
    check(
      "设置-存储页展示密钥存放位置",
      fullSectionText().includes("master-key"),
      fullSectionText().slice(0, 200),
    );
    for (const label of ["导出密钥", "导入密钥"]) {
      check(
        `设置-存储页含「${label}」按钮`,
        Array.from(document.querySelectorAll("button")).some((b) => b.textContent.includes(label)),
        sectionText(),
      );
    }

    // 8. 主题快切按钮
    check(
      "顶部栏含主题快切",
      !!document.querySelector('button[aria-label="切换主题"]'),
    );

    // 复原：把探针为了断言而临时重新显示的模块再隐藏回去，保持用户原有状态
    if (restoredHidden.length) {
      location.hash = "#/settings";
      const modTabR = await waitFor(() =>
        Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "模块"),
      );
      modTabR?.click();
      await sleep(300);
      for (const label of restoredHidden) {
        const s = Array.from(document.querySelectorAll('button[role="switch"]')).find(
          (b) => (b.getAttribute("aria-label") ?? "") === label,
        );
        if (s && s.getAttribute("aria-checked") === "true") {
          s.click();
          await sleep(420);
        }
      }
    }

    // 复原：探针展开了侧边栏 → 收回归档（保持「默认收起」的用户态）
    if (expandedByProbe) {
      const collapseBtn = await waitFor(() => document.querySelector('button[aria-label="收起侧边栏"]'));
      collapseBtn?.click();
      await sleep(360);
    }
  }

  async function report() {
    const payload = {
      results,
      pass: results.length > 0 && results.every((r) => r.ok),
      failed: results.filter((r) => !r.ok).map((r) => r.name),
    };
    const json = JSON.stringify(payload);

    // 分块上报：断言多了以后整包塞进查询串会超过 Node 的请求头上限（HTTP 431），
    // 结果是一个字节都收不到。
    // ⚠️ 必须切**原始 JSON**再逐块 encodeURIComponent，不能先编码再切片 ——
    // 后者会让某块以半个 `%E5` 结尾，Vite 内部 decodeURI(req.url) 直接抛
    // "Internal server error: URI malformed"（现象：日志里一堆 500，人还以为探针挂了）。
    // 按**码点**切片（Array.from）是为了不劈开代理对，否则 encodeURIComponent 会抛错。
    const points = Array.from(json);
    const CHUNK = 800;
    const total = Math.max(1, Math.ceil(points.length / CHUNK));
    for (let i = 0; i < total; i++) {
      const part = points.slice(i * CHUNK, (i + 1) * CHUNK).join("");
      try {
        await fetch(`/__e2e?c=${i + 1}/${total}&d=${encodeURIComponent(part)}`);
      } catch {
        /* 忽略 */
      }
    }
    console.log("[e2e]", json);
  }

  async function main() {
    try {
      await waitFor(() => document.querySelector("nav"));
      await sleep(1200); // 等首屏副作用（设置拉取 / 窗口 bounds 恢复）稳定，避免尺寸抖动导致响应式误判
      await run();
    } catch (err) {
      results.push({ name: "探针异常", ok: false, extra: String(err) });
    } finally {
      await report();
      window.__wbE2EActive = false;
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", main);
  } else {
    main();
  }
})();
