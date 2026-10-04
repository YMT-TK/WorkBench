import { useEffect, useMemo } from "react";
import { Box, ChevronDown, ChevronUp, Eye, EyeOff, RotateCcw, X } from "lucide-react";
import type { PluginState } from "@/core/shared/api";
import { Switch } from "@/core/shared/components/Switch";
import type { SettingField, WidgetManifest } from "@/core/plugin-host/types";

/**
 * 数据中心插件配置面板（AGENTS §18.7）。
 * 三类配置：显示状态（enabled）、排布顺序（走 layout 引擎，单一顺序来源）、
 * 插件参数（settingsSchema → plugins.config JSON）。全部变更即落库。
 */
export interface PluginConfigProps {
  widgets: WidgetManifest[];
  /** 全量展示顺序（含已隐藏项，便于重新开启后保留位置） */
  order: string[];
  states: Record<string, PluginState>;
  configs: Record<string, Record<string, unknown>>;
  onClose: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onMove: (from: number, to: number) => void;
  onConfigChange: (id: string, key: string, value: unknown) => void;
  onReset: (id: string) => void;
}

export function PluginConfigPanel({
  widgets,
  order,
  states,
  configs,
  onClose,
  onToggle,
  onMove,
  onConfigChange,
  onReset,
}: PluginConfigProps) {
  const byId = useMemo(() => new Map(widgets.map((w) => [w.id, w])), [widgets]);

  // 以 order 为主，兜底并入未登记进 order 的注册项（避免升级新增插件时缺失）
  const items = useMemo(() => {
    const known = order.map((id) => byId.get(id)).filter((w): w is WidgetManifest => Boolean(w));
    const rest = widgets.filter((w) => !order.includes(w.id));
    return [...known, ...rest];
  }, [order, byId, widgets]);

  const enabledCount = items.filter((w) => (states[w.id]?.enabled ?? 1) === 1).length;

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="数据中心配置"
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/25 p-4 pt-[8vh]"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[min(620px,calc(100vw-2rem))] flex-col overflow-hidden rounded-card border border-border bg-surface shadow-float"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-primary">数据中心配置</div>
            <div className="text-xs text-text-muted">
              调整插件显示与顺序（已启用 {enabledCount}/{items.length}）
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭配置"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-text-muted hover:bg-bg-sidebar hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </header>

        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
          {items.map((w, i) => (
            <PluginRow
              key={w.id}
              widget={w}
              index={i}
              total={items.length}
              enabled={(states[w.id]?.enabled ?? 1) === 1}
              config={configs[w.id] ?? {}}
              onToggle={onToggle}
              onMove={onMove}
              onConfigChange={onConfigChange}
              onReset={onReset}
            />
          ))}
          {items.length === 0 && (
            <li className="py-8 text-center text-sm text-text-muted">还没有注册任何插件</li>
          )}
        </ul>
      </div>
    </div>
  );
}

function PluginRow({
  widget,
  index,
  total,
  enabled,
  config,
  onToggle,
  onMove,
  onConfigChange,
  onReset,
}: {
  widget: WidgetManifest;
  index: number;
  total: number;
  enabled: boolean;
  config: Record<string, unknown>;
  onToggle: PluginConfigProps["onToggle"];
  onMove: PluginConfigProps["onMove"];
  onConfigChange: PluginConfigProps["onConfigChange"];
  onReset: PluginConfigProps["onReset"];
}) {
  const Icon = widget.icon ?? Box;
  const schema = widget.settingsSchema;

  return (
    <li
      className={`rounded-card border border-border bg-bg-app/50 p-3 transition-colors ${
        enabled ? "" : "opacity-60"
      }`}
    >
      <div className="flex items-center gap-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
          <Icon size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-text-primary">{widget.name}</div>
          {widget.description && (
            <div className="truncate text-xs text-text-muted">{widget.description}</div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => onMove(index, index - 1)}
            disabled={index === 0}
            aria-label={`上移 ${widget.name}`}
            title="上移"
            className="grid h-6 w-6 place-items-center rounded-md text-text-muted hover:bg-surface hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronUp size={14} />
          </button>
          <button
            onClick={() => onMove(index, index + 1)}
            disabled={index === total - 1}
            aria-label={`下移 ${widget.name}`}
            title="下移"
            className="grid h-6 w-6 place-items-center rounded-md text-text-muted hover:bg-surface hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ChevronDown size={14} />
          </button>

          <span
            className="ml-1 inline-flex w-14 shrink-0 items-center justify-end gap-1 text-xs text-text-muted"
            title={enabled ? "显示中" : "已隐藏"}
          >
            {enabled ? (
              <Eye size={12} />
            ) : (
              <EyeOff size={12} />
            )}
            {enabled ? "显示" : "隐藏"}
          </span>
          <Switch
            checked={enabled}
            ariaLabel={`${widget.name} 显示开关`}
            onChange={() => onToggle(widget.id, !enabled)}
          />
        </div>
      </div>

      {schema && schema.length > 0 && (
        <div className="mt-3 space-y-2.5 border-t border-border pt-3">
          {schema.map((field) => (
            <FieldControl
              key={field.key}
              field={field}
              value={config[field.key]}
              onChange={(v) => onConfigChange(widget.id, field.key, v)}
            />
          ))}
          <div className="text-right">
            <button
              onClick={() => onReset(widget.id)}
              className="inline-flex items-center gap-1 rounded-pill border border-border px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary"
            >
              <RotateCcw size={11} />
              恢复默认
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: SettingField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const current = value === undefined ? field.default : value;
  const inputClass =
    "h-8 w-full rounded-md border border-border bg-surface px-2 text-sm text-text-primary outline-none focus:border-accent";

  if (field.type === "boolean") {
    const on = Boolean(current);
    return (
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-text-secondary">{field.label}</span>
        <Switch checked={on} ariaLabel={field.label} onChange={(v) => onChange(v)} />
      </div>
    );
  }

  return (
    <label className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-xs text-text-secondary">{field.label}</span>
      {field.type === "select" ? (
        <select
          value={String(current ?? "")}
          onChange={(e) => onChange(e.target.value)}
          className={inputClass}
        >
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === "number" ? "number" : "text"}
          value={String(current ?? "")}
          placeholder={field.placeholder}
          onChange={(e) =>
            onChange(field.type === "number" ? Number(e.target.value) : e.target.value)
          }
          className={inputClass}
        />
      )}
    </label>
  );
}
