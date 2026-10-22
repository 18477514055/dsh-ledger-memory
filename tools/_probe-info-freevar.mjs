/**
 * 探针：**用 Node 自己证明** `info` 在 `runMidTurnCompact` 里是自由变量。
 *
 * ★ 为什么要这么绕：上一版我靠"诊断文件没出现"来推断 —— 那是**间接证据**，
 *   而文件不出现也可能因为夹具没走到、权限、路径……
 *   ⇒ 这次换成**直接证据**：不读源码猜，也不 mock OS，
 *     而是把函数体当成一段**可求值的文本**，在受控作用域里跑，
 *     让 JS 引擎自己告诉你 `info` 有没有绑定。
 *
 * ★ 做法（关键的技巧）：
 *   用 `new Function` 造一个和原函数**同形参**的壳，壳里**只放那一行**，
 *   变量沿作用域链查找 —— 若 `info` 未定义，就会抛 `ReferenceError: info is not defined`。
 *   这说明：**在同一套形参下，`info` 不来自形参**。
 *   然后我们再去模块顶层找 `info` —— 有，就是"外部变量"；没有，就是真·自由变量（bug）。
 *
 * 跑法：node tools/_probe-info-freevar.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");
const part3Path = path.join(LIB, "part3.js");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `  ← ${extra}`}`);
  }
};

// ── ① 把 `info` 那一行抓出来（原样，不是改写）──
const src = fs.readFileSync(part3Path, "utf8");
const lines = src.split(/\r?\n/);
const runStart = lines.findIndex((l) => /^export async function runMidTurnCompact/.test(l));
ok("① 定位 runMidTurnCompact", runStart >= 0);

// 找函数体里第一处 `const rootDir = info?` 那一行
let refLineNo = -1;
let refText = "";
for (let i = runStart; i < lines.length; i++) {
  if (/const\s+rootDir\s*=\s*info\?/.test(lines[i])) {
    refLineNo = i + 1;
    refText = lines[i].trim();
    break;
  }
  if (/^(export |function )/.test(lines[i]) && i > runStart + 2) break;
}
ok("① 抓到那句原话（不改写、不重打）", refLineNo > 0, `未找到`);
if (refLineNo > 0) console.log(`        ${refLineNo}: ${refText}`);

// ── ② 用同形参的壳跑这一行，看会不会抛 ReferenceError ──
//   ★ 壳的形参**必须与原函数逐字一致**，否则等于换了个夹具（纪律 8）。
const sigMatch = /^export async function runMidTurnCompact\s*\(([^)]*)\)/.exec(
  lines[runStart],
);
const params = sigMatch ? sigMatch[1] : "";
ok("② 取到原函数的形参表", params.includes("ctx") && params.includes("deps"), params);
console.log(`        形参 = (${params})`);

// 壳里不放 info，也不放任何叫 info 的东西
const shellBody = `${refText}\nreturn typeof rootDir;`;
let shellErr;
let shellOut;
try {
  // eslint-disable-next-line no-new-func
  const fn = new Function(params, shellBody);
  // 传哑参即可：我们只关心 `info` 解析得到不到
  shellOut = fn({}, {}, {}, {});
} catch (e) {
  shellErr = e;
}

ok(
  "② 🔴 在**同形参**下执行那一行 ⇒ 抛 ReferenceError(info is not defined)",
  shellErr instanceof ReferenceError && /info/.test(String(shellErr.message)),
  shellErr === undefined ? `没抛，返回 ${shellOut}` : `${shellErr.name}: ${shellErr.message}`,
);
if (shellErr !== undefined) console.log(`        ${shellErr.name}: ${shellErr.message}`);

// ── ③ 反证：把 info 显式传进去，它就不抛了 ──
//   ⇒ 证明"抛"确实是因为**没有绑定**，不是这句语法有问题。
let fixedOut;
let fixedErr;
try {
  // eslint-disable-next-line no-new-func
  const fn2 = new Function(params, `const info = { projectRoot: "X" };\n${refText}\nreturn rootDir;`);
  fixedOut = fn2({}, {}, {}, {});
} catch (e) {
  fixedErr = e;
}
ok(
  "③ 反证：补上 `const info = {…}` 之后同一行不抛（说明缺的就是这个绑定）",
  fixedErr === undefined && fixedOut === "X",
  fixedErr === undefined ? `返回 ${JSON.stringify(fixedOut)}` : `${fixedErr.name}: ${fixedErr.message}`,
);

// ── ④ 模块顶层有没有 `info`（若有，它就不是自由变量）──
const mod = await import(pathToFileURL(part3Path).href);
ok(
  "④ part3 的**导出**里没有 info（所以不是从模块导入来的）",
  !Object.prototype.hasOwnProperty.call(mod, "info"),
  Object.keys(mod).filter((k) => /info/i.test(k)).join(",") || "(无含 info 的导出)",
);

// ── ⑤ 全模块顶层有没有 `let/const/var info` ──
const topLevelInfo = [];
{
  // 粗判据：行首（允许缩进 0）声明的 info
  for (let i = 0; i < lines.length; i++) {
    if (/^(?:export\s+)?(?:const|let|var)\s+info\b/.test(lines[i])) topLevelInfo.push(i + 1);
  }
}
ok(
  "⑤ 模块顶层**没有** info 声明（⇒ 那句是真·自由变量 ⇒ 必然 ReferenceError）",
  topLevelInfo.length === 0,
  `实际有 ${topLevelInfo.length} 处：${topLevelInfo.join(",")}`,
);

// ── ⑥ 结论汇总 ──
console.log("\n── ⑥ 判定 ──");
if (shellErr instanceof ReferenceError && topLevelInfo.length === 0 && !mod.info) {
  console.log("  ⇒ `info` 在 runMidTurnCompact 里**没有任何绑定**。");
  console.log("  ⇒ 第 " + refLineNo + " 行运行时必抛 ReferenceError。");
  console.log("  ⇒ 它外面是 `try { … } catch {}`（part3.js:3080）⇒ **静默吞掉**。");
  console.log("  ⇒ 结论：**诊断块从未真正执行过**，所以 .dsh-ledger-midturn.log 永远不出现。");
} else {
  console.log("  ⇒ 判定未成立，需人工复核（别硬套结论）。");
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
