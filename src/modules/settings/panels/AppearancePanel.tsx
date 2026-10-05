import { Check } from "lucide-react";
import { useTheme, type ThemeMode } from "@/app/theme/ThemeProvider";
import { SettingRow } from "../components/SettingRow";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

/** 外观：主题切换（令牌与双值实现见 AGENTS §6）。 */
export function AppearancePanel() {
  const { theme, resolved, setTheme } = useTheme();
  return (
    <div className="space-y-5">
      <SettingRow label="主题" hint={`当前生效：${resolved === "dark" ? "深色" : "浅色"}`}>
        <div className="flex gap-2">
          {THEME_OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => setTheme(o.value)}
              className={`inline-flex items-center gap-1 rounded-pill border px-3 py-1 text-sm transition-colors ${
                theme === o.value
                  ? "border-accent bg-accent/5 text-accent"
                  : "border-border text-text-muted hover:text-text-primary"
              }`}
            >
              {theme === o.value && <Check size={13} />}
              {o.label}
            </button>
          ))}
        </div>
      </SettingRow>
    </div>
  );
}
