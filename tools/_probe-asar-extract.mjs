/**
 * 只读探针：直接从 app.asar 里**取出指定文件的真实字节**（不落盘、不改动任何东西）。
 *
 * ★ 为什么需要它：内核包（`@deepseek-ai/*`）在 profile 的 node_modules 里**是空的**
 *   （只有 cosmokit / dsh-subprocess / schemastery），真正的实现全在
 *   `resources/app.asar` 里。而 `read`/`grep`/`glob` 都进不去 asar
 *   （实测：`read …app.asar\dsh\…` → not found；`rg …app.asar\dsh` → os error 3）。
 *   ⇒ 要看内核源码，必须自己解 asar 头。
 *
 * asar 格式（Electron 官方）：
 *   [0..4)   uint32 LE  = 4（pickle 的长度字段大小）
 *   [4..8)   uint32 LE  = headerSize + 4
 *   [8..12)  uint32 LE  = headerSize  ← 官方文档就是这三个 u32
 *   [12..12+headerSize) = JSON 头（UTF-8），描述目录树 + 每个文件的 offset/size
 *   文件数据从 `12 + headerSize` 起（**4 字节对齐到 4**；实际上官方用 8）
 *   ★ 偏移基准：`file.offset` 是相对"数据区起点"的，数据区起点 = 8 + headerSize
 *     （即 pickle 总长）。这一点必须用真实文件验，不能背。
 *
 * 用法：
 *   node tools/_probe-asar-extract.mjs list <子串>       # 找路径
 *   node tools/_probe-asar-extract.mjs cat  <完整路径>   # 打印内容
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const ASAR =
  (process.env.DSH_ASAR ?? path.join(os.homedir(), "AppData", "Local", "Programs", "DeepSeek Harness", "resources", "app.asar"));

const buf = fs.readFileSync(ASAR);
const u32 = (o) => buf.readUInt32LE(o);
// asar 头是 4 个 u32：
//   [0] = 4                       pickle 的第一段长度
//   [4] = headerSize + 8
//   [8] = headerSize + 4
//   [12] = headerSize             ← **JSON 的真实长度在这里**
//   [16..] = JSON
// ★ 踩过：用 [8] 当 headerSize 会多切 4 字节 ⇒ `JSON.parse` 报
//   "Unexpected non-whitespace character after JSON"。尺子必须先验。
const headerSize = u32(12);
const jsonStart = 16;
const headerJson = buf.subarray(jsonStart, jsonStart + headerSize).toString("utf8");
const header = JSON.parse(headerJson);

// 数据区起点：官方 @electron/asar 是 `8 + u32(4)`（= JSON 长度 + 16），
// 与"JSON 从 16 开始、长 u32(12)"自洽 ⇒ 数据紧接 JSON 之后，无对齐填充。
const DATA_BASE = 8 + u32(4);

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const p = prefix === "" ? name : `${prefix}/${name}`;
    if (child.files !== undefined) walk(child, p, out);
    else out.push({ path: p, size: Number(child.size), offset: Number(child.offset), hash: child.integrity?.hash });
  }
  return out;
}
const all = walk(header, "", []);

const mode = process.argv[2] ?? "list";
const arg = process.argv[3] ?? "";

if (mode === "list") {
  const hits = all.filter((f) => f.path.toLowerCase().includes(arg.toLowerCase()));
  console.log(`asar 内共 ${all.length} 个文件；匹配 "${arg}" 的 ${hits.length} 个：`);
  for (const h of hits.slice(0, 60)) console.log(`  ${h.size.toString().padStart(9)}  ${h.path}`);
} else if (mode === "grep") {
  // 在内核源码里搜内容。★ 必须自己解 asar —— rg/read 都进不去。
  const re = new RegExp(arg, "i");
  let hits = 0;
  for (const f of all) {
    if (!/\.(js|mjs|cjs|yml|yaml|json|ts)$/.test(f.path)) continue;
    if (f.size > 4_000_000) continue; // 超大文件跳过（sourcemap 等）
    const start = DATA_BASE + f.offset;
    const s = buf.subarray(start, start + f.size).toString("utf8");
    if (!re.test(s)) continue;
    hits++;
    console.log(`\n=== ${f.path} (${f.size}B) ===`);
    for (const line of s.split("\n")) {
      if (re.test(line)) console.log(`  ${line.trim().slice(0, 240)}`);
    }
    if (hits >= 25) {
      console.log("\n（命中已达 25 个文件上限）");
      break;
    }
  }
  console.log(`\n共命中 ${hits} 个文件`);
} else if (mode === "verify") {
  // ★ 先证明尺子对：拿 asar 里每个文件自带的 SHA256 校验我们解出来的字节。
  const crypto = await import("node:crypto");
  let checked = 0;
  let bad = 0;
  const withHash = all.filter((f) => typeof f.hash === "string" && f.size > 0);
  for (const f of withHash.slice(0, Number(arg || 400))) {
    const start = DATA_BASE + f.offset;
    const bytes = buf.subarray(start, start + f.size);
    const got = crypto.createHash("sha256").update(bytes).digest("hex");
    checked++;
    if (got !== f.hash) {
      bad++;
      if (bad <= 3) console.log(`  MISMATCH ${f.path}\n    期望 ${f.hash}\n    实得 ${got}`);
    }
  }
  console.log(`校验 ${checked} 个文件，不符 ${bad} 个 ⇒ ${bad === 0 ? "偏移/长度推导正确（尺子可信）" : "★ 推导错了，读数不可信"}`);
  process.exit(bad === 0 ? 0 : 1);
} else if (mode === "cat") {
  const f = all.find((x) => x.path === arg);
  if (f === undefined) {
    console.log(`没找到 ${arg}`);
    process.exit(1);
  }
  console.log(`--- ${f.path}  (size=${f.size}, offset=${f.offset}) ---`);
  const start = DATA_BASE + f.offset;
  const end = start + f.size;
  if (end > buf.length) {
    console.log(`  越界（start=${start} end=${end} 文件共 ${buf.length}）`);
    process.exit(1);
  }
  // ★ 给了第 4 个参数 ⇒ 按**字节**写到文件（不经 stdout）。
  //   踩过：PowerShell 的 `>` 重定向 stdout 会写成 **UTF-16**，
  //   之后按 UTF-8 读就变成每个字符夹空字节的乱码（还误以为是文件本身坏了）。
  const outTo = process.argv[4];
  if (typeof outTo === "string" && outTo !== "") {
    fs.writeFileSync(outTo, buf.subarray(start, end));
    console.log(`已按字节写出 ${f.size} 字节 → ${outTo}`);
  } else {
    process.stdout.write(buf.subarray(start, end).toString("utf8"));
  }
}
