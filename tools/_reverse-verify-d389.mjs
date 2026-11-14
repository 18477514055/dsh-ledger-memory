/**
 * ★ 反向验证（D389）：把三处修复**各自摘掉**，看探针会不会当场见红。
 *
 * 判据（纪律 10）：**摘一处不红 = 那条断言根本没在守它**。
 * 每摘一次都单独跑一遍，跑完立刻按原字节还原，最后核对 sha256。
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, "lib", "board-http.js");
const probe = path.join(root, "tools", "_probe-d389-board-roots-store.mjs");
const original = fs.readFileSync(target, "utf8");
const sha0 = crypto.createHash("sha256").update(original).digest("hex");

const cases = [
  {
    name: "R1 摘掉「启动时读回存档」",
    edits: [["loadBoardRootsStore();", "/* loadBoardRootsStore(); —— 反向验证：故意不读回 */"]],
    expect: ["③", "⑤", "⑥"],
  },
  {
    // ★★★ 实测记录（别改回来）：只摘「按项目序号接续」那**一行**，探针**全绿**（0 红）。
    //   原因是真的：`rootSeq` 有**两条**写入路径 —— ① 循环里的 `if (seq > rootSeq)`；
    //   ② 循环外的 `parsed.seq`（快照里存的就是当时的最大值）。两者互为冗余。
    //   ⇒ 要证明"重启后序号会接续"这件事有守，必须**两条一起摘**（纪律 22：
    //   「我能破坏它」≠「它是那个洞的唯一守卫」）。两条都摘 ⇒ ④ 立刻见红。
    name: "R2 摘掉「序号接着上次继续发」（两条冗余路径一起摘）",
    edits: [
      ["    if (seq > rootSeq) rootSeq = seq;", "    /* 反向验证：故意不接续序号（其一） */"],
      ["  if (Number.isFinite(parsed.seq) && parsed.seq > rootSeq) rootSeq = parsed.seq;", "  /* 反向验证：故意不接续序号（其二） */"],
    ],
    expect: ["④"],
  },
  {
    name: "R3 摘掉「已经不存在的项目不恢复」",
    edits: [["    if (!alive) continue;", "    /* 反向验证：故意不剔死项目 */"]],
    expect: ["⑤"],
  },
  {
    name: "R4 摘掉「写盘节流」（改成每次立刻写）",
    edits: [["  const wait = ROOTS_WRITE_THROTTLE_MS - (Date.now() - rootsLastWriteAt);", "  const wait = -1; // 反向验证：故意不节流"]],
    expect: ["②"],
  },
];

let bad = 0;
for (const c of cases) {
  let out = "";
  let code = 0;
  try {
    const missing = c.edits.filter(([from]) => !original.includes(from));
    if (missing.length > 0) {
      console.log(`FAIL  ${c.name} —— 源码里找不到要摘的那一行，本轮反向验证无效`);
      bad += 1;
      continue;
    }
    let mutated = original;
    for (const [from, to] of c.edits) mutated = mutated.replace(from, to);
    fs.writeFileSync(target, mutated, "utf8");
    try {
      out = execFileSync(process.execPath, [probe], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      code = 0;
    } catch (e) {
      out = String(e.stdout ?? "") + String(e.stderr ?? "");
      code = e.status ?? 1;
    }
  } finally {
    fs.writeFileSync(target, original, "utf8");
  }
  const fails = out.split(/\r?\n/).filter((l) => l.includes("  FAIL  "));
  const hit = c.expect.filter((tag) => fails.some((l) => l.includes(tag)));
  const complete = out.includes("PROBE-COMPLETE");
  const ok = code !== 0 && hit.length > 0;
  if (!ok) bad += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name} → exit=${code} 崩溃/中途=${complete ? "跑完" : "中断"} 命中预期组=${hit.join(",") || "（无）"} 红色条数=${fails.length}`);
  for (const l of fails.slice(0, 3)) console.log(`        ${l.trim()}`);
}

const sha1 = crypto.createHash("sha256").update(fs.readFileSync(target, "utf8")).digest("hex");
console.log(`\n还原核对：${sha0 === sha1 ? "PASS 逐字节一致" : "FAIL 源码被改坏了"}  ${sha0.slice(0, 12)}…`);
if (sha0 !== sha1) bad += 1;
console.log("PROBE-COMPLETE");
process.exit(bad === 0 ? 0 : 1);
