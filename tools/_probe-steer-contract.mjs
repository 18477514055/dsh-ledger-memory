/** 只读：查内核 Agent 的 steer 与 status 契约（决定"手动命令能否立刻唤醒一轮"）。 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const ASAR = (process.env.DSH_ASAR ?? path.join(os.homedir(), "AppData", "Local", "Programs", "DeepSeek Harness", "resources", "app.asar"));
const buf = fs.readFileSync(ASAR);
const u32 = (o) => buf.readUInt32LE(o);
const headerSize = u32(12);
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString("utf8"));
const DATA_BASE = 8 + u32(4);
const walk = (node, prefix, out) => {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix === "" ? name : `${prefix}/${name}`;
    if (child.files !== undefined) walk(child, p, out);
    else out.push({ path: p, size: Number(child.size), offset: Number(child.offset) });
  }
  return out;
};
const all = walk(header, "", []);
const read = (p) => {
  const f = all.find((x) => x.path === p);
  return f === undefined ? undefined : buf.subarray(DATA_BASE + f.offset, DATA_BASE + f.offset + f.size).toString("utf8");
};

const LOOP = "dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js";
const src = read(LOOP);
console.log("agent-loop 长度 = " + src.length);
const L = src.split("\n");

// steer 的定义与 status 语义
for (const key of ["steer(", "status", "runMaintenance", "waking"]) {
  console.log("\n=== 含 " + key + " 的行（最多 18 条）===");
  let n = 0;
  for (let i = 0; i < L.length && n < 18; i += 1) {
    if (L[i].includes(key)) {
      console.log(String(i + 1).padStart(6) + "| " + L[i].trim().slice(0, 170));
      n += 1;
    }
  }
}

// 把 steer 的完整方法体打出来
const idx = L.findIndex((l) => /^\s*steer\s*\(/.test(l));
if (idx >= 0) {
  console.log("\n=== steer 方法体（从 " + (idx + 1) + " 行起 40 行）===");
  for (let i = idx; i < Math.min(L.length, idx + 40); i += 1) console.log(String(i + 1).padStart(6) + "| " + L[i]);
}
