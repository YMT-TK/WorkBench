// WorkBench 开发启动器（`npm run dev:app`）
//
// 背景（本机环境适配，已实测）：
//   `tauri dev` 的 beforeDevCommand 会以 `cmd /S /C` 派生子进程，在本机会失败：
//       failed to run command `npm run dev` with `cmd /S /C`:
//       所有的管道范例都在使用中。 (os error 231)
//   与沙箱无关（管理员权限运行、危险模式运行均复现）。
//
// 因此本脚本改为：
//   1) 自己直接拉起 Vite（stdio 继承，不经过 Tauri 的管道派生）
//   2) 等 127.0.0.1:5173 可访问后，再以 beforeDevCommand="" 启动 `tauri dev`
// 等价于 `npm run tauri dev`，Ctrl+C 会同时结束 vite 与 tauri（含进程树）。

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = 5173;

/** 等待端口可连接（Vite 就绪） */
function waitForPort(timeoutMs = 90_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: HOST, port: PORT });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`等待 Vite (${HOST}:${PORT}) 超时`));
        } else {
          setTimeout(attempt, 300);
        }
      });
    };
    attempt();
  });
}

const children = [];
let shuttingDown = false;

/** Windows 下 child.kill 只结束 shell，需要连进程树一起结束 */
function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.pid) killTree(child.pid);
  }
  setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function run(command, label) {
  const child = spawn(command, { cwd: ROOT, stdio: "inherit", shell: true });
  children.push(child);
  child.on("exit", (code) => {
    console.log(`[dev-app] ${label} 已退出（code=${code}），结束其余进程…`);
    shutdown(code ?? 0);
  });
  return child;
}

// 1) 拉起 Vite
run("npm run dev", "vite");

// 2) 等 Vite 就绪后拉起 Tauri（跳过 beforeDevCommand）
try {
  await waitForPort();
  console.log(`[dev-app] Vite 就绪 → http://${HOST}:${PORT}，正在启动 Tauri…`);

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "workbench-dev-"));
  const overrideConfig = path.join(tmpDir, "dev.config.json");
  writeFileSync(overrideConfig, JSON.stringify({ build: { beforeDevCommand: "" } }));

  run(`npx tauri dev --config "${overrideConfig}"`, "tauri dev");
} catch (err) {
  console.error(`[dev-app] ${err instanceof Error ? err.message : String(err)}`);
  shutdown(1);
}
