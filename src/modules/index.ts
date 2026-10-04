/**
 * 功能模块自动装载（AGENTS §3 规约 2）。
 *
 * 每个模块实现文件（`modules/<id>/<X>.tsx`）在**文件底部**调用 `registerModule(...)`
 * 完成自注册。这里用 Vite 的 `import.meta.glob` 一次性把它们全部加载，
 * 于是**新增模块只需新建目录 + 写注册调用，不必再改任何清单文件**
 * （此前是手写 import 列表，容易漏加一行导致模块「写了但不出现」）。
 *
 * 约定：目录名 = 模块 id（`registerModule({ id })`），见 AGENTS §16 命名一致性。
 */
import { listModules } from "@/app/registry";

/** 各模块实现文件（eager 立即执行，触发其顶层的 registerModule 副作用） */
const implementations = import.meta.glob("./*/*.tsx", { eager: true });

// dev 期审计：发现「有目录但没注册」的情况，立刻在控制台点名，避免静默遗漏。
if (import.meta.env.DEV) {
  const dirs = new Set(
    Object.keys(implementations)
      .map((key) => key.split("/")[1])
      .filter((d): d is string => Boolean(d)),
  );
  const registered = new Set(listModules().map((m) => m.id));
  const unregistered = [...dirs].filter((d) => !registered.has(d));
  if (unregistered.length > 0) {
    console.warn(
      `[registry] 以下模块目录未调用 registerModule，不会出现在侧边栏/路由中：${unregistered.join(", ")}`,
    );
  }
}
