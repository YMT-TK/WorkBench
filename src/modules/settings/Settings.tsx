import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Check,
  Cog,
  Eye,
  EyeOff,
  FolderOpen,
  HardDrive,
  Info,
  Palette,
  RotateCcw,
  Settings as SettingsIcon,
} from "lucide-react";
import { listModules, registerModule } from "@/app/registry";
import { useTheme, type ThemeMode } from "@/app/theme/ThemeProvider";
import { api, isTauri, type StorageInfo } from "@/core/shared/api";
import { Card } from "@/core/shared/components/Card";
import { ErrorState, LoadingState } from "@/core/shared/components/States";
import { Switch } from "@/core/shared/components/Switch";
import { notify } from "@/core/shared/components/Toast";
import { useAppSetting } from "@/core/shared/hooks/useAppSetting";
import { errorDetail, reportError, safeLog } from "@/core/shared/utils/errors";
import { formatFileSize } from "@/core/shared/utils/format";

const SubMenus = [
  { id: "appearance", name: "外观", icon: Palette },
  { id: "general", name: "通用", icon: Cog },
  { id: "data", name: "数据", icon: HardDrive },
  { id: "modules", name: "模块", icon: Eye },
  { id: "about", name: "关于", icon: Info },
] as const;

type SubId = (typeof SubMenus)[number]["id"];

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

