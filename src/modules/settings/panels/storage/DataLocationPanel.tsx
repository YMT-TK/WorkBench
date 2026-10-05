import { useCallback, useState } from "react";
import { AlertTriangle, FolderOpen, RotateCcw, ScrollText } from "lucide-react";
import {
  api,
  type MigrationReport,
  type StorageInfo,
} from "@/core/shared/api";
import { notify } from "@/core/shared/components/Toast";
import { errorDetail, reportError, safeLog } from "@/core/shared/utils/errors";
import { formatFileSize } from "@/core/shared/utils/format";
import { Note } from "../../components/Note";
import { SectionTitle } from "../../components/SectionTitle";
import { SettingRow } from "../../components/SettingRow";

/**
 * ① 数据位置（设计文档 §7.1 / §7.3）。
 *
 * 用户**只需改一个根目录**，其下 media / backup / keys / logs 按固定相对布局跟随；
 * 「运行日志」也在这里给出地址 —— 界面里不另做日志浏览（ADR-16）。
 */
export function DataLocationPanel({
  info,
  onChanged,
}: {
  info: StorageInfo;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(info.isCustom ? info.dataDir : "");
  const [migrate, setMigrate] = useState(true);
  const [saving, setSaving] = useState(false);
  const [report, setReport] = useState<MigrationReport | null>(null);
  // 迁移被拒（目标已有主库）时把完整说明留在页面上 —— toast 一闪而过，
  // 而这条信息用户往往要照着它去处置目标目录。
  const [migrateError, setMigrateError] = useState("");

  const openDir = (path: string | null) => {
    api
      .storageOpenDir(path)
      .then(() => undefined)
      .catch((err: unknown) => reportError(err, "打开目录失败"));
  };

  const apply = useCallback(
    (dir: string | null) => {
      setSaving(true);
      setReport(null);
      setMigrateError("");
      api
        .storageSetDir(dir, dir ? migrate : false)
        .then((r) => {
          setReport(r);
          notify(
            "success",
            dir ? `${r.note}；重启程序后生效` : "已恢复默认数据根目录，重启程序后生效",
          );
          onChanged();
        })
        .catch((err: unknown) => {
          const detail = errorDetail(err);
          safeLog(`[settings] storage_set_dir failed: ${detail}`);
          setMigrateError(detail);
          notify("error", "迁移未执行 —— 原因见下方说明");
        })
        .finally(() => setSaving(false));
    },
    [migrate, onChanged],
  );

  const pending = info.pendingDir;
  const totalSize = info.dbSize + info.dirs.reduce((sum, d) => sum + d.size, 0);

  return (
    <section className="space-y-5">
      <SectionTitle title="数据位置" hint={`合计占用 ${formatFileSize(totalSize)}`} />

      {pending && (
        <Note tone="warning" title="重启后生效：">
          数据根目录已改为 <span className="break-all">{pending}</span>，
          请关闭并重新打开程序；本次运行的仍是旧目录。
        </Note>
      )}

      <SettingRow label="数据根目录" hint="唯一需要配置的位置，其余子目录按固定相对路径跟随">
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

      <SettingRow label="目录结构" hint="根目录下的固定布局，改根目录即整体搬迁">
        <div className="divide-y divide-border rounded-card border border-border">
          <div className="flex items-center gap-3 px-3 py-2">
            <span className="shrink-0 rounded-pill bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
              主库
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-xs text-text-secondary">{info.dbPath}</div>
              <div className="text-[11px] text-text-muted">
                SQLite 主库（含 WAL 附属文件）· {formatFileSize(info.dbSize)}
              </div>
            </div>
          </div>
          {info.dirs.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-3 py-2">
              <span className="shrink-0 rounded-pill bg-bg-sidebar px-2 py-0.5 text-[11px] text-text-muted">
                {d.id}/
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-xs text-text-secondary">{d.path}</div>
                <div className="text-[11px] text-text-muted">
                  {d.label} · {d.exists ? formatFileSize(d.size) : "尚未创建（按需生成）"}
                </div>
              </div>
              <button
                onClick={() => openDir(d.path)}
                className="shrink-0 rounded-pill border border-border px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary"
              >
                打开
              </button>
            </div>
          ))}
        </div>
      </SettingRow>

      <SettingRow
        label="运行日志"
        hint="按生成时间保存：当前文件 workbench.log，超过 5MB 滚动为带时间戳的文件，保留最近 10 份"
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-bg-sidebar px-2 py-1 text-xs text-text-secondary">
              {info.logDir}
            </code>
            <button
              onClick={() => openDir(info.logDir)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-border px-3 py-1 text-xs text-text-secondary hover:bg-bg-sidebar hover:text-text-primary"
            >
              <FolderOpen size={13} />
              打开目录
            </button>
          </div>
          {info.logFiles.length > 0 && (
            <div className="divide-y divide-border rounded-card border border-border">
              {info.logFiles.slice(0, 5).map((f) => (
                <div key={f.name} className="flex items-center gap-2 px-3 py-1.5">
                  <ScrollText size={11} className="shrink-0 text-text-muted" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary">
                    {f.name}
                  </span>
                  <span className="shrink-0 text-[11px] text-text-muted">
                    {formatFileSize(f.size)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="text-[11px] text-text-muted">
            日志只落盘、界面里不另做日志浏览 —— 要排查时用上面的按钮打开目录自己看文件。
          </div>
        </div>
      </SettingRow>

      {migrateError && (
        <Note tone="danger" icon={<AlertTriangle size={13} />} title="迁移未执行：">
          <span className="whitespace-pre-line">{migrateError}</span>
        </Note>
      )}

      {report && report.target && (
        <Note tone="success" title={`搬迁完成 · ${report.note}`}>
          {report.parts.map((p) => (
            <div key={p.label}>
              · {p.label}：{p.files} 个文件
              {p.skipped > 0 ? `、跳过 ${p.skipped} 个` : ""}
              {p.bytes > 0 ? ` · ${formatFileSize(p.bytes)}` : ""}
            </div>
          ))}
          <div className="mt-1">全部通过 SHA-256 回读校验；旧目录原样保留，可随时回退。</div>
        </Note>
      )}

      <SettingRow
        label="自定义数据根目录"
        hint={`留空 = 使用默认目录；默认 ${info.defaultDir}`}
      >
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="如 D:\\WorkBenchData"
              aria-label="自定义数据根目录"
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
              title={info.isCustom ? "恢复默认数据根目录" : "当前已是默认目录"}
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

          <Note>
            填写绝对路径，目录不存在会自动创建并做可写性校验。改完需
            <span className="text-text-secondary"> 重启程序 </span>
            才生效；写入使用 SQLite 单连接 + WAL，同一数据库只允许一个进程写。
            <div className="mt-1">
              🔴 目标目录里<span className="text-text-primary">已经有一份 workbench.db</span>
              时，迁移会被直接拒绝 —— 那种情况下「该以哪份为准」没有安全答案，
              所以程序不替你决定，也不会悄悄覆盖。
            </div>
          </Note>
        </div>
      </SettingRow>
    </section>
  );
}
