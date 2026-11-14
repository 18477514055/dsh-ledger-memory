/**
 * D376 补 import：拆出去的新文件需要**自己 import** 它引用的外部符号。
 *
 * ★ 为什么必须有这一步（这是拆模块的固定坑，D368 记过、本轮又撞）：
 *   `export { x } from "./y.js"` 只把名字**导出**，**不在本模块作用域绑定**；
 *   而拆出去的函数体里引用的 `LOCK_STORE_VERSION` / `fs` / `path` 等，
 *   原来靠 part1.js 顶部那些 import —— 搬到新文件后**一个都没有了**。
 *
 * ★ 做法：不猜、不手打 —— 从**原模块的 import 块**里按名字筛，
 *   再把筛出来的 import 语句原样复制到新文件头注之后。
 *   判据：**缺哪个符号，就去原模块的 import 里找哪个，不要自己拼路径。**
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DRY = process.argv.includes("--dry");

const PLANS = [
  { src: "lib/part3.js", out: "lib/part3-settings.js" },
  { src: "lib/part1.js", out: "lib/part1-store.js" },
];

/** 把 `import { a, b } from "x"` 拆成 {names, from, raw}；非具名 import 也保留 */
function parseImports(srcText) {
  const lines = srcText.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    // 单行 import
    let m = /^import\s+(.+?)\s+from\s+"([^"]+)";?\s*$/.exec(l);
    if (m) {
      out.push({ raw: l, spec: m[1], from: m[2] });
      continue;
    }
    // 多行 import：`import {` 开头，直到 `} from "...";`
    if (/^import\s*\{/.test(l)) {
      let j = i;
      const buf = [l];
      while (j < lines.length && !/^\}\s*from\s*"[^"]+";?\s*$/.test(lines[j])) {
        j += 1;
        if (j < lines.length) buf.push(lines[j]);
      }
      const joined = buf.join("\n");
      const mm = /^import\s*\{([\s\S]*?)\}\s*from\s*"([^"]+)";?\s*$/.exec(joined);
      if (mm) out.push({ raw: joined, spec: `{${mm[1]}}`, from: mm[2], multiline: true });
      i = j;
      continue;
    }
    // 默认 import（`import fs from "node:fs"`）
    m = /^import\s+([A-Za-z_$][\w$]*)\s+from\s+"([^"]+)";?\s*$/.exec(l);
    if (m) out.push({ raw: l, spec: m[1], from: m[2], defaultOnly: true });
  }
  return out;
}

function namesOf(spec) {
  // `{ a, b as c }` → ["a","c"]（用本地名）
  if (!spec.startsWith("{")) return [spec.trim()];
  return spec
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const as = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(x);
      return as ? as[1] : x;
    });
}

/** 从代码文本里粗取"用到的标识符"（去注释与字符串，避免误判）
 *
 * ★★★ 必须**逐行**剥离字符串，不能整文件跑正则（本轮实测栽过一次）：
 *   整文件跑 `/(?:[^"\\]|\\.)*"/` 时，**前一个字符串的收尾引号会被当成后一个的起始引号**
 *   ⇒ 跨行吞掉大段代码 ⇒ `protocolGapOf` 明明在 469/544 行被调用，却被判成"没用到"
 *   ⇒ 新文件缺 import ⇒ 运行时 `ReferenceError`。
 *   ★ 判据：**"我提取了标识符" ≠ "我提取到了该有的标识符"** —— 提取器自己也要验召回率。
 *     （D368 在锚点判据上栽过同一个形状，这是同型复发。）
 */