function Appearance() {
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

/** 通用：进程级行为（AGENTS §19 托盘 / 关闭语义） */
function GeneralPanel() {
  const [closeToTray, setCloseToTray] = useAppSetting<boolean>("close_to_tray", true);

  const hideNow = () => {
    if (!isTauri()) {
      notify("info", "浏览器调试环境没有系统托盘，请在真机里试");
      return;
    }
    api.appHideToTray().catch((err: unknown) => reportError(err, "隐藏到托盘失败"));
  };

  return (
    <div className="space-y-5">
      <SettingRow
        label="关闭窗口时最小化到托盘"
        hint={closeToTray ? "点右上角 ✕ 只收进托盘，程序不退出" : "点右上角 ✕ 会直接结束程序"}
      >
        <div className="flex items-center gap-3">
          <Switch
            checked={closeToTray}
            ariaLabel="关闭到托盘开关"
            onChange={(v) => {
              setCloseToTray(v);
              notify(
                "success",
                v ? "已开启：关闭将收进托盘" : "已关闭：关闭将直接结束程序",
              );
            }}
          />
          <span className="text-xs text-text-muted">{closeToTray ? "开启" : "关闭"}</span>
        </div>
      </SettingRow>

      <SettingRow label="托盘" hint="单击托盘图标还原窗口；右键菜单里才有「退出 WorkBench」">
        <button
          onClick={hideNow}
          className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1 text-xs text-text-secondary hover:bg-bg-sidebar hover:text-text-primary"
        >
          <EyeOff size={13} />
          立即隐藏到托盘
        </button>
      </SettingRow>

      <div className="rounded-card border border-border bg-bg-sidebar px-3 py-2 text-xs text-text-muted">
        单实例保护已开启：重复启动不会开出第二个窗口，而是唤回正在运行的实例，
        避免同一个数据库被两个进程同时写入。
      </div>
    </div>
  );
}

/**
 * 数据：本机 SQLite 的存放位置（AGENTS §20）。
 * 修改目录需重启生效 —— 数据库连接在进程启动时就已打开，无法热切换。
 */
function DataPanel() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errText, setErrText] = useState("");
  const [draft, setDraft] = useState("");
  const [migrate, setMigrate] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    if (!isTauri()) {
      // 浏览器调试环境没有 IPC，预期内降级（真机才会有真实数据）
      setStatus("ready");
      return;
    }
    setStatus("loading");
    api
      .storageInfo()
      .then((v) => {
        setInfo(v);
        setDraft(v.isCustom ? v.dataDir : "");
        setStatus("ready");
      })
      .catch((err: unknown) => {
        // 这里只渲染 ErrorState（不弹 toast，避免反复打扰）；但按 §11 必须留下日志，
        // 否则「读不到存储信息」会变成一段无迹可查的静默失败。
        safeLog(`[settings] storage_info failed: ${errorDetail(err)}`);
        setErrText(errorDetail(err));
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const apply = useCallback(
    (dir: string | null) => {
      setSaving(true);
      api
        .storageSetDir(dir, dir ? migrate : false)
        .then(() => {
          notify(
            "success",
            dir ? "已保存数据目录，重启程序后生效" : "已恢复默认数据目录，重启程序后生效",
          );
          load();
        })
        .catch((err: unknown) => reportError(err, "设置数据目录失败"))
        .finally(() => setSaving(false));
    },
    [load, migrate],
  );

  const openDir = (path?: string | null) => {
    api
      .storageOpenDir(path)
      .then(() => undefined)
      .catch((err: unknown) => reportError(err, "打开目录失败"));
  };

  if (status === "loading") return <LoadingState label="读取存储信息…" />;
  if (status === "error") {
    return (
      <ErrorState
        title="读取存储信息失败"
        description={errText}
        onRetry={load}
      />
    );
  }
  if (!info) {
    return (
      <div className="rounded-card border border-dashed border-border px-4 py-8 text-center text-xs text-text-muted">
        浏览器调试环境读不到本机存储信息；请在真机（<code>npm run dev:app</code>）中查看。
      </div>
    );
  }

  const pending = info.pendingDir;

  return (
    <div className="space-y-5">
      {pending && (
        <div className="rounded-card border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-text-secondary">
          <span className="font-medium text-text-primary">重启后生效：</span>
          数据目录已改为 <span className="break-all">{pending}</span>，
          请关闭并重新打开程序；本次运行的仍是旧目录。
        </div>
      )}

      <SettingRow label="数据目录" hint="本机 SQLite 数据库所在位置">
        <div className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-bg-sidebar px-2 py-1 text-xs text-text-secondary">
            {info.runningDir}
          </code>
          <button
            onClick={() => openDir(info.runningDir)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-border px-3 py-1 text-xs text-text-secondary hover:bg-bg-sidebar hover:text-text-primary"
          >
            <FolderOpen size={13} />
            打开目录
          </button>
        </div>
      </SettingRow>

      <SettingRow label="数据库文件" hint={`占用 ${formatFileSize(info.dbSize)}（含 WAL 附属文件）`}>
        <code className="block break-all rounded-md border border-border bg-bg-sidebar px-2 py-1 text-xs text-text-muted">
          {info.dbPath}
        </code>
      </SettingRow>

      <SettingRow
        label="自定义数据目录"
        hint={`留空 = 使用默认目录；默认 ${info.defaultDir}`}
      >
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="如 D:\\WorkBenchData"
              aria-label="自定义数据目录"
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm text-text-primary outline-none focus:border-accent"
            />
            <button
              onClick={() => apply(draft.trim())}
              disabled={saving || draft.trim() === ""}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-accent px-3 py-1 text-xs text-accent hover:bg-accent/5 disabled:opacity-40"
            >
              应用
            </button>
            <button
              onClick={() => {
                setDraft("");
                apply(null);
              }}
              disabled={saving || !info.isCustom}
              title={info.isCustom ? "恢复默认数据目录" : "当前已是默认目录"}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-border px-3 py-1 text-xs text-text-muted hover:text-text-primary disabled:opacity-40"
            >
              <RotateCcw size={12} />
              恢复默认
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={migrate}
              onChange={(e) => setMigrate(e.target.checked)}
              className="h-3.5 w-3.5 accent-[rgb(var(--accent-rgb))]"
            />
            同时把现有数据库复制到新目录（<span className="text-text-secondary">只复制不删除</span>
            ，旧目录原样保留，可随时回退）
          </label>

          <div className="rounded-card border border-border bg-bg-sidebar px-3 py-2 text-xs text-text-muted">
            填写绝对路径，目录不存在会自动创建并做可写性校验。改完需
            <span className="text-text-secondary"> 重启程序 </span>
            才生效；写入使用 SQLite 单连接 + WAL，同一数据库只允许一个进程写。
          </div>
        </div>
      </SettingRow>
    </div>
  );
}

/** 模块可见性面板：补 AGENTS §15 的可操作入口（此前只有读取逻辑，无任何地方可改） */
function ModulesPanel() {
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
      <div className="rounded-card border border-border bg-bg-sidebar px-3 py-2 text-xs text-text-muted">
        隐藏只收起侧边栏入口，模块数据与配置完整保留；隐藏后仍可用命令面板（Ctrl+K）调起。
      </div>

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

function About() {
  // 模块清单驱动，避免新增模块后这里的架构说明漏改（AGENTS §2 规约 2）
  const mods = listModules();
  const home = mods.find((m) => m.pinned);
  const business = mods.filter((m) => !m.system && !m.pinned);
  const archText = [home?.name, ...business.map((m) => m.name)].filter(Boolean).join(" + ");
  return (
    <div className="space-y-1.5 text-sm text-text-secondary">
      <div className="text-text-primary">WorkBench · 桌面工作台</div>
      <div>版本 0.1.0</div>
      <div>插件化架构：{archText || "—"}</div>
      <div className="pt-1 text-xs text-text-muted">
        命令面板 Ctrl+K · 数据存于本机 SQLite（单实例独占写） · 关闭默认收进系统托盘
      </div>
    </div>
  );
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-sm text-text-secondary">{label}</span>
        {hint && <span className="text-xs text-text-muted">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export default function Settings() {
  const [sub, setSub] = useState<SubId>("appearance");
  return (
    <div className="flex h-full">
      <aside className="w-44 shrink-0 border-r border-border p-3">
        <div className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
          设置
        </div>
        <div className="space-y-0.5">
          {SubMenus.map((m) => {
            const Icon = m.icon;
            const active = sub === m.id;
            return (
              <button
                key={m.id}
                onClick={() => setSub(m.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  active
                    ? "bg-surface font-medium text-accent"
                    : "text-text-secondary hover:bg-surface/60 hover:text-text-primary"
                }`}
              >
                <Icon size={15} className="shrink-0" />
                {m.name}
              </button>
            );
          })}
        </div>
      </aside>
      <section className="min-w-0 flex-1 overflow-auto p-5">
        <div className="mb-3 text-xs font-medium uppercase tracking-wide text-text-muted">
          {SubMenus.find((m) => m.id === sub)?.name ?? "设置"}
        </div>
        <Card>
          {sub === "appearance" && <Appearance />}
          {sub === "general" && <GeneralPanel />}
          {sub === "data" && <DataPanel />}
          {sub === "modules" && <ModulesPanel />}
          {sub === "about" && <About />}
        </Card>
      </section>
    </div>
  );
}

registerModule({
  id: "settings",
  name: "设置",
  description: "外观、通用行为、数据存储与模块可见性",
  icon: SettingsIcon,
  component: Settings,
  order: 90,
  system: true,
});
