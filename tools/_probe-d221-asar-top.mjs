// D221 · 看 app.asar 顶层结构 + 找 Electron 主进程 / 桌面外壳（只列名，不解内容）
import fs from "node:fs";
import path from "node:path";

// ★ 隐私（D221）：**绝不把真实用户名写进 tools/**（它是 PUBLIC 的）。
//   路径用环境变量拼：%LOCALAPPDATA%\\Programs\\DeepSeek Harness\\resources\\app.asar
//   ★ 回读：本机解析结果就是活桌面端那个 asar（与硬编码时同一个文件）。
const ASAR = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness", "resources", "app.asar");
const fd = fs.openSync(ASAR, "r");
try {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const tree = JSON.parse(jsonBuf.toString("utf8"));

  console.log("═══ app.asar 顶层 ═══");
  for (const [k, v] of Object.entries(tree.files ?? {})) {
    const kind = v.files ? "DIR " : "FILE";
    console.log(`  ${kind} ${k}${v.size ? ` (${v.size} B)` : ""}`);
  }

  console.log("\n═══ 顶层目录下第一层（只看非 node_modules）═══");
  for (const [k, v] of Object.entries(tree.files ?? {})) {
    if (!v.files || k === "node_modules") continue;
    const kids = Object.keys(v.files);
    console.log(`  ${k}/ → ${kids.slice(0, 25).join(", ")}${kids.length > 25 ? ` …(+${kids.length - 25})` : ""}`);
  }
} finally {
  fs.closeSync(fd);
}
