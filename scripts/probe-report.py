"""把 dev server 日志里的分块探针报告拼回可读结果。

用法：
    python scripts/probe-report.py .workbuddy/e2e.log

为什么要有这个脚本：探针报告按 800 个**码点**切片、每块单独 URL 编码后发成
`/__e2e?c=<i>/<n>&d=<片段>`（见 AGENTS §17.7）。手工 grep 只会看到一堆 `%E4`，
而且最容易犯的错是**缺块时拿残 JSON 当结论** —— 所以这里第一件事就是把缺块报出来。

多轮的情况（整页重载会重跑探针）只取**最后一轮**：按块号 1 的出现位置切一刀。
"""
import json
import re
import sys
import urllib.parse

LOG = sys.argv[1] if len(sys.argv) > 1 else ".workbuddy/e2e.log"

PAT = re.compile(r"__e2e\?c=(\d+)/(\d+)&d=(\S+)")


def load_rounds(log_path):
    """按日志顺序返回 [{'total': n, 'parts': {idx: 已解码片段}}]，每轮一份。"""
    rounds = []
    with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = PAT.search(line)
            if not m:
                continue
            idx, total = int(m.group(1)), int(m.group(2))
            # 块号回到 1 = 新的一轮（整页重载会重跑探针）
            if idx == 1 or not rounds:
                rounds.append({"total": total, "parts": {}})
            # 逐块解码再拼接：每块是**独立** encodeURIComponent 的，不能先拼再解
            rounds[-1]["total"] = max(rounds[-1]["total"], total)
            rounds[-1]["parts"][idx] = urllib.parse.unquote(m.group(3))
    return rounds


def main():
    try:
        rounds = load_rounds(LOG)
    except FileNotFoundError:
        print(f"!! 找不到日志：{LOG}")
        return 2

    if not rounds:
        print(f"!! {LOG} 里没有任何 /__e2e 请求 —— 探针没跑起来（WB_E2E=1 了吗？）")
        return 2

    print(f"日志共 {len(rounds)} 轮上报，取最后一轮")
    rnd = rounds[-1]
    total, parts = rnd["total"], rnd["parts"]

    missing = [i for i in range(1, total + 1) if i not in parts]
    if missing:
        print(f"!! 缺块 {missing}（共 {total} 块）—— 报告不完整，不能当结论。")
        print("   常见原因：dev server 被重启 / 日志被截断 / 探针中途 reload。")
        return 1

    payload = "".join(parts[i] for i in range(1, total + 1))
    try:
        obj = json.loads(payload)
    except json.JSONDecodeError as exc:
        print(f"!! JSON 解析失败：{exc}")
        return 1

    results = obj["results"]
    failed = [r for r in results if not r["ok"]]
    print(f"\n断言 {len(results)} 条｜通过 {len(results) - len(failed)}｜失败 {len(failed)}")
    print(f"overall pass = {obj['pass']}")

    if failed:
        print("\n===== 失败明细 =====")
        for r in failed:
            print(f"- {r['name']}")
            if r.get("extra"):
                print(f"    现场：{r['extra'][:500]}")
    else:
        print("\n===== 全部断言 =====")
        for r in results:
            print(f"PASS  {r['name']}")

    return 0 if obj["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
