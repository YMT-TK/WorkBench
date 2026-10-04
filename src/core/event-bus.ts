/**
 * 跨模块事件总线 —— 唯一跨模块通信通道（AGENTS §3 规约 3）。
 * 模块间禁止直接 import，一律通过 emit/on 通信。
 */
type Handler<T = unknown> = (payload: T) => void;

class EventBus {
  private handlers = new Map<string, Set<Handler<unknown>>>();

  /** 订阅事件，返回取消订阅函数 */
  on<T = unknown>(event: string, handler: Handler<T>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as Handler<unknown>);
    return () => this.off(event, handler);
  }

  off<T = unknown>(event: string, handler: Handler<T>): void {
    this.handlers.get(event)?.delete(handler as Handler<unknown>);
  }

  /** 发布事件 */
  emit<T = unknown>(event: string, payload?: T): void {
    this.handlers.get(event)?.forEach((h) => h(payload));
  }
}

export const eventBus = new EventBus();
export default eventBus;
