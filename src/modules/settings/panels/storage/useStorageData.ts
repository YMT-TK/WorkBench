import { useCallback, useEffect, useState } from "react";
import {
  api,
  isTauri,
  type BackupItem,
  type KeyStatus,
  type StorageInfo,
} from "@/core/shared/api";
import { errorDetail, safeLog } from "@/core/shared/utils/errors";

export type LoadStatus = "loading" | "ready" | "error";

export interface StorageData {
  info: StorageInfo | null;
  key: KeyStatus | null;
  backups: BackupItem[];
  status: LoadStatus;
  error: string;
  reload: () => void;
}

/**
 * 存储页的三份数据（数据位置 / 密钥状态 / 备份列表）统一在这里加载。
 *
 * **各自独立降级**：凭据库读不到不该把「数据位置」整块打掉，反之亦然。
 * 但三者共用一个 `reload` —— 跨机导入会同时改动密钥与备份列表，
 * 两处分别刷新迟早漏掉一个（表现为「导完了但列表里没出现」）。
 */
export function useStorageData(): StorageData {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [key, setKey] = useState<KeyStatus | null>(null);
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState("");

  const reload = useCallback(() => {
    if (!isTauri()) {
      // 浏览器调试环境没有 IPC，预期内降级（真机才有真实数据与凭据库）
      setStatus("ready");
      return;
    }
    setStatus("loading");
    setError("");

    api
      .storageInfo()
      .then((v) => {
        setInfo(v);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        // 只渲染 ErrorState（不弹 toast，避免反复打扰）；但必须留日志，
        // 否则「读不到存储信息」会变成一段无迹可查的静默失败（AGENTS §11）。
        safeLog(`[settings] storage_info failed: ${errorDetail(err)}`);
        setError(errorDetail(err));
        setStatus("error");
      });

    api
      .keyStatus()
      .then(setKey)
      .catch((err: unknown) => {
        safeLog(`[settings] key_status failed: ${errorDetail(err)}`);
        setKey(null);
      });

    api
      .backupList()
      .then(setBackups)
      .catch((err: unknown) => {
        safeLog(`[settings] backup_list failed: ${errorDetail(err)}`);
        setBackups([]);
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { info, key, backups, status, error, reload };
}
