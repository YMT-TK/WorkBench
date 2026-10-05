import { EyeOff } from "lucide-react";
import { api, isTauri } from "@/core/shared/api";
import { Switch } from "@/core/shared/components/Switch";
import { notify } from "@/core/shared/components/Toast";
import { useAppSetting } from "@/core/shared/hooks/useAppSetting";
import { reportError } from "@/core/shared/utils/errors";
import { Note } from "../components/Note";
import { SettingRow } from "../components/SettingRow";

/** 通用：进程级行为（AGENTS §19 托盘 / 关闭语义）。 */
export function GeneralPanel() {
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
              notify("success", v ? "已开启：关闭将收进托盘" : "已关闭：关闭将直接结束程序");
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

      <Note>
        单实例保护已开启：重复启动不会开出第二个窗口，而是唤回正在运行的实例，
        避免同一个数据库被两个进程同时写入。
      </Note>
    </div>
  );
}
