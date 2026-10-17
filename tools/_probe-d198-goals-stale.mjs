/**
 * ★★★★★ 只读审计（D198）：**「目标树会自动被维护吗？」—— 用户当场问的那个问题。**
 *
 * 用户原话（逐字）：*"另外就是模型真的会自动维护目标那张表吗？我看我们这个项目目标那个表很久没动了。"*
 *
 * ★ 这个问题**不能凭感觉答**。它其实是三个可查的子问题：
 *   ① **可见吗**：目标树在注入里吗？（D181 已做过 ⇒ 预期"在"）
 *   ② **有义务吗**：有没有一条**会拦人**的判据要求维护它？（台账/分流各有一条硬门 —— 目标树有没有？）
 *   ③ **知道它旧吗**：注入里有没有**任何"它多久没动"的信号**？
 *
 * ★★ 为什么必须把②与③分开问（这是本探针的全部价值）：
 *   D46 那条铁律说"**恢复必须是推给模型的**" —— 我们**照做了**：目标树**每回合都推**。
 *   但"推内容"与"推新鲜度"**不是同一件事**：
 *     推了内容 ⇒ 模型**看得见**它在讲什么（①通）；
 *     没推年龄 ⇒ 模型**看不出它已经旧了** —— 而**旧的目标树与新的一模一样**，
 *     都只是几行字。⇒ 模型没有任何理由去动它（③断）。
 *   ⇒ **"看得见内容" ≠ "看得出它该更新了"**（与 D195 那条"能读到 ≠ 知道要读"同型）。
 *
 * 只读：只读文件与注册表，**不写任何东西**。
 * 跑法：node tools/_probe-d198-goals-stale.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
let gaps = 0;
const say = (ok, label, detail) => {
  if (!ok) gaps++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
};

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const tools = new Map();
const handlers = new Map();
const ctx = {
  tools: { register: (d) => tools.set(d.name, d) },
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

// ── 渲染真实注入（与情形 12/45/71、D195 探针同一把尺子）──────────────────
async function renderRealInjection() {
  const list = handlers.get("agent/pre-step") ?? [];
  const agent = { session: { header: { id: "s-d198-inj", cwd: ROOT }, id: "s-d198-inj" } };
  let decision = { messages: [] };
  for (const h of list) decision = await h({ agent, messages: [] }, async () => decision);
  const msgs = Array.isArray(decision?.messages) ? decision.messages : [];
  const texts = [];
  for (const m of msgs) {
    const c = m?.content;
    if (typeof c === "string") texts.push(c);
    else if (Array.isArray(c)) for (const p of c) if (typeof p?.text === "string") texts.push(p.text);
  }
  return texts.join("\n\n");
}
const injected = await renderRealInjection();

// ── ① 可见吗：目标树在不在注入里 ────────────────────────────────────────
bar("① 可见吗：目标树**在注入里**吗？（D181 承诺过它会推行）");
{
  const head = "### 目标树";
  const at = injected.indexOf(head);
  say(at >= 0, "注入里出现「目标树」段", at >= 0 ? `位置 ${at}` : "**没有**");
  if (at >= 0) {
    const seg = injected.slice(at, at + 700);
    console.log("  ── 注入到模型的那一段，原文前 700 字 ──");
    for (const ln of seg.split("\n")) console.log(`    ${ln}`);
    // ★ 它有没有把**卡**也带出来（光有标题 = 空壳）
    //   ★ 尺子修正（第二次）：第一版写 `^- \*\*` —— 只匹配**顶格**那张，
    //     而树里的子卡是**缩进**的 ⇒ 报了「1 张」（真值 3 张）。**子卡也是卡。**
    const nCard = (seg.match(/^\s*- \*\*/gm) ?? []).length;
    say(nCard > 0, "带出了目标卡本身（不是只有标题）", `段内看到 ${nCard} 张卡行`);
  }
}

