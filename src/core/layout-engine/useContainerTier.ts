import { useEffect, useRef, useState } from "react";
import type { LayoutTier } from "@/core/shared/hooks/useMediaQuery";

/** 断点阈值（内容区宽度 px，AGENTS §14） */
export const TIER_BREAKPOINTS = { wide: 1280, mid: 960 } as const;

export function tierForWidth(width: number): LayoutTier {
  if (width >= TIER_BREAKPOINTS.wide) return "wide";
  if (width >= TIER_BREAKPOINTS.mid) return "mid";
  return "narrow";
}

/**
 * 用 ResizeObserver 观察「内容区容器」宽度并返回响应式档位（AGENTS §14）。
 * 与按屏幕的媒体查询不同：容器尺寸变化（窗口缩放 / 侧边栏收起 / 系统 DPI 缩放）即重算，
 * 保证网格列数随内容区实时变化，侧边栏收起后内容区自动升档。
 */
export function useContainerTier<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    // 首次立即测量一次，避免首帧档位误判
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  return { ref, width, tier: tierForWidth(width) };
}
