/**
 * D374 取证器 —— 逐条验证 Gemini4 静态审查 022 的 6 项发现。
 *
 * ★ 极性约定：**PASS = 行为正确**（缺陷已修 / 不存在）；**FAIL = 缺陷仍在**。
 *   ⇒ 未修基线上应大面积 FAIL；打上补丁后应为 FAIL 0。这就是"反向见红"的正向读法。
 *
 * ★ 铁律（本项目纪律）：
 *   ① **不改代码**，只读被测行为。
 *   ② 每条结论必须有**可复现的输入**，不接受"读代码看起来会这样"。
 *   ③ **不可达 / 报告说错 ⇒ 记 KNOWN**，绝不写 PASS 冒充"修好了"。
 *   ④ 必须打印跑完哨兵 `PROBE-COMPLETE`（D324：崩溃会冒充检出）。
 *   ⑤ 断言**不许带 `|| 空也算过`** 这种恒真分支（F-01 f 第一版就是这么废掉的）。
 *
 * 用法：node tools/_probe-d374-verify.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// ★ 必须用 fileURLToPath：本项目路径含中文，URL.pathname 会留下 %XX 百分号编码（本轮实测栽过一次）
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
let fail = 0;
let known = 0;
const rows = [];

function ok(title, cond, detail) {
  if (cond) {
    pass += 1;
    rows.push(`  PASS  ${title}`);
  } else {
    fail += 1;
    rows.push(`  FAIL  ${title}${detail !== undefined ? `  ⟵ ${detail}` : ""}`);
  }
}

function knownRow(title, detail) {
  known += 1;
  rows.push(`  KNOWN ${title}${detail !== undefined ? `  ⟵ ${detail}` : ""}`);
}

const fp = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "fingerprint.js")).href);
const bk = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "backup.js")).href);

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `d374-${tag}-`));
}

// ═══════════════════════════════════════════════════════════════════════════
// F-01：_backup/ 必须从 scanBlind / scanFingerprints / locateProjectRoots / stampDir 排除
//       + identityOfPath 对子目录保留名 / 隐藏文件 / _backup 返回 undefined
// ═══════════════════════════════════════════════════════════════════════════
{
  const t = tmpDir("f01");
  try {
    const pid = fp.newProjectId();
    fs.writeFileSync(
      path.join(t, ".dsh-ledger.json"),
      JSON.stringify({ projectId: pid, active: "LEDGER.md", decisionsDir: "decisions" }, null, 2) + "\n",
      "utf8",
    );
    // 模拟"一个已经被盖过指纹的 LEDGER.md"（writeFileAtomic 只在 opts.fp 给了才加）
    const stamped = fp.applyFingerprint3("# Active Ledger\n\n- Task A\n", { kind: "active", project: pid, key: "-" });
    fs.writeFileSync(path.join(t, "LEDGER.md"), stamped.text, "utf8");

    // 走真实备份路径：逐字节复制当前磁盘内容到 _backup/LEDGER.md.bak
    const bkRes = bk.backupBeforeWrite({ memBase: t, rel: "LEDGER.md", prevText: stamped.text });
    const bakPath = path.join(t, "_backup", "LEDGER.md.bak");
    const bakText = fs.existsSync(bakPath) ? fs.readFileSync(bakPath, "utf8") : "";
    ok(
      "F-01 前置：备份真的生成且**逐字节带着**三载体指纹（前提不成立的话后面全是假绿）",
      bkRes.ok === true && bakText === stamped.text && bakText.includes("dsh-fp-front:"),
      JSON.stringify({ bkRes, bakLen: bakText.length, hasFront: bakText.includes("dsh-fp-front:") }),
    );

    // ① scanBlind 必须只认活体那一个
    const sb = fp.scanBlind(t);
    const sbActive = sb.byKind.get("active") ?? [];
    ok(
      "F-01 a：scanBlind 排除 _backup/ ⇒ 只认出 1 个 kind=active 且是活体 LEDGER.md",
      sbActive.length === 1 && sbActive[0].rel === "LEDGER.md",
      JSON.stringify(sbActive.map((x) => x.rel)),
    );

    // ② scanFingerprints：报告把它列为缺陷，但它先按 .md 过滤，.bak 天然进不来
    const sfp = fp.scanFingerprints(t);
    const sfpActive = sfp.byKind.get("active") ?? [];
    knownRow(
      "F-01 b（报告误判）：scanFingerprints 本来就排除 .bak（`if (!e.name.endsWith(\".md\")) continue`）⇒ 这一处不是缺陷",
      `scanned=${sfp.scanned} active=${JSON.stringify(sfpActive.map((x) => x.rel))}`,
    );

    // ③ 改名后仍能唯一解析
    const renamed = path.join(t, "我的台账.md");
    fs.renameSync(path.join(t, "LEDGER.md"), renamed);
    const resolved = fp.resolveByIdentity(t, { name: "LEDGER.md", kind: "active", project: pid });
    ok(
      "F-01 c：存在 _backup/LEDGER.md.bak 时，改名后仍能**唯一**解析回 `我的台账.md`",
      resolved.ok === true && resolved.rel === "我的台账.md",
      JSON.stringify(resolved),
    );

    const reb = fp.rebuildFromFingerprints(t);
    ok(
      "F-01 d：rebuildFromFingerprints 不因 _backup 副本报身份歧义（active 恰好 1 个）",
      (reb.byKind.get("active") ?? []).length === 1 && !reb.warnings.some((w) => w.includes("歧义")),
      JSON.stringify({ n: (reb.byKind.get("active") ?? []).length, warnings: reb.warnings }),
    );

    // ④ 删掉活体后，绝不能把备份当活体返回
    fs.unlinkSync(renamed);
    const afterDel = fp.resolveByIdentity(t, { name: "LEDGER.md", kind: "active", project: pid });
    ok(
      "F-01 e：活体删除后如实报缺失，**绝不**误绑到 _backup/LEDGER.md.bak（幽灵复活）",
      afterDel.ok === false,
      JSON.stringify(afterDel),
    );

    // ⑤ locateProjectRoots：roots 里绝不许出现 _backup
    //   ★★★ 夹具必须是 **`_backup/` 里一个 `.md`**，不能是 `.bak`：
    //     该函数 L938 有 `if (!e.isFile() || !e.name.endsWith(".md")) continue;`
    //     ⇒ `.bak` 天然进不去，用 `.bak` 测就是**空守**（我第一版正是如此，反向验证 B4 仍绿才发现）。
    //     `_backup/` 里出现 `.md` 是真实形状：`stampDir` 会盖 `.md`、用户也可能手放副本。
    fs.writeFileSync(
      path.join(t, "_backup", "COPY.md"),
      fp.applyFingerprint3("# copy\n", { kind: "active", project: pid, key: "-" }).text,
      "utf8",
    );
    const lpr = fp.locateProjectRoots(t, pid, { upLevels: 0 });
    const roots = Array.isArray(lpr.roots) ? lpr.roots : [];
    ok(
      "F-01 f：locateProjectRoots 不把 _backup 当项目根信号（含 _backup/COPY.md 这种 .md 形状）",
      roots.length === 0,
      JSON.stringify({ roots, scanned: lpr.scanned }),
    );

    // ⑥ stampDir：绝不给备份目录里的文件盖章（盖章 = 把备份改坏）
    fs.writeFileSync(path.join(t, "_backup", "untouched.md"), "# Untouched\n", "utf8");
    const sd = fp.stampDir(t, (rel) => ({ kind: "custom", key: rel, project: pid }));
    ok(
      "F-01 g：stampDir 不给 _backup/ 里的文件盖章（备份必须逐字节不变）",
      !sd.updated.some((p) => String(p).includes("_backup")),
      JSON.stringify({ updated: sd.updated, skipped: sd.skipped }),
    );
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ── F-01 第二部分：identityOfPath 对保留名 / 隐藏文件 / _backup ─────────────
{
  const t = tmpDir("f01b");
  try {
    const pid = fp.newProjectId();
    fs.writeFileSync(
      path.join(t, ".dsh-ledger.json"),
      JSON.stringify(
        {
          projectId: pid,
          active: "LEDGER.md",
          decisionsDir: "decisions",
          handoffDir: "_handoff",
          archiveDir: "_ledger-archive",
          logDir: "_ledger-log",
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    fs.writeFileSync(path.join(t, "LEDGER.md"), "# 台账\n", "utf8");

    const info = {
      memoryBase: t,
      projectRoot: t,
      activeRel: "LEDGER.md",
      decisionsDir: "decisions",
      handoffDir: "_handoff",
      archiveDir: "_ledger-archive",
      logDir: "_ledger-log",
      stashDir: "_stash",
      extensionsDir: "extensions",
    };

    const cases = [
      ["_handoff/README.md", "说明文件（保留名）"],
      ["_ledger-archive/INDEX.md", "索引（保留名）"],
      ["extensions/.hidden.md", "隐藏文件"],
      ["_stash/SECURITY.md", "保留名"],
      ["_backup/LEDGER.md", "_backup 里的文件"],
    ];
    for (const [rel, why] of cases) {
      const got = fp.identityOfPath(info, path.join(t, rel));
      ok(
        `F-01 h：identityOfPath("${rel}") —— ${why}**不该**拿到指纹身份`,
        got === undefined,
        got === undefined ? undefined : `拿到 ${JSON.stringify(got)}`,
      );
    }

    // ★ 反向：活体单例必须**照常**拿到身份（放宽没放过头）
    const live = fp.identityOfPath(info, path.join(t, "LEDGER.md"));
    ok(
      "F-01 h-反向：活体 LEDGER.md 仍能拿到 {kind:active}（保留名拦截没有放过头）",
      live !== undefined && live.kind === "active",
      JSON.stringify(live),
    );

    // ★★★ 关键区分（B2 反向验证发现的）：
    //   补丁在 `identityOfPath` 里加了**两处**内容相同的拦截 —— 开头一处（补丁新增）
    //   与兜底分支前一处（D366 本来就有）。因此**只撤开头那处，行为不变**（另一处兜住）。
    //   ⇒ 撤开头那处不红**不代表它是空守**，而是"修复重复"。
    //   ★ 要证明开头那处**确实有独立作用**，得找一个"会走到步骤②/③提前返回"的形状：
    //     `decisions/README.md` —— 步骤② 会把 `decisions/<baseName>.md` 认成卡片，
    //     而 README 必须在步骤②**之前**被拦掉，否则它就成了 key="README" 的决策卡。
    //     ★ 注意：这里只撤开头那处时，兜底那处**管不到**（因为步骤②已经提前 return 了）⇒ 能见红。
    const cardInfo = { ...info, decisionsDir: "decisions" };
    const readmeInCards = fp.identityOfPath(cardInfo, path.join(t, "decisions", "README.md"));
    ok(
      "F-01 i：identityOfPath(\"decisions/README.md\") 被拦在**卡片分支之前**（否则会变成 key=README 的决策卡）",
      readmeInCards === undefined,
      JSON.stringify(readmeInCards),
    );
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-02：detectTrackedMemory / installPreCommitHook 必须覆盖 _backup
// ═══════════════════════════════════════════════════════════════════════════
{
  const part2 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part2.js")).href);
  const t = tmpDir("f02");
  try {
    fs.mkdirSync(path.join(t, "_backup"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: t });
    execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: t });
    execFileSync("git", ["config", "user.name", "T"], { cwd: t });
    fs.writeFileSync(path.join(t, "_backup", "LEDGER.md.bak"), "secret backup\n", "utf8");
    execFileSync("git", ["add", "-f", "_backup/LEDGER.md.bak"], { cwd: t });

    const dtm = part2.detectTrackedMemory(t);
    ok(
      "F-02 a：detectTrackedMemory 检出被 git add -f 的 _backup/LEDGER.md.bak",
      dtm.ok === true && (dtm.tracked ?? []).some((x) => String(x).includes("_backup")),
      JSON.stringify(dtm).slice(0, 240),
    );

    const hk = part2.installPreCommitHook(t, { enabled: true });
    let blocked = false;
    try {
      execFileSync("git", ["commit", "-m", "x"], { cwd: t, stdio: "pipe" });
    } catch {
      blocked = true;
    }
    ok(
      "F-02 b：pre-commit 钩子拦截暂存区里的 _backup/LEDGER.md.bak",
      hk.installed === true && blocked === true,
      JSON.stringify({ installed: hk.installed, blocked }),
    );
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-03：repairConformance 在已拆卡项目上**不得**重建空 DECISIONS.md
// ═══════════════════════════════════════════════════════════════════════════
{
  const part4 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part4.js")).href);
  const t = tmpDir("f03");
  try {
    fs.mkdirSync(path.join(t, "decisions"), { recursive: true });
    fs.writeFileSync(
      path.join(t, ".dsh-ledger.json"),
      JSON.stringify(
        {
          projectId: fp.newProjectId(),
          active: "LEDGER.md",
          decisions: "DECISIONS.md",
          decisionsDir: "decisions",
          revision: 1,
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    fs.writeFileSync(path.join(t, "LEDGER.md"), "# 台账\n", "utf8");
    fs.writeFileSync(path.join(t, "decisions", "D1.md"), "# D1 — 卡片化决策\n- **状态**：长期有效\n", "utf8");
    const existedBefore = fs.existsSync(path.join(t, "DECISIONS.md"));
    const rep = part4.repairConformance(t, { apply: true });
    const createdAfter = fs.existsSync(path.join(t, "DECISIONS.md"));
    ok(
      "F-03：repairConformance({apply:true}) 在 decisions 已拆卡时**不**重建空 DECISIONS.md",
      existedBefore === false && createdAfter === false,
      JSON.stringify({ existedBefore, createdAfter, actions: rep.actions }),
    );

    // ★ 反向：没有卡片的初始空目录场景**仍应**建单文件（兼容 21b 升级路径，别修过头）
    const t2 = tmpDir("f03b");
    try {
      fs.mkdirSync(path.join(t2, "decisions"), { recursive: true });
      fs.writeFileSync(
        path.join(t2, ".dsh-ledger.json"),
        JSON.stringify(
          { projectId: fp.newProjectId(), active: "LEDGER.md", decisions: "DECISIONS.md", decisionsDir: "decisions", revision: 1 },
          null,
          2,
        ) + "\n",
        "utf8",
      );
      fs.writeFileSync(path.join(t2, "LEDGER.md"), "# 台账\n", "utf8");
      const rep2 = part4.repairConformance(t2, { apply: true });
      ok(
        "F-03 反向：decisions/ 为空目录（还没有卡）时**仍会**建单文件 DECISIONS.md（没修过头）",
        fs.existsSync(path.join(t2, "DECISIONS.md")),
        JSON.stringify(rep2.actions),
      );
    } finally {
      fs.rmSync(t2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-04：renderExtensionInjection / readExtension 必须剥离三载体指纹
// ═══════════════════════════════════════════════════════════════════════════
{
  const part2 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part2.js")).href);
  const part8 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part8.js")).href);
  const t = tmpDir("f04");
  try {
    const pid = fp.newProjectId();
    fs.writeFileSync(
      path.join(t, ".dsh-ledger.json"),
      JSON.stringify({ projectId: pid, active: "LEDGER.md" }, null, 2) + "\n",
      "utf8",
    );
    fs.writeFileSync(path.join(t, "LEDGER.md"), "# 台账\n", "utf8");
    const info = part2.inspect(t);

    const cr = part8.createExtension(info, t, {
      name: "api-map",
      description: "接口速查",
      mode: "plain",
      inject: true,
    });
    part8.writeExtension(info, t, cr.created.id, { content: "# 接口速查表\n\n- GET /v1/health -> 200 OK\n" });
    const rendered = part8.renderExtensionInjection(info, t);
    const rdSingle = part8.readExtension(info, t, cr.created.id, {});

    const hasLeak = (s) =>
      String(s).includes("dsh-fp-front") || String(s).includes("<!--dsh-id:") || String(s).includes("[dsh-fp-link]");
    ok(
      "F-04 a：renderExtensionInjection 注入内容已剥离三载体指纹（不泄露信标、不挤占 maxChars）",
      rendered.includes("GET /v1/health") && !hasLeak(rendered),
      rendered.slice(0, 220),
    );
    ok(
      "F-04 b：readExtension（单文件）返回干净正文",
      rdSingle.ok === true && !hasLeak(rdSingle.text) && String(rdSingle.text).includes("GET /v1/health"),
      JSON.stringify(rdSingle.text ?? "").slice(0, 220),
    );

    const crCard = part8.createExtension(info, t, { name: "boss-cards", description: "Boss 卡", mode: "decisions" });
    part8.writeExtension(info, t, crCard.created.id, { key: "B1", content: "# Boss 1\n- HP 1000\n" });
    const rdCard = part8.readExtension(info, t, crCard.created.id, { key: "B1" });
    ok(
      "F-04 c：readExtension（卡片型）返回干净正文",
      rdCard.ok === true && !hasLeak(rdCard.text) && String(rdCard.text).includes("Boss 1"),
      JSON.stringify(rdCard.text ?? "").slice(0, 220),
    );

    // ★ 反向：磁盘上那份**必须仍带指纹**（剥离只发生在读出口，不许把存储也洗了）
    //   ★ 落点实测是 `extensions/<id>/content.md`（不是 `extensions/<id>.md`）——
    //     我第一版按 `<id>.md` 找，找不到就 FAIL，那是**夹具找错路径**，不是被测对象的问题。
    let rawStored = "";
    const walkExt = (d) => {
      let ents;
      try {
        ents = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walkExt(p);
        else if (e.name === "content.md" || e.name === "api-map.md") rawStored = fs.readFileSync(p, "utf8");
      }
    };
    walkExt(path.join(t, "extensions"));
    ok(
      "F-04 反向：磁盘上的扩展文件**仍然带**指纹（剥离只在读出口，没把存储洗掉）",
      rawStored !== "" && rawStored.includes("dsh-fp-front:"),
      JSON.stringify(rawStored.slice(0, 160)),
    );
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-05：migrateToV3 必须把 _backup 一并迁入 V3 记忆目录
// ═══════════════════════════════════════════════════════════════════════════
{
  const part7 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part7.js")).href);
  const t = tmpDir("f05");
  try {
    const proj = path.join(t, "my-app");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".dsh-ledger.json"),
      JSON.stringify({ projectId: fp.newProjectId(), active: "LEDGER.md", protocolVersion: 2 }, null, 2) + "\n",
      "utf8",
    );
    fs.writeFileSync(path.join(proj, "LEDGER.md"), "# V2 台账\n", "utf8");
    bk.backupBeforeWrite({ memBase: proj, rel: "LEDGER.md", prevText: "# V2 台账（上一版）\n" });
    const hadBackup = fs.existsSync(path.join(proj, "_backup", "LEDGER.md.bak"));

    const mig = part7.migrateToV3(proj, { apply: true });
    const memDir = mig.ok === true ? path.join(proj, mig.targetDir) : undefined;
    const bkInV3 = memDir !== undefined ? bk.readBackup(memDir, "LEDGER.md") : { exists: false };
    const oldStillThere = fs.existsSync(path.join(proj, "_backup"));
    ok(
      "F-05：migrateToV3 把 _backup 一并迁入 V3 记忆目录、内容逐字保住、源码根不残留",
      hadBackup === true &&
        mig.ok === true &&
        bkInV3.exists === true &&
        bkInV3.text === "# V2 台账（上一版）\n" &&
        oldStillThere === false,
      JSON.stringify({ hadBackup, migOk: mig.ok, targetDir: mig.targetDir, bkExists: bkInV3.exists, oldStillThere }),
    );
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// F-06：renderRecentWork 必须有 isUnderReal 边界 + 同毫秒确定性决胜
// ═══════════════════════════════════════════════════════════════════════════
{
  const part2 = await import(pathToFileURL(path.join(PROJECT_ROOT, "lib", "part2.js")).href);
  const t = tmpDir("f06");
  try {
    const proj = path.join(t, "proj");
    const outsideLog = path.join(t, "outside-log", "2026-W15");
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(outsideLog, { recursive: true });
    fs.writeFileSync(
      path.join(outsideLog, "L1-turns.md"),
      "- 2026-04-10 10:00:00 (L1) outside secret ｜ 做了什么：leaked ｜ 下一步：none\n",
      "utf8",
    );
    const leaked = part2.renderRecentWork({ projectRoot: proj, logRel: "../outside-log" });
    ok(
      "F-06 a：renderRecentWork 拒绝越出 memoryBase 的 logDir（返回空串，读不到 outside secret）",
      typeof leaked === "string" && leaked === "",
      JSON.stringify(String(leaked).slice(0, 160)),
    );

    const inLog = path.join(proj, "_ledger-log", "2026-W15");
    fs.mkdirSync(inLog, { recursive: true });
    const fixed = new Date("2026-04-10T10:05:00.000Z");
    const names = ["L1-turns.md", "L1-turns-002.md", "L1-turns-003.md", "L1-turns-004.md", "L1-turns-005.md"];
    for (let i = 0; i < names.length; i++) {
      const p = path.join(inLog, names[i]);
      fs.writeFileSync(
        p,
        `- 2026-04-10 10:0${i}:00 (L1) shard-${i + 1} ｜ 做了什么：work ${i + 1} ｜ 下一步：step ${i + 1}\n`,
        "utf8",
      );
      fs.utimesSync(p, fixed, fixed);
    }
    const out = part2.renderRecentWork({ projectRoot: proj, logRel: "_ledger-log" });
    ok(
      "F-06 b：同 mtimeMs 时 renderRecentWork 稳定选中最高分片号（shard-5）",
      typeof out === "string" && out.includes("shard-5") && !out.includes("shard-1"),
      JSON.stringify(String(out).slice(0, 200)),
    );
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log(rows.join("\n"));
console.log("═".repeat(64));
console.log(`  合计：PASS ${pass} · FAIL ${fail} · KNOWN ${known}`);
console.log("PROBE-COMPLETE");