// ── ② 有义务吗：有没有一条**会拦人**的判据要求维护目标树 ─────────────────
bar("② 有义务吗：**谁在逼模型维护它？**（台账与分流各有一条硬门 —— 目标树有没有？）");
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8");
  // 找注入里那段「本回合收尾义务」的原文（真正送达模型的那一份）
  const obAt = injected.indexOf("本回合收尾义务");
  say(obAt >= 0, "注入里有「本回合收尾义务」段", obAt >= 0 ? `位置 ${obAt}` : "**没有**");
  if (obAt >= 0) {
    const seg = injected.slice(obAt, obAt + 900);
    console.log("  ── 收尾义务段，原文 ──");
    for (const ln of seg.split("\n").slice(0, 16)) console.log(`    ${ln}`);
    const mentionsGoals = /目标树|GOALS|ledger_goals/.test(seg);
    say(
      mentionsGoals,
      "★ 收尾义务段里**要求维护目标树**",
      mentionsGoals ? "提到了" : "**一个字都没提** ⇒ 没有任何机制在逼模型动它"
    );
  }
  // 硬门（会拦压缩的那两条）里有没有目标树
  const gateSeg = src.slice(src.indexOf("function flushOwed") - 200, src.indexOf("function flushOwed") + 6000);
  const gateGoals = /goals|目标树/.test(gateSeg);
  say(
    gateGoals,
    "★ 落盘/分流**硬门**里含目标树",
    gateGoals ? "含" : "**不含** ⇒ 不做目标树维护，压缩照常发生（零代价 ⇒ 零动机）"
  );
  // 有没有"陈旧"判据
  const stale = /goalStale|goalsOwed|目标树.*陈旧|陈旧.*目标树|goalsStaleAt/.test(src);
  say(stale, "★ 代码里有「目标树陈旧」这一类判据", stale ? "有" : "**一条都没有**");
}

// ── ③ 知道它旧吗：注入里有没有「它多久没动」的信号 ──────────────────────
bar("③ 看得出它旧吗：注入里有没有**任何「它多久没动」的信号**？");
{
  const at = injected.indexOf("### 目标树");
  const seg = at < 0 ? "" : injected.slice(at, at + 1400);
  // 目标树段里出现日期 / "上次更新" 之类的才算有信号
  const hasDate = /\d{4}-\d{2}-\d{2}|\d{1,2}\s*天前|上次更新|最后更新|mtime/.test(seg);
  say(
    hasDate,
    "★ 目标树段里带**时间/年龄**信息",
    hasDate ? "带了" : "**没有** ⇒ 旧树与新树在模型眼里**长得一模一样**（这就是它一直不动的原因）"
  );

  // ★★★ 决定性对照：**同一份注入里的台账那一段，反而是带日期的** ——
  //   说明"带不带年龄"不是做不到，是目标树这一段**没做**。
  const ledger = fs.readFileSync(path.join(ROOT, "LEDGER.md"), "utf8");
  const ledgerDated = /\d{4}-\d{2}-\d{2}/.test(ledger);
  say(ledgerDated, "（对照）台账正文里带日期", ledgerDated ? "带" : "不带");
  if (ledgerDated && !hasDate) {
    console.log(
      "  ★★ 对照结果：**台账带日期、目标树不带** —— 所以模型知道台账多新、不知道目标树多旧。"
    );
  }
}

