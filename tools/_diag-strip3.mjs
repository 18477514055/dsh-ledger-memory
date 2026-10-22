// 验 selftest 里那把 strip 对**真实源码**是否够用。
// ★ 用 spawnSync 跑 selftest 拿到 globalThis 不现实；改为对 selftest 源码做同样处理：
//   直接 import 它的函数定义（selftest 是脚本，import 会执行整份 —— 太慢）。
// ⇒ 折中：把函数体抠出来，用 **正则边界**（函数名 + 下一个 function）精确切。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const selfSrc = fs.readFileSync(path.join(ROOT, "tools", "selftest.mjs"), "utf8");

function grab(name) {
  const i = selfSrc.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`找不到 ${name}`);
  // 从函数头开始，按大括号配平找结尾
  let j = selfSrc.indexOf("{", i);
  let depth = 0;
  for (; j < selfSrc.length; j++) {
    if (selfSrc[j] === "{") depth++;
    else if (selfSrc[j] === "}") {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
    }
  }
  return selfSrc.slice(i, j);
}

const fnNeeds = grab("needsValueAfter");
const fnStrip = grab("stripCommentsAndLiterals");
const strip = new Function(`${fnNeeds}\n${fnStrip}\nreturn stripCommentsAndLiterals;`)();

// ── 夹具：字面量里的块注释结束符 ─────────────────────────────────────
const tricky = [
  "const a = 1;",
  "// 普通注释",
  "const re = /^[^0-9]*/;",
  "function after() {}",
  'const s = "字符串里的 /* 不该算注释";',
  "function after2() {}",
].join("\n");
const out = strip(tricky);
const probe = [
  ["after 保住", out.includes("function after")],
  ["after2 保住", out.includes("function after2")],
  ["普通注释被剥", !out.includes("普通注释")],
];

// ── 真实对象 ─────────────────────────────────────────────────────────
const p2 = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");
const code = strip(p2);
for (const n of ["authorizeRequest", "assertAuthorized", "writeFileAtomic", "isUnderReal"]) {
  probe.push([`part2.${n} 保住`, new RegExp(`export\\s+function\\s+${n}\\s*\\(`).test(code)]);
}
const o = [...p2.matchAll(/export\s+function\s+(\w+)/g)].length;
const k = [...code.matchAll(/export\s+function\s+(\w+)/g)].length;
probe.push([`export function 数不变（${o} vs ${k}）`, o === k]);

let bad = 0;
for (const [label, ok] of probe) {
  if (!ok) bad++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log(bad === 0 ? "\n✅ strip 正确" : `\n❌ ${bad} 处`);
process.exitCode = bad ? 1 : 0;
