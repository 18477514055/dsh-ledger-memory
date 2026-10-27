/**
 * _probe-d326-008-fixes.mjs —— 独立验证 Gemini 008 的五条修复**行为上**真的成立。
 *
 * ★ 为什么不直接跑 selftest 的 123①–123⑤ 就行：
 *   123 那五条是**补丁作者自己写的**。本项目已栽过的同类：报告说"已修 + 断言已加"，
 *   但断言的条件位写错 ⇒ 永远绿（D323 的 `ok()` 参数顺序）。所以这里**另写一份**，
 *   判据从"我要的行为"出发，不从"他写的断言"出发。
 *
 * ★ 每条都必须能**证伪**：配套 `_reverse-verify-d326.mjs` 逐条拆掉修复，看这里会不会红。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (f) => import(pathToFileURL(path.join(ROOT, "lib", f)).href);

const part1Mod = await load("part1.js");
const part2Mod = await load("part2.js");
const part4Mod = await load("part4.js");
const part5Mod = await load("part5.js");
const part7Mod = await load("part7.js");

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

/** 返回对象里所有值为 undefined 的属性路径（lossless JSON 的判据）。 */
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
const mkTmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), "d326-" + tag + "-"));

/**
 * ★★★★ 2026-10-26（D326 · 尺子错 #40，本轮自己撞的）：
 *   F-03 那条夹具原来用**写死的会话 id**（`session-d3260001-…`）。
 *   而 `recordShadowedIndex` 是**内存 + 磁盘并起来**的（`readShadowedStore()`），
 *   磁盘那份住在 **DSH 家的 `plugin-data`** 里 —— **不随临时目录清理、跨进程累积**。
 *   ⇒ 后果：反向验证里"破坏版"跑过一次之后，磁盘上就留下了这个 sid 的记录；
 *     之后"正常版"再跑，同 `summarySeq` 被去重跳过 ⇒ 拿到的是**破坏版留下的旧记录**
 *     ⇒ 正常版也红。**全红和全绿一样是假的**（纪律 6/8 的镜像）。
 *   ★ 判据：**凡是"写到进程外持久层"的夹具，标识必须每次运行唯一**，
 *     否则第二次运行就不是同一个实验了。
 *   ⇒ 每次运行生成一个唯一的 uuid 形状 id（tag 仍稳定，方便回溯路径断言）。
 */
const UNIQ_SID = `session-d326${String(Date.now()).slice(-4)}-0000-4000-8000-${String(
  Math.floor(Math.random() * 1e12)
).padStart(12, "0")}`;

