import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ArrowLeft, Check, HardDriveDownload, RefreshCw, X } from "lucide-react";
import {
  api,
  isTauri,
  type BackupItem,
  type ImportKeyResult,
  type ImportPrecheck,
  type PackInfo,
  type RestoreReport,
  type WbkeyHeader,
} from "@/core/shared/api";
import { notify } from "@/core/shared/components/Toast";
import { errorDetail, safeLog } from "@/core/shared/utils/errors";
import { Note } from "../../components/Note";
import { DoneStep, KeyStep, PackStep, ReviewStep } from "./ImportStageViews";

type Stage = "pack" | "key" | "review" | "done";

/**
 * 「从别的电脑导入」向导（设计文档 §7.6 / ADR-17）。
 *
 * 场景：公司电脑 → 家里笔记本。用户手上是**备份包目录 + .wbkey** 两样东西。
 *
 * ## 为什么值得做成向导
 * 原来这两步是分开的两个入口（密钥导入 / 恢复），顺序只写在页面的一段说明文字里。
 * 顺序反了虽然不会毁数据（恢复会被拒绝），但用户得自己记住并来回跳。
 * 向导把这个顺序变成**程序强制的**，并且**先做只读预检**：
 * 指纹对不上就在这一步停下 —— 此时磁盘上什么都还没改。
 *
 * ## 为什么第一步只读 `.wbkey` 的明文头
 * `fp` / `created` 在文件里本来就是明文，所以「文件选对没有」这一步**不需要口令** ——
 * 选错文件时用户不用先输一遍口令才知道错了。
 *
 * 视图部分见 `ImportStageViews.tsx`；本文件只管**状态与请求编排**。
 */
