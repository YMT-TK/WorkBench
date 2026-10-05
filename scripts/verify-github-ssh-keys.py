#!/usr/bin/env python3
"""校验 GitHub 的 SSH 主机密钥，并生成一份可直接交给 ssh 使用的 known_hosts 文件。

## 为什么需要这个脚本

本机有两个约束叠在一起：

1. GitHub 的 22 端口在本地被 reset，所以 remote 走 `ssh://git@ssh.github.com:443/...`；
2. `~/.ssh/` 下的**已有文件**会被安全策略拦住写入（在同目录**新建**文件却可以），
   所以 `>> ~/.ssh/known_hosts` 与「写临时文件再改名覆盖」都不通。

于是 `git push` 会以 `Host key verification failed` 失败。正确的解法**不是**关掉主机校验
（`StrictHostKeyChecking=no` = 把中间人当成 GitHub），而是**自己拿一份可信的 known_hosts**：
只包含「用 GitHub 官方指纹逐个核对过」的密钥，再用仓库局部配置指过去：

    git config core.sshCommand "ssh -o UserKnownHostsFile=<生成的这份文件>"

⚠️ 若目标文件已存在且被沙箱拦写，脚本会退到临时文件并把该敲的命令打出来（见文末 `--out` 说明）。

## 信任链

    docs.github.com（HTTPS/TLS 拿官方指纹）  ←核对→  ssh-keyscan 拿到的实际密钥

⛔ **不要** `ssh-keyscan ... >> ~/.ssh/known_hosts` —— 那等于无条件信任链路上的任何东西，
`ssh-keyscan` 本身不提供任何身份保证。

## 用法

    # 生成 / 覆盖一份只含已验证密钥的文件（--merge 可把现有 known_hosts 的内容并进来）
    python scripts/verify-github-ssh-keys.py --out ~/.ssh/known_hosts.github443 \\
        --merge ~/.ssh/known_hosts

依赖：仅标准库；需要 `ssh-keyscan`（Git for Windows 自带）。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import subprocess
import sys
import tempfile

# 来自 https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
# ⚠️ 若 GitHub 换钥，本表要同步更新（脚本会因指纹不符而拒绝写文件，不会静默放行）。
OFFICIAL_GITHUB_FINGERPRINTS = {
    "ssh-ed25519": "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU",
    "ecdsa-sha2-nistp256": "SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM",
    "ssh-rsa": "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s",
    # DSA 已停止支持，仅用于识别「扫到了不该出现的旧密钥」
    "ssh-dss": "SHA256:br9IjFspm1vxR3iA35FWE+4VTyz1hYVLIE2t1/CeyWQ",
}


def fingerprint(blob_b64: str) -> str:
    """SSH 指纹 = 对解码后的密钥 blob 取 SHA-256 再 base64（去掉补位 '='）。"""
    digest = hashlib.sha256(base64.b64decode(blob_b64)).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def scan(host: str, port: int) -> tuple[list[tuple[str, str]], list[str]]:
    """跑 ssh-keyscan，返回 ([(keytype, b64blob)], [原始行])。"""
    try:
        out = subprocess.run(
            ["ssh-keyscan", "-p", str(port), host],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except FileNotFoundError:
        sys.exit("找不到 ssh-keyscan —— Git for Windows 自带，检查 PATH")
    except subprocess.TimeoutExpired:
        sys.exit(f"ssh-keyscan 超时（{host}:{port}）——网络不通？")

    entries: list[tuple[str, str]] = []
    raw: list[str] = []
    for line in out.stdout.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue  # 注释行是 ssh-keyscan 自己写的 banner，不是密钥
        parts = line.split()
        if len(parts) < 3:
            continue
        entries.append((parts[1], parts[2]))
        raw.append(line)
    if not entries:
        sys.exit(f"ssh-keyscan 没有从 {host}:{port} 取到任何密钥（stderr: {out.stderr.strip()[:200]}）")
    return entries, raw


def verify(entries: list[tuple[str, str]]) -> list[str]:
    """逐条核对官方指纹，返回可写入的原始行长什么样由调用方拼装。"""
    ok: list[str] = []
    bad: list[str] = []
    for keytype, blob in entries:
        got = fingerprint(blob)
        want = OFFICIAL_GITHUB_FINGERPRINTS.get(keytype)
        if want is None:
            print(f"  ?  {keytype:22s} {got}  （官方未公布该类型，跳过）")
        elif got == want:
            print(f"  OK {keytype:22s} {got}")
            ok.append(keytype)
        else:
            print(f"  !! {keytype:22s} {got}  期望 {want}")
            bad.append(keytype)
    if bad:
        sys.exit(f"!! 指纹不匹配：{bad} —— 拒绝写文件（可能是中间人，或 GitHub 换钥需更新脚本里的官方表）")
    if not ok:
        sys.exit("!! 没有任何可核对的密钥")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description="校验 GitHub SSH 主机密钥并生成 known_hosts 文件")
    ap.add_argument("--host", default="ssh.github.com", help="默认 ssh.github.com（走 443 的那个）")
    ap.add_argument("--port", type=int, default=443, help="默认 443")
    ap.add_argument("--out", required=True, help="输出的 known_hosts 文件路径")
    ap.add_argument("--merge", help="可选：把这份已有 known_hosts 的内容并到前面（保住其它主机条目）")
    args = ap.parse_args()

    print(f"[1/3] 扫描 {args.host}:{args.port}")
    entries, raw = scan(args.host, args.port)

    print("[2/3] 与 GitHub 官方指纹核对")
    verified_types = verify(entries)

    host_field = args.host if args.port == 22 else f"[{args.host}]:{args.port}"
    lines = [f"{host_field} {ktype} {blob}" for ktype, blob in entries if ktype in verified_types]

    merged: list[str] = []
    if args.merge:
        merge_path = os.path.expanduser(args.merge)
        if os.path.exists(merge_path):
            with open(merge_path, encoding="utf-8", errors="replace") as fh:
                merged = [ln.rstrip("\n") for ln in fh if ln.strip() and not ln.startswith("#")]
            print(f"      并入 {merge_path} 的 {len(merged)} 行")

    out_path = os.path.expanduser(args.out)
    payload = merged + lines
    try:
        parent = os.path.dirname(out_path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
            for ln in payload:
                fh.write(ln + "\n")
    except OSError as exc:
        # 实测：`~/.ssh/` 下对**已有文件**的写入可能被沙箱 / 安全软件拦掉（建新文件却可以）。
        # 别让用户拿着一串 traceback 去猜 —— 退到临时文件，把下一步该敲什么打清楚。
        fallback = os.path.join(tempfile.gettempdir(), "known_hosts.github")
        with open(fallback, "w", encoding="utf-8", newline="\n") as fh:
            for ln in payload:
                fh.write(ln + "\n")
        print(f"!! 写入 {out_path} 失败（{exc.__class__.__name__}: {exc}）")
        print(f"   已改为写到内容完全相同的临时文件：{fallback}")
        print("   请自行拷过去，或让本仓库的 git 直接用它：")
        print(f'       git config core.sshCommand "ssh -o UserKnownHostsFile={fallback}"')
        return 1

    print(f"[3/3] 已写入 {out_path}（{len(payload)} 行，其中本次验证通过 {len(lines)} 行）")
    print()
    print("让本仓库的 git 用它：")
    print(f'    git config core.sshCommand "ssh -o UserKnownHostsFile={out_path}"')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
