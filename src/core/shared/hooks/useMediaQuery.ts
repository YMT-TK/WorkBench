import { useEffect, useState } from "react";

/** 响应式断点基础（AGENTS §14 窗体适配）：按媒体查询返回是否命中 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mq.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

/** 内容区宽度断点（AGENTS §14）：宽屏 / 中屏 / 窄屏 */
export type LayoutTier = "wide" | "mid" | "narrow";

export function useLayoutTier(): LayoutTier {
  const wide = useMediaQuery("(min-width: 1280px)");
  const mid = useMediaQuery("(min-width: 960px)");
  if (wide) return "wide";
  if (mid) return "mid";
  return "narrow";
}
