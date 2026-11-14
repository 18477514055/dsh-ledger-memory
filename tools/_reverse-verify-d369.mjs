/**
 * D369 反向验证 v2：破坏方式改为**从源码精确照抄**，不再手写正则猜形状。
 * ★★★ 上一版 v1 只有 1/6 见红，其中 3 处是「破坏没生效」（正则不匹配）——
 *   那不是"判据太弱"，是**我的破坏工具自己坏了**。尺子错第 26 条同型：
 *   **统计/破坏之前先把原文原样 dump 出来，形状对了再写替换。**
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PROBE = "tools/_probe-d369-verify.mjs";

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

// 从源码里截取"精确子串"的小工具：给定定位行里的一段，原样取出
const pick = (file, needle) => {
  const t = read(file);
  const i = t.indexOf(needle);
  if (i < 0) throw new Error(`在 ${file} 里找不到 ${JSON.stringify(needle.slice(0, 60))}`);
  return { text: t, index: i };
};

const BREAKS = [
  {
    id: "B1",
    what: "撤销 manifestMirrorPath 拒绝 '.' 与 '.' 段",
    file: "lib/manifest-mirror.js",
    build: () => {
      const N1 = 'if (norm === "" || norm === ".") return undefined;';
      const N2 = 'norm.split("/").some((seg) => seg === "" || seg === "." || seg === "..")';
      return [
        { from: N1, to: 'if (norm === "") return undefined;' },
        { from: N2, to: 'norm.split("/").some((seg) => seg === "" || seg === "..")' },
      ];
    },
  },
  {
    id: "B2",
    what: "撤销 verifySeal 的 forSeal 同源剥离（**必须把二次剥离那段加回去**）",
    file: "lib/fingerprint.js",
    // ★★★★★ 这一条我改了三版才对，过程本身值钱：
    //   v1 只改调用处 ⇒ 实现里 `if (opts.forSeal === true)` 还在 ⇒ 仍绿。
    //   v2 调用处 + 实现两处都撤 ⇒ **仍绿**。
    //     为什么？补丁不仅加了 forSeal，还**删掉了原来的二次剥离那三行**
    //     （`const fmKeep = /^---\n[\s\S]*?\n---\n/.exec(noBom)` …）。
    //     只撤 forSeal = 回到"普通 strip 且**没有**二次剥离" ⇒ 反而更正确 ⇒ 当然不红。
    //   ⇒ 真正的破坏是**把那段二次剥离加回去**（这才是"未修"的样子）。
    //   ★ 判据：**破坏必须构造出"未修时的完整形状"，不是"删掉修复"** —— 两者不等价。
    build: () => [
      { from: "{ strip: true, forSeal: true }", to: "{ strip: true }" },
      { from: "    if (opts.forSeal === true) return { text: s, removed, added: false };\n", to: "" },
      {
        from: "    stripped = applyFingerprint3(text, undefined, { strip: true }).text;\n",
        to:
          "    stripped = applyFingerprint3(text, undefined, { strip: true }).text;\n" +
          "    const noBom = stripped.startsWith(\"\\uFEFF\") ? stripped.slice(1) : stripped;\n" +
          "    const fmKeep = /^---\\n[\\s\\S]*?\\n---\\n/.exec(noBom);\n" +
          "    if (fmKeep !== null) stripped = noBom.slice(fmKeep[0].length);\n",
      },
    ],
  },
  {
    id: "B3",
    what: "撤销多载体 seal 一致性核对",
    file: "lib/fingerprint.js",
    build: () => {
      const t = read("lib/fingerprint.js");
      // 找 verifySeal 里涉及 seals 的那段
      const i = t.indexOf("p.seals");
      if (i < 0) throw new Error("找不到 p.seals");
      const start = t.lastIndexOf("//", i);
      // 截到该 if 块结束：从 i 往前找到 "if (" 开始
      const ifStart = t.lastIndexOf("if (", i);
      if (ifStart < 0) throw new Error("找不到对应 if");
      // 简单法：把条件改成 false
      const lineEnd = t.indexOf("\n", ifStart);
      const condLine = t.slice(ifStart, lineEnd);
      return [{ from: condLine, to: "if (false) {" }];
    },
  },
  {
    id: "B4",
    what: "撤销 writeLedger/archiveLedger 里行内信标 kind/key 兜底",
    file: "lib/part4.js",
    // ★★★ v2 的正则 `\.kind \?\? "[a-z]+"` 匹配不到真实形态：
    //   实际是 `rawFpW.kind ?? target`（变量）、`r3Arch.id.kind ?? "archive"`（多一层 .id）。
    //   ⇒ 改为**逐条精确替换**（从源码照抄）。
    build: () => [
      { from: "kind: rawFpW.kind ?? target", to: "kind: rawFpW.kind" },
      { from: "key: rawFpW.key ?? \"-\"", to: "key: rawFpW.key" },
      { from: "kind: r3Arch.id.kind ?? \"archive\"", to: "kind: r3Arch.id.kind" },
      { from: "kind: rawFpAct.kind ?? \"active\"", to: "kind: rawFpAct.kind" },
      { from: "key: rawFpAct.key ?? \"-\"", to: "key: rawFpAct.key" },
    ],
  },
  {
    id: "B5",
    what: "撤销 conformanceOf 对 README/SECURITY 与符号链接的过滤",
    file: "lib/part2.js",
    build: () => {
      const t = read("lib/part2.js");
      const m = /!\s*\/\^\(\?:INDEX\|README\|SECURITY\)[^\n]{0,80}/.exec(t);
      if (m === null) throw new Error("找不到 README/SECURITY 过滤");
      return [{ from: m[0], to: "true" }];
    },
  },
  {
    id: "B6",
    what: "撤销 extUsageOf 的指纹剥离（回到未剥离判空）",
    file: "lib/part8.js",
    build: () => {
      const t = read("lib/part8.js");
      const i = t.indexOf("function extUsageOf");
      if (i < 0) throw new Error("找不到 extUsageOf");
      const seg = t.slice(i, i + 2600);
      const m = /applyFingerprint3\([^)]*\{ strip: true \}\)\.text/.exec(seg);
      if (m === null) throw new Error("extUsageOf 里找不到 strip 剥离");
      return [{ from: m[0], to: "text" }];
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
