// D217 · 核出「给市场条目用的真值」—— 一个数字都不许凭印象写。
// 用法：node tools/_probe-d217-market-truth.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const lib = path.join(ROOT, "lib");

const defs = fs.readFileSync(path.join(lib, "defs.js"), "utf8");
const index = fs.readFileSync(path.join(lib, "index.js"), "utf8");
const all = fs
  .readdirSync(lib)
  .filter((f) => f.endsWith(".js"))
  .sort()
  .map((f) => fs.readFileSync(path.join(lib, f), "utf8"))
  .join("\n");

// ① 子命令：从真源 LEDGER_SUBCOMMANDS 数
const i = defs.indexOf("const LEDGER_SUBCOMMANDS = [");
const j = defs.indexOf("\n];", i);
const seg = defs.slice(i, j);
const subs = [...seg.matchAll(/sub:\s*"([a-zA-Z_]+)"/g)].map((m) => m[1]);
console.log(`① 子命令（真源 LEDGER_SUBCOMMANDS）：${subs.length} 条`);
console.log(`   ${subs.join(" / ")}`);
console.log(`   ★ 含 triage? ${subs.includes("triage") ? "是" : "否 —— 那它就不是子命令，别写进市场条目"}`);

// ② 工具：与自检情形 43 同一套判据（字面量 + 常量两种写法）
const regStart = all.indexOf("for (const [label, factory] of [");
const regEnd = all.indexOf("]) {", regStart);
const regSeg = all.slice(regStart, regEnd === -1 ? regStart + 8000 : regEnd);
const literalNames = [...regSeg.matchAll(/\["(ledger_[a-z_]+)"/g)].map((m) => m[1]);
const constNames = [...regSeg.matchAll(/\[([A-Z][A-Z0-9_]+),\s*\(\)\s*=>/g)].map((m) => m[1]);
console.log(`\n② 工具：${literalNames.length} 字面量 + ${constNames.length} 常量 = ${literalNames.length + constNames.length}`);

// ③ 设置项
const ssStart = all.indexOf("const SETTING_SPECS = [");
const ssEnd = all.indexOf("\n];", ssStart);
const ssSeg = all.slice(ssStart, ssEnd);
const keys = [...ssSeg.matchAll(/\n\s{2}\{\s*\n\s{4}key:\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
console.log(`③ 设置项：${keys.length}`);

// ④ 运行时依赖（市场条目说「零运行时依赖」必须是真的）
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
console.log(`\n④ dependencies：${JSON.stringify(pkg.dependencies ?? {})}`);
console.log(`   peerDependencies：${JSON.stringify(pkg.peerDependencies ?? {})}`);
console.log(`   ⇒ 「零运行时依赖」${Object.keys(pkg.dependencies ?? {}).length === 0 ? "成立" : "★ 不成立，不许写"}`);

// ⑤ 版本
console.log(`\n⑤ 版本：${pkg.version}`);
