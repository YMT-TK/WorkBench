import { useCallback, useEffect, useMemo, useState } from "react";
import { LayoutDashboard, SlidersHorizontal } from "lucide-react";
import { listWidgets } from "@/core/plugin-host/registry";
import { registerModule } from "@/app/registry";
import { api, isTauri, type PluginState } from "@/core/shared/api";
import { PageContainer } from "@/core/shared/components/Page";
import { EmptyState, ErrorState, SkeletonCard } from "@/core/shared/components/States";
import { useGridLayout } from "@/core/layout-engine";
import { useDebouncedCallback } from "@/core/shared/hooks/useDebouncedCallback";
import { reportError } from "@/core/shared/utils/errors";
import { useHeaderActions } from "@/app/layout/HeaderActions";
import type { WidgetManifest } from "@/core/plugin-host/types";
import { WidgetCard } from "./WidgetCard";
import { PluginConfigPanel } from "./PluginConfig";

/**
 * 数据中心（模块壳，系统级）—— 只读插件注册表渲染 Widget（AGENTS §2 铁律）。
 * 加 Widget 不动本文件：注册表 + plugins 表驱动。
 * 网格列数随内容区宽度重算、拖拽排序并持久化（AGENTS §14 布局引擎联动）。
 * 插件配置（显示/顺序/参数）见 PluginConfigPanel；页头由外层统一 header 呈现（§18.6）。
 */
