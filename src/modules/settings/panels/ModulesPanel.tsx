import { useMemo } from "react";
import { EyeOff } from "lucide-react";
import { listModules } from "@/app/registry";
import { Switch } from "@/core/shared/components/Switch";
import { notify } from "@/core/shared/components/Toast";
import { useAppSetting } from "@/core/shared/hooks/useAppSetting";
import { Note } from "../components/Note";

/** 模块可见性面板：AGENTS §15 的操作入口（隐藏 = 藏入口而非禁用，数据完整保留）。 */
export function ModulesPanel() {
  const modules = useMemo(() => listModules(), []);
  const [hidden, setHidden] = useAppSetting<string[]>("hidden_modules", []);

  const toggle = (id: string, name: string, nextHidden: boolean) => {
    setHidden(nextHidden ? [...hidden, id] : hidden.filter((x) => x !== id));
    notify(
      nextHidden ? "info" : "success",
      nextHidden ? `「${name}」已从侧边栏隐藏` : `「${name}」已恢复显示`,
    );
  };

  const business = modules.filter((m) => !m.system);
  const system = modules.filter((m) => m.system);

  return (
    <div className="space-y-5">
      <Note>
        隐藏只收起侧边栏入口，模块数据与配置完整保留；隐藏后仍可用命令面板（Ctrl+K）调起。
      </Note>

      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
          工作模块
        </div>
        <div className="divide-y divide-border">
          {business.map((m) => {
            const Icon = m.icon;
            const isHidden = hidden.includes(m.id);
            return (
              <div key={m.id} className="flex items-center gap-3 py-2.5">
                <Icon size={17} className="shrink-0 text-text-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-text-primary">{m.name}</div>
                  {m.description && (
                    <div className="truncate text-xs text-text-muted">{m.description}</div>
                  )}
                </div>
                <Switch
                  checked={!isHidden}
                  ariaLabel={`${m.name} 显示开关`}
                  title={isHidden ? "点击恢复显示" : "点击隐藏入口"}
                  onChange={() => toggle(m.id, m.name, !isHidden)}
                />
                <span className="w-14 shrink-0 text-right text-xs text-text-muted">
                  {isHidden ? (
                    <span className="inline-flex items-center gap-1">
                      <EyeOff size={12} /> 已隐藏
                    </span>
                  ) : (
                    "显示中"
                  )}
                </span>
              </div>
            );
          })}
          {business.length === 0 && (
            <div className="py-4 text-sm text-text-muted">暂无工作模块</div>
          )}
        </div>
      </div>

      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">系统</div>
        <div className="divide-y divide-border">
          {system.map((m) => {
            const Icon = m.icon;
            return (
              <div key={m.id} className="flex items-center gap-3 py-2.5">
                <Icon size={17} className="shrink-0 text-text-muted" />
                <div className="min-w-0 flex-1 truncate text-sm text-text-primary">{m.name}</div>
                <span className="shrink-0 rounded-pill border border-border px-2 py-0.5 text-[11px] text-text-muted">
                  始终显示
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
