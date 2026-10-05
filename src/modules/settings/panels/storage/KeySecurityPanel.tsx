import { useState } from "react";
import { AlertTriangle, Download, KeyRound, ShieldCheck, Upload } from "lucide-react";
import { api, type KeyStatus, type StorageInfo } from "@/core/shared/api";
import { notify } from "@/core/shared/components/Toast";
import { reportError } from "@/core/shared/utils/errors";
import { Note } from "../../components/Note";
import { SectionTitle } from "../../components/SectionTitle";
import { SettingRow } from "../../components/SettingRow";
import { keyStateBanner } from "./keyState";

/**
 * ② 密钥与安全（AGENTS §7 / 设计文档 §8）。
 *
 * 主密钥存 OS 凭据库，**没有路径概念** —— 所以这里**没有「密钥路径」输入框**。
 * 唯一的路径项是 `.wbkey`（口令加密的可移植密钥文件）的导出位置。
 */
export function KeySecurityPanel({
  info,
  status,
  onChanged,
}: {
  info: StorageInfo;
  status: KeyStatus | null;
  onChanged: () => void;
}) {
  const keysDir = info.dirs.find((d) => d.id === "keys")?.path ?? info.runningDir;
  const [exportPath, setExportPath] = useState(`${keysDir}\\master-key.wbkey`);
  const [exportPass, setExportPass] = useState("");
  const [importPath, setImportPath] = useState("");
  const [importPass, setImportPass] = useState("");
  const [busy, setBusy] = useState(false);

  const banner = status ? keyStateBanner(status.state) : null;

  const doExport = () => {
    const target = exportPath.trim();
    if (!target) {
      notify("warning", "请先填写导出路径");
      return;
    }
    if (exportPass.length < 8) {
      notify("warning", "口令至少 8 个字符 —— 它是这个文件唯一的防线");
      return;
    }
    setBusy(true);
    api
      .keyExportWbkey(target, exportPass)
      .then((written) => {
        setExportPass("");
        notify("success", `密钥已导出：${written}`);
        onChanged();
      })
      .catch((err: unknown) => reportError(err, "导出密钥失败"))
      .finally(() => setBusy(false));
  };

  const doImport = () => {
    const target = importPath.trim();
    if (!target) {
      notify("warning", "请先填写要导入的 .wbkey 文件路径");
      return;
    }
    setBusy(true);
    // replace 恒为 false：这个入口**绝不**替用户决定「顶掉在用密钥」，
    // 需要替换时走「④ 跨机导入」向导，那里有显式确认。
    api
      .keyImportWbkey(target, importPass, false)
      .then((res) => {
        setImportPass("");
        notify("success", `密钥导入完成（指纹 ${res.fingerprint}）`);
        onChanged();
      })
      .catch((err: unknown) => reportError(err, "导入密钥失败"))
      .finally(() => setBusy(false));
  };

  return (
    <section className="space-y-5 border-t border-border pt-5">
      <SectionTitle title="密钥与安全" hint="字段级加密：会员密码 / Git Token / API Key" />

      {banner && (
        <Note tone={banner.tone} icon={<AlertTriangle size={13} />} title={banner.title}>
          {banner.desc}
        </Note>
      )}

      <SettingRow
        label="主密钥"
        hint={status ? `算法 ${status.algorithm}（字段级，非整库加密）` : "读取中…"}
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs ${
                !status
                  ? "border-border text-text-muted"
                  : status.state === "ok"
                    ? "border-success/40 text-success"
                    : status.state === "mismatch" || status.state === "missing"
                      ? "border-danger/40 text-danger"
                      : "border-warning/40 text-warning"
              }`}
            >
              <KeyRound size={12} />
              {!status
                ? "读不到凭据库"
                : status.state === "ok"
                  ? "密钥与数据匹配"
                  : status.exists
                    ? "密钥已就位（未与数据匹配）"
                    : "主密钥尚未生成"}
            </span>
            <span className="text-[11px] text-text-muted">
              存放：{status ? `${status.service} / ${status.account}` : "本机 OS 凭据库"} ·
              Windows 凭据管理器
            </span>
          </div>
          {status?.fingerprint && (
            <code className="block break-all rounded-md border border-border bg-bg-sidebar px-2 py-1 text-xs text-text-muted">
              密钥指纹 {status.fingerprint}
              {status.storedFingerprint && status.storedFingerprint !== status.fingerprint
                ? ` · 数据记录的指纹 ${status.storedFingerprint}`
                : ""}
            </code>
          )}
        </div>
      </SettingRow>

      <Note>
        <div className="mb-1 flex items-center gap-1.5 font-medium text-text-secondary">
          <ShieldCheck size={13} />
          保护范围
        </div>
        <div>· 加密：会员密码、Git Token、API Key 等敏感字段（经 secure 接口写入的值）</div>
        <div>· 不加密：音频等媒体文件（体积大、无密级，不放进数据库）</div>
        <div>
          · 主密钥只存本机 OS 凭据库，不进数据库、不进配置文件，
          <span className="text-text-secondary">也没有路径可配</span>。
        </div>
      </Note>

      <SettingRow
        label="导出密钥备份"
        hint="口令加密的 .wbkey：换机 / 重装系统前务必导出一份"
      >
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={exportPath}
              onChange={(e) => setExportPath(e.target.value)}
              placeholder="如 D:\\keys\\master-key.wbkey"
              aria-label="密钥导出路径"
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm text-text-primary outline-none focus:border-accent"
            />
            <input
              value={exportPass}
              onChange={(e) => setExportPass(e.target.value)}
              type="password"
              placeholder="设置口令（≥8 位）"
              aria-label="密钥导出口令"
              className="h-8 w-40 shrink-0 rounded-md border border-border bg-surface px-2 text-sm text-text-primary outline-none focus:border-accent"
            />
            <button
              onClick={doExport}
              disabled={busy || !exportPath.trim()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-accent px-3 py-1 text-xs text-accent hover:bg-accent/5 disabled:opacity-40"
            >
              <Download size={12} />
              导出密钥
            </button>
          </div>
          <Note>
            导出的是<span className="text-text-secondary">用你的口令二次加密</span>
            的文件，不是密钥明文：文件被拷走、没有口令也解不开；反过来，口令忘了这份备份也就废了
            —— 请把口令记在密码管理器里。
          </Note>
        </div>
      </SettingRow>

      <SettingRow
        label="导入密钥"
        hint="公司电脑 → 个人笔记本：先导入密钥，再打开拷来的数据库"
      >
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={importPath}
              onChange={(e) => setImportPath(e.target.value)}
              placeholder="选择或粘贴 .wbkey 文件路径"
              aria-label="密钥导入路径"
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm text-text-primary outline-none focus:border-accent"
            />
            <input
              value={importPass}
              onChange={(e) => setImportPass(e.target.value)}
              type="password"
              placeholder="输入该文件的口令"
              aria-label="密钥导入口令"
              className="h-8 w-40 shrink-0 rounded-md border border-border bg-surface px-2 text-sm text-text-primary outline-none focus:border-accent"
            />
            <button
              onClick={doImport}
              disabled={busy || !importPath.trim()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-accent px-3 py-1 text-xs text-accent hover:bg-accent/5 disabled:opacity-40"
            >
              <Upload size={12} />
              导入密钥
            </button>
          </div>
          <Note tone="warning" icon={<AlertTriangle size={13} />} title="密钥丢了就真的回不来了。">
            已加密字段无法重置也无法绕过；反过来，任何拿到密钥的人都能解开你的敏感数据。
            程序<span className="text-text-primary">不会</span>
            在缺密钥时自动生成新的 —— 那只会把已有密文全部作废。
            <div className="mt-1">
              更好的做法是走下面的「④ 跨机导入」：它会把密钥与备份包**一起**校验，
              顺序也不会搞反。
            </div>
          </Note>
        </div>
      </SettingRow>
    </section>
  );
}
