/**
 * ★★★★★★ 行为取证（D193）：**`/ledger principles approve` 真的把那一路接上了吗？**
 *
 * 背景（D189 已查实的缺口）：
 *   `applyPrincipleProposal` = D180 里"用户批准后写盘"的**唯一**函数，原来**调用点 = 0**
 *   （静态：剥注释后只剩定义；对照：`registerGoalsInManifest` 定义 1 调用 1；行为：提议 → 同意 → 什么都不发生）。
 *   ⇒ 用户拍板：**另开 `/ledger principles approve <id>`**（不改 checkpoint 四选一那条稳定契约）。
 *
 * ★ 本探针的判据（**行为优先**，静态只作辅助）：
 *   ① **端到端**：模型提议 → 用户敲 `approve` → 确认卡片 → **文件里真有那段字**；
 *   ② ★★★ **拒绝路径**：卡片选"取消" ⇒ **一个字节都不写**（否则"确认"是摆设）；
 *   ③ ★★★ **一次一批准**：同一提案批两次 ⇒ 第二次必须找不到（不能重复写）；
 *   ④ **命令层专属**：`approve` **不是工具**（工具表里没有它）——
 *      若模型能自己批准自己的提议，守卫归零；
 *   ⑤ `remove` 逐字匹配失败 ⇒ 拒写（删不到就报错，绝不猜）。
 *
 * 只读：只在临时目录里造项目，**不碰本项目任何文件**。
 * 跑法：node tools/_probe-d193-approve-wired.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);

let bad = 0;
const chk = (label, cond, detail) => {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${detail === undefined ? "" : `\n      ${detail}`}`);
  if (!cond) bad++;
};

/** 造一个带 PRINCIPLES.md 的临时项目 + 可用的假 ctx。 */
function mkProject(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `d193-${tag}-`));
  fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n## 状态\n- x\n", "utf8");
  fs.writeFileSync(path.join(dir, "DECISIONS.md"), "# 决策\n", "utf8");
  fs.writeFileSync(path.join(dir, "PRINCIPLES.md"), "# 根本原则\n\n## 一、用户手写的\n要准确。\n", "utf8");
  fs.writeFileSync(
    path.join(dir, ".dsh-ledger.json"),
    JSON.stringify({
      version: 1, active: "LEDGER.md", decisions: "DECISIONS.md",
      principles: "PRINCIPLES.md", archiveDir: "_ledger-archive", maxActiveLines: 300,
      logDir: "_ledger-log",
      logLevels: { L0: true, L1: true, L2: true, L3: false, L4: true },
      revision: 0,
    }),
    "utf8"
  );
  return dir;
}

/** 极简假 ctx：够本探针用（工具 / 命令 / userQuestions / handlers）。
 *
 *  ★★★ 这里**必须复刻 `ctx.inject(deps, cb)`** —— 我第一版把它写成 `() => ({dispose(){}})`
 *    的空壳，于是 `/ledger` 命令**根本没被注册**（插件是用 `ctx.inject(["commands"], …)`
 *    注册命令的），探针当场撞出 `cmd === undefined`。
 *  ⇒ 那**不是被测对象的问题，是我的夹具漏了一步**（纪律 6：夹具没走通时，
 *    绝不能把"夹具故障"当成"被测对象的问题"）。真实语义（见自检 L419-431）：
 *    服务不在 ⇒ 不执行 cb、也不抛错；在 ⇒ 用一个**挂着该服务**的 scope 调 cb。
 */
function mkCtx() {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  let answer = null;
  const asked = [];
  const services = {
    tools: { register: (d) => tools.set(d.name, d) },
    commands: { register: (d) => commands.set(d.name, d) },
    userQuestions: {
      async ask(req) {
        asked.push(req);
        if (answer === null) throw new Error("探针没装应答器 ⇒ 模拟卡片送不出去");
        return answer(req);
      },
    },
  };
  const ctx = {
    // ★ 工具是**直接** `ctx.tools.register(...)` 注册的（不是走 inject）
    //   ⇒ 这几个必须直接挂在 ctx 上；我第一版只放进 `services`，
    //     于是 `ctx.tools` 是 undefined、注册全部静默失败（外层 try/catch 吞掉了）。
    tools: services.tools,
    commands: services.commands,
    userQuestions: services.userQuestions,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on: (ev, h) => {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(h);
      return () => {};
    },
    inject(deps, cb) {
      for (const d of deps) if (!(d in services)) return undefined;
      const scope = Object.create(ctx);
      for (const d of deps) scope[d] = services[d];
      return cb(scope);
    },
    get: (n) => services[n],
  };
  return { ctx, tools, commands, handlers, asked, setAnswer: (f) => (answer = f) };
}

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);

