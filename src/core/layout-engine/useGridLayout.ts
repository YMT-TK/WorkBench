import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/core/shared/api";
import { useDebouncedCallback } from "@/core/shared/hooks/useDebouncedCallback";
import { buildSnapshot, columnsForTier, mergeIds, moveIndex, parseOrder } from "./engine";
import { useContainerTier } from "./useContainerTier";

/**
 * 网格布局引擎 hook：把「注册顺序」与「用户排布」合成可渲染顺序，并持久化。
 *
 * - 列数随容器宽度实时重算（AGENTS §14 布局引擎联动）
 * - 排布存 app_settings: `layout:<scope>`，debounce 300ms（AGENTS §6.4 变更即落库）
 * - 新增 Widget 自动并入末尾、已移除的丢弃（升级不丢排布）
 * - 非 Tauri 环境静默降级为纯前端（不持久化，不报错）
 */
export function useGridLayout(scope: string, ids: string[]) {
  const { ref: containerRef, tier } = useContainerTier<HTMLDivElement>();
  const columns = columnsForTier(tier);
  const [order, setOrder] = useState<string[]>(ids);

  // 用 joined key 作依赖，避免调用方每次渲染传入新数组导致 effect 抖动。
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const idsKey = ids.join("|");
  const key = `layout:${scope}`;

  // 载入已保存布局（仅首次，按 scope）。
  useEffect(() => {
    let alive = true;
    api
      .getSetting(key)
      .then((raw) => {
        if (!alive) return;
        const saved = parseOrder(raw);
        if (saved) setOrder((prev) => mergeIds(saved, idsRef.current.length ? idsRef.current : prev));
      })
      .catch(() => {
        /* 非 Tauri 环境降级：不持久化 */
      });
    return () => {
      alive = false;
    };
  }, [key]);

  // 注册集合变化（新增/移除 Widget）时并入，保证升级后新卡片可见。
  useEffect(() => {
    setOrder((prev) => {
      const merged = mergeIds(prev, idsRef.current);
      const same = merged.length === prev.length && merged.every((v, i) => v === prev[i]);
      return same ? prev : merged;
    });
  }, [idsKey]);

  const persist = useDebouncedCallback((next: string[], cols: number) => {
    api.setSetting(key, JSON.stringify(buildSnapshot(scope, next, cols))).catch(() => {
      /* 非 Tauri 环境降级 */
    });
  }, 300);

  const move = useCallback(
    (from: number, to: number) => {
      setOrder((prev) => {
        const next = moveIndex(prev, from, to);
        if (next !== prev) persist(next, columns);
        return next;
      });
    },
    [persist, columns],
  );

  /** 按 id 直接移动到目标 id 之前（拖拽落点用，避免调用方算 index） */
  const moveById = useCallback(
    (dragId: string, targetId: string) => {
      setOrder((prev) => {
        const from = prev.indexOf(dragId);
        const to = prev.indexOf(targetId);
        const next = moveIndex(prev, from, to);
        if (next !== prev) persist(next, columns);
        return next;
      });
    },
    [persist, columns],
  );

  return useMemo(
    () => ({ containerRef, columns, tier, order, move, moveById }),
    [containerRef, columns, tier, order, move, moveById],
  );
}
