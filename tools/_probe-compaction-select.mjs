/**
 * 只读：把内核 `dsh-compaction-basic` 的**范围选择**与**自动触发**整段取出来读。
 *
 * ★ 为什么必须读实现（而不是只看 Service 签名）：我们要做的是"**只压掉增量的一部分**、
 *   而不是整个积压"。这取决于两个**实现细节**：
 *     ① 自动那条怎么选范围（`retainRatio` 到底怎么用）；
 *     ② `compactRegion` 对边界/回合的要求（决定我们能不能在回合内自己选一段）。
 *   签名只告诉你"能调"，实现才告诉你"调了会怎样"。
 *
 * 用法：node tools/_probe-compaction-select.mjs
 */
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
  if (f === undefined) throw new Error("asar 里没有 " + p);
  return buf.subarray(DATA_BASE + f.offset, DATA_BASE + f.offset + f.size).toString("utf8");
};

const P = "dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js";
const src = read(P);
const L = src.split("\n");
console.log(`${P}\n共 ${L.length} 行\n`);

/** 打印包含关键词的行（带行号）。 */
function show(label, keys, max = 30) {
  console.log(`${"═".repeat(72)}\n${label}\n${"═".repeat(72)}`);
  let n = 0;
  for (let i = 0; i < L.length && n < max; i += 1) {
    if (keys.some((k) => L[i].includes(k))) {
      console.log(String(i + 1).padStart(5) + "| " + L[i].slice(0, 190));
      n += 1;
    }
  }
  console.log("");
}

show("① 范围选择：selectCompactableRange / retainRatio / retainTokens", [
  "selectCompactableRange",
  "retainRatio",
  "retainTokens",
  "compactIfNeeded",
  "thresholdRatio",
]);

show("② compactRegion 的边界与回合约束", [
  "compactRegion",
  "toolPairingBalanced",
  "openTurn",
  "owner",
]);

// 把 selectCompactableRange 整个函数体打出来
const fnNames = ["function selectCompactableRange", "const selectCompactableRange"];
let idx = L.findIndex((l) => fnNames.some((f) => l.includes(f)));
if (idx < 0) {
  idx = L.findIndex((l) => /selectCompactableRange\s*\(/.test(l));
}
if (idx >= 0) {
  console.log(`${"═".repeat(72)}\nselectCompactableRange 函数体（从 ${idx + 1} 行）\n${"═".repeat(72)}`);
  // 用花括号配平截取完整函数
  const text = L.slice(idx).join("\n");
  let depth = 0;
  let started = false;
  let end = text.length;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{") {
      depth += 1;
      started = true;
    } else if (text[i] === "}") {
      depth -= 1;
      if (started && depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  console.log(text.slice(0, end));
}

// compactIfNeeded 整个函数体
const i2 = L.findIndex((l) => /^\s*compactIfNeeded\s*\(/.test(l));
if (i2 >= 0) {
  console.log(`\n${"═".repeat(72)}\ncompactIfNeeded 函数体（从 ${i2 + 1} 行，60 行）\n${"═".repeat(72)}`);
  for (let i = i2; i < Math.min(L.length, i2 + 60); i += 1) {
    console.log(String(i + 1).padStart(5) + "| " + L[i]);
  }
}

// ★ 公开的 compactRegion 方法：它怎么决定 owner（这决定我们能不能在回合内自选范围）
{
  const i3 = L.findIndex((l) => /^\s*compactRegion\s*\(/.test(l));
  if (i3 >= 0) {
    console.log(`\n${"═".repeat(72)}\n公开 compactRegion 方法（从 ${i3 + 1} 行，30 行）\n${"═".repeat(72)}`);
    for (let i = i3; i < Math.min(L.length, i3 + 30); i += 1) {
      console.log(String(i + 1).padStart(5) + "| " + L[i]);
    }
  }
}

// ★ 任意行区间（便于按需细读）：node … --lines 920 1000
const li = process.argv.indexOf("--lines");
if (li > 0) {
  const a = Number(process.argv[li + 1]);
  const b = Number(process.argv[li + 2]);
  console.log(`\n${"═".repeat(72)}\n行 ${a}~${b}\n${"═".repeat(72)}`);
  for (let i = a - 1; i < Math.min(L.length, b); i += 1) {
    console.log(String(i + 1).padStart(5) + "| " + L[i]);
  }
}
