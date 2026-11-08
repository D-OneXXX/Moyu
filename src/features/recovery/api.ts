import { invoke } from "@tauri-apps/api/core";
import type { BackupImportResult } from "@/features/backup/api";

export interface DbHealth {
  ok: boolean;
  /** 数据库启动或恢复自检错误码；健康时为 null。 */
  errorCode: string | null;
  dataDir: string;
}

export const recoveryApi = {
  getDbHealth: () => invoke<DbHealth>("get_db_health"),
  openDataDir: () => invoke<void>("open_data_dir"),
  recoverDatabase: (sourcePath: string) =>
    invoke<BackupImportResult>("recover_database_from_backup", {
      sourcePath,
    }),
};
