/**
 * 探针（D289 · V3 阶段 1 续）：**记忆读写真的跟着 `memoryRoot` 走了吗？**
 *
 * ★★ 为什么必须有这一条（`_probe-v3-memoryroot.mjs` 不顶用）：
 *   `_probe-v3-memoryroot.mjs` 只验 `inspect()` **算出来的字段对不对**。
 *   而我们真正要保证的是：**写的时候真的写进记忆子目录、读的时候真的从那里读**。
 *   这两件事之间隔着几十处 `path.resolve(root, info.xxxRel)` —— 那正是本探针要钉的东西。
 *
 * ★★★ 判据（这条探针的核心）：**同一把尺子在修复前后必须给出相反结论**。
 *   修之前：V3 项目下 `ledger_write` 会**写进项目根**（因为它还在用 `root`）
 *   ⇒ 断言 ①② 必红。
 *   修之后：写进记忆子目录 ⇒ 同在的断言转绿。
 *   ⇒ 若它一开始就全绿，那不是"改对了"，是**尺子没测到东西**（得重写尺子）。
 *
 * ★ 覆盖四个真实写入口 + 两个真实读入口：
 *   写：`writeLedger`（active / decisions / journal）、`writeLog`（L1）、`writePrinciples`
 *   读：`inspect().activeAbs`、`readKindRaw`（decisions）
 *
 * 跑法：node tools/_probe-v3-e2e.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");
const LIB_URL = `file://${LIB.replace(/\\/g, "/")}/`;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `  ← ${extra}`}`);
  }
};

const part2 = await import(new URL("./part2.js", LIB_URL).href);
const part4 = await import(new URL("./part4.js", LIB_URL).href);
const part5 = await import(new URL("./part5.js", LIB_URL).href);

/** 造一个 V3 项目：记忆全在 `<项目名>-ledger-memory/` 里。 */
function makeV3Project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3e2e-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n", "utf8");
  const memDir = `${path.basename(dir)}-ledger-memory`;
  const memAbs = path.join(dir, memDir);
  fs.mkdirSync(memAbs, { recursive: true });
  fs.writeFileSync(path.join(memAbs, "LEDGER.md"), "# 台账\n\n旧内容。\n", "utf8");
  fs.mkdirSync(path.join(memAbs, "_ledger-archive"), { recursive: true });
  fs.mkdirSync(path.join(memAbs, "_ledger-log"), { recursive: true });
  const manifest = {
    version: 1,
    active: "LEDGER.md",
    decisions: "DECISIONS.md",
    decisionsDir: "decisions",
    archiveDir: "_ledger-archive",
    logDir: "_ledger-log",
    revision: 0,
    maxActiveLines: 400,
    memoryRoot: memDir,
  };
  fs.writeFileSync(path.join(dir, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { dir, memDir, memAbs };
}

/** 造同样的项目，但不登记 memoryRoot（V2 对照）。 */
function makeV2Project() {
  const { dir, memDir, memAbs } = makeV3Project();
  const mp = path.join(dir, ".dsh-ledger.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  delete m.memoryRoot;
  fs.writeFileSync(mp, JSON.stringify(m, null, 2), "utf8");
  // 把记忆文件挪回项目根，使其成为真正的 V2 布局
  for (const n of fs.readdirSync(memAbs)) {
    fs.renameSync(path.join(memAbs, n), path.join(dir, n));
  }
  fs.rmSync(memAbs, { recursive: true, force: true });
  return { dir, memDir, memAbs };
}

// ═══ ① 写：ledger_write({target:"active"}) 必须写进记忆子目录 ═══
console.log("── ① 写活跃台账：V3 下必须落进记忆子目录，项目根不许出现 LEDGER.md ──");
{
  const { dir, memAbs } = makeV3Project();
  const before = fs.readFileSync(path.join(memAbs, "LEDGER.md"), "utf8");
  const r = part4.writeLedger(dir, { target: "active", mode: "append", content: "- V3 新条目\n" }, {}, {});
  ok("① 写入返回 ok", r?.ok === true, JSON.stringify(r).slice(0, 200));
  ok(
    "① ★★ 记忆子目录里的 LEDGER.md **真的变了**",
    fs.readFileSync(path.join(memAbs, "LEDGER.md"), "utf8") !== before,
  );
  ok(
    "① ★★ 项目根**没有**冒出 LEDGER.md（没写错地方）",
    !fs.existsSync(path.join(dir, "LEDGER.md")),
  );
  ok(
    "① 新内容确实在记忆子目录那份里",
    /V3 新条目/.test(fs.readFileSync(path.join(memAbs, "LEDGER.md"), "utf8")),
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ ② 写：decisions 卡片模式必须写进记忆子目录里的 decisions/ ═══
console.log("\n── ② 写决策卡：必须落进记忆子目录里的 decisions/ ──");
{
  const { dir, memAbs } = makeV3Project();
  const r = part4.writeLedger(
    dir,
    { target: "decisions", content: "## D900\n\n- 一条测试决策\n" },
    {},
    {},
  );
  ok("② 写入返回 ok", r?.ok === true, JSON.stringify(r).slice(0, 300));
  const cardInMem = path.join(memAbs, "decisions", "D900.md");
  ok("② ★★ 卡片落在记忆子目录里", fs.existsSync(cardInMem), cardInMem);
  ok("② ★★ 项目根**没有**冒出 decisions/", !fs.existsSync(path.join(dir, "decisions")));
  // 读回来
  const info = part2.inspect(dir);
  const rr = part4.readKindRaw(dir, info, "decisions");
  ok("② ★ 读也走同一处：readKindRaw 读到了刚写的那张", /一条测试决策/.test(rr.raw), `mode=${rr.mode} chars=${rr.raw.length}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ ③ 写：ledger_log_write（L1）必须写进记忆子目录里的日志目录 ═══
console.log("\n── ③ 写 L1 日志：必须落进记忆子目录里的 _ledger-log/ ──");
{
  const { dir, memAbs } = makeV3Project();
  const r = part5.writeLog(dir, { title: "V3 探针写的一条 L1" });
  ok("③ 写入返回 ok", r?.ok === true, JSON.stringify(r).slice(0, 300));
  const logFiles = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/^L1-.*\.md$/.test(e.name)) logFiles.push(p);
    }
  };
  if (fs.existsSync(path.join(memAbs, "_ledger-log"))) walk(path.join(memAbs, "_ledger-log"));
  ok("③ ★★ L1 文件出现在记忆子目录的 _ledger-log 下", logFiles.length > 0, logFiles.join(", "));
  ok(
    "③ ★★ 内容真的写进去了",
    logFiles.length > 0 && /V3 探针写的一条 L1/.test(fs.readFileSync(logFiles[0], "utf8")),
  );
  ok("③ ★★ 项目根**没有**冒出 _ledger-log/", !fs.existsSync(path.join(dir, "_ledger-log")));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ ④ 写：writePrinciples 必须写进记忆子目录 ═══
console.log("\n── ④ 写根本原则：必须落进记忆子目录 ──");
{
  const { dir, memAbs } = makeV3Project();
  const r = part2.writePrinciples(dir, { content: "原则一：测试。", mode: "append", authorizedBy: "probe" });
  ok("④ 写入返回 ok", r?.ok === true, JSON.stringify(r).slice(0, 300));
  ok("④ ★★ PRINCIPLES.md 落在记忆子目录里", fs.existsSync(path.join(memAbs, "PRINCIPLES.md")));
  ok("④ ★★ 项目根**没有**冒出 PRINCIPLES.md", !fs.existsSync(path.join(dir, "PRINCIPLES.md")));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ ⑤ V2 对照：没有 memoryRoot 时，一切照旧写在项目根 ═══
console.log("\n── ⑤ V2 对照：不登记 memoryRoot ⇒ 全部照旧写在项目根（行为不变）──");
{
  const { dir } = makeV2Project();
  const before = fs.readFileSync(path.join(dir, "LEDGER.md"), "utf8");
  const r = part4.writeLedger(dir, { target: "active", mode: "append", content: "- V2 新条目\n" }, {}, {});
  ok("⑤ 写入返回 ok", r?.ok === true, JSON.stringify(r).slice(0, 200));
  ok(
    "⑤ ★★ 项目根的 LEDGER.md 真的变了（与 V3 之前的字节行为一致）",
    fs.readFileSync(path.join(dir, "LEDGER.md"), "utf8") !== before,
  );
  ok("⑤ 没有记忆子目录被创建出来", !fs.existsSync(path.join(dir, `${path.basename(dir)}-ledger-memory`)));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ ⑥ ledger_init 能"生出"一个 V3 项目（唯一能创建 V3 的入口）═══
console.log("\n── ⑥ ledger_init({memoryRoot}) 必须真的建出 V3 布局 ──");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3init-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  const memDir = `${path.basename(dir)}-ledger-memory`;

  const r = await part4.defineInitTool().execute(
    {
      root: dir,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive",
      logDir: "_ledger-log",
      decisionsDir: "decisions",
      memoryRoot: memDir,
      initialActive: "# 台账\n\n- 第一条\n",
      initialDecisions: "# 关键决策记录\n",
      gitignore: true,
      gitInit: false,
    },
    { agent: { session: { header: { id: "probe-v3" } }, cwd: dir } },
  );
  const memAbs = path.join(dir, memDir);
  ok("⑥ init 返回 ok", r?.ok === true, JSON.stringify(r).slice(0, 400));
  ok("⑥ ★★ 记忆子目录被建出来了", fs.existsSync(memAbs), memAbs);
  ok("⑥ ★★ LEDGER.md 在记忆子目录里", fs.existsSync(path.join(memAbs, "LEDGER.md")));
  ok("⑥ ★★ 项目根**没有** LEDGER.md", !fs.existsSync(path.join(dir, "LEDGER.md")));
  ok("⑥ ★★ 清单**仍在项目根**", fs.existsSync(path.join(dir, ".dsh-ledger.json")));
  const mp = path.join(dir, ".dsh-ledger.json");
  const m = JSON.parse(fs.readFileSync(mp, "utf8"));
  ok("⑥ ★★ 清单里记下了 memoryRoot", m.memoryRoot === memDir, String(m.memoryRoot));
  // 再 inspect 一遍，必须认出 V3
  const info = part2.inspect(dir);
  ok("⑥ ★★ 建完之后 inspect 认得这是 V3", info.memoryRoot === memDir, String(info.memoryRoot));
  ok("⑥ ★★ activeAbs 落在记忆子目录", info.activeAbs === path.join(memAbs, "LEDGER.md"), info.activeAbs);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══ ⑦ 重复 init 不许把 memoryRoot 抹掉（否则记忆“突然空了”）═══
console.log("\n── ⑦ 重复 ledger_init 不许抹掉 memoryRoot ──");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3reinit-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  const memDir = `${path.basename(dir)}-ledger-memory`;
  const exec = { agent: { session: { header: { id: "probe-v3" } }, cwd: dir } };
  await part4.defineInitTool().execute(
    {
      root: dir,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive",
      memoryRoot: memDir,
      initialActive: "# 台账\n",
      initialDecisions: "# 决策\n",
      gitignore: false,
      gitInit: false,
    },
    exec,
  );
  // 第二次 init：**不传** memoryRoot
  const r2 = await part4.defineInitTool().execute(
    {
      root: dir,
      active: "LEDGER.md",
      decisions: "DECISIONS.md",
      archiveDir: "_ledger-archive",
      gitignore: false,
      gitInit: false,
    },
    exec,
  );
  const m2 = JSON.parse(fs.readFileSync(path.join(dir, ".dsh-ledger.json"), "utf8"));
  ok("⑦ 第二次 init 返回 ok", r2?.ok === true, JSON.stringify(r2).slice(0, 300));
  ok(
    "⑦ ★★ memoryRoot 被**保留**（没被抹成 V2 布局）",
    m2.memoryRoot === memDir,
    `实际=${String(m2.memoryRoot)}`,
  );
  const info2 = part2.inspect(dir);
  ok("⑦ ★★ 重跑之后仍认得 V3", info2.memoryRoot === memDir, String(info2.memoryRoot));
  ok("⑦ ★★ 台账仍指向记忆子目录", info2.activeAbs === path.join(dir, memDir, "LEDGER.md"), info2.activeAbs);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
