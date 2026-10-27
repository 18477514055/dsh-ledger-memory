// D329：查清「生产 2293 vs 我的一次性副本 2281」差的 12 条到底是什么。
// ★ 纪律：数字不同**先问是不是环境不同**，不许猜、也不许当"副本坏了"。
// 做法：同一份代码做两个副本 —— A 带 .git、B 不带 .git，其余完全相同。
//   若 A==生产且 B==2281，则差异**全部来自 .git 的有无**（= 环境，不是快照）。
//   若都不等于生产，再往下查。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "diag-d329-count-"));

function makeCopy(name, keepGit) {
  const dst = path.join(tmp, name);
  fs.cpSync(ROOT, dst, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      if (base === "node_modules") return false;
      if (!keepGit && base === ".git") return false;
      return true;
    },
  });
  return dst;
}

function run(cwd) {
  const r = spawnSync(process.execPath, [path.join(cwd, "tools", "selftest.mjs")], {
    encoding: "utf8",
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/合计：PASS (\d+) · SKIP (\d+) · FAIL (\d+)/);
  const passLines = new Set(
    out.split("\n").filter((l) => /^\s+PASS\s/.test(l)).map((l) => l.trim())
  );
  return {
    completed: m !== null,
    pass: m ? Number(m[1]) : -1,
    skip: m ? Number(m[2]) : -1,
    fail: m ? Number(m[3]) : -1,
    passLines,
    out,
  };
}

console.log("═══ 生产（原地）═══");
const prod = run(ROOT);
console.log(`  PASS=${prod.pass} SKIP=${prod.skip} FAIL=${prod.fail} 完成=${prod.completed}`);

console.log("");
console.log("═══ 副本 A（带 .git）═══");
const a = run(makeCopy("with-git", true));
console.log(`  PASS=${a.pass} SKIP=${a.skip} FAIL=${a.fail} 完成=${a.completed}`);

console.log("");
console.log("═══ 副本 B（不带 .git）═══");
const b = run(makeCopy("no-git", false));
console.log(`  PASS=${b.pass} SKIP=${b.skip} FAIL=${b.fail} 完成=${b.completed}`);

console.log("");
console.log("═══ 差在哪：A 有而 B 没有的 PASS 行 ═══");
const onlyA = [...a.passLines].filter((l) => !b.passLines.has(l));
for (const l of onlyA) console.log(`  + ${l}`);
console.log(`  共 ${onlyA.length} 条`);

console.log("");
console.log("═══ 差在哪：B 有而 A 没有的 PASS 行 ═══");
const onlyB = [...b.passLines].filter((l) => !a.passLines.has(l));
for (const l of onlyB) console.log(`  + ${l}`);
console.log(`  共 ${onlyB.length} 条`);

console.log("");
console.log("═══ 判定 ═══");
console.log(`  生产=${prod.pass}  A(带.git)=${a.pass}  B(无.git)=${b.pass}`);
if (prod.pass === a.pass) {
  console.log("  ⇒ 差异**全部来自 .git 的有无**（环境差异，不是另一份快照）。");
  console.log(`     生产与带 .git 的副本逐字相等；去掉 .git 就少 ${a.pass - b.pass} 条依赖 git 仓库的断言。`);
} else {
  console.log(`  ⇒ 还有别的差异（生产与副本 A 不等，差 ${prod.pass - a.pass}）⇒ 需继续查。`);
  const onlyProd = [...prod.passLines].filter((l) => !a.passLines.has(l));
  for (const l of onlyProd.slice(0, 20)) console.log(`       生产独有: ${l}`);
}
console.log("PROBE-COMPLETE");
