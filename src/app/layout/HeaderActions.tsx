import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * 模块头部动作槽（AGENTS §18.6）。
 *
 * 页面不再自带标题栏（内层 PageHeader 已移除），模块若要往「外层统一 header」放操作
 * 按钮（如数据中心的「配置」），用 `useHeaderActions(<button .../>)` 注册即可，
 * 动作会被渲染到顶栏右侧，不占用内容显示区域。
 */
interface HeaderActionsContextValue {
  actions: ReactNode;
  setActions: (node: ReactNode) => void;
}

const HeaderActionsContext = createContext<HeaderActionsContextValue | null>(null);

export function HeaderActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActionsState] = useState<ReactNode>(null);
  // setter 保持稳定引用，避免消费方 effect 因上游重渲染反复触发
  const setActions = useCallback((node: ReactNode) => setActionsState(node), []);
  const value = useMemo(() => ({ actions, setActions }), [actions, setActions]);
  return <HeaderActionsContext.Provider value={value}>{children}</HeaderActionsContext.Provider>;
}

/**
 * 注册当前模块的头部动作。node 请用 useMemo 保持引用稳定，否则每次渲染都会重新登记。
 * 组件卸载时自动清空（避免上一个模块的动作残留到下一个页面）。
 */
export function useHeaderActions(node: ReactNode): void {
  const ctx = useContext(HeaderActionsContext);
  const setterRef = useRef(ctx?.setActions);
  setterRef.current = ctx?.setActions;

  useEffect(() => {
    const set = setterRef.current;
    if (!set) return;
    set(node);
    return () => set(null);
  }, [node]);
}

/** 顶栏读取当前模块注册的动作（内部使用） */
export function useHeaderActionsValue(): ReactNode {
  return useContext(HeaderActionsContext)?.actions ?? null;
}