// ══════════════════════════════════════════════════════════════════════════
// ① F-01：defineIndexTool(op:"write") 在 memoryRoot 越界时**不抛 TDZ**，且不写穿源码根
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkTmp("f01");
  try {
    const proj = path.join(t, "proj");
    fs.mkdirSync(path.join(proj, "decisions"), { recursive: true });
    fs.writeFileSync(path.join(proj, "decisions", "D1.md"), "## D1 · 决策\n\n正文\n", "utf8");
    fs.writeFileSync(
      path.join(proj, ".dsh-ledger.json"),
      JSON.stringify({
        version: 1,
        active: "LEDGER.md",
        decisions: "DECISIONS.md",
        archiveDir: "_archive",
        decisionsDir: "decisions",
        memoryRoot: "../escape-mem",
      }),
      "utf8"
    );
    let res;
    let err;
    try {
      res = await part4Mod.defineIndexTool().execute({ root: proj, kind: "decisions", op: "write" }, {});
    } catch (e) {
      err = e;
    }
    ok(
      "① a 越界 + op:write ⇒ **不抛**（TDZ 已消除）",
      err === undefined,
      err === undefined ? "no throw" : err.name + ": " + err.message
    );
    ok(
      "① b 越界 + op:write ⇒ wrote:false 且 writeError 是非空字符串",
      res?.ok === true && res?.wrote === false && typeof res?.writeError === "string" && res.writeError !== "",
      "wrote=" + res?.wrote + " err=" + res?.writeError
    );
    ok(
      "① c 源码根上**没有**被建出 decisions/INDEX.md",
      !fs.existsSync(path.join(proj, "decisions", "INDEX.md")),
      ""
    );
    ok("① d 越界时返回值仍是 lossless JSON", undefPaths(res).length === 0, JSON.stringify(undefPaths(res)));
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ② F-02：ledger_goals(op:upsert) 卡片模式 ⇒ 返回值无 undefined + 审计是真路径 + revision 递增
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkTmp("f02");
  try {
    const proj = path.join(t, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const exec = { agent: { session: { header: { id: "sid-d326-g", cwd: proj }, events: () => [] } } };
    const initR = await part4Mod.defineInitTool().execute(
      { root: proj, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_archive", goalsDir: "goals" },
      exec
    );
    ok("② 0 夹具：ledger_init 走通", initR?.ok === true, "ok=" + initR?.ok);

    const st = { touched: new Map(), flushedAt: new Map() };
    const g = await part2Mod.defineGoalsTool(st).execute(
      { root: proj, op: "upsert", id: "g1", title: "目标一", kr: ["KR1"] },
      exec
    );
    ok("② a upsert 成功", g?.ok === true, JSON.stringify(g).slice(0, 160));
    ok("② b 卡片模式下返回值**无 undefined 属性**（lossless JSON）", undefPaths(g).length === 0, JSON.stringify(undefPaths(g)));
    ok("② c 返回值里**没有** `lines: undefined` 这个键", !("lines" in g) || g.lines !== undefined, "lines=" + String(g?.lines));
    ok("② d revision 真的递增到 1", g?.revision === 1, "revision=" + g?.revision);

    const audit = part4Mod.logRead(proj, { view: "audit" });
    const line = audit?.changes?.[0]?.text ?? "";
    // ★★★ 尺子错 #38（本轮自己撞的）：原来写 `line.includes("goals")` —— 而审计行里
    //   `target` 那个字段**本来就写着 goals**，所以这条**恒真** ⇒ 把"改回写死 GOALS.md"
    //   的破坏也放过去了（反向验证的 ②-c 未变红，正是它抓出来的）。
    //   ⇒ 判据必须**只认卡片目录 `goals` 且排除 `GOALS.md`**。
    ok(
      "② e 审计行指向**卡片目录**（`goals`）而不是写死的 GOALS.md",
      line.includes("`goals`") && !line.includes("GOALS.md"),
      line.slice(0, 140)
    );
    ok("② f 审计行不是写死的「0 行」", !/\b0 行\b/.test(line), line.slice(0, 140));
    ok("② g 审计行带 revision→1", line.includes("revision→1"), line.slice(0, 140));
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ③ F-03：runTurnCompact 压成后补齐 6 项收尾
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkTmp("f03");
  try {
    const proj = path.join(t, "proj");
    fs.mkdirSync(proj, { recursive: true });
    const exec = { agent: { session: { header: { id: UNIQ_SID, cwd: proj }, events: () => [] } } };
    await part4Mod.defineInitTool().execute(
      { root: proj, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_archive" },
      exec
    );
    const st = {
      deltaAnchor: new Map(),
      deltaNudged: new Map(),
      flushedAt: new Map([[UNIQ_SID, Date.now()]]),
      lastCompactCycleAt: new Map(),
      flushBlocked: new Map([[UNIQ_SID, { count: 1 }]]),
      triageBlocked: new Map([[UNIQ_SID, { count: 1 }]]),
      triageAt: new Map(),
      triageOwedAt: new Map(),
      hfCompacted: new Map(),
      deltaYieldSince: new Map(),
      capsuleSnapshot: new Map(),
      capsuleHydrated: new Set(),
      hfSource: new Map(),
      reinject: new Map(),
      shadowedIndex: new Map(),
      compactCounts: new Map(),
      hfCompactAfterTurn: new Map(),
    };
    let calls = 0;
    const ctx = {
      get(svc) {
        if (svc === "tokenMeter") {
          return {
            measure() {
              calls += 1;
              return {
                totalTokens: calls <= 2 ? 78000 : 12000,
                windowSize: 100000,
                nodes: [
                  { seq: 0, tokens: 1000 },
                  { seq: 1, tokens: 35000 },
                  { seq: 2, tokens: 32000 },
                  { seq: 3, tokens: 5000 },
                  { seq: 4, tokens: 5000 },
                ],
              };
            },
          };
        }
        if (svc === "compaction") {
          return {
            async compactNow() {
              return {};
            },
            async compactRegion() {
              return { shadowedTokenCount: 67000, shadowedSeqs: [1, 2] };
            },
          };
        }
        return undefined;
      },
    };
    const evs = [
      { seq: 0, type: "system/message", content: [{ type: "text", text: "sys" }] },
      { seq: 1, type: "user/message", content: [{ type: "text", text: "u1" }] },
      { seq: 2, type: "assistant/message", content: [{ type: "text", text: "a1" }] },
      { seq: 3, type: "user/message", content: [{ type: "text", text: "u2" }] },
      { seq: 4, type: "assistant/message", content: [{ type: "text", text: "a2" }] },
      {
        seq: 5,
        type: "compaction/summary",
        time: Date.now(),
        data: { shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2], shadowedTokenCount: 67000, summary: [{ text: "sum" }] },
      },
    ];
    const agent = {
      session: {
        header: { id: UNIQ_SID, cwd: proj },
        requestContext: () => ({ contextWindow: 100000 }),
        surface: { nodes: [0, 1, 2, 3, 4] },
        log: evs,
        events: () => evs,
        eventAt: (s) => evs.find((e) => e.seq === s),
      },
    };
    const info = part2Mod.inspect(proj);
    const capMem = new Map([[UNIQ_SID, { userMessages: [{ text: "用户关键原话", at: "12:00" }], errors: [], artifacts: new Map() }]]);
    const r = await part5Mod.runTurnCompact(ctx, st, agent, capMem, info, 0.1);

    ok("③ 0 夹具：runTurnCompact 真压成了", r?.compacted === true, JSON.stringify(r).slice(0, 200));
    // ★★★ 尺子错 #39（本轮自己撞的）：原来取 `[0]` —— 而 `shadowedIndex` 是
    //   **内存 + 磁盘并起来**的（`readShadowedStore()`），磁盘那份在 plugin-data 里
    //   **跨进程、跨运行累积**；同一个 `summarySeq` 还会被去重跳过。
    //   ⇒ 夹具的 summarySeq 恒为 5，第一次跑过之后磁盘上就已经有 5 了 ⇒
    //     `[0]` 是**更早那次**留下的旧记录（那时还没有 capRel 字段）⇒ 恒红。
    //   ★ 这是"夹具前提错了，全绿/全红都是假的"（纪律 6/8）的镜像：**全红也是假的**。
    //   ⇒ 必须按**本次的 summarySeq（=5）**取，而不是取数组首项。
    const idxList = st.shadowedIndex.get(UNIQ_SID) ?? [];
    const idx = idxList.find((x) => x.summarySeq === 5) ?? idxList[idxList.length - 1];
    ok("③ a 被压段索引带 capRel（逐字原件指针）", typeof idx?.capRel === "string" && idx.capRel !== "", "capRel=" + String(idx?.capRel));
    const reinj = st.reinject.get(UNIQ_SID);
    ok("③ b 已 armReinject（压后首步会强制重注）", reinj instanceof Set && reinj.size > 0, "size=" + (reinj?.size ?? "n/a"));
    ok("③ c 锚点已按压后水位重置", Number.isFinite(st.deltaAnchor.get(UNIQ_SID)), "anchor=" + String(st.deltaAnchor.get(UNIQ_SID)));
    const cc = st.compactCounts.get(UNIQ_SID);
    ok(
      "③ d compactCounts 计了 full=1 且来源 auto:midturn",
      cc?.total === 1 && cc?.full === 1 && cc?.delta === 0 && cc?.lastSource === "auto:midturn",
      JSON.stringify(cc)
    );
    ok("③ e 已重置 flushedAt（下一个周期要重新落盘）", !st.flushedAt.has(UNIQ_SID), "has=" + st.flushedAt.has(UNIQ_SID));
    ok("③ f lastCompactCycleAt 已开新周期", typeof st.lastCompactCycleAt.get(UNIQ_SID) === "number", "");
    ok("③ g 拦次数已清零", !st.flushBlocked.has(UNIQ_SID) && !st.triageBlocked.has(UNIQ_SID), "");
    ok("③ h 返回值是 lossless JSON", undefPaths(r).length === 0, JSON.stringify(undefPaths(r)));
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ④ F-04：/ledger lock 命令补上工作区边界；ledger_init 不覆写损坏清单
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkTmp("f04");
  try {
    const ws = path.join(t, "ws");
    const proj = path.join(ws, "proj");
    const outside = path.join(t, "outside");
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# Workspace\n", "utf8");
    const fakeAgent = { session: { header: { id: "sid-d326-lock", cwd: proj } } };
    const lockRes = await part5Mod.runLedgerSub({}, { agent: fakeAgent }, {}, "lock", null, outside);
    ok("④ a /ledger lock 到工作区外 ⇒ 拒绝（kind:error）", lockRes?.kind === "error", "kind=" + lockRes?.kind);
    ok("④ b 拒绝文案说清是「拒绝锁定」", String(lockRes?.text ?? "").includes("拒绝锁定"), String(lockRes?.text ?? "").slice(0, 120));
    ok("④ c 真的**没锁上**（lockedRootOf 仍 undefined）", part1Mod.lockedRootOf(fakeAgent) === undefined, "");

    // 工作区**内**的目录必须照常能锁（否则就是拦过头）
    const inside = path.join(ws, "inside");
    fs.mkdirSync(inside, { recursive: true });
    const okRes = await part5Mod.runLedgerSub({}, { agent: fakeAgent }, {}, "lock", null, inside);
    ok("④ d 工作区**内**的目录照常能锁（没拦过头）", okRes?.kind === "success", "kind=" + okRes?.kind);
    part1Mod.setProjectLock(fakeAgent, undefined);

    const bad = path.join(t, "bad-proj");
    fs.mkdirSync(bad, { recursive: true });
    const broken = "{ corrupt json";
    fs.writeFileSync(path.join(bad, ".dsh-ledger.json"), broken, "utf8");
    let err;
    try {
      await part4Mod.defineInitTool().execute(
        { root: bad, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_archive" },
        {}
      );
    } catch (e) {
      err = e;
    }
    ok("④ e ledger_init 对损坏清单 ⇒ 抛错拒绝", err !== undefined, err === undefined ? "no throw" : String(err.message).slice(0, 120));
    ok(
      "④ f 损坏的清单**一个字节都没被覆写**",
      fs.readFileSync(path.join(bad, ".dsh-ledger.json"), "utf8") === broken,
      ""
    );
    ok("④ g 且没被当成全新项目建出记忆子目录", !fs.existsSync(path.join(bad, "bad-proj-ledger-memory")), "");

    // 真·全新项目必须照常能 init（否则就是拦过头）
    const fresh = path.join(t, "fresh");
    fs.mkdirSync(fresh, { recursive: true });
    const fr = await part4Mod.defineInitTool().execute(
      { root: fresh, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_archive" },
      {}
    );
    ok("④ h 真·全新项目照常能 init（没拦过头）", fr?.ok === true, "ok=" + fr?.ok);
    ok("④ i 全新项目默认生第三代（建出记忆子目录）", fs.existsSync(path.join(fresh, "fresh-ledger-memory")), "");
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ⑤ F-05：migrateToV3 目标已存在时做双向文件集校验 + 嵌套链接检查
// ══════════════════════════════════════════════════════════════════════════
{
  const t = mkTmp("f05");
  try {
    const proj = path.join(t, "proj");
    fs.mkdirSync(path.join(proj, "decisions"), { recursive: true });
    fs.mkdirSync(path.join(proj, "_archive"), { recursive: true });
    fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(path.join(proj, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.writeFileSync(path.join(proj, "decisions", "D1.md"), "## D1 · 决策一\n", "utf8");
    fs.writeFileSync(
      path.join(proj, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_archive", decisionsDir: "decisions" }),
      "utf8"
    );
    const memAbs = path.join(proj, "proj-ledger-memory");
    fs.mkdirSync(path.join(memAbs, "decisions"), { recursive: true });
    fs.mkdirSync(path.join(memAbs, "_archive"), { recursive: true });
    fs.writeFileSync(path.join(memAbs, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(path.join(memAbs, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.writeFileSync(path.join(memAbs, "decisions", "D1.md"), "## D1 · 决策一\n", "utf8");
    fs.writeFileSync(path.join(memAbs, "decisions", "D999.md"), "## D999 · 混入的脏卡\n", "utf8");
    const r = part7Mod.migrateToV3(proj, { apply: true });
    ok("⑤ a 目标目录含多余未知文件 ⇒ ok:false 拒绝沿用", r?.ok === false, "ok=" + r?.ok);
    ok("⑤ b problems 里点名了那个多余文件", Array.isArray(r?.problems) && r.problems.some((p) => p.includes("D999.md")), JSON.stringify(r?.problems ?? []).slice(0, 160));
    ok("⑤ c 原记忆**一个字节都没动**（LEDGER.md 仍在源码根）", fs.existsSync(path.join(proj, "LEDGER.md")), "");
    ok("⑤ d 清单没被改（memoryRoot 仍不存在）", (() => {
      const m = JSON.parse(fs.readFileSync(path.join(proj, ".dsh-ledger.json"), "utf8"));
      return m.memoryRoot === undefined || m.memoryRoot === "";
    })(), "");
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}
{
  // ⑤ 反向的另一半：**干净**的目标目录必须照常沿用（否则就是拦过头）
  const t = mkTmp("f05b");
  try {
    const proj = path.join(t, "proj");
    fs.mkdirSync(path.join(proj, "decisions"), { recursive: true });
    fs.mkdirSync(path.join(proj, "_archive"), { recursive: true });
    fs.writeFileSync(path.join(proj, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(path.join(proj, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.writeFileSync(path.join(proj, "decisions", "D1.md"), "## D1 · 决策一\n", "utf8");
    fs.writeFileSync(
      path.join(proj, ".dsh-ledger.json"),
      JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_archive", decisionsDir: "decisions" }),
      "utf8"
    );
    const memAbs = path.join(proj, "proj-ledger-memory");
    fs.mkdirSync(path.join(memAbs, "decisions"), { recursive: true });
    fs.mkdirSync(path.join(memAbs, "_archive"), { recursive: true });
    fs.writeFileSync(path.join(memAbs, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(path.join(memAbs, "DECISIONS.md"), "# 决策\n", "utf8");
    fs.writeFileSync(path.join(memAbs, "decisions", "D1.md"), "## D1 · 决策一\n", "utf8");
    const r = part7Mod.migrateToV3(proj, { apply: true });
    ok("⑤ e 目标目录**干净且一致** ⇒ 照常沿用（ok:true，没拦过头）", r?.ok === true, "ok=" + r?.ok + " reason=" + String(r?.reason ?? "").slice(0, 120));
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

console.log("");
console.log("═══ " + pass + " PASS / " + fail + " FAIL ═══");
console.log("PROBE-COMPLETE pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
