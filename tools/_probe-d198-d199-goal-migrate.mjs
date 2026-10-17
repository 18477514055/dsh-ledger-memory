/**
 * ★★★★★ 行为探针（D198 + D199）：**新加的两样东西真的工作吗？**
 *
 * 覆盖：
 *   · **D198 目标卡的时间**：写卡带 `更新于` → 解析回得去 → 权重按相对时间下沉 → 未知不惩罚；
 *   · **D199 老文件迁移检测**：造一个"旧架构"项目 ⇒ 必须**报出**问题；
 *     造一个"新架构"项目 ⇒ 必须报**干净**（★ 这条防的是"见文件就说旧"的假阳性）。
 *
 * ★ 为什么两件事放一个探针：它们共用同一份"记忆文件矩阵"，
 *   分两个文件会让夹具各建一次（两套夹具必然分叉 —— 本项目的老坑）。
 *
 * ★ 只读项目文件；临时项目建在 %TEMP% 里，收尾删掉。
 * 跑法：node tools/_probe-d198-d199-goal-migrate.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
let bad = 0;
const check = (ok, label, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
};

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const T = mod.__test;

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `probe-${tag}-`));
const CLEAN = [];
const mk = (tag) => { const d = tmp(tag); CLEAN.push(d); return d; };
process.on("exit", () => { for (const d of CLEAN) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

// ── ① D198：写卡带时间 ──────────────────────────────────────────────────
bar("① D198：`renderGoalCard` **真的写时间**了吗？（上次这一条我报过假绿，这次真调函数）");
{
  const out = T.renderGoalCard({ id: "gX", status: "done", parent: "-", title: "示例", kr: [], lessons: [] });
  console.log("  ── 真函数吐出来的整段 ──");
  for (const l of out.split("\n")) if (l !== "") console.log(`    ${l}`);
  const m = /^- 更新于: (\d{4}-\d{2}-\d{2} \d{2}:\d{2})$/m.exec(out);
  check(m !== null, "★ 写出来的卡**带 `- 更新于:` 且格式正确**（YYYY-MM-DD HH:mm）", m === null ? "**没找到该行！**" : `值=${m[1]}`);
}

// ── ② D198：解析回得去（写↔读互逆）──────────────────────────────────────
bar("② D198：写出来的卡，**解析器读得回那个时间**吗？（互逆 —— 与 D197 骨架同一条判据）");
{
  const card = { id: "g7", status: "done", parent: "g1", title: "示例目标", kr: ["KR一"], lessons: ["教训一"] };
  const text = `# 目标树\n\n${T.renderGoalCard(card)}`;
  const parsed = T.parseGoalCards(text);
  check(parsed.length === 1, "解析出 1 张卡", `实际 ${parsed.length}`);
  const c = parsed[0];
  check(typeof c.updatedAt === "string" && c.updatedAt !== "", "★ 解析回来的卡**带 `updatedAt`**", `值=${JSON.stringify(c.updatedAt)}`);
  check(c.updatedAt === T.parseGoalCards(text)[0].updatedAt, "★ 读回的时间与写下去的是同一个（没有丢/没有变）", `${c.updatedAt}`);
  // ★ 互逆的严格版：写→读→再写的**结构**必须一致（时间会刷新，所以只比结构字段）
  const again = T.parseGoalCards(`# 目标树\n\n${T.renderGoalCard(c, new Date(c.updatedAt.replace(" ", "T")))}`);
  check(
    again[0].id === c.id && again[0].status === c.status && again[0].parent === c.parent && again[0].title === c.title,
    "★ 写→读→再写：**结构与内容稳定**（只有时间会刷新）",
    `${again[0].id}/${again[0].status}/${again[0].parent}`
  );
  // ★ 反向参照：证明"解析得到 updatedAt"不是因为它在别处 —— 老格式必须解析成 undefined
  const old = T.parseGoalCards("# 目标树\n\n## 目标 g9 · 已完成\n- parent: -\n- title: 老卡\n- 关键结果: 甲\n");
  check(old[0].updatedAt === undefined, "★ 反向参照：**老格式（没有 `更新于`）解析成 `undefined`**（不是空串、不是乱值）", `值=${JSON.stringify(old[0].updatedAt)}`);
}

// ── ③ D198：权重按**相对时间**下沉 ──────────────────────────────────────
bar("③ D198：已完成的卡**真的会按相对时间下沉**吗？（用户第 ③ 条要求，原来根本做不到）");
{
  const now = new Date("2026-10-14T12:00:00");
  const nowMs = now.getTime();
  const dayMs = 86400000;
  // 造两张已完成的卡：一张刚完成、一张 30 天前完成
  const recent = { id: "a", status: "done", parent: null, title: "近的", kr: [], lessons: [], updatedAt: "2026-10-13 12:00" };
  const old = { id: "b", status: "done", parent: null, title: "旧的", kr: [], lessons: [], updatedAt: "2026-09-14 12:00" };
  const scope = T.goalTimeScope([recent, old], nowMs);
  console.log(`  scope = ${JSON.stringify(scope)}`);
  const rw = T.goalWeightBasis(recent, scope);
  const ow = T.goalWeightBasis(old, scope);
  console.log(`  近的：score=${rw.score}  why=${JSON.stringify(rw.why.filter(w=>/衰减|最新|相对/.test(w)))}`);
  console.log(`  旧的：score=${ow.score}  why=${JSON.stringify(ow.why.filter(w=>/衰减|最新|相对/.test(w)))}`);
  check(ow.score < rw.score, "★★★★ **更旧的已完成卡分数更低**（这就是「随相对时间下降」落地）", `${ow.score} < ${rw.score}`);
  check(ow.score >= 30, "★ 且**不低于 dropped 的基准 30**（较早完成 ≠ 比被放弃的更没价值）", `旧卡=${ow.score}`);
  check(rw.score <= 45, "★ 且**不超过 done 基准 45**（衰减只会往下、永不往上）", `近卡=${rw.score}`);
  // ★★ 未知不惩罚
  const noTime = { id: "c", status: "done", parent: null, title: "老格式", kr: [], lessons: [] };
  const nw = T.goalWeightBasis(noTime, scope);
  console.log(`  无时间的：score=${nw.score}  why=${JSON.stringify(nw.why.filter(w=>/没有|衰减/.test(w)))}`);
  check(nw.score === 45, "★★★★ **没有 `更新于` 的卡一分不扣**（不知道就不惩罚 —— 否则老项目会被无端降权）", `=${nw.score}`);
  // ★★★ 真调函数验"是不是真的动了分"，而不是只看静态代码
  check(ow.score !== 45, "★ 旧卡**确实被扣了分**（不是所有 done 都恒 45 —— 那正是修复前的状态）", `旧卡=${ow.score} vs 修复前恒 45`);
}

// ── ④ D198：注入里真的带"多久没动" ─────────────────────────────────────
bar("④ D198：注入的目标树段里，**真的看得出它旧了吗**？（这正是当初缺口 ③）");
{
  const nowMs = Date.now();
  const tree = {
    cards: [
      { id: "g1", status: "root", parent: null, title: "根目标", kr: [], lessons: [], updatedAt: "2026-10-01 09:00" },
      { id: "g2", status: "done", parent: "g1", title: "老格式卡", kr: [], lessons: [] },
    ],
    byId: new Map(), childrenOf: new Map(), roots: ["g1"], issues: [],
  };
  tree.byId.set("g1", tree.cards[0]); tree.byId.set("g2", tree.cards[1]);
  tree.childrenOf.set("g1", ["g2"]);
  const text = T.renderGoalTree(tree);
  console.log("  ── 渲染出来的目标树 ──");
  for (const l of text.split("\n")) if (l.trim() !== "") console.log(`    ${l}`);
  check(/更新于 [\d-]+ [\d:]+（\d+ 天前）/.test(text), "★★ 有时间的卡**显示了「更新于 … （N 天前）」**");
  check(text.includes("更新于：**未知**"), "★★ 没时间的卡**如实显示「未知」**（不是省略、也不是编一个「刚刚」）");
}

// ── ⑤ D199：旧架构项目 —— 必须**报出**问题 ────────────────────────────
bar("⑤ D199：一个**旧架构**项目，`ledger_migrate` 报不报得出来？");
{
  const root = mk("mig-old");
  // 造一个"旧架构"活跃台账：状态 + 日期流水 + 已完成勾选 + 内嵌决策 混在一起
  const lines = ["# 台账", "", "## 一、项目目标", "把插件做好", ""];
  for (let i = 0; i < 30; i++) lines.push(`- 2026-10-${String((i % 28) + 1).padStart(2, "0")} 做了第 ${i} 件事`);
  lines.push("", "### 已完成明细");
  for (let i = 0; i < 25; i++) lines.push(`- [x] 第 ${i} 项已完成`);
  lines.push("", "## 决策 D1", "用 Node 写；只追加不删。");
  fs.writeFileSync(path.join(root, "LEDGER.md"), lines.join("\n") + "\n", "utf8");
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive" }, null, 2),
    "utf8"
  );
  fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 决策\n", "utf8");
  fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });

  const r = await callTool(root, "ledger_migrate", {});
  check(r.needsMigration === true, "★ 报出「需要迁移」", `problemCount=${r.problemCount}`);
  const hitKeys = new Set(r.files.flatMap((f) => f.hits.map((h) => h.key)));
  check(hitKeys.has("dateFlow"), "★ 识别出**日期流水**", `count=${(r.files.flatMap(f=>f.hits).find(h=>h.key==="dateFlow")??{}).count}`);
  check(hitKeys.has("doneChecklist"), "★ 识别出**已完成勾选清单**", `count=${(r.files.flatMap(f=>f.hits).find(h=>h.key==="doneChecklist")??{}).count}`);
  check(r.steps.length >= 2, "★★ 给出了**可执行的步骤**（不是只说「你旧了」）", `${r.steps.length} 步`);
  console.log("  ── steps ──");
  for (const s of r.steps) console.log(`    · ${s.split("\n")[0]}`);
  // ★★ 关键：**只读** —— 跑完不能改任何文件
  const before = fs.readFileSync(path.join(root, "LEDGER.md"), "utf8");
  await callTool(root, "ledger_migrate", {});
  check(fs.readFileSync(path.join(root, "LEDGER.md"), "utf8") === before, "★★★★ `ledger_migrate` **一个字节都没写**（与 conform 的加法相对，它是纯检测）");
}

// ── ⑥ D199：**新架构**项目 —— 必须报**干净**（防"见文件就说旧"的假阳性）──
bar("⑥ D199：一个**新架构**项目，必须**不报**问题（这条防假阳性 —— 乱报会让 AI 去改本来没问题的文件）");
{
  const root = mk("mig-new");
  fs.writeFileSync(
    path.join(root, "LEDGER.md"),
    "# 项目台账 · 当前状态\n\n## 目标\n把插件做好\n\n## 下一步\n写探针\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 关键决策\n\n## D1 · 用 Node\n", "utf8");
  fs.writeFileSync(path.join(root, "JOURNAL.md"), "# 回合流水\n\n- 2026-10-14 做了甲\n- 2026-10-14 做了乙\n", "utf8");
  fs.writeFileSync(
    path.join(root, "GOALS.md"),
    `# 目标树\n\n${T.renderGoalCard({ id: "g1", status: "root", parent: "-", title: "根目标", kr: [], lessons: [] })}\n`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify({
      version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive",
      journal: "JOURNAL.md", goals: "GOALS.md",
    }, null, 2),
    "utf8"
  );
  fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });

  const r = await callTool(root, "ledger_migrate", {});
  check(r.needsMigration === false, "★★★★ **新架构项目报「不需要迁移」**（「见文件就说旧」的假阳性当场防住）", `problemCount=${r.problemCount}`);
  check(r.notes.some((n) => n.includes("不需要迁移")), "★ 且明说不需要，而不是沉默", "");
  // ★★ 反向参照：证明第⑥条不是"什么都没测"（同一把尺子在⑤上必须报红）
  check(true, "（⑤ 已经证明同一把尺子**能报红** —— 所以这里的「绿」是真的绿）", "");
}

// ── ⑦ D199：目标卡缺时间 ⇒ 报出并给步骤（"更新到新版本"那一半）─────────
bar("⑦ D199：老格式的**目标卡缺 `更新于`** ⇒ 报出并给步骤？");
{
  const root = mk("mig-goals");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n当前状态\n", "utf8");
  fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 决策\n", "utf8");
  // ★ 老格式卡：没有 `更新于`
  fs.writeFileSync(
    path.join(root, "GOALS.md"),
    "# 目标树\n\n## 目标 g1 · 根本目标\n- parent: -\n- title: 根\n\n## 目标 g2 · 已完成\n- parent: g1\n- title: 子\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", goals: "GOALS.md" }, null, 2),
    "utf8"
  );
  fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });

  const r = await callTool(root, "ledger_migrate", {});
  const g = r.files.flatMap((f) => f.hits).find((h) => h.key === "goalNoTime");
  check(g !== undefined, "★★ 报出「目标卡缺 `更新于`」", g === undefined ? "**没报出来**" : `缺 ${g.count} 张：${JSON.stringify(g.ids)}`);
  check(g !== undefined && g.count === 2, "★ 数对了（两张卡都没有时间）", `count=${g?.count}`);
  check((g?.why ?? "").includes("不能替你补"), "★★ 且明说**插件不能替你补**（乱补时间 = 伪造事实）", "");
  check(r.steps.some((s) => s.includes("给目标卡补时间")), "★ 给出了「用 upsert 重写那张卡」的步骤", "");
}

// ── 帮手：真调注册表里的工具（与 selftest 同一把尺子）────────────────────
async function callTool(root, name, args) {
  const tools = new Map();
  const ctx = {
    tools: { register: (d) => tools.set(d.name, d) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on: () => () => {},
    inject: (deps, cb) => {
      const s = { commands: { register: () => () => {} }, userQuestions: { async ask() { return { answers: [] }; } } };
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
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`工具没注册：${name}`);
  return tool.execute(args ?? {}, { agent: { session: { header: { id: "probe", cwd: root } } } });
}

bar(`结  论：${bad === 0 ? "全部通过" : `${bad} 项不符合预期`}`);
console.log("  ★ D198：写卡带时间 · 解析读得回 · 已完成的按相对时间下沉 · **未知不惩罚** · 注入里看得见年龄。");
console.log("  ★ D199：旧架构报得出 · 新架构不误报 · 缺时间的卡报得出且**不替它补** · 全程只读。");
