/**
 * D372 反向验证：逐处**构造未修形状**，确认取证器见红。
 * ★ 继承 D369/D370 的教训：破坏必须构造"未修时的完整形状"，不是"删掉修复"；
 *   替换必须**从源码逐字照抄**（不手写正则猜形状）；applied === 0 ⇒ 报「未生效」。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PROBE = "tools/_probe-d372-verify.mjs";

const runProbe = () => {
  try {
    const out = execFileSync(process.execPath, [PROBE], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const m = /合计：PASS (\d+) · FAIL (\d+)/.exec(out);
    if (m === null) return { pass: -1, fail: -1, noSentinel: true };
    return { pass: Number(m[1]), fail: Number(m[2]) };
  } catch {
    return { crashed: true, pass: -1, fail: -1 };
  }
};

const read = (f) => fs.readFileSync(f, "utf8");

const BREAKS = [
  {
    id: "B1",
    what: "撤销 F-01：卡片指纹 key 不再 encodeKey、基准退回 projectRoot（未修时的完整形状）",
    file: "lib/part8.js",
    build: () => [
      // 逐字照抄已修代码
      { from: "    const memBaseCard = memoryBaseOf(resolveInfo(info, fallbackRoot).info, baseRootCard);\n", to: "" },
      {
        from: "    const cardRelPosix = memBaseCard ? path.relative(memBaseCard, path.join(dirAbs, mode.dir, `${key}.md`)).replace(/\\\\/g, \"/\") : key;",
        to: "    const cardRelPosix = baseRootCard ? path.relative(baseRootCard, path.join(dirAbs, mode.dir, `${key}.md`)).replace(/\\\\/g, \"/\") : key;",
      },
      { from: "    const targetKey = rawFpCard?.key ?? encodeKey(cardRelPosix || key);", to: "    const targetKey = rawFpCard?.key ?? (cardRelPosix || key);" },
    ],
  },
  {
    id: "B2",
    what: "撤销 F-02a：stripFencedCodeForFp 不再擦行内反引号（还原未修形状）",
    file: "lib/fingerprint.js",
    build: () => [
      {
        from: "    const stripped = inFence ? \"\" : l.replace(/`[^`\\n]*`/g, (m) => \" \".repeat(m.length));\n    out.push(stripped);",
        to: "    out.push(inFence ? \"\" : l);",
      },
    ],
  },
  {
    id: "B3",
    what: "撤销 F-02b：把 applyFingerprint3 里那段激进的行内替换加回（未修时的完整形状）",
    file: "lib/fingerprint.js",
    build: () => [
      {
        from: "      keptLines.push(nextL);",
        to:
          "      nextL = nextL.replace(/<!--\\s*dsh-ledger-fp:[\\s\\S]*?-->/g, () => {\n" +
          "        removed += 1;\n" +
          "        return \"\";\n" +
          "      });\n" +
          "      keptLines.push(nextL);",
      },
    ],
  },
  {
    id: "B4",
    what: "撤销 F-03：locateProjectRoots 去掉 visited 去重",
    file: "lib/fingerprint.js",
    build: () => [
      { from: "  const visited = new Set();\n", to: "" },
      { from: "    if (visited.has(dirAbs)) return;\n    visited.add(dirAbs);\n", to: "" },
    ],
  },
  {
    id: "B5",
    what: "撤销 F-04：writePrinciples 回执去掉 backup / backupFailed 回显",
    file: "lib/part2.js",
    build: () => [
      { from: "    ...(b?.ok === true ? { backup: b.rel } : {}),\n", to: "" },
      { from: "    ...(b?.ok === true || b?.skipped === true ? {} : { backupFailed: b?.reason ?? \"未知\" }),\n", to: "" },
    ],
  },
  {
    id: "B6",
    what: "撤销 F-06：scanFingerprints / scanBlind 去掉入参防御",
    file: "lib/fingerprint.js",
    build: () => [
      {
        from: '  if (typeof rootAbs !== "string" || rootAbs.trim() === "") {\n    return { byKind: new Map(), byProject: new Map(), bad: [], scanned: 0, unreadable: 0, truncated: false };\n  }\n',
        to: "",
      },
      {
        from:
          '  if (typeof rootAbs !== "string" || rootAbs.trim() === "") {\n' +
          "    return {\n      byKind: new Map(),\n      byProject: new Map(),\n      bad: [],\n      scanned: 0,\n" +
          "      skippedBinary: 0,\n      skippedBig: 0,\n      unreadable: 0,\n      truncated: false,\n    };\n  }\n",
        to: "",
      },
    ],
  },
];

const base = runProbe();
console.log(`基线：PASS ${base.pass} · FAIL ${base.fail}${base.noSentinel === true ? "（★ 没有跑完哨兵 ⇒ 探针没跑完）" : ""}`);
if (base.fail !== 0 || base.noSentinel === true) {
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
  const red = r.crashed === true || r.noSentinel === true || r.fail > 0;
  if (red) {
    caught += 1;
    rows.push(`红  ${b.id} ${b.what} ⇒ FAIL ${r.fail}（替换 ${applied}/${built.length} 处）`);
  } else {
    missed += 1;
    rows.push(`★仍绿 ${b.id} ${b.what} ⇒ 替换 ${applied} 处仍全绿 ⇒ 这条修复没有被断言守着`);
  }
}

console.log(rows.join("\n"));
const after = runProbe();
console.log("─".repeat(72));
console.log(`反向验证：${caught} / ${BREAKS.length} 见红${missed > 0 ? `，${missed} 处没见红` : ""}`);
console.log(`还原后复核：PASS ${after.pass} · FAIL ${after.fail}`);
console.log("REVERSE-COMPLETE");
process.exit(missed === 0 && after.fail === 0 ? 0 : 1);
