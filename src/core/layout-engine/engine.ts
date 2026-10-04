import type { LayoutTier } from "@/core/shared/hooks/useMediaQuery";
import type { GridItemLayout, LayoutSnapshot } from "./types";

/** 断点 → 列数（AGENTS §14：断点按内容区宽度，非屏幕） */
export const TIER_COLUMNS: Record<LayoutTier, number> = { wide: 4, mid: 3, narrow: 2 };

export function columnsForTier(tier: LayoutTier): number {
  return TIER_COLUMNS[tier];
}

/** 由有序 id 列表生成网格项（1×1，逐行铺满） */
export function itemsFromOrder(order: string[], columns: number): GridItemLayout[] {
  return order.map((id, i) => ({
    id,
    pos: { x: i % columns, y: Math.floor(i / columns), w: 1, h: 1 },
  }));
}

/** 数组内元素移动（拖拽排序）：把 from 处元素插到 to 处 */
export function moveIndex<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * 合并持久化顺序与当前注册 ids：
 * 保留历史顺序，新增项追加到末尾，已移除项丢弃。保证升级新增 Widget 不丢失已有排布。
 */
export function mergeIds(persisted: string[], current: string[]): string[] {
  const set = new Set(current);
  const kept = persisted.filter((id) => set.has(id));
  const added = current.filter((id) => !kept.includes(id));
  return [...kept, ...added];
}

/** 生成布局快照（供持久化） */
export function buildSnapshot(
  scope: string,
  order: string[],
  columns: number,
): LayoutSnapshot {
  return { scope, columns, items: itemsFromOrder(order, columns) };
}

/** 从持久化字符串解析出有序 id 列表；损坏或缺失返回 null（调用方回退默认顺序） */
export function parseOrder(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw) as Partial<LayoutSnapshot>;
    if (Array.isArray(snap.items)) {
      return snap.items.map((it) => it.id).filter((id): id is string => typeof id === "string");
    }
  } catch {
    /* 布局损坏则回退默认，不阻断渲染 */
  }
  return null;
}
