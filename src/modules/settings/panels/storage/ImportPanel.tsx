import { useState } from "react";
import { HardDriveDownload } from "lucide-react";
import type { StorageInfo } from "@/core/shared/api";
import { Note } from "../../components/Note";
import { SectionTitle } from "../../components/SectionTitle";
import { SettingRow } from "../../components/SettingRow";
import { ImportWizard } from "./ImportWizard";

/**
 * ④ 跨机导入（设计文档 §7.6 / ADR-17）。
 *
 * 这一段的职责很窄：**把「备份包 + .wbkey」这两样东西一次性收进来**。
 * 原来的两个入口（密钥导入 / 恢复）各自没问题，但顺序只写在说明文字里，
 * 用户得自己记；这里把它变成一次向导，并且在动手前先只读预检。
 *
 * 顺带把「换机要带走哪两个位置」明写出来 —— 用户描述的场景是
 * 「点备份 → 程序告诉我存哪儿 → 我拷到另一台机器 → 点导入」，那这一步就不能
 * 让他自己去 ①②③ 三段里各找一次路径。
 */
export function ImportPanel({
  info,
  onImported,
}: {
  info: StorageInfo;
  onImported: () => void;
}) {
  const [wizardOpen, setWizardOpen] = useState(false);

  const dirOf = (id: string) => info.dirs.find((d) => d.id === id)?.path ?? info.runningDir;
  const backupDir = dirOf("backup");
  const keysDir = dirOf("keys");

  return (
    <section className="space-y-5 border-t border-border pt-5">
      <SectionTitle title="跨机导入" hint="备份包 + .wbkey 一次收进来" />

      <SettingRow label="换机要带走的两个位置" hint="公司电脑 → 家里笔记本：这两样缺一不可">
        <div className="space-y-2">
          <div className="divide-y divide-border rounded-card border border-border">
            <div className="flex items-start gap-3 px-3 py-2">
              <span className="mt-0.5 shrink-0 rounded-pill bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                ① 备份包
              </span>
              <div className="min-w-0 flex-1">
                <code className="block break-all text-xs text-text-secondary">{backupDir}</code>
                <div className="text-[11px] text-text-muted">
                  上面「③ 备份与恢复」里点「立即备份」生成，把整个
                  <span className="text-text-secondary"> 快照目录 </span>
                  复制走
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3 px-3 py-2">
              <span className="mt-0.5 shrink-0 rounded-pill bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                ② 密钥文件
              </span>
              <div className="min-w-0 flex-1">
                <code className="block break-all text-xs text-text-secondary">
                  {`${keysDir}\\master-key.wbkey`}
                </code>
                <div className="text-[11px] text-text-muted">
                  上面「② 密钥与安全 → 导出密钥备份」生成（口令加密，别忘了口令）
                </div>
              </div>
            </div>
          </div>
          <div className="text-[11px] text-text-muted">
            备份包<span className="text-text-secondary">不含密钥</span>
            —— 密钥在本机 OS 凭据库，从没进过数据目录。所以两样必须分开带。
          </div>
        </div>
      </SettingRow>

      <SettingRow
        label="从别的电脑导入"
        hint="换机 / 复刻配置：先验密钥，再登记备份包，最后恢复数据"
      >
        <div className="space-y-2.5">
          <button
            onClick={() => setWizardOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-pill border border-accent px-3 py-1 text-xs text-accent hover:bg-accent/5"
          >
            <HardDriveDownload size={12} />
            从别的电脑导入…
          </button>

          <Note>
            <div className="mb-1">
              把你从旧机器上带过来的<span className="text-text-secondary">两样东西</span>
              都选进来：备份包目录 + 密钥文件（.wbkey）。
            </div>
            <div>
              · 向导会<b className="text-text-primary">先做只读预检</b>
              ：解开密钥、比对指纹 —— 不匹配就到此为止，磁盘上什么都不会改。
            </div>
            <div>· 校验通过才会依次：装密钥 → 登记备份包 → 恢复数据 → 提示重启。</div>
            <div>
              · 顺序由程序强制，所以<b className="text-text-primary">不会出现「先恢复、后导入密钥」</b>
              这种把自己绕死的走法。
            </div>
          </Note>

          <div className="text-[11px] text-text-muted">
            只带了备份包、没带密钥也行：如果这份数据没有加密字段，向导会直接放行；
            有加密字段时它会明确告诉你缺的是哪一把钥匙（会给出指纹）。
          </div>
        </div>
      </SettingRow>

      {wizardOpen && (
        <ImportWizard onClose={() => setWizardOpen(false)} onDone={onImported} />
      )}
    </section>
  );
}
