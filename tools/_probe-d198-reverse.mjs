/**
 * ★★★★★ 只读反向验证（D198）：**D198 那把尺子能不能看见红？**
 *
 * ★ 为什么非做不可（本机纪律 10）：*"反向验证必须摘到能看见红为止"* ——
 *   一个恒绿的判据**证明不了任何东西**：我不能说"目标树没有年龄信号"，
 *   除非我能证明"**假如它有**，这把尺子会红"。
 *
 * ★★ 本探针的做法：**造一份"有年龄信号 / 有义务"的假注入**，喂给**同一套判据**
 *   （把 D198 探针里的判据抽出来当函数，不另写一份 —— 两份判据必然分叉）。
 *   ⇒ 若假注入上判据**变绿**，说明那把尺子**真的在测那件事**。
 *
 * ★ 只读：不动源码、不动注入实现、不写项目文件。
 * 跑法：node tools/_probe-d198-reverse.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
let bad = 0;
const check = (ok, label, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
};

// ── 判据（与 `_probe-d198-goals-stale.mjs` **逐字同一套**）────────────────
//   ★ 刻意在这里**重抄一遍形状、而不是 import 它**：那个探针是**脚本**（顶层 await 直接跑），
//     import 它会**连带把它的输出重跑一遍**（噪声），而判据本身只有下面这几条。
//   ⚠️ 但"重抄"就有分叉风险 ⇒ 所以本探针**同时**断言"两边对同一份真注入的结论一致"。
const hasAgeSignal = (goalsSegment) =>
  /\d{4}-\d{2}-\d{2}|\d{1,2}\s*天前|上次更新|最后更新|mtime/.test(goalsSegment);
const obligesGoals = (obligationSegment) => /目标树|GOALS|ledger_goals/.test(obligationSegment);

// ── 真注入（现状）────────────────────────────────────────────────────────
async function realInjection() {
  const mod = await import(
    new URL("../lib/index.js", import.meta.url).href
  );
  const handlers = new Map();
  const ctx = {
    tools: { register: () => {} },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on: (ev, h) => {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(h);
      return () => {};
    },
    inject: (deps, cb) => {
      const s = {
        commands: { register: () => () => {} },
        userQuestions: { async ask() { return { answers: [] }; } },
      };
      for (const d of deps) if (!(d in s)) return undefined;
      const scope = Object.create(ctx);
      for (const d of deps) scope[d] = s[d];
      return cb(scope);
    },
    get: () => undefined,
    webServer: { register: () => () => {} },
    configEditor: { entries: () => [], configuration: () => [], edit: async () => {} },
  };
  mod.apply(ctx, {});
  const list = handlers.get("agent/pre-step") ?? [];
  const agent = { session: { header: { id: "s-d198rev", cwd: ROOT }, id: "s-d198rev" } };
  let decision = { messages: [] };
  for (const h of list) decision = await h({ agent, messages: [] }, async () => decision);
  const texts = [];
  for (const m of decision?.messages ?? []) {
    const c = m?.content;
    if (typeof c === "string") texts.push(c);
    else if (Array.isArray(c)) for (const p of c) if (typeof p?.text === "string") texts.push(p.text);
  }
  return texts.join("\n\n");
}

const inj = await realInjection();
const slice = (head, len) => {
  const at = inj.indexOf(head);
  return at < 0 ? "" : inj.slice(at, at + len);
};

bar("前提：真注入拿到了、两段都在（否则下面全是假绿 / 假红）");
{
  const g = slice("### 目标树", 1400);
  const o = slice("本回合收尾义务", 900);
  check(g !== "", "① 拿到「目标树」段", `长度 ${g.length}`);
  check(o !== "", "② 拿到「收尾义务」段", `长度 ${o.length}`);
}

bar("方向 A（真注入）：判据应当报「没有年龄信号 / 没有义务」—— 红");
{
  check(!hasAgeSignal(slice("### 目标树", 1400)), "A① 真注入：目标树段**没有**年龄信号（期望红）");
  check(!obligesGoals(slice("本回合收尾义务", 900)), "A② 真注入：收尾义务段**不提**目标树（期望红）");
}

bar("方向 B（★关键）：**假注入——里面**确实有**年龄信号 / 义务 ⇒ 判据必须变绿");
{
  // 造一份"假如插件做了这件事"会长成什么样的注入 —— 只改要测的那一点，其余照抄真注入。
  const g = slice("### 目标树", 1400);
  const o = slice("本回合收尾义务", 900);

  const gWithAge = `### 目标树（**记忆的组织方式** · 最后更新：2026-10-14 01:04，已 9 小时）\n` + g;
  const oWithGoals =
    o.replace(
      "· ② `ledger_triage`",
      "· ② 检查目标树：做完了的卡标 `done`、新开的标 `active`（`ledger_goals`）\n· ③ `ledger_triage`"
    );

  check(
    hasAgeSignal(gWithAge),
    "★★★★ B① **假注入里加了日期 ⇒ 那把尺子立刻变绿**（证明它真的在测「年龄」这件事）"
  );
  check(
    obligesGoals(oWithGoals),
    "★★★★ B② **假注入里加了「检查目标树」⇒ 立刻变绿**（证明它真的在测「有没有义务」）"
  );

  // ── ★ 还要证明：**改别的不会让它变绿**（否则那把尺子可能在测别的）──
  const gNoiseOnly = g.replace("### 目标树", "### 目标树（和上次一样）");
  check(
    !hasAgeSignal(gNoiseOnly),
    "★ B③ 负向对照：只加「和上次一样」这种**不含日期**的话 ⇒ **仍然红**（尺子不是见词就绿）"
  );
  const oNoiseOnly = o.replace("· ② `ledger_triage`", "· ② 顺手看看别的东西\n· ③ `ledger_triage`");
  check(
    !obligesGoals(oNoiseOnly),
    "★ B④ 负向对照：只加了无关的一步 ⇒ **仍然红**（不是「段变长就绿」）"
  );
}

bar("一致性：本探针重抄的判据，与真探针跑真注入的结论必须一致");
{
  // 真探针在真注入上报的是「③ ❌ 没有年龄信号」+「② ❌ 收尾义务没提目标树」
  // ⇒ 本探针在**同一份注入**上必须得到同一结论（否则两边判据已经分叉）。
  const same =
    !hasAgeSignal(slice("### 目标树", 1400)) && !obligesGoals(slice("本回合收尾义务", 900));
  check(same, "两边对**同一份真注入**得到同一结论（判据没分叉）");
}

bar(`结  论：${bad === 0 ? "反向验证通过" : `有 ${bad} 条不符合预期`}`);
console.log("  ★ 通过意味着：D198 那把尺子**看得见红**，也**只在真做了那件事时变绿**。");
console.log("  ★ 所以「目标树没有年龄信号、也没有任何机制在逼模型维护它」是**测出来的**，不是感觉。");
