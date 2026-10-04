/**
 * dev 专用端到端探针（仅当 Vite 以 WB_E2E=1 启动时由 vite.config.ts 注入）。
 *
 * 为什么需要它：静态文本回报只能证明「渲染出来了」，证明不了交互。
 * 这个脚本在真实 WebView 里跑一遍关键交互，把断言结果回报给 Vite 终端：
 *   1) 侧边栏默认收起 → 展开后可读；分组（主界面/工作模块/系统）与模块入口齐全，首项为数据中心
 *   2) 外层统一 header：只有「模块名（加粗）+ 模块描述（小一号）」，无产品名前缀；且有搜索入口
 *   3) 内容区不再有内层标题 h1（PageHeader 已移除）
 *   4) 数据中心卡片：存在且带阴影类（视觉升级）
 *   5) 数据中心配置面板：打开 → 插件行/开关/参数表单 → 切换开关并复原 → 关闭
 *   6) Ctrl+K 唤起命令面板 → 过滤 → 回车跳转 → 面板关闭
 *   7) 设置页开关隐藏模块 → 侧边栏实时移除 → 再点恢复；设置页含「通用 / 数据」新子页
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
    // 0. 归位到数据中心（探针可能因 HMR/整页重载在任意路由上重跑，需幂等）+ 展开侧边栏
    const nav = await waitFor(() => document.querySelector("nav"));
    check("侧边栏已渲染", !!nav);
    if (!location.hash.startsWith("#/data-center")) {
      location.hash = "#/data-center";
      await waitFor(() => document.querySelector('button[title="配置数据中心插件"]'), 6000);
      await sleep(200);
    }
    const expandBtn = document.querySelector('button[aria-label="展开侧边栏"]');
    if (expandBtn) {
      expandBtn.click();
      expandedByProbe = true;
      await sleep(360);
    }

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
    // 本轮新增：通用（关闭到托盘）/ 数据（存储位置）两个子页
    for (const name of ["通用", "数据"]) {
      check(`设置页含「${name}」子页`, !!subTab(name));
    }

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

    // 7a. 设置 → 数据：验证 storage_* 命令链路真的通了（不只是页面在）
    const dbPathEl = await openSub("数据", () =>
      Array.from(document.querySelectorAll("code")).find((c) =>
        c.textContent.includes("workbench.db"),
      ),
    );
    const sectionText = () =>
      (document.querySelector("section")?.innerText ?? "").replace(/\s+/g, " ").slice(0, 140);
    check("设置-数据页读出数据库路径", !!dbPathEl, dbPathEl?.textContent || `现场=${sectionText()}`);
    check(
      "设置-数据页含「打开目录」",
      Array.from(document.querySelectorAll("button")).some((b) =>
        b.textContent.includes("打开目录"),
      ),
      sectionText(),
    );

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

    // 8. 主题快切按钮
    check(
      "顶部栏含主题快切",
      !!document.querySelector('button[aria-label="切换主题"]'),
    );

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
    const url = "/__e2e?" + encodeURIComponent(JSON.stringify(payload));
    try {
      await fetch(url);
    } catch {
      /* 忽略 */
    }
    console.log("[e2e]", JSON.stringify(payload));
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
