/**
 * ★★★★ 探针（D386）：**看板六类记忆面的 kind→rel 映射必须各对各的**。
 *
 * 为什么要有它：真机上「台账 / 流水 / 根本原则」三个标签全是空/一行，而磁盘上
 * `LEDGER.md` 有 34 KB。根因是 `kindToRel` 只写三支、其它 kind **一路回落到 `goalsRel`**
 * （`active` → `GOALS.md`），且 `cardModeOf` 用 `goalsDir` 去判非决策类的形态。
 * 这两个都是**静默**的：不抛错、返回"看起来合法"的路径。
 *
 * 判据两层：
 *   ① **纯函数层**（离线、确定性）：给一个六类全不同的假 info，六个 kind 必须各返回自己的 rel；
 *      `cardModeOf` 对 active/journal/principles 必须 `card:false`，即使 goalsDir 已登记。
 *   ② **真项目层**（可选 argv 给项目根）：用与看板完全相同的调用链，把每类读到的字符数打出来。
 *
 * ★ 反向验证：把 `kindToRel` 退回三支写法 ⇒ ① 里四条当场见红。
 */
import fs from "node:fs";
import path from "node:path";
import { inspect } from "../lib/part2.js";
import { kindToRel, cardModeOf, listCards, readKindRaw } from "../lib/card-ops.js";

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra === undefined ? "" : " → " + extra}`); }
};

// ── ① 纯函数层：六类各不同的假 info（golasDir 故意登记，用来暴露"回落 goals"）──
const fake = {
  activeRel: "L-A.md",
  decisionsRel: "D-A.md",
  journalRel: "J-A.md",
  lessonsRel: "S-A.md",
  goalsRel: "G-A.md",
  principlesRel: "P-A.md",
  decisionsDir: "",
  lessonsDir: "",
  goalsDir: "goals", // ★ 故意登记：三支写法会让 active 走 goalsDir
};
const want = {
  active: "L-A.md",
  decisions: "D-A.md",
  journal: "J-A.md",
  lessons: "S-A.md",
  goals: "G-A.md",
  principles: "P-A.md",
};
for (const [kind, rel] of Object.entries(want)) {
  const got = kindToRel(fake, kind);
  ok(`① kindToRel(${kind}) = ${rel}`, got === rel, String(got));
}
ok("① 未知 kind ⇒ undefined（不许回落）", kindToRel(fake, "nope") === undefined, String(kindToRel(fake, "nope")));
for (const kind of ["active", "journal", "principles"]) {
  const m = cardModeOf(fake, kind);
  ok(`① cardModeOf(${kind}).card === false（即使 goalsDir 已登记）`, m?.card === false, JSON.stringify(m));
}
ok("① cardModeOf(goals).card === true（该登记仍生效）", cardModeOf(fake, "goals")?.card === true);

// ── ② 真项目层（可选）──
const ROOT = process.argv[2];
if (ROOT !== undefined) {
  console.log(`\n真项目层：${ROOT}`);
  const info = inspect(ROOT);
  console.log(`  layout=${info.memoryRoot ? "v3" : "flat"} memoryRoot=${info.memoryRoot ?? "—"} revision=${info.revision ?? "—"}`);
  for (const kind of ["active", "decisions", "journal", "lessons", "goals", "principles"]) {
    const mode = cardModeOf(info, kind);
    let text = "";
    let extraTxt = "";
    if (mode.card === true) {
      let cards = [];
      try { cards = listCards(path.join(ROOT, info.memoryRoot ?? ""), mode.dirRel) ?? []; } catch {}
      extraTxt = `卡片 ${cards.length} 张`;
      try { text = readKindRaw(ROOT, info, kind)?.raw ?? ""; } catch {}
    } else {
      try { text = readKindRaw(ROOT, info, kind)?.raw ?? ""; } catch {}
      extraTxt = `rel=${JSON.stringify(mode.fileRel)}`;
    }
    console.log(`  ${kind.padEnd(10)} ${String(text.length).padStart(6)} 字符 · ${extraTxt}`);
    // ★ 只要"该类自己声明了 rel 且文件在磁盘上存在"，读出的正文就不许为 0。
    const rel = mode.card === true ? undefined : mode.fileRel;
    if (typeof rel === "string" && rel !== "") {
      const abs = path.join(ROOT, info.memoryRoot ?? "", rel);
      if (fs.existsSync(abs) && fs.statSync(abs).size > 0) {
        ok(`② ${kind} 文件存在（${fs.statSync(abs).size} B）⇒ 必须读到正文`, text.length > 0, `${text.length} 字符`);
      }
    }
  }
}

console.log(`\n合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
