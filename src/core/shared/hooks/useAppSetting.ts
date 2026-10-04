import { useEffect, useRef, useState } from "react";
import { api } from "@/core/shared/api";
import { eventBus } from "@/core/event-bus";

/** 设置变更事件（AGENTS §3：跨模块只走 event-bus，非 React 代码据此感知） */
export const SETTING_CHANGED = "setting.changed";

export interface SettingChangedPayload {
  key: string;
  value: unknown;
}

/**
 * 同一 key 的活跃订阅者（每个 useAppSetting 实例登记一个）。
 * 没有它时，同一设置在不同组件里各持一份互不感知的副本 —— 例如
 * 设置页改 hidden_modules，侧边栏要等重新挂载才会变，属真实缺陷。
 */
const subscribers = new Map<string, Set<(v: unknown) => void>>();

function subscribe(key: string, fn: (v: unknown) => void): () => void {
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(fn);
  return () => {
    const cur = subscribers.get(key);
    cur?.delete(fn);
    if (cur && cur.size === 0) subscribers.delete(key);
  };
}

/**
 * 读取 / 写入单个应用设置（持久化到 app_settings，AGENTS §5）。
 * - 初次挂载从 Rust 拉取；set 时立即写库（带 JSON 序列化）。
 * - 跨组件实时同步：任一实例 set 后同步广播给同 key 的其他实例。
 * - 同时 emit `setting.changed`，供非 React 代码通过 event-bus 订阅。
 *
 * 注意：effect 仅以 key 为依赖，fallback 用 ref 持有。
 * 若把 fallback 放进依赖数组，调用方传字面量（如 `[]` / `{}`）时每次渲染都是新引用，
 * 会导致「拉取 → setState 新引用 → 重渲染 → 再次拉取」的无限循环（仅在有已存值时触发）。
 */
export function useAppSetting<T>(key: string, fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  useEffect(() => {
    let active = true;

    api
      .getSetting(key)
      .then((raw) => {
        if (!active || raw == null) return;
        try {
          setValue(JSON.parse(raw) as T);
        } catch {
          setValue(fallbackRef.current);
        }
      })
      .catch(() => {
        /* 非 Tauri 环境（纯前端调试）静默降级为 fallback */
      });

    const unsubscribe = subscribe(key, (v) => {
      if (active) setValue(v as T);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [key]);

  const set = (v: T) => {
    setValue(v);
    api.setSetting(key, JSON.stringify(v)).catch(() => {});
    subscribers.get(key)?.forEach((fn) => fn(v));
    eventBus.emit<SettingChangedPayload>(SETTING_CHANGED, { key, value: v });
  };

  return [value, set];
}