export function ImportWizard({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [stage, setStage] = useState<Stage>("pack");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [pack, setPack] = useState<PackInfo | null>(null);
  const [keyPath, setKeyPath] = useState("");
  const [keyHead, setKeyHead] = useState<WbkeyHeader | null>(null);
  const [pass, setPass] = useState("");

  const [pre, setPre] = useState<ImportPrecheck | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const [outcome, setOutcome] = useState<{
    replaced: boolean;
    previousFingerprint: string | null;
    adopted: BackupItem;
    restored: RestoreReport;
  } | null>(null);

  /** 系统「选目录」对话框 —— 只在真机里有；浏览器调试环境直接收起。 */
  async function pickDirectory(title: string): Promise<string | null> {
    if (!isTauri()) {
      notify("info", "浏览器调试环境没有系统文件对话框，请在真机里试");
      return null;
    }
    try {
      const picked = await open({ directory: true, multiple: false, title });
      return typeof picked === "string" ? picked : null;
    } catch (e) {
      setErr(errorDetail(e));
      return null;
    }
  }

  async function runPrecheck(dir: string, kp: string, pp: string): Promise<boolean> {
    setBusy(true);
    setErr("");
    try {
      const r = await api.importPrecheck(dir, kp, pp);
      setPre(r);
      setStage("review");
      return true;
    } catch (e) {
      setErr(errorDetail(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const choosePack = async () => {
    setErr("");
    const dir = await pickDirectory(
      "选择备份包目录（里面应有 workbench.db 与 manifest.json）",
    );
    if (!dir) return;
    setBusy(true);
    try {
      const info = await api.importInspect(dir);
      setPack(info);
      // 换了备份包 → 之前选的密钥与预检结果全部作废，别让它们串台。
      setKeyPath("");
      setKeyHead(null);
      setPass("");
      setPre(null);
      setConfirmReplace(false);
      if (info.keyFingerprint) {
        setStage("key");
      } else {
        await runPrecheck(dir, "", "");
      }
    } catch (e) {
      setErr(errorDetail(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseKey = async () => {
    setErr("");
    if (!isTauri()) {
      notify("info", "浏览器调试环境没有系统文件对话框，请在真机里试");
      return;
    }
    let picked: string | null = null;
    try {
      const r = await open({
        multiple: false,
        directory: false,
        title: "选择密钥文件（.wbkey）",
        filters: [{ name: "WorkBench 密钥", extensions: ["wbkey"] }],
      });
      picked = typeof r === "string" ? r : null;
    } catch (e) {
      setErr(errorDetail(e));
      return;
    }
    if (!picked) return;
    setBusy(true);
    try {
      // 只读明文头：这一步不需要口令，就能判断「文件选对没有」。
      setKeyHead(await api.wbkeyInspect(picked));
      setKeyPath(picked);
      setPre(null);
    } catch (e) {
      setErr(errorDetail(e));
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!pack || !pre) return;
    setBusy(true);
    setErr("");
    try {
      // 顺序固定：① 装密钥 → ② 登记备份包 → ③ 恢复（留 prerestore 快照 + 待替换）
      let installed: ImportKeyResult | null = null;
      if (pack.keyFingerprint) {
        installed = await api.keyImportWbkey(keyPath, pass, confirmReplace);
      }
      const adopted = await api.importAdopt(pack.path);
      const restored = await api.backupRestore(adopted.id);
      setOutcome({
        replaced: installed?.replaced ?? false,
        previousFingerprint: installed?.previousFingerprint ?? null,
        adopted,
        restored,
      });
      setStage("done");
      notify("success", "导入完成，重启程序后生效");
    } catch (e) {
      const detail = errorDetail(e);
      safeLog(`[import] cross-device import failed: ${detail}`);
      setErr(detail);
    } finally {
      setBusy(false);
    }
  };

  const steps =
    pack && !pack.keyFingerprint
      ? ["备份包", "确认", "完成"]
      : ["备份包", "密钥", "确认", "完成"];
  const stepIndex =
    stage === "pack"
      ? 0
      : stage === "key"
        ? 1
        : stage === "review"
          ? steps.length - 2
          : steps.length - 1;

  const canExecute =
    pre !== null &&
    pre.verdict !== "mismatch" &&
    (pre.verdict !== "replaces_local_key" || confirmReplace) &&
    !busy;

  // 返回上一步：没有密钥需求时「确认」的前一步是「备份包」。
  const backStage: Stage = pack?.keyFingerprint ? "key" : "pack";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="从别的电脑导入"
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/25 p-4 pt-[5vh]"
      onClick={onClose}
    >
      <div
        className="w-[min(660px,calc(100vw-2rem))] overflow-hidden rounded-card border border-border bg-surface shadow-float"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <HardDriveDownload size={16} className="shrink-0 text-accent" />
          <span className="flex-1 text-sm font-medium text-text-primary">从别的电脑导入</span>
          <button
            onClick={onClose}
            aria-label="关闭向导"
            className="rounded-md p-1 text-text-muted hover:bg-bg-sidebar hover:text-text-primary"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-[11px] text-text-muted">
          {steps.map((s, i) => (
            <span key={s} className="flex items-center gap-1.5">
              {i > 0 && <span className="opacity-50">›</span>}
              <span className={i === stepIndex ? "font-medium text-accent" : ""}>
                {i < stepIndex ? "✓ " : ""}
                {s}
              </span>
            </span>
          ))}
        </div>

        <div className="space-y-3 px-4 py-4">
          {err && (
            <Note tone="danger" icon={<AlertTriangle size={13} />} title="出错了：">
              <span className="whitespace-pre-line">{err}</span>
            </Note>
          )}

          {stage === "pack" && <PackStep busy={busy} onChoose={choosePack} />}

          {stage === "key" && pack && (
            <KeyStep
              pack={pack}
              keyPath={keyPath}
              keyHead={keyHead}
              pass={pass}
              busy={busy}
              onChooseKey={chooseKey}
              onPassChange={setPass}
              onVerify={() => runPrecheck(pack.path, keyPath, pass)}
            />
          )}

          {stage === "review" && pack && pre && (
            <ReviewStep
              pack={pack}
              pre={pre}
              confirmReplace={confirmReplace}
              onConfirmChange={setConfirmReplace}
            />
          )}

          {stage === "done" && outcome && <DoneStep outcome={outcome} />}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          {stage === "review" && !busy && (
            <button
              onClick={() => setStage(backStage)}
              className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1 text-xs text-text-muted hover:text-text-primary"
            >
              <ArrowLeft size={12} />
              {pre?.verdict === "mismatch" ? "换一个密钥文件" : "上一步"}
            </button>
          )}
          {busy && (
            <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
              <RefreshCw size={12} className="animate-spin" />
              处理中…
            </span>
          )}
          <span className="flex-1" />
          {stage === "review" && (
            <button
              onClick={execute}
              disabled={!canExecute}
              className="inline-flex items-center gap-1.5 rounded-pill border border-accent bg-accent/5 px-3 py-1 text-xs text-accent hover:bg-accent/10 disabled:opacity-40"
            >
              <HardDriveDownload size={12} />
              执行导入
            </button>
          )}
          {stage === "done" && (
            <button
              onClick={() => {
                onDone();
                onClose();
              }}
              className="inline-flex items-center gap-1.5 rounded-pill border border-accent px-3 py-1 text-xs text-accent hover:bg-accent/5"
            >
              <Check size={12} />
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
