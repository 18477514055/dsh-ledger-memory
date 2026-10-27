// D329：证明情形 50⑦ 那五条断言**能被证伪**（否则它们只是装饰）。
// ★ 判据（D324）：反向验证必须摘到"能看见红"为止，且必须**跑完**（PROBE-COMPLETE），
//   崩溃冒充检出不算。
//
// ★★ 为什么要单独做一个（而不是只信 `_reverse-verify-d329`）：
//   那个验的是**探针**能红；这里验的是**自检里的常驻断言**能红 ——
//   两者是不同的守卫。探针会被清掉，自检不会。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const BREAKS = [
  {
    name: "破坏A：panelUnitsOf 直接把内部值透传（出站完全不换算 = 原病灶）",
    file: path.join("lib", "part1.js"),
    from: "out[k] = scale !== 1 && Number.isFinite(v) ? v / scale : v;",
    to: "out[k] = v;",
  },
  {
    name: "破坏B：panelUnitsOf 对**所有**数值都除 scale（会误伤无 scale 的计数项）",
    file: path.join("lib", "part1.js"),
    from: "out[k] = scale !== 1 && Number.isFinite(v) ? v / scale : v;",
    to: "out[k] = Number.isFinite(v) ? v / (scale === 1 ? 60000 : scale) : v;",
  },
  {
    name: "破坏C：panelUnitsOf 不做数值判断（字符串/布尔被 Number 运算碰到）",
    file: path.join("lib", "part1.js"),
    from: "out[k] = scale !== 1 && Number.isFinite(v) ? v / scale : v;",
    to: "out[k] = scale !== 1 ? v / scale : v;",
  },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rev50-d329-"));
const ISO = path.join(tmp, "proj");
fs.cpSync(ROOT, ISO, {
  recursive: true,
  filter: (src) => {
    const base = path.basename(src);
    // ★ 必须**保留 .git**：情形 118 有 13 条断言读真仓库（remote.pushDefault / pre-push 钩子 /
    //   私有库无记忆面）。第一版排除了它 ⇒ 基线从 2293 掉到 2281，看着像"副本坏了"。
    //   ★ 实证：`_diag-d329-count.mjs` 同代码两副本 —— 带 .git 2293（与生产逐字相等）、
    //     不带 2281 ⇒ 差的 12 条全是 `.git` 的有无，**是环境不是快照**（D327 同型）。
    return base !== "node_modules";
  },
});

const run = () => {
  const r = spawnSync(process.execPath, [path.join(ISO, "tools", "selftest.mjs")], {
    encoding: "utf8",
    cwd: ISO,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/合计：PASS (\d+) · SKIP (\d+) · FAIL (\d+)/);
  return {
    completed: m !== null,
    pass: m ? Number(m[1]) : -1,
    skip: m ? Number(m[2]) : -1,
    fail: m ? Number(m[3]) : -1,
    out,
  };
};

console.log("═══ 基线 ═══");
const b = run();
console.log(`  完成=${b.completed} PASS=${b.pass} SKIP=${b.skip} FAIL=${b.fail}`);
if (!b.completed || b.fail !== 0) {
  console.log("  ✗ 基线不绿，先修基线");
  process.exit(1);
}
console.log("  ✓ 基线绿，开始破坏");

let caught = 0;
let missed = 0;
for (const br of BREAKS) {
  const f = path.join(ISO, br.file);
  const src = fs.readFileSync(f, "utf8");
  if (!src.includes(br.from)) {
    console.log(`\n  ?? ${br.name}\n     锚点没找到 ⇒ 破坏点不自洽`);
    missed += 1;
    continue;
  }
  const backup = src;
  fs.writeFileSync(f, src.replace(br.from, br.to), "utf8");
  const r = run();
  fs.writeFileSync(f, backup, "utf8");
  const detected = r.completed && r.fail > 0;
  if (detected) caught += 1;
  else missed += 1;
  console.log(`\n  ${detected ? "✓ 检出" : "✗ 漏检"}  ${br.name}`);
  console.log(`     PASS=${r.pass} FAIL=${r.fail} 完成=${r.completed}`);
  if (detected) {
    for (const line of r.out.split("\n").filter((l) => /^\s+FAIL/.test(l)).slice(0, 6)) {
      console.log(`       ${line.trim()}`);
    }
  }
}

console.log(`\n═══ 合计：检出 ${caught} / 漏检 ${missed}（共 ${BREAKS.length}）═══`);
console.log(caught === BREAKS.length ? "⇒ 那几条常驻断言**真能被证伪**" : "⇒ 有断言是装饰品");
console.log("PROBE-COMPLETE");
