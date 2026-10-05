import { ErrorState, LoadingState } from "@/core/shared/components/States";
import { BackupPanel } from "./BackupPanel";
import { DataLocationPanel } from "./DataLocationPanel";
import { ImportPanel } from "./ImportPanel";
import { KeySecurityPanel } from "./KeySecurityPanel";
import { useStorageData } from "./useStorageData";

/**
 * 存储（AGENTS §7 / §20 · 设计文档 §7 / §8）。
 *
 * 合并了原来分开的「数据」「隐私」两页 —— 两者本质都是「数据放在哪」：
 *   ① 数据位置   用户**只需改一个根目录**，其下 media / backup / keys / logs 按固定相对布局跟随
 *   ② 密钥与安全 主密钥存 OS 凭据库，**没有路径概念**；唯一路径项是 .wbkey 的导出位置
 *   ③ 备份与恢复 快照 = 跨机迁移载体，恢复前比对指纹
 *   ④ 跨机导入   把「备份包 + .wbkey」一次收进来，顺序由程序强制；并明写换机要带走的两个位置
 *
 * 本文件只负责**组合与加载**；每段的逻辑各在自己的文件里（原来它们挤在一个 1082 行的文件里）。
 */
export function StoragePanel() {
  const { info, key, backups, status, error, reload } = useStorageData();

  if (status === "loading") return <LoadingState label="读取存储信息…" />;
  if (status === "error") {
    return <ErrorState title="读取存储信息失败" description={error} onRetry={reload} />;
  }
  if (!info) {
    return (
      <div className="rounded-card border border-dashed border-border px-4 py-8 text-center text-xs text-text-muted">
        浏览器调试环境读不到本机存储信息；请在真机（<code>npm run dev:app</code>）中查看。
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <DataLocationPanel info={info} onChanged={reload} />
      <KeySecurityPanel info={info} status={key} onChanged={reload} />
      <BackupPanel backups={backups} onChanged={reload} />
      <ImportPanel info={info} onImported={reload} />
    </div>
  );
}
