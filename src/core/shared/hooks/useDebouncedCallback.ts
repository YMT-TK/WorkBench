import { useEffect, useMemo, useRef } from "react";

/**
 * 返回防抖后的回调（依赖项变化时重建）。用于配置项「变更即落库」的 debounce（AGENTS §5）。
 * 组件卸载后不再触发，避免 setState on unmounted 警告。
 */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const mounted = useRef(true);
  useEffect(() => () => {
    mounted.current = false;
  }, []);

  return useMemo(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return (...args: A) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (mounted.current) fnRef.current(...args);
      }, ms);
    };
  }, [ms]);
}