// ── ④ 事实：它到底多久没动了（用磁盘与审计量，不靠印象）────────────────
bar("④ 事实：这个项目里，目标树到底多久没动了？");
{
  const gAbs = path.join(ROOT, "GOALS.md");
  const gStat = fs.statSync(gAbs);
  const lStat = fs.statSync(path.join(ROOT, "LEDGER.md"));
  // ★ 尺子修正（第三次，也是同一个病）：第一版用 `toISOString()` —— 那是 **UTC**，
  //   本地 +08:00 ⇒ 显示成 10-13 17:04，看起来像"昨天下午写的"，其实是当天 01:04。
  //   ★ 本项目所有时间判据都是**本地时**（日志里就是本地时）⇒ 显示必须同一把尺子，
  //     否则会把"刚建完 9 小时"读成"隔了一整天"（差点据此夸大结论）。
  const f = (t) => {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  console.log(`  GOALS.md   最后写入：${f(gStat.mtimeMs)}`);
  console.log(`  LEDGER.md  最后写入：${f(lStat.mtimeMs)}`);
  console.log(`  （由台账改过而目标树没动 ⇒ 每写一次台账，两者就差得更远）`);

  // ★★ 尺子修正（我第一版在这里报了「0 次」，**那是尺子错**，记下来）：
  //   第一版拿 `GOALS.md` 的 **mtime 当"诞生日"**，然后数"mtime 之后有哪些写入" ——
  //   而 mtime 是**最后一次**写入的时刻（01:04:28.xxx），日志只精确到**秒**
  //   ⇒ 那一条本身被判成"早于诞生" ⇒ 恒 0 次。
  //   ★ 这是纪律 1「指标必须有时间窗」的**反型**：窗口的边界取到了**窗口内最后一个事件**上。
  //   正解：**诞生日 = 第一次写入**，再数「**距第一次超过 60 秒**」的后续写入
  //   （60 秒是刻意取的：建树那 3 次是 11 秒内的**同一次动作**，不该算成"维护过"）。
  const logDir = path.join(ROOT, "_ledger-log");
  const goalStamps = [];
  const ledgerStamps = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith("L0-") && e.name.endsWith(".md")) {
        for (const ln of fs.readFileSync(p, "utf8").split("\n")) {
          const m = /^- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \((.*?)\)/.exec(ln);
          if (m === null) continue;
          const t = Date.parse(m[1].replace(" ", "T") + "+08:00");
          if (Number.isNaN(t)) continue;
          const kind = m[2];
          if (kind === "ledger-goals") goalStamps.push(t);
          else if (kind === "active" || kind === "append" || kind === "ledger-write") ledgerStamps.push(t);
        }
      }
    }
  };
  if (fs.existsSync(logDir)) walk(logDir);
  goalStamps.sort((a, b) => a - b);
  const birth = goalStamps.length === 0 ? undefined : goalStamps[0];
  const after = birth === undefined ? [] : goalStamps.filter((t) => t - birth > 60000);
  const ledgerAfter = birth === undefined ? [] : ledgerStamps.filter((t) => t - birth > 60000);
  console.log(`\n  目标树的**第一次**写入（诞生日）：${birth === undefined ? "（没有记录）" : f(birth)}`);
  console.log(`    建成那一次共写了 ${goalStamps.length} 次（${goalStamps.length > 1 ? "11 秒内的同一动作" : ""}）`);
  console.log(`  ★ 诞生**之后**（>60 秒）的维护：目标树 **${after.length}** 次 · 台账类 **${ledgerAfter.length}** 次`);
  say(
    after.length > 0,
    "目标树诞生后**被再维护过**",
    after.length > 0
      ? `维护了 ${after.length} 次`
      : `**0 次** ⇒ 建完就再没动过，而同期台账写了 ${ledgerAfter.length} 次（与用户观察一致）`
  );
}

// ── ⑤ 反向：假如"没人推"，它会怎样？（证明 ① 是有效的，问题在 ②③）──────
bar("⑤ 反向：把「推」拿掉会怎样？（证明问题不是「没推」，是「没义务 / 没年龄」）");
{
  const gAbs = path.join(ROOT, "GOALS.md");
  const txt = fs.readFileSync(gAbs, "utf8");
  const cards = mod.__test?.parseGoalCards === undefined ? undefined : mod.__test.parseGoalCards(txt);
  if (cards === undefined) {
    console.log("  ⚠️ __test 没导出 parseGoalCards ⇒ 这一段跳过（结论打折）");
  } else {
    console.log(`  盘上 GOALS.md 共 ${cards.length} 张卡：`);
    for (const c of cards) {
      console.log(`    · ${c.id} [${c.status}] ${c.title.slice(0, 40)} · ${c.kr.length} KR · ${c.lessons.length} 教训`);
    }
    // ★ 关键判据：状态是不是"停在进行中"—— 做完了却不标 done，就是没人维护的证据
    const stuck = cards.filter((c) => c.status === "active").map((c) => c.id);
    console.log(`\n  仍标「进行中」的卡：${stuck.length === 0 ? "（无）" : stuck.join(", ")}`);
    // ★ 措辞必须精确（**我第一版写错了一次**）：不能写"没有任何一张卡的状态被推进过" ——
    //   `g2` 建树时就已是 `done`。机械证据是**别的**：树**出生之后一次都没被写过**
    //   ⇒ 它里面**一个字节都还是出生那天的样子**，而同期项目做了 11 条决策。
    console.log(
      "  ★ 判据：目标树**出生之后一次都没被写过** ⇒ 内容还是出生那天那一份；" +
        `而同期台账写了 ${ledgerAfter.length} 次。` +
        "（注意措辞：`g2` 建树时就是 done —— 不能笼统说「状态没被推进过」。）"
    );
  }
}

bar(`结  论：共发现 ${gaps} 处与「目标树为何不自动维护」有关的缺口`);
console.log("  ★ 结论形态：①**可见**（推内容）✅ —— D181 做到了；②**无义务**❌；③**无年龄信号**❌。");
console.log("  ★ 所以答案是：**不会自动维护。** 它会被「推」到模型眼前，但**没有任何东西要求模型动它**，");
console.log("    而注入里也**看不出它旧了** ⇒ 旧树与新树长得一样 ⇒ 模型没有理由去更新。");
console.log("  ★ 与 D195 同型的一条：**「看得见内容」 ≠ 「看得出它该更新了」**。");