export default function DataCenter() {
  const widgets = useMemo(() => listWidgets(), []);
  const [pluginStates, setPluginStates] = useState<Record<string, PluginState>>({});
  const [configs, setConfigs] = useState<Record<string, Record<string, unknown>>>({});
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [configOpen, setConfigOpen] = useState(false);

  const load = useCallback(() => {
    setStatus("loading");
    api
      .listPlugins()
      .then((list) => {
        const states: Record<string, PluginState> = {};
        const cfgs: Record<string, Record<string, unknown>> = {};
        list.forEach((p) => {
          states[p.id] = p;
          cfgs[p.id] = parseConfig(p.config);
        });
        setPluginStates(states);
        setConfigs(cfgs);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (isTauri()) {
          // 宿主内失败 = 真实故障，必须暴露（不再静默降级掩盖）
          reportError(err, "读取插件状态失败");
          setStatus("error");
        } else {
          // 浏览器调试环境：预期内的降级，全部按默认显示
          setStatus("ready");
        }
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 全量 id（含已隐藏项）交给布局引擎：顺序是唯一来源，隐藏项保留位置以便重新开启
  const allIds = useMemo(() => widgets.map((w) => w.id), [widgets]);
  const { containerRef, columns, order, move } = useGridLayout("data-center", allIds);

  // 实际渲染：过滤掉 plugins.enabled=0 的卡片
  const ordered = useMemo(
    () =>
      order
        .filter((id) => (pluginStates[id]?.enabled ?? 1) === 1)
        .map((id) => widgets.find((w) => w.id === id))
        .filter((w): w is WidgetManifest => Boolean(w)),
    [order, pluginStates, widgets],
  );

  const byId = useMemo(() => new Map(widgets.map((w) => [w.id, w])), [widgets]);

  // ---------- 配置写操作（变更即落库） ----------

  const setEnabled = useCallback((id: string, enabled: boolean) => {
    const value = enabled ? 1 : 0;
    setPluginStates((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? defaultState(id)), id, enabled: value },
    }));
    api.updatePlugin(id, { enabled: value }).catch((err: unknown) => {
      if (isTauri()) reportError(err, "更新插件显示状态失败");
    });
  }, []);

  const persistConfig = useDebouncedCallback((id: string, cfg: Record<string, unknown>) => {
    const json = JSON.stringify(cfg);
    setPluginStates((prev) => ({ ...prev, [id]: { ...(prev[id] ?? defaultState(id)), id, config: json } }));
    api.updatePlugin(id, { config: json }).catch((err: unknown) => {
      if (isTauri()) reportError(err, "保存插件配置失败");
    });
  }, 400);

  const setConfigValue = useCallback(
    (id: string, key: string, value: unknown) => {
      const next = { ...(configs[id] ?? {}), [key]: value };
      setConfigs((prev) => ({ ...prev, [id]: next }));
      persistConfig(id, next);
    },
    [configs, persistConfig],
  );

  const resetConfig = useCallback(
    (id: string) => {
      const def: Record<string, unknown> = {};
      byId.get(id)?.settingsSchema?.forEach((f) => (def[f.key] = f.default));
      setConfigs((prev) => ({ ...prev, [id]: def }));
      persistConfig(id, def);
    },
    [byId, persistConfig],
  );

  // 模块动作注册到外层统一 header（不占用内容区）
  const headerActions = useMemo(
    () => (
      <button
        onClick={() => setConfigOpen(true)}
        title="配置数据中心插件"
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface hover:text-text-primary"
      >
        <SlidersHorizontal size={14} />
        <span className="hidden sm:inline">配置</span>
      </button>
    ),
    [],
  );
  useHeaderActions(headerActions);

  // 拖拽视觉反馈（被拖项半透明、落点高亮环）
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const resetDrag = () => {
    setDraggingId(null);
    setOverId(null);
  };

  return (
    <PageContainer>
      {status === "loading" && (
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}

      {status === "error" && (
        <ErrorState
          title="读取插件状态失败"
          description="无法从本地数据库加载卡片配置，可重试。"
          onRetry={load}
        />
      )}

      {status === "ready" && (
        <div
          ref={containerRef}
          className="grid gap-4"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {ordered.map((w, i) => {
            const isDragging = draggingId === w.id;
            const isOver = overId === w.id && draggingId !== w.id;
            return (
              <div
                key={w.id}
                draggable
                onDragStart={() => setDraggingId(w.id)}
                onDragEnd={resetDrag}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (overId !== w.id) setOverId(w.id);
                }}
                onDragLeave={() => {
                  if (overId === w.id) setOverId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (draggingId && draggingId !== w.id) {
                    const from = order.indexOf(draggingId);
                    const to = order.indexOf(w.id);
                    if (from >= 0 && to >= 0) move(from, to);
                  }
                  resetDrag();
                }}
                className={`cursor-grab transition-transform duration-200 active:cursor-grabbing ${
                  isDragging ? "scale-[0.98] opacity-40" : ""
                } ${isOver ? "rounded-card ring-2 ring-accent/50 ring-offset-2 ring-offset-bg-app" : ""}`}
              >
                <WidgetCard manifest={w} config={configs[w.id] ?? {}} index={i} />
              </div>
            );
          })}

          {ordered.length === 0 && (
            <div className="col-span-full">
              <EmptyState
                title="暂无可见卡片"
                description="所有卡片都被关闭了。可在插件配置中重新开启。"
                action={
                  <button
                    onClick={() => setConfigOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1 text-xs text-accent hover:bg-surface"
                  >
                    <SlidersHorizontal size={13} />
                    打开配置
                  </button>
                }
              />
            </div>
          )}
        </div>
      )}

      {configOpen && (
        <PluginConfigPanel
          widgets={widgets}
          order={order}
          states={pluginStates}
          configs={configs}
          onClose={() => setConfigOpen(false)}
          onToggle={setEnabled}
          onMove={move}
          onConfigChange={setConfigValue}
          onReset={resetConfig}
        />
      )}
    </PageContainer>
  );
}

function parseConfig(raw?: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function defaultState(id: string): PluginState {
  return { id, enabled: 1, sort: 0, config: "{}" };
}

// 自注册（modules/index.ts 引入本文件即生效）：数据中心为系统级常驻入口，
// pinned=true → 侧边栏「主界面」分组首项，并作为默认落地页（AGENTS §15）。
registerModule({
  id: "data-center",
  name: "数据中心",
  description: "插件化卡片区，聚合各类概览信息",
  icon: LayoutDashboard,
  component: DataCenter,
  order: 10,
  system: true,
  pinned: true,
});
