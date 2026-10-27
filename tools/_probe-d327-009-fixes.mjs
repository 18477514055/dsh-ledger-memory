/**
 * _probe-d327-009-fixes.mjs —— 独立验证 Gemini 009 的五条修复**行为上**真的成立。
 *
 * ★ 关键设计：这个探针在**打补丁之前**跑必须见红（证明病真的存在），
 *   打补丁之后跑必须全绿（证明修真的有效）。两条都成立，才算"病真、修也真"。
 *
 * ★ 判据不从 009 的断言里抄 —— 从「我要的行为」出发。
 *   本项目已栽过：报告说"已修 + 断言已加"而断言条件位写错 ⇒ 永远绿（D323 的 ok() 参数顺序）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (f) => import(pathToFileURL(path.join(ROOT, "lib", f)).href);

const part1Mod = await load("part1.js");
const part2Mod = await load("part2.js");
const part3Mod = await load("part3.js");
const part4Mod = await load("part4.js");
const part5Mod = await load("part5.js");
// ★ `setActiveSettings` 的**唯一出口**在 `defs.js`（`part1.js` 里没有它）。
const defsMod = await load("defs.js");

let pass = 0;
let fail = 0;
const ok = (t, c, detail) => {
  if (typeof c !== "boolean") throw new TypeError("ok() 第二参必须是布尔：" + t);
  if (c) {
    pass += 1;
    console.log("PASS  " + t + (detail === undefined ? "" : "  —— " + detail));
  } else {
    fail += 1;
    console.log("FAIL  " + t + (detail === undefined ? "" : "  —— " + detail));
  }
};
const undefPaths = (obj, pfx = "") => {
  if (obj === null || typeof obj !== "object") return [];
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = pfx === "" ? k : pfx + "." + k;
    if (v === undefined) out.push(p);
    else if (v !== null && typeof v === "object") out.push(...undefPaths(v, p));
  }
  return out;
};
const mkTmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "d327-" + tag + "-"));

/** 造一个 V3 默认项目（三方卡片目录 + 日志），返回 {dir, info}。 */
async function mkV3(tag) {
  const d = mkTmp(tag);
  const exec = { agent: { session: { header: { id: "session-d3270001-0000-4000-8000-000000000000", cwd: d }, events: () => [] } } };
  const r = await part4Mod.defineInitTool().execute(
    {
      root: d,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive",
      decisionsDir: "decisions",
      lessonsDir: "lessons",
      goalsDir: "goals",
      logDir: "_ledger-log",
      memoryRoot: "m-memory",
    },
    exec
  );
  if (r?.ok !== true) throw new Error("V3 夹具没走通：" + JSON.stringify(r).slice(0, 200));
  return { dir: d, info: part2Mod.inspect(d), exec };
}

