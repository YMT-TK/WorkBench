/**
 * Widget 自动装载（AGENTS §3 规约 1）。
 *
 * 每个 Widget 在自己的 `manifest.ts` 里调用 `registerWidget(...)` 自注册；
 * 这里用 `import.meta.glob` 自动发现并加载全部 manifest，
 * 于是**新增 Widget 只需新建 `widgets/<id>/`（组件 + manifest），不必改任何清单文件**。
 *
 * 约定：目录名 = Widget id（`registerWidget({ id })`），见 AGENTS §16 命名一致性。
 */
import { listWidgets } from "@/core/plugin-host/registry";

/** 各 Widget 的 manifest（eager 立即执行，触发其内部的 registerWidget 副作用） */
const manifests = import.meta.glob("./*/manifest.ts", { eager: true });

// dev 期审计：有目录但没注册 manifest 的 Widget 会在控制台被点名。
if (import.meta.env.DEV) {
  const dirs = new Set(
    Object.keys(manifests)
      .map((key) => key.split("/")[1])
      .filter((d): d is string => Boolean(d)),
  );
  const registered = new Set(listWidgets().map((w) => w.id));
  const unregistered = [...dirs].filter((d) => !registered.has(d));
  if (unregistered.length > 0) {
    console.warn(
      `[registry] 以下 Widget 目录缺少 manifest.ts 注册，不会出现在数据中心：${unregistered.join(", ")}`,
    );
  }
}
