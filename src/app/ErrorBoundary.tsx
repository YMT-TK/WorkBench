import { Component, type ReactNode } from "react";
import { errorDetail, safeLog } from "@/core/shared/utils/errors";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * 全局错误边界（AGENTS §11）。
 * 捕获渲染期异常，避免整页白屏并提供降级 UI；技术细节进日志，
 * 不暴露密钥/内部路径（用户可见仅友好文案 + 可选复制详情）。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    // 技术细节入后端日志（AGENTS §11：友好文案对外，技术细节入日志）
    safeLog(`[ErrorBoundary] ${errorDetail(error)} | ${String(info)}`);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-text-primary">
          <div className="text-lg font-semibold">页面出错了</div>
          <div className="max-w-md text-sm text-text-secondary">{this.state.error.message}</div>
          <div className="flex gap-2">
            <button
              className="rounded-pill border border-border px-3 py-1 text-sm text-accent"
              onClick={() => this.setState({ error: null })}
            >
              重试
            </button>
            <button
              className="rounded-pill border border-border px-3 py-1 text-sm text-text-secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(errorDetail(this.state.error));
              }}
            >
              复制详情
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
