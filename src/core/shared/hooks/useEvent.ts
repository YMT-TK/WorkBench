import { useEffect, useRef } from "react";
import { eventBus } from "@/core/event-bus";

/**
 * 订阅 event-bus 事件（AGENTS §3 规约 3：跨模块通信唯一通道）。
 *
 * handler 用 ref 持有，effect 只依赖事件名 —— 调用方不必为内联箭头函数做 memo，
 * 也不会因父组件重渲染而反复解绑/重绑。
 *
 * 用法：
 *   useEvent<{ projectId: string }>("project.committed", (p) => refresh(p.projectId));
 */
export function useEvent<T = unknown>(event: string, handler: (payload: T) => void): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => eventBus.on<T>(event, (payload) => ref.current(payload)), [event]);
}
