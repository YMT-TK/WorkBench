import { AlertTriangle, Check, FileKey, FolderOpen, ShieldCheck } from "lucide-react";
import type {
  ImportPrecheck,
  PackInfo,
  RestoreReport,
  WbkeyHeader,
} from "@/core/shared/api";
import { formatFileSize } from "@/core/shared/utils/format";
import { Note } from "../../components/Note";

/**
 * 跨机导入向导的**四个阶段视图**（纯展示，不含状态与请求）。
 *
 * 与 `ImportWizard.tsx`（状态机 + 请求编排）分开，是为了让两边都能一眼读完：
 * 向导最怕的是「校验结果写歪了」，而那种错误只有把视图单独拎出来才好审。
 */

const sameFp = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** 备份包概况卡：让用户确认「这确实是我那份」。 */
export function PackSummary({ pack }: { pack: PackInfo }) {
  return (
    <div className="rounded-card border border-border bg-bg-sidebar px-3 py-2 text-xs text-text-muted">
      <div className="truncate font-mono text-[11px] text-text-secondary">{pack.path}</div>
      <div className="mt-1">
        · 打包时间 {pack.utcStamp} · 主库 {formatFileSize(pack.dbBytes)} · 媒体 {pack.mediaFiles}{" "}
        个文件
      </div>
      {pack.sourceDir && <div>· 来源目录 {pack.sourceDir}</div>}
      <div>
        · 要求密钥{" "}
        {pack.keyFingerprint ? (
          <code className="text-text-secondary">{pack.keyFingerprint}</code>
        ) : (
          "无（这份数据没有加密字段）"
        )}
      </div>
      {pack.idAdjusted && (
        <div className="text-text-secondary">· 目录名会被规范化为「{pack.id}」</div>
      )}
      {!pack.hasManifest && (
        <div className="text-warning">· 缺 manifest.json（信息不全，也无法核对完整性）</div>
      )}
    </div>
  );
}

/** 第一步：选备份包目录。 */
export function PackStep({ busy, onChoose }: { busy: boolean; onChoose: () => void }) {
  return (
    <>
      <p className="text-xs leading-relaxed text-text-secondary">
        先选旧机器上导出的那个<span className="text-text-primary">备份包目录</span> ——
        里面应当有 <code>workbench.db</code> 与 <code>manifest.json</code>。
        选中后程序会先读出「它要求哪把钥匙」，再向你要密钥。
      </p>
      <button
        onClick={onChoose}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-pill border border-accent px-3 py-1 text-xs text-accent hover:bg-accent/5 disabled:opacity-40"
      >
        <FolderOpen size={12} />
        选择备份包目录…
      </button>
    </>
  );
}

