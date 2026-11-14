/**
 * D370 反向验证：逐处**构造未修形状**，确认取证器见红。
 * ★ 继承 D369 的教训：破坏必须构造"未修时的完整形状"，不是"删掉修复"；
 *   且替换必须从源码精确照抄（不手写正则猜形状）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PROBE = "tools/_probe-d370-verify.mjs";

const runProbe = () => {
  try {
    const out = execFileSync(process.execPath, [PROBE], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const m = /合计：PASS (\d+) · FAIL (\d+)/.exec(out);
    return m === null ? { pass: -1, fail: -1 } : { pass: Number(m[1]), fail: Number(m[2]) };
  } catch {
    return { crashed: true, pass: -1, fail: -1 };
  }
};

const read = (f) => fs.readFileSync(f, "utf8");

const BREAKS = [
  {
    id: "B1",
    what: "撤销 F-01：扩展写入时不再注入三载体指纹（按变量名精确摘）",
    file: "lib/part8.js",
    // ★★★ 第 1 版没生效：我按 `{ fp: ... }` 字面量删，而实际传的是**变量** `fpOptExt` / `fpOptNew`。
    //   ⇒ 判据：破坏要摘的是**真正被传进去的那个东西**，不是我以为的形状。
    build: () => [
      { from: "const w = writeFileAtomic(file, nextText, fpOptExt);", to: "const w = writeFileAtomic(file, nextText);" },
      {
        from: "          fpOptNew,\n",
        to: "",
      },
    ],
  },
  {
    id: "B2",
    what: "撤销 F-02：resolveByIdentity 按名解析去掉越界校验",
    file: "lib/fingerprint.js",
    build: () => {
      const t = read("lib/fingerprint.js");
      const i = t.indexOf("export function resolveByIdentity");
      if (i < 0) throw new Error("找不到 resolveByIdentity");
      const seg = t.slice(i, i + 3000);
      const m = /if\s*\(\s*isAbsoluteAnywhere\(name\)[^)]*\)[^;]*;|isUnderReal\(rootAbs,\s*path\.resolve\(rootAbs,\s*name\)\)/.exec(seg);
      if (m === null) throw new Error("找不到越界校验");
      return [{ from: m[0], to: "false" }];
    },
  },
  {
    id: "B3",
    what: "撤销 F-03：archiveLedger 回执去掉 backup 回显",
    file: "lib/part4.js",
    build: () => [
      { from: "...(backup?.ok === true ? { backup: backup.rel } : {}),", to: "" },
      { from: "...(backup?.ok === true || backup?.skipped === true ? {} : { backupFailed: backup?.reason ?? \"未知\" }),", to: "" },
    ],
  },
  {
    id: "B4",
    what: "撤销 F-04：writePrinciples 原子写失败改回 throw",
    file: "lib/part2.js",
    build: () => {
      const t = read("lib/part2.js");
      const i = t.indexOf("export function writePrinciples");
      const seg = t.slice(i, i + 6000);
      // 找 "_w.ok !== true" 后的返回
      const m = /if\s*\(\s*_w\.ok\s*!==\s*true\s*\)\s*\{?[\s\S]{0,400}?\}/.exec(seg);
      if (m === null) throw new Error("找不到 _w.ok 分支");
      return [{ from: m[0], to: 'if (_w.ok !== true) throw new Error(String(_w.reason ?? "原子写失败"));' }];
    },
  },
  {
    id: "B5",
    what: "撤销 F-05：identityOfPath 卡片目录不再排除 SECURITY.md",
    file: "lib/fingerprint.js",
    build: () => [
      { from: "!/^(INDEX|README|SECURITY)\\.md$/i.test(baseName)", to: "!/^(INDEX|README)\\.md$/i.test(baseName)" },
    ],
  },
  {
    id: "B6",
    what: "撤销 F-06：损坏指纹判据改回对不上的串",
    file: "lib/fingerprint.js",
    // ★★★ 第 1 版未生效：我按 `if (includes("损坏"))` 猜形状，实际是 `String(p3.reason).includes("损坏") ||`。
    //   ⇒ 判据：替换串必须**从源码照抄**，不许按记忆猜。
    build: () => [{ from: 'String(p3.reason).includes("损坏") ||', to: 'String(p3.reason).includes("损坏或被篡改") ||' }],
  },
  {
    id: "B7",
    what: "撤销 F-07：locateProjectRoots 去掉入参类型防御",
    file: "lib/fingerprint.js",
    build: () => {
      const t = read("lib/fingerprint.js");
      const m = /if\s*\(\s*typeof startAbs\s*!==\s*"string"\s*\|\|\s*startAbs\.trim\(\)\s*===\s*""\s*\)\s*return\s*\{[^}]*\};/.exec(t);
      if (m === null) throw new Error("找不到 locateProjectRoots 的类型防御");
      return [{ from: m[0], to: "" }];
    },
  },
];

const base = runProbe();
console.log(`基线：PASS ${base.pass} · FAIL ${base.fail}`);
if (base.fail !== 0) {
  console.log("★ 基线不全绿 ⇒ 先修取证器。");
  process.exit(2);
}

let caught = 0;
let missed = 0;
const rows = [];
for (const b of BREAKS) {
  const abs = path.join(process.cwd(), b.file);
  const original = fs.readFileSync(abs);
  let text = original.toString("utf8");
  let built;
  try {
    built = b.build();
  } catch (e) {
    rows.push(`★构造失败 ${b.id} ${b.what} ⇒ ${String(e?.message ?? e)}`);
    missed += 1;
    continue;
  }
  let applied = 0;
  for (const r of built) {
    if (text.includes(r.from)) {
      text = text.split(r.from).join(r.to);
      applied += 1;
    }
  }
  if (applied === 0) {
    rows.push(`★未生效 ${b.id} ${b.what} ⇒ ${built.length} 条替换一条都没命中`);
    missed += 1;
    continue;
  }
  fs.writeFileSync(abs, text, "utf8");
  const r = runProbe();
  fs.writeFileSync(abs, original);
  const red = r.crashed === true || r.fail > 0;
  if (red) {
    caught += 1;
    rows.push(`红  ${b.id} ${b.what} ⇒ FAIL ${r.fail}（替换 ${applied} 处）`);
  } else {
    missed += 1;
    rows.push(`★仍绿 ${b.id} ${b.what} ⇒ 替换 ${applied} 处仍全绿 ⇒ 这条修复没有被断言守着`);
  }
}

console.log(rows.join("\n"));
const after = runProbe();
console.log("─".repeat(70));
console.log(`反向验证：${caught} / ${BREAKS.length} 见红${missed > 0 ? `，${missed} 处没见红` : ""}`);
console.log(`还原后复核：PASS ${after.pass} · FAIL ${after.fail}`);
console.log("REVERSE-COMPLETE");
process.exit(missed === 0 && after.fail === 0 ? 0 : 1);
