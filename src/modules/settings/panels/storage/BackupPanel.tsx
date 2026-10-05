import { useState } from "react";
import { AlertTriangle, Archive, FolderOpen, RotateCw, ShieldCheck, Trash2 } from "lucide-react";
import { api, type BackupAutoMode, type BackupItem } from "@/core/shared/api";
import { Switch } from "@/core/shared/components/Switch";
import { notify } from "@/core/shared/components/Toast";
import { useAppSetting } from "@/core/shared/hooks/useAppSetting";
import { reportError } from "@/core/shared/utils/errors";
import { formatFileSize } from "@/core/shared/utils/format";
import { Note } from "../../components/Note";
import { SectionTitle } from "../../components/SectionTitle";
import { SettingRow } from "../../components/SettingRow";

/**
 * ③ 备份与恢复（设计文档 §7.4）。
 *
 * 快照 = 目录 `backup/backup_<UTC戳>/`（主库 + media/ + manifest.json），
 * 它**同时就是跨机迁移载体**（ADR-14）。恢复三步顺序不可换：
 * ① 校验密钥指纹 → ② 自动留一份 `prerestore_` 快照 → ③ 写成待替换文件（重启生效）。
 */
export function BackupPanel({
  backups,
  onChanged,
}: {
  backups: BackupItem[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [autoBackup, setAutoBackup] = useAppSetting<BackupAutoMode>("backup.auto", "off");
  const [keepCount, setKeepCount] = useAppSetting<number>("backup.keep", 5);
  // 恢复 / 删除是破坏性操作，用「点一次亮出确认条」代替 window.confirm ——
  // 后者在无头 webview 里会一直阻塞，e2e 探针根本过不去。
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const doBackup = () => {
    setBusy(true);
    api
      .backupCreate()
      .then((r) => {
        notify("success", `备份已创建：${r.id}`);
        onChanged();
      })
      .catch((err: unknown) => reportError(err, "创建备份失败"))
      .finally(() => setBusy(false));
  };

  const doRestore = (id: string) => {
    setBusy(true);
    api
      .backupRestore(id)
      .then((r) => {
        setPendingRestore(null);
        notify("success", `已就位（恢复前的快照：${r.preRestoreId}），请重启程序生效`);
        onChanged();
      })
      .catch((err: unknown) => reportError(err, "恢复失败"))
      .finally(() => setBusy(false));
  };

  const doDeleteBackup = (id: string) => {
    api
      .backupDelete(id)
      .then(() => {
        setPendingDelete(null);
        notify("success", "备份已删除");
        onChanged();
      })
      .catch((err: unknown) => reportError(err, "删除备份失败"));
  };

  return (
    <section className="space-y-5 border-t border-border pt-5">
      <SectionTitle
        title="备份与恢复"
        hint={
          backups.length
            ? `共 ${backups.length} 份 · 占用 ${formatFileSize(
                backups.reduce((s, b) => s + b.size, 0),
              )}`
            : "还没有备份"
        }
      />

      <SettingRow label="一键备份" hint="快照 = 主库 + media/，每个文件都做 SHA-256 回读校验">
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={doBackup}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-pill border border-accent px-3 py-1 text-xs text-accent hover:bg-accent/5 disabled:opacity-40"
            >
              <Archive size={12} />
              立即备份
            </button>
            <button
              onClick={() =>
                api
                  .backupOpenDir()
                  .catch((err: unknown) => reportError(err, "打开备份目录失败"))
              }
              className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1 text-xs text-text-secondary hover:bg-bg-sidebar hover:text-text-primary"
            >
              <FolderOpen size={12} />
              打开备份目录
            </button>
          </div>
          <Note tone="warning" icon={<AlertTriangle size={13} />}>
            备份默认落在数据目录内的 <code>backup/</code>，
            <span className="text-text-primary">与数据同一块盘</span>
            —— 盘坏了、目录被误删，备份会一起没。重要数据请用上面的「打开备份目录」
            把快照复制到 U 盘或网盘。
          </Note>
        </div>
      </SettingRow>

      <SettingRow label="自动备份" hint="每次启动时自动创建一份，并按保留份数清理最老的">
        <div className="flex flex-wrap items-center gap-5">
          <label className="flex items-center gap-2 text-xs text-text-muted">
            <Switch
              checked={autoBackup === "on_start"}
              onChange={(v) => setAutoBackup(v ? "on_start" : "off")}
              ariaLabel="启动时自动备份"
            />
            启动时自动备份
          </label>
          <label className="flex items-center gap-2 text-xs text-text-muted">
            保留
            <input
              type="number"
              min={1}
              max={50}
              value={keepCount}
              onChange={(e) => setKeepCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
              aria-label="备份保留份数"
              className="h-7 w-16 rounded-md border border-border bg-surface px-2 text-xs text-text-primary outline-none focus:border-accent"
            />
            份
          </label>
        </div>
      </SettingRow>

      <SettingRow label="备份列表" hint="恢复前会自动给当前状态留一份快照">
        {backups.length === 0 ? (
          <div className="rounded-card border border-dashed border-border px-4 py-6 text-center text-xs text-text-muted">
            还没有备份。点上面的「立即备份」创建第一份。
          </div>
        ) : (
          <div className="divide-y divide-border rounded-card border border-border">
            {backups.map((b) => (
              <div key={b.id} className="space-y-2 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="shrink-0 rounded-pill bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                    {b.isPreRestore ? "恢复前快照" : "备份"}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                    {b.utcStamp}
                  </span>
                  <span className="shrink-0 text-[11px] text-text-muted">
                    {formatFileSize(b.size)}
                  </span>
                  <button
                    onClick={() => setPendingRestore(b.id)}
                    className="shrink-0 rounded-pill border border-accent px-2 py-0.5 text-[11px] text-accent hover:bg-accent/5"
                  >
                    <RotateCw size={11} className="mr-1 inline" />
                    恢复
                  </button>
                  <button
                    onClick={() => setPendingDelete(b.id)}
                    className="shrink-0 rounded-pill border border-border px-2 py-0.5 text-[11px] text-text-muted hover:text-danger"
                  >
                    <Trash2 size={11} className="mr-1 inline" />
                    删除
                  </button>
                </div>
                <div className="text-[11px] text-text-muted">
                  主库 {formatFileSize(b.dbBytes)} · 媒体 {b.mediaFiles} 个文件
                  {b.keyFingerprint ? ` · 密钥指纹 ${b.keyFingerprint}` : " · 无加密字段"}
                  {!b.hasManifest && " · 缺清单文件（信息不全）"}
                </div>
                {pendingRestore === b.id && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-[11px] text-text-secondary">
                    <span className="min-w-0 flex-1">
                      用这份备份<b className="text-text-primary">覆盖当前数据</b>
                      ？恢复前会自动留一份快照，完成后需重启程序。
                    </span>
                    <button
                      onClick={() => doRestore(b.id)}
                      disabled={busy}
                      className="rounded-pill border border-danger px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-40"
                    >
                      确认恢复
                    </button>
                    <button
                      onClick={() => setPendingRestore(null)}
                      className="rounded-pill border border-border px-2 py-0.5 text-[11px] text-text-muted"
                    >
                      取消
                    </button>
                  </div>
                )}
                {pendingDelete === b.id && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md border border-danger/40 bg-danger/10 px-2 py-1.5 text-[11px] text-text-secondary">
                    <span className="min-w-0 flex-1">删除这份备份？删除后不可恢复。</span>
                    <button
                      onClick={() => doDeleteBackup(b.id)}
                      className="rounded-pill border border-danger px-2 py-0.5 text-[11px] text-danger hover:bg-danger/10"
                    >
                      确认删除
                    </button>
                    <button
                      onClick={() => setPendingDelete(null)}
                      className="rounded-pill border border-border px-2 py-0.5 text-[11px] text-text-muted"
                    >
                      取消
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingRow>

      <Note>
        <div className="mb-1 flex items-center gap-1.5 font-medium text-text-secondary">
          <ShieldCheck size={13} />
          换机 / 跨设备复刻
        </div>
        <div>
          · 备份包
          <span className="text-text-secondary">不含密钥</span>
          —— 密钥在本机 OS 凭据库，从没进过数据目录，备份自然带不走它。
        </div>
        <div>· 所以换机要两样一起带走：备份包 + 「导出密钥备份」拿到的 .wbkey。</div>
        <div>
          · 到新机器后顺序固定：
          <span className="text-text-primary">先导入密钥 → 再恢复数据 → 重启</span>。
        </div>
        <div>
          · 顺序反了也不会毁数据：指纹不匹配时恢复会被
          <span className="text-text-primary">直接拒绝</span>
          ，并告诉你要导入哪一把钥匙。
        </div>
        <div>
          · 别手工拼这个顺序了 —— 用下面的「④ 跨机导入」，
          它会按这个顺序走，并且在动手前先验一遍钥匙。
        </div>
      </Note>
    </section>
  );
}
