/** 只读：从 app.asar 解出 compaction-basic，查它的 idle/busy 判定。 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

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
  if (f === undefined) throw new Error("no " + p);
  return buf.subarray(DATA_BASE + f.offset, DATA_BASE + f.offset + f.size).toString("utf8");
};

const src = read("dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js");
const L = src.split("\n");
console.log("compaction-basic 共 " + L.length + " 行");

// 关键词用数组拼接，避免在 shell 里跟引号打架。
const KEYS = ["busy", "Idle", "idle", "runMaintenance"];
for (const k of KEYS) {
  console.log("\n=== 含 " + k + " 的行（最多 16 条）===");
  let n = 0;
  for (let i = 0; i < L.length && n < 16; i += 1) {
    if (L[i].includes(k)) {
      console.log(String(i + 1).padStart(5) + "| " + L[i].trim().slice(0, 180));
      n += 1;
    }
  }
}

// 把 compactNow 的整个函数体打出来（找 idle 判定在哪一步）。
console.log("\n=== compactNow 函数体 ===");
const start = L.findIndex((l) => /compactNow\s*\(/.test(l) && /=|\{/.test(l));
if (start >= 0) {
  for (let i = start; i < Math.min(L.length, start + 60); i += 1) {
    console.log(String(i + 1).padStart(5) + "| " + L[i]);
  }
}
