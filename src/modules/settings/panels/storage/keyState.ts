import type { KeyState } from "@/core/shared/api";
import type { NoteTone } from "../../components/Note";

export interface KeyBanner {
  tone: NoteTone;
  title: string;
  desc: string;
}

/**
 * 密钥三态 → 顶部横幅（设计文档 §8.5 的「静默生成密钥」防护）。
 * `ok` 正常时不需要横幅。
 */
export function keyStateBanner(state: KeyState): KeyBanner | null {
  switch (state) {
    case "ok":
      return null;
    case "first_run":
      return {
        tone: "info",
        title: "尚未生成主密钥",
        desc: "首次写入敏感字段（会员密码 / Git Token / API Key）时才会创建。创建后请立刻导出一份口令加密的备份。",
      };
    case "adopt_existing":
      return {
        tone: "info",
        title: "已采用本机已有密钥",
        desc: "本机凭据库里已有一把密钥，已记录指纹用于以后校验。",
      };
    case "mismatch":
      return {
        tone: "danger",
        title: "密钥与数据不匹配",
        desc: "本机凭据库里的密钥解不开这个数据库 —— 敏感字段无法读写。请导入与这份数据配套的密钥（.wbkey）。",
      };
    case "missing":
      return {
        tone: "warning",
        title: "缺少密钥：此数据来自另一台机器",
        desc: "数据库里记录了密钥指纹，但本机凭据库里没有对应密钥。请先导入密钥（.wbkey）—— 程序不会自动生成新密钥，以免把已有密文全部作废。",
      };
  }
}