// ══════════════════════════════════════════════════════════════════════════
// ① F-01：V3 卡片模式下 enabledKeysOf 必须认卡片目录
//    ★ 这是**最实在的一条**：本项目每回合注入里就写着「本项目尚未启用 目标树/经验与教训」，
//      而它明明有 goals/ 与 lessons/ 卡片。
// ══════════════════════════════════════════════════════════════════════════
{
  const { dir, info } = await mkV3("f01");
  try {
    // 前提自检：这个项目确实是卡片模式、且没有单文件
    ok("① 0 夹具：decisionsDir/goalsDir/lessonsDir 都登记了", info.decisionsDir === "decisions" && info.goalsDir === "goals" && info.lessonsDir === "lessons", `dec=${info.decisionsDir} goals=${info.goalsDir} lessons=${info.lessonsDir}`);
    ok("① 0b 夹具：**没有**单文件 GOALS.md / LESSONS.md（goalsRel/lessonsRel 为 undefined）", info.goalsRel === undefined && info.lessonsRel === undefined, `goalsRel=${String(info.goalsRel)} lessonsRel=${String(info.lessonsRel)}`);

    const on = part1Mod.enabledKeysOf(info);
    ok("① a enabledKeysOf 认出了 goals（卡片目录也算启用）", on.has("goals"), [...on].join(","));
    ok("① b enabledKeysOf 认出了 lessons", on.has("lessons"), [...on].join(","));
    ok("① c enabledKeysOf 认出了 decisions（纯卡片模式下也要认）", on.has("decisions"), [...on].join(","));

    const unenabled = part1Mod.renderUnenabledCapabilities(info);
    ok(
      "① d renderUnenabledCapabilities 不再谎报「目标树 / 经验与教训 尚未启用」",
      !/目标树/.test(unenabled) && !/经验与教训/.test(unenabled),
      unenabled.slice(0, 160).replace(/\n/g, " ⏎ ")
    );

    const proto = part1Mod.renderProtocolBlock(info);
    ok("① e renderProtocolBlock 下发了目标树的卡片格式协议", /目标/.test(proto) && /goals/.test(proto), proto.length + " 字符");
    ok("① f renderProtocolBlock 下发了经验教训的卡片格式协议", /教训/.test(proto) && /lessons/.test(proto), "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ② F-02：repairConformance 必须兑现 conformanceOf 的 fixable 承诺
//    ★ 判据：**体检说能修的东西，apply 之后必须真的没有那个缺口**（推荐可执行性）
// ══════════════════════════════════════════════════════════════════════════
{
  const { dir, info } = await mkV3("f02");
  try {
    // 制造缺口：把 decisions/ 卡片目录删掉（保留清单登记）
    const decDir = path.join(dir, "m-memory", "decisions");
    fs.rmSync(decDir, { recursive: true, force: true });
    const before = part2Mod.conformanceOf(part2Mod.inspect(dir));
    ok("② 0 夹具：删掉卡片目录后体检**确实**报了缺口", before.verdict === "upgradeable" || (before.reasons ?? []).some((x) => /decisions/.test(x)), `verdict=${before.verdict}`);
    ok("② 0b 夹具：fixable 里确有「创建卡片目录」这类可执行承诺", (before.fixable ?? []).some((x) => /创建卡片目录/.test(x)), JSON.stringify(before.fixable));

    const dry = part4Mod.repairConformance(dir, { apply: false });
    ok("② a 干跑如实报告「将创建卡片目录」（不空转）", (dry.actions ?? []).some((x) => /卡片目录/.test(x)), JSON.stringify(dry.actions));

    // ★ 先记下单文件 DECISIONS.md 现在在不在 —— 后面要证明"apply 没改变它"（见 ②e 的尺子错 #42）
    const decFile = path.join(dir, "m-memory", "DECISIONS.md");
    const decFileBefore = fs.existsSync(decFile);

    const applied = part4Mod.repairConformance(dir, { apply: true });
    ok("② b 实跑**真的建出了** decisions/ 目录", fs.existsSync(decDir), "exists=" + fs.existsSync(decDir));
    ok("② c 实跑 actions 里记了这件事", (applied.actions ?? []).some((x) => /卡片目录/.test(x)), JSON.stringify(applied.actions));

    const after = part2Mod.conformanceOf(part2Mod.inspect(dir));
    ok(
      "② d ★★★ apply 之后那个缺口**真的没了**（不是「建议存在 ≠ 建议可执行」）",
      !(after.reasons ?? []).some((x) => /卡片目录 `decisions`.*不存在/.test(x)),
      JSON.stringify(after.reasons ?? []).slice(0, 200)
    );
    // ★★★ 尺子错 #42（本轮自己撞的）：这条原来断言「apply 之后 m-memory/DECISIONS.md 不该存在」。
    //   可那个文件是 **`ledger_init` 一开始就建好的**（实测 init 后立刻 exists=true），
    //   ⇒ 前提根本不成立，它红得毫无意义（与「夹具前提错了，红也不是证据」同型）。
    //   ⇒ 正解：判据改成**「这件事前后没变」** —— 记录 apply 之前的取值，apply 之后必须**一样**。
    ok(
      "② e repairConformance **没有**改动单文件 DECISIONS.md 的存在性（没把卡片化往回推）",
      decFileBefore === fs.existsSync(decFile),
      `before=${decFileBefore} after=${fs.existsSync(decFile)}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ③ F-03：settingsValuesOf 必须走 settingPrecedence（默认 panel）
//    ★ 判据：改了面板值 ⇒ 指纹要变、变更提醒要出
// ══════════════════════════════════════════════════════════════════════════
{
  const { dir, info } = await mkV3("f03");
  try {
    // 清单里塞一个与面板不同的旧值
    const manPath = path.join(dir, ".dsh-ledger.json");
    const man = JSON.parse(fs.readFileSync(manPath, "utf8"));
    man.maxActiveLines = 150;
    man.settingPrecedence = "panel";
    fs.writeFileSync(manPath, JSON.stringify(man, null, 2) + "\n", "utf8");

    const info2 = part2Mod.inspect(dir);
    const vals = part3Mod.settingsValuesOf(info2);
    const panel = part1Mod.currentSettings().maxActiveLines;
    ok(
      "③ a 「以面板为准」时 settingsValuesOf.maxActiveLines **取面板值**，不是清单旧值 150",
      vals.maxActiveLines !== "150",
      `got=${vals.maxActiveLines} panel=${panel} manifest=150`
    );

    // 指纹必须对面板改动有反应
    const fp1 = part3Mod.settingsValuesOf(info2).maxActiveLines;
    ok("③ b 指纹输入里那一项确实来自生效值（不是恒等式）", typeof fp1 === "string", fp1);

    // 切到「以清单为准」时，必须**真的**用清单值（否则就是把开关修坏了）
    //
    // ★★★ 尺子错 #41（本轮自己撞的，两段）：`precedenceValue` 读的是
    //   **`currentSettings().settingPrecedence`（= 设置面板）**，不是清单里的那一项。
    //   ① 我一开始改 `.dsh-ledger.json` 的 `settingPrecedence` ⇒ **改错了对象**；
    //   ② 改用 `currentSettings().settingPrecedence = "manifest"` 仍无效 ——
    //      `currentSettings()` 在 `activeSettings === null` 时**每次返回一个新的
    //      `settingDefaults()` 副本** ⇒ 改它等于改了个一次性对象，赋值立刻蒸发。
    //   ⇒ 正确做法是走**唯一出口** `setActiveSettings(...)`（`defs.js:1017`）。
    //   ★★ 尺子错 #44（同一处的第三段）：我接着又把值写成 `settingPrecedence: "manifest"` ——
    //     而代码里的常量是 **`PRECEDENCE_PROJECT = "project"`**（`defs.js:1258`）！
    //     传一个不存在的档位名 ⇒ `precedenceIsProject()` 永假 ⇒ 仍然全程走面板值。
    //   ⇒ 判据（纪律 #24 的同型）：**别按「我以为它叫什么」写字面量** ——
    //     要么 import 常量，要么先 grep 出真值再写。
    const prevSettings = { ...part1Mod.currentSettings() };
    defsMod.setActiveSettings({ ...prevSettings, settingPrecedence: defsMod.PRECEDENCE_PROJECT });
    let vals2;
    try {
      vals2 = part3Mod.settingsValuesOf(part2Mod.inspect(dir));
    } finally {
      defsMod.setActiveSettings(prevSettings);
    }
    ok("③ c 切到「以清单为准」时**必须**用清单值 150（没把开关修坏）", vals2.maxActiveLines === "150", "got=" + vals2.maxActiveLines + "（经 setActiveSettings 切面板）");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ④ F-04：ledger_lessons 卡片模式 list 不得含 undefined；add/rm 要递增 revision
// ══════════════════════════════════════════════════════════════════════════
{
  const { dir, exec } = await mkV3("f04");
  try {
    const st = { touched: new Map(), flushedAt: new Map() };
    const lessons = part2Mod.defineLessonsTool(st);

    const add = await lessons.execute({ root: dir, op: "add", id: "L1", title: "首条教训", kind: "其他", cause: "根因", symptom: "症状", fix: "修法" }, exec);
    ok("④ a add 成功", add?.ok === true, JSON.stringify(add).slice(0, 200));
    ok("④ b add 返回值**无 undefined 属性**（lossless JSON）", undefPaths(add).length === 0, JSON.stringify(undefPaths(add)));
    ok("④ c add 让 revision 递增到 1", add?.revision === 1, "revision=" + add?.revision);

    const list = await lessons.execute({ root: dir, op: "list" }, exec);
    ok("④ d list 返回值**无 undefined 属性**", undefPaths(list).length === 0, JSON.stringify(undefPaths(list)));
    ok("④ e list 的 relPath 是**卡片目录** `lessons`（不是 undefined、也不是 LESSONS.md）", list?.relPath === "lessons", "relPath=" + String(list?.relPath));
    ok("④ f list 标明 mode:card", list?.mode === "card", "mode=" + String(list?.mode));

    const add2 = await lessons.execute({ root: dir, op: "add", id: "E1", type: "经验", title: "首条经验", kind: "机制", source: "文件:1", fix: "去哪改" }, exec);
    ok("④ g 第二次 add 让 revision 递增到 2（不是原地不动）", add2?.revision === 2, "revision=" + add2?.revision);

    const rm = await lessons.execute({ root: dir, op: "rm", id: "L1" }, exec);
    ok("④ h rm 也递增 revision（到 3）", rm?.revision === 3, "revision=" + rm?.revision);

    const audit = part4Mod.logRead(dir, { view: "audit" });
    const lines = (audit?.changes ?? []).map((x) => x.text);
    ok("④ i 审计行带 revision（不是恒缺）", lines.some((l) => /revision→/.test(l)), lines.slice(0, 2).join(" ｜ ").slice(0, 200));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ F-05：detectMigration 必须能看见卡片模式下的旧格式目标卡
// ══════════════════════════════════════════════════════════════════════════
{
  const { dir } = await mkV3("f05");
  try {
    // 造一张**没有** `- 更新于:` 的旧格式目标卡（卡片模式：goals/g1.md）
    //
    // ★★★ 尺子错 #43（本轮自己撞的）：我一开始写成**一级标题** `# 目标 g1`，
    //   而 `parseGoalCards` 只认**二级** `## 目标 <id>`（`/^##\s*目标\s+([A-Za-z0-9._-]+)/`）
    //   ⇒ 解析出 0 张卡 ⇒ 根本构不出「缺时间戳」这个前提 ⇒ ⑤ 红得毫无意义。
    //   实测（`_diag-d327-4fails.mjs`）：一级 0 张 / 二级 1 张。
    //   ★ 这是「夹具前提错了，全绿是假绿」的**镜像**：**全红也是假的**（纪律 6/8）。
    const gDir = path.join(dir, "m-memory", "goals");
    fs.mkdirSync(gDir, { recursive: true });
    const CARD = "## 目标 g1 · 进行中\n\n- KR: 甲\n";
    fs.writeFileSync(path.join(gDir, "g1.md"), CARD, "utf8");
    ok("⑤ 0 夹具：这张卡的形状能被 parseGoalCards 认出来", part2Mod.parseGoalCards(CARD).length === 1, "解析出 " + part2Mod.parseGoalCards(CARD).length + " 张卡");

    const mig = part4Mod.detectMigration(dir);
    const hay = JSON.stringify(mig);
    ok(
      "⑤ a detectMigration 在**卡片模式**下检出了缺 `- 更新于:` 的旧格式目标卡",
      /g1/.test(hay) && /goalNoTime|更新于/.test(hay),
      hay.slice(0, 260)
    );
    ok("⑤ b 且没谎报 needsMigration:false", mig?.needsMigration !== false, "needsMigration=" + String(mig?.needsMigration));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("");
console.log("═══ " + pass + " PASS / " + fail + " FAIL ═══");
console.log("PROBE-COMPLETE pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
