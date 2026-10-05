import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { CornerDownLeft, EyeOff, Search } from "lucide-react";
import { useAppSetting } from "@/core/shared/hooks/useAppSetting";

/**
 * 命令面板（AGENTS §12-A：全局搜索 Ctrl/Cmd+K）。
 * 注意 AGENTS §15：隐藏 = 藏入口而非禁用 —— 已隐藏模块仍可在此调起（带「已隐藏」标记）。
 */

/**
 * 命令面板所需的最小模块契约。
 *
 * 🔴 刻意**不**引用 `@/app/registry` 的 `ModuleManifest`：`core/` 是平台库层，
 * 不许反向依赖应用骨架 `app/`（AGENTS §21.2 / §21.6）—— 模块清单由外壳经 props 注入。
 * `ModuleManifest` 在结构上满足本接口，调用处无需显式转换。
 */
export interface CommandPaletteModule {
  id: string;
  name: string;
  icon: ComponentType<{ size?: string | number; className?: string }>;
  /** 系统级模块不参与「隐藏」（AGENTS §15）；非 system 才显示「已隐藏」标记 */
  system?: boolean;
}

interface CommandPaletteContextValue {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(null);

export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext);
  if (!ctx) throw new Error("useCommandPalette 必须在 CommandPaletteProvider 内使用");
  return ctx;
}

export function CommandPaletteProvider({
  modules,
  children,
}: {
  /** 🔴 由应用壳注入（`listModules()`）—— `core/` 不认识模块注册表 */
  modules: CommandPaletteModule[];
  children: ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  // 全局快捷键：Ctrl/Cmd+K 开关，Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") setIsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <CommandPaletteContext.Provider value={{ isOpen, open, close }}>
      {children}
      {isOpen && <CommandPalette modules={modules} onClose={close} />}
    </CommandPaletteContext.Provider>
  );
}

function CommandPalette({
  modules,
  onClose,
}: {
  modules: CommandPaletteModule[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hidden] = useAppSetting<string[]>("hidden_modules", []);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return modules.filter(
      (m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q),
    );
  }, [modules, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const run = useCallback(
    (id: string) => {
      navigate(`/${id}`);
      onClose();
    },
    [navigate, onClose],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/25 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="w-[min(560px,calc(100vw-3rem))] overflow-hidden rounded-card border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search size={16} className="shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="跳转到模块…"
            className="h-11 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const it = items[active];
                if (it) run(it.id);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
        </div>

        <ul className="max-h-72 overflow-y-auto py-1">
          {items.map((m, i) => {
            const Icon = m.icon;
            const isHidden = !m.system && hidden.includes(m.id);
            return (
              <li key={m.id}>
                <button
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(m.id)}
                  className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm ${
                    i === active ? "bg-bg-sidebar text-text-primary" : "text-text-secondary"
                  }`}
                >
                  <Icon size={16} className="shrink-0 text-text-muted" />
                  <span className="flex-1 truncate">{m.name}</span>
                  {isHidden && (
                    <span className="inline-flex items-center gap-1 rounded-pill border border-border px-1.5 py-0.5 text-[11px] text-text-muted">
                      <EyeOff size={11} />
                      已隐藏
                    </span>
                  )}
                  {i === active && <CornerDownLeft size={13} className="text-text-muted" />}
                </button>
              </li>
            );
          })}
          {items.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-text-muted">没有匹配的模块</li>
          )}
        </ul>
      </div>
    </div>
  );
}
