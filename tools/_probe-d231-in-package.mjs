/**
 * D231 标志物验证 —— **这一版修的那几行，确实在包里吗？**
 *
 * ★ 为什么必须单独做（而不是指望 `_probe-pack-check.mjs`）：
 *   那个探针的标志物清单是 **D62/A2/A3/D61** 时代的，**没有一条覆盖 D231**。
 *   于是 D231 若没进包，它**照样全绿** —— 这正是本项目第 34 节那条教训的形态：
 *   「**"发布了" ≠ "发布的是修好的那一版"**」。
 *   ⇒ 判据：**每一版新增的修复，都必须有自己独一无二、能在包里被找到的标志物。**
 *
 * ★ 标志物必须是**独一无二**的（第 34 节教训②）：
 *   不能用 `ifRevision` 这类到处都有的字符串，必须是这一版才有的写法。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const tgz = process.argv[2];
if (tgz === undefined) {
  console.log("用法: node tools/_probe-d231-in-package.mjs <tgz>");
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d231pack-"));
execFileSync("tar", ["-xzf", path.resolve(tgz), "-C", tmp], { stdio: "pipe" });
const libDir = path.join(tmp, "package", "lib");
const lib = fs
  .readdirSync(libDir)
  .filter((f) => f.endsWith(".js"))
  .sort()
  .map((f) => fs.readFileSync(path.join(libDir, f), "utf8"))
  .join("\n");

// ── D231 的三个标志物（每个都只在"修好之后"才存在）────────────────────────
const MARKS = [
  [
    "① 欠账落盘的唯一写出口 `recordOwed`（part1）",
    /export function recordOwed\(sid, rec\)/,
  ],
  [
    "② 落盘路径 = plugin-data 下（与 locks/anchors 同目录），绝不是用户工作区",
    /return path\.join\(path\.dirname\(lockStorePath\(\)\), OWED_STORE_FILE\)/,
  ],
  [
    "③ 注入侧真的**读回**盘上那份（只写不读 = 白做）",
    /const pendDisk = pendMem === undefined \? owedFor\(okey\) : undefined;/,
  ],
  [
    "④ ★ 没有台账就**不许催**（用户当场报的自我矛盾）",
    /const hasLedger = info\?\.activeRel !== undefined;/,
  ],
  [
    "⑤ 且守卫条件里真的用了它（声明了不用 = 假修）",
    /if \(hasLedger && !reminded && \(pend !== undefined \|\| needWrite \|\| needTriage\)\) \{/,
  ],
  [
    "⑥ 盘上那份**措辞分开**（不冒充「上一条回复」）",
    /这场对话上一次结束时没有完成/,
  ],
];

console.log(`═══ D231 标志物是否真的在包里 ═══\n包：${tgz}\n`);
let ok = 0;
for (const [label, re] of MARKS) {
  const hit = re.test(lib);
  console.log(`  ${hit ? "✓" : "✗"} ${label}`);
  if (hit) ok += 1;
}

// ★ 反向：**旧写法必须已消失** —— 否则是"两套并存"，实际走哪套不确定。
const GONE = [
  [
    "旧守卫（没有 hasLedger）必须已消失",
    /if \(!reminded && \(pend !== undefined \|\| needWrite \|\| needTriage\)\) \{/,
  ],
];
console.log("\n── 反向：旧写法必须已消失 ──");
for (const [label, re] of GONE) {
  const still = re.test(lib);
  console.log(`  ${still ? "✗" : "✓"} ${label}（${still ? "★ 仍在包里 —— 两套并存" : "已消失"}）`);
  if (!still) ok += 1;
}

const total = MARKS.length + GONE.length;
console.log(`\n⇒ ${ok}/${total} 通过 ${ok === total ? "· ✅ D231 确实在包里" : "· ❌ 有项没进包，不许发布"}`);
process.exit(ok === total ? 0 : 1);