/** 第二步：选 .wbkey 并输入口令。 */
export function KeyStep({
  pack,
  keyPath,
  keyHead,
  pass,
  busy,
  onChooseKey,
  onPassChange,
  onVerify,
}: {
  pack: PackInfo;
  keyPath: string;
  keyHead: WbkeyHeader | null;
  pass: string;
  busy: boolean;
  onChooseKey: () => void;
  onPassChange: (v: string) => void;
  onVerify: () => void;
}) {
  const matched = keyHead ? sameFp(keyHead.fingerprint, pack.keyFingerprint) : false;
  return (
    <>
      <PackSummary pack={pack} />

      <div className="flex items-center gap-2">
        <FileKey size={13} className="shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
          {keyPath || "还没有选择密钥文件"}
        </span>
        <button
          onClick={onChooseKey}
          disabled={busy}
          className="shrink-0 rounded-pill border border-border px-3 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
        >
          选择密钥文件…
        </button>
      </div>

      {keyHead && (
        <div
          className={`rounded-card border px-3 py-2 text-xs text-text-secondary ${
            matched ? "border-success/40 bg-success/10" : "border-danger/40 bg-danger/10"
          }`}
        >
          {matched ? (
            <span>
              ✓ 指纹一致（<code>{keyHead.fingerprint}</code>
              ）—— 这个文件就是这份数据要的钥匙。
            </span>
          ) : (
            <span>
              ✗ 指纹对不上：这份数据要 <code>{pack.keyFingerprint}</code>，而这个文件是{" "}
              <code>{keyHead.fingerprint}</code>。请换用导出备份时同时导出的那个密钥文件。
            </span>
          )}
          {keyHead.created > 0 && (
            <div className="mt-1 text-[11px] text-text-muted">
              该文件导出于 {new Date(keyHead.created * 1000).toLocaleString()}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={pass}
          onChange={(e) => onPassChange(e.target.value)}
          type="password"
          placeholder="输入该 .wbkey 的口令"
          aria-label="导入向导口令"
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 text-sm text-text-primary outline-none focus:border-accent"
        />
        <button
          onClick={onVerify}
          disabled={busy || !keyPath || pass.length < 8}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-accent px-3 py-1 text-xs text-accent hover:bg-accent/5 disabled:opacity-40"
        >
          <ShieldCheck size={12} />
          验证密钥
        </button>
      </div>
      <div className="text-[11px] text-text-muted">
        口令只用于在本机解开这个文件，
        <span className="text-text-secondary">不会被保存</span>。验证通过后才会进入下一步。
      </div>
    </>
  );
}

/** 第三步：预检结果 + 确认。 */
export function ReviewStep({
  pack,
  pre,
  confirmReplace,
  onConfirmChange,
}: {
  pack: PackInfo;
  pre: ImportPrecheck;
  confirmReplace: boolean;
  onConfirmChange: (v: boolean) => void;
}) {
  const tone =
    pre.verdict === "mismatch"
      ? "danger"
      : pre.verdict === "replaces_local_key"
        ? "warning"
        : "success";

  return (
    <>
      <PackSummary pack={pack} />

      <Note
        tone={tone}
        icon={pre.verdict === "mismatch" ? <AlertTriangle size={13} /> : <ShieldCheck size={13} />}
        title="校验结果："
      >
        {pre.summary}
      </Note>

      {pre.warnings.map((w) => (
        <Note key={w} tone="warning" icon={<AlertTriangle size={13} />}>
          {w}
        </Note>
      ))}

      {pre.verdict !== "mismatch" && (
        <div className="rounded-card border border-border bg-bg-sidebar px-3 py-2 text-xs text-text-muted">
          <div className="mb-1 font-medium text-text-secondary">将要执行：</div>
          <div>① {pack.keyFingerprint ? "把密钥写入本机凭据库" : "无需密钥，跳过此步"}</div>
          <div>② 把备份包复制进本机 backup/ 并登记（逐文件 SHA-256 校验）</div>
          <div>③ 恢复数据：先自动留一份「恢复前快照」，再写成待替换文件</div>
          <div className="mt-1 text-text-secondary">完成后需要重启程序才生效。</div>
        </div>
      )}

      {pre.verdict === "replaces_local_key" && (
        <label className="flex items-start gap-2 rounded-card border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={confirmReplace}
            onChange={(e) => onConfirmChange(e.target.checked)}
            aria-label="确认替换本机密钥"
            className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[rgb(var(--danger-rgb))]"
          />
          <span>
            我确认<span className="font-medium text-text-primary">替换本机在用的密钥</span>
            ，并知晓本机原有加密字段将无法再解开。
          </span>
        </label>
      )}
    </>
  );
}

/** 第四步：完成。 */
export function DoneStep({
  outcome,
}: {
  outcome: {
    replaced: boolean;
    previousFingerprint: string | null;
    adopted: { id: string };
    restored: RestoreReport;
  };
}) {
  return (
    <>
      <Note tone="success" icon={<Check size={13} />} title="导入完成">
        备份包已登记为本机快照「{outcome.adopted.id}」，数据已就位（恢复前的快照：
        {outcome.restored.preRestoreId}）。
      </Note>
      <div className="rounded-card border border-border bg-bg-sidebar px-3 py-2 text-xs text-text-muted">
        <div>· 主库 {formatFileSize(outcome.restored.dbBytes)}</div>
        <div>· 媒体 {outcome.restored.mediaFiles} 个文件</div>
        {outcome.replaced && (
          <div className="text-text-secondary">
            · 已替换本机原有密钥
            {outcome.previousFingerprint && `（旧指纹 ${outcome.previousFingerprint}）`}
          </div>
        )}
      </div>
      <Note tone="warning" icon={<AlertTriangle size={13} />} title="还差最后一步：">
        请<span className="font-medium text-text-primary">关闭并重新打开程序</span>
        —— 数据库连接在启动时就打开了，没法热切换，本次运行读到的仍是旧数据。
      </Note>
    </>
  );
}