// ═══════════════════════════════════════════════════════════════════════════
bar("① 端到端：模型提议 → 用户 approve → **文件里真有那段字**");
{
  const root = mkProject("e2e");
  const run = mkCtx();
  mod.apply(run.ctx, {});
  const cmd = run.commands.get("ledger");
  chk("命令 `ledger` 已注册", cmd !== undefined);
  const agent = { session: { header: { id: "s-d193-e2e", cwd: root } }, steer() {} };
  const exec = { agent, session: { header: { id: "s-d193-e2e", cwd: root } } };

  const prop = await run.tools.get("ledger_propose_principle").execute(
    { op: "add", text: "## 二、可回溯性优先\n每一个结论都必须带出处。", reason: "用户多次强调" },
    exec
  );
  console.log(`  提议：ok=${prop.ok} id=${prop.proposalId}`);
  chk("提议登记成功", prop.ok === true && typeof prop.proposalId === "string", JSON.stringify(prop).slice(0, 160));
  const before = fs.readFileSync(path.join(root, "PRINCIPLES.md"), "utf8");
  chk("提议**不写文件**（提议 ≠ 写盘）", !before.includes("可回溯性优先"), before.slice(0, 80));

  // 用户敲 pending
  const pend = await cmd.handler({
    commandId: "c1", agent, rawInput: "principles pending",
    attachments: [], signal: new AbortController().signal,
  });
  console.log(`  pending ⇒ ${pend.kind}`);
  chk("`pending` 列出了那条提议（含它的 id）",
    pend.kind === "success" && String(pend.text).includes(prop.proposalId),
    String(pend.text).slice(0, 200));

  // 用户点"写入"
  run.setAnswer(() => ({ answers: [{ id: "ledger-principles-approve", selected: ["写入"] }] }));
  const ap = await cmd.handler({
    commandId: "c2", agent, rawInput: "principles approve",
    attachments: [], signal: new AbortController().signal,
  });
  console.log(`  approve ⇒ ${ap.kind}：${String(ap.text).split("\n")[0]}`);
  const after = fs.readFileSync(path.join(root, "PRINCIPLES.md"), "utf8");
  chk("★★★★★ `approve` 之后，那段原则**真的在文件里**（这就是原来断掉的那条路）",
    ap.kind === "success" && after.includes("可回溯性优先") && after.includes("每一个结论都必须带出处"),
    `kind=${ap.kind} 含内容=${after.includes("可回溯性优先")}`);
  chk("且用户原来那条原则**没被动过**（append 不覆盖）",
    after.includes("要准确"), after.slice(0, 120));
  chk("确认卡片里**逐字显示了将要写入的内容**（用户是先看见才按的）",
    run.asked.length > 0 && String(run.asked[run.asked.length - 1].questions[0].question).includes("每一个结论都必须带出处"),
    `问过 ${run.asked.length} 次`);

  // ③ 一次一批准
  run.setAnswer(() => ({ answers: [{ id: "ledger-principles-approve", selected: ["写入"] }] }));
  const again = await cmd.handler({
    commandId: "c3", agent, rawInput: `principles approve ${prop.proposalId}`,
    attachments: [], signal: new AbortController().signal,
  });
  chk("★★★★ 同一个提议**批第二次 ⇒ 找不到**（一次一批准，不能重复写）",
    again.kind === "error" && /找不到|没有待批准/.test(String(again.text)),
    `kind=${again.kind} ${String(again.text).slice(0, 140)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
bar("② ★★★ 拒绝路径：卡片选「取消」⇒ **一个字节都不写**");
{
  const root = mkProject("cancel");
  const run = mkCtx();
  mod.apply(run.ctx, {});
  const cmd = run.commands.get("ledger");
  const agent = { session: { header: { id: "s-d193-cancel", cwd: root } }, steer() {} };
  const exec = { agent, session: { header: { id: "s-d193-cancel", cwd: root } } };
  await run.tools.get("ledger_propose_principle").execute(
    { op: "add", text: "## 不该出现的原则\n这条绝不该被写进去。" },
    exec
  );
  run.setAnswer(() => ({ answers: [{ id: "ledger-principles-approve", selected: ["取消"] }] }));
  const r = await cmd.handler({
    commandId: "c4", agent, rawInput: "principles approve",
    attachments: [], signal: new AbortController().signal,
  });
  const body = fs.readFileSync(path.join(root, "PRINCIPLES.md"), "utf8");
  chk("★★★★★ 点「取消」⇒ 文件里**没有**那段内容（确认不是摆设）",
    !body.includes("这条绝不该被写进去"), body.slice(0, 120));
  chk("并且如实告诉用户「没有写入」", /没有写入/.test(String(r.text)), String(r.text).slice(0, 120));

  // 卡片送不出去（探针没装应答器那一路）
  run.setAnswer(null);
  const r2 = await cmd.handler({
    commandId: "c5", agent, rawInput: "principles approve",
    attachments: [], signal: new AbortController().signal,
  });
  const body2 = fs.readFileSync(path.join(root, "PRINCIPLES.md"), "utf8");
  chk("★★★★ 卡片送不出去 ⇒ **也不写**，且明说不写（宁可让用户重来，也不猜他同意了）",
    r2.kind === "error" && !body2.includes("这条绝不该被写进去"),
    `kind=${r2.kind} 含内容=${body2.includes("这条绝不该被写进去")}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
bar("③ ★★★ 命令层专属：`approve` **不是工具**（否则模型能自己批准自己）");
{
  const root = mkProject("no-tool");
  const run = mkCtx();
  mod.apply(run.ctx, {});
  const names = [...run.tools.keys()];
  // ★★★ 尺子修正（本探针第一版在这里报了一个**假红**）：
  //   我原来写 `/approv|principles/` —— 而工具名是 `ledger_propose_principle`
  //   （**单数** `principle`）⇒ 它被自己的尺子筛掉了，于是"相关工具只有 1 个"。
  //   ★ 这不是被测对象少了东西，是**我的匹配面太窄**（与 LESSONS L2 同一类错）。
  //   ⇒ 判据改成匹配词根 `principle`（单复数都吃）。
  const approvalish = names.filter((n) => /principle/.test(n));
  console.log(`  与原则相关的工具：${approvalish.join(", ") || "(无)"}`);
  chk("★★★★★ 工具表里**没有**任何「批准」类工具（批准只在命令行层）",
    !names.some((n) => /approv/i.test(n)),
    names.join(", "));
  chk("模型能碰原则的仍然只有那两个（提议 + 请求授权窗口）",
    approvalish.length === 2 && approvalish.includes("ledger_propose_principle"),
    approvalish.join(", "));
  chk("★★★ 而 `approve` 的子命令确实存在于**命令解析**里（否则这条路根本不存在）",
    /head === "approve"/.test(fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8")),
    "查 lib/index.js 里的 approve 分支");
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
bar("④ `remove` 逐字匹配失败 ⇒ 拒写（删不到就报错，绝不猜）");
{
  const root = mkProject("remove-miss");
  const run = mkCtx();
  mod.apply(run.ctx, {});
  const cmd = run.commands.get("ledger");
  const agent = { session: { header: { id: "s-d193-rm", cwd: root } }, steer() {} };
  const exec = { agent, session: { header: { id: "s-d193-rm", cwd: root } } };
  await run.tools.get("ledger_propose_principle").execute(
    { op: "remove", text: "这条在文件里根本不存在的一段" },
    exec
  );
  run.setAnswer(() => ({ answers: [{ id: "ledger-principles-approve", selected: ["写入"] }] }));
  const r = await cmd.handler({
    commandId: "c6", agent, rawInput: "principles approve",
    attachments: [], signal: new AbortController().signal,
  });
  const body = fs.readFileSync(path.join(root, "PRINCIPLES.md"), "utf8");
  chk("★★★★ 删一段文件里没有的内容 ⇒ 报错、**文件原样不动**",
    r.kind === "error" && body.includes("要准确") && !/notFound/.test(body),
    `kind=${r.kind} ${String(r.text).slice(0, 160)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
bar(`结  论：${bad === 0 ? "全部通过" : `${bad} 项不通过`}`);
console.log(
  bad === 0
    ? "  D193 那条路**真的接上了**：提议 → 用户 `approve` → 确认 → 落盘；\n" +
      "  且取消 / 送不出去 / 重复批准 / 删不到 **四种情况都不写盘**。"
    : "  ⚠️ 上面有 ❌ ⇒ **不要**把它当成已修好。"
);
process.exit(bad === 0 ? 0 : 1);