function usedIdentifiers(code) {
  const set = new Set();
  for (const rawLine of code.split("\n")) {
    let l = rawLine;
    // 去掉行内块注释残留与行注释
    l = l.replace(/\/\*[\s\S]*?\*\//g, " ");
    if (/^\s*\/\//.test(l)) continue;
    // ★ 逐行剥离字符串 / 模板串（同行配对，绝不跨行）
    l = l.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    l = l.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    l = l.replace(/`(?:[^`\\]|\\.)*`/g, "``");
    for (const m of l.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) set.add(m[1]);
  }
  return set;
}

let bad = 0;
for (const p of PLANS) {
  const srcAbs = path.join(PROJECT_ROOT, p.src);
  const outAbs = path.join(PROJECT_ROOT, p.out);
  const srcText = fs.readFileSync(srcAbs, "utf8");
  const outText = fs.readFileSync(outAbs, "utf8");

  const imports = parseImports(srcText);
  const used = usedIdentifiers(outText);

  // 新文件里**自己定义**的名字（export function / const）不算"要用外部"
  const selfDefined = new Set([
    ...[...outText.matchAll(/^export (?:async )?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]),
    ...[...outText.matchAll(/^export const\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]),
    ...[...outText.matchAll(/^(?:async )?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]),
    ...[...outText.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]),
  ]);

  // ★★★ 优先走**叶子模块**：若某个名字同时能从 `./base.js` / `./defs.js` 拿到，
  //   就不要从 `./partN.js` 拿 —— 后者会把新文件拖进 `lib/` 那张本来就高度成环的图
  //   （本项目栽过：新增模块 import 任何 partN 都有把求值顺序改坏的风险）。
  //   实测本例：`stamp` / `readTextSafe` / `writeFileAtomic` / `ensureDir` **全在 base.js**，
  //   而 part1.js 只是从 part2.js 转手拿的 ⇒ 新文件必须直接从 base.js 拿。
  const LEAF_SOURCES = ["./base.js", "./defs.js", "./pure-ops.js", "./manifest-mirror.js", "./backup.js", "./gates.js"];
  const leafExports = new Map(); // name -> 来源路径
  for (const rel of LEAF_SOURCES) {
    const abs = path.join(PROJECT_ROOT, "lib", path.basename(rel));
    if (!fs.existsSync(abs)) continue;
    const t = fs.readFileSync(abs, "utf8");
    for (const m of t.matchAll(/^export (?:async )?function\s+([A-Za-z_$][\w$]*)/gm)) leafExports.set(m[1], rel);
    for (const m of t.matchAll(/^export const\s+([A-Za-z_$][\w$]*)/gm)) leafExports.set(m[1], rel);
    for (const m of t.matchAll(/^export \{([^}]*)\}/gm)) {
      for (const n of m[1].split(",").map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean)) leafExports.set(n, rel);
    }
  }

  const needed = [];
  const fromLeaf = new Map(); // rel -> names[]
  for (const imp of imports) {
    const names = namesOf(imp.spec);
    const hit = names.filter((n) => used.has(n) && !selfDefined.has(n));
    if (hit.length === 0) continue;
    if (imp.defaultOnly || !imp.spec.startsWith("{")) {
      needed.push(imp.raw.trim());
      continue;
    }
    const pairs = imp.spec
      .replace(/^\{|\}$/g, "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => {
        const as = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(x);
        const local = as ? as[1] : x;
        return used.has(local) && !selfDefined.has(local);
      });
    for (const pair of pairs) {
      const as = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(pair);
      const local = as ? as[1] : pair;
      const leaf = leafExports.get(local);
      if (leaf !== undefined && leaf !== imp.from) {
        // 该名字能从叶子模块拿 ⇒ 改走叶子，不改走 partN
        if (!fromLeaf.has(leaf)) fromLeaf.set(leaf, []);
        fromLeaf.get(leaf).push(pair);
      } else {
        // 保持原来源（同一来源的合并）
        if (!fromLeaf.has(imp.from)) fromLeaf.set(imp.from, []);
        fromLeaf.get(imp.from).push(pair);
      }
    }
  }
  for (const [rel, pairs] of fromLeaf) {
    if (pairs.length > 0) needed.push(`import { ${pairs.join(", ")} } from "${rel}";`);
  }

  if (needed.length === 0) {
    console.log(`  ${p.out}：无需补 import`);
    continue;
  }

  // 插到"头注之后"（头注是 `/** … */`，找到第一个 `*/` 之后）
  const idx = outText.indexOf("*/");
  const insertAt = idx >= 0 ? outText.indexOf("\n", idx) + 1 : 0;
  const next = outText.slice(0, insertAt) + "\n" + needed.join("\n") + "\n" + outText.slice(insertAt);

  if (!DRY) fs.writeFileSync(outAbs, next, "utf8");
  console.log(`  ${p.out}：补了 ${needed.length} 条 import`);
  for (const n of needed) console.log("      " + n.slice(0, 140));
  bad += 1;
}
console.log(DRY ? "\n（DRY RUN —— 未写盘）" : "\nIMPORT-FIX-DONE");
