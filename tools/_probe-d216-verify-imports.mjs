// ═══════════════════════════════════════════════════════════════════════════
// D216 · 生成结果的**静态校验器**：一次性把所有缺失/多余的 import 找出来
// ═══════════════════════════════════════════════════════════════════════════
//
// ★ 为什么必须写它（我在拆分里**连炸两次**后才想通）：
//   第一次漏 `DEFAULT_LOG_LEVELS`、第二次漏 `stampSec` —— 我都在"跑一次、看哪里炸、补哪里"，
//   那是**打地鼠**：每修一个都要跑 3 分钟自检，而且**只能发现被执行到的那条路**。
//   ★ 本项目纪律 11 的同型：**"跑通了" ≠ "都对了"** —— 没被执行的分支里的漏 import 查不出来。
//
// ⇒ 正解：**静态**算出"每个模块用到了哪些不属于自己的顶层名字"，
//   与"它实际 import 了哪些"逐一比对。不跑代码，毫秒级，且**覆盖全部路径**。
//
// 用法：node tools/_probe-d216-verify-imports.mjs <拆分目录>
// ═══════════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
// ★★★ 与生成器**共用同一把尺子**（词法器）—— 否则两边判不一致，校验器会报假绿。
//   正则版漏过 13 处引用（含 `CHECKPOINT_TOOL`），详见 `_d216-lexer.mjs`。
import { codeOnly } from "./_d216-lexer.mjs";

const DIR = process.argv[2];
if (!DIR) {
  console.error("用法：node tools/_probe-d216-verify-imports.mjs <拆分目录>");
  process.exit(2);
}
const LIB = path.join(DIR, "lib");
const files = fs.readdirSync(LIB).filter((f) => f.endsWith(".js") && f !== "client.js").sort();

/** 每个文件里"定义了"哪些顶层名（export 前缀无关，只看声明）。 */
const declRe = /^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
const defined = new Map();
const bodies = new Map();
for (const f of files) {
  const text = fs.readFileSync(path.join(LIB, f), "utf8");
  bodies.set(f, text);
  const names = new Set();
  for (const line of text.split("\n")) {
    const m = declRe.exec(line);
    if (m !== null) names.add(m[1]);
  }
  // `export { A, B };` 形式（本方案的入口文件用）也算"本文件对外提供"
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}\s*(?:from\s*"[^"]*"\s*)?;?\s*$/gm)) {
    for (const part of m[1].split(",")) {
      const nm = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) names.add(nm);
    }
  }
  defined.set(f, names);
}

/** 每个文件"import 了"哪些名字（含 `from "./x.js"`）。 */
function importedNames(text) {
  const out = new Set();
  for (const m of text.matchAll(/^import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/gm)) {
    for (const part of m[1].split(",")) {
      const nm = part.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(nm)) out.add(nm);
    }
  }
  return out;
}

const NODE_BUILTIN = new Set(["fs", "os", "path", "spawnSync", "createHash", "randomUUID", "fileURLToPath", "execFileSync"]);
const allTop = new Set();
for (const s of defined.values()) for (const n of s) allTop.add(n);

/**
 * 剥注释与字符串（**与生成器同一把尺子**，否则两边判不一致）。
 *
 * ★★★ 为什么**模板字符串不能整个剥掉**（我在这里栽过一次，纪律 4 的变体）：
 *   第一版把 `` `…${x}…` `` 整体换成 ` `` ` ⇒ **`${…}` 里的真实引用也一起没了**
 *   ⇒ 校验器报"全部 ✅"，而运行时 `part1.js` 当场 `ReferenceError: stampSec is not defined`
 *   （它正是在 `` `- ${stampSec(now)} …` `` 里被调用的）。
 *   ⇒ ★ **剥离掉的恰好是被测内容** —— 这正是"判据的输入必须是被测对象自己产生的"那条纪律。
 * ★ 修法：模板字符串**保留 `${…}` 里的表达式**，只把字面部分换成占位。
 */
function strip(t) {
  // ★ 与生成器**同一把尺子**（词法器）—— 上一版的正则在这里报过假绿。
  return codeOnly(t).replace(/\.\.\./g, " ");
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let problems = 0;
for (const f of files) {
  const text = bodies.get(f);
  const body = strip(text);
  const mine = defined.get(f);
  const got = importedNames(text);
  // 用到但不属于本文件、也不是 node 内建/全局的
  const missing = [];
  for (const n of allTop) {
    if (mine.has(n)) continue;
    if (!new RegExp(`(?<![\\w$.])${esc(n)}(?![\\w$])`).test(body)) continue;
    if (got.has(n)) continue;
    missing.push(n);
  }
  // 多余 import：import 了但本文件根本没用（无害，但要报，便于收窄）
  const unused = [];
  for (const n of got) {
    if (NODE_BUILTIN.has(n)) continue;
    if (!new RegExp(`(?<![\\w$.])${esc(n)}(?![\\w$])`).test(body)) unused.push(n);
  }
  if (missing.length || unused.length) {
    problems += 1;
    console.log(`⛔ ${f}`);
    if (missing.length) console.log(`   缺 import（会 ReferenceError）：${missing.join(", ")}`);
    if (unused.length) console.log(`   多余 import（无害）：${unused.join(", ")}`);
  } else {
    console.log(`✅ ${f}`);
  }
}
console.log(`\n有问题的文件：${problems} / ${files.length}`);
process.exitCode = problems > 0 ? 1 : 0;
