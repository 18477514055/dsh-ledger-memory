/**
 * 探针（V3 阶段 3 · D295）：**迁移器的事务性 —— 中断在任何一步都必须能安全重试**
 *
 * 🔴 这是整个 V3 里**唯一会移动真实记忆文件**的一步，所以判据必须比别处更硬。
 *
 * 方案（任务书 §5.2 要求"不能有两个可被同时写入的权威源"）：
 *   ① 影子目录 `<项目名>-ledger-memory.partial/`
 *   ② 全量复制 + **逐项校验**（文件数 / 字节数 / 每个文件的 sha256）
 *   ③ **原子改名**（`.partial` → 正式名）—— 一次 rename，要么全成要么全不成
 *   ④ **最后一步才改清单**（`memoryRoot`）
 *   ⑤ 旧文件移到 `$DSH_HOME\plugin-data\dsh-ledger-memory\_retired\<项目名>\`（用户指定）
 *
 * ★★★ 关键性质：**切换点只有「改清单」那一次原子写**。
 *   在这之前中断 ⇒ 旧清单仍指旧位置 ⇒ 插件行为**完全没变** ⇒ 重试安全。
 *
 * ★ 本探针要证明的四件事：
 *   A. **干跑**（默认）一个字节都不写 —— 这是"先看再动"的保证
 *   B. 正常路径：复制 → 校验 → 改名 → 改清单 → 全对
 *   C. **中断在改清单之前** ⇒ 清单未变、旧文件仍可用 ⇒ 重跑能接着做完
 *   D. **校验不过就不改名** ⇒ 绝不带着坏副本往前冲
 *
 * 跑法：node tools/_probe-v3-migrate.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = import.meta.dirname;
const LIB = path.join(HERE, "..", "lib");
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

const part7 = await import(new URL("./part7.js", LIB_URL).href);
const migrateToV3 = part7.migrateToV3;

/** 造一个 V2 形态的项目（记忆直接摊在项目根）。 */
function makeV2Project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-v3mig-"));
  fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), "LEDGER.md\ndecisions/\n_ledger-archive/\n", "utf8");
  fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n- 一条状态\n", "utf8");
  fs.writeFileSync(path.join(dir, "JOURNAL.md"), "# 流水\n\n- 2026-10-21 做了什么\n", "utf8");
  fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "decisions", "D1.md"), "## D1\n决策一\n", "utf8");
  fs.writeFileSync(path.join(dir, "decisions", "D2.md"), "## D2\n决策二\n", "utf8");
  fs.mkdirSync(path.join(dir, "_ledger-archive", "2026-10", "week3"), { recursive: true });
  fs.writeFileSync(path.join(dir, "_ledger-archive", "2026-10", "week3", "x.md"), "归档内容\n", "utf8");
  const manifest = {
    version: 1,
    protocolVersion: 2,
    active: "LEDGER.md",
    decisionsDir: "decisions",
    journal: "JOURNAL.md",
    archiveDir: "_ledger-archive",
    revision: 5,
    maxActiveLines: 400,
    autoGitAdd: false,
  };
  fs.writeFileSync(path.join(dir, ".dsh-ledger.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { dir, manifest };
}

/** 递归收集 `rel` 下的所有文件（相对路径 + sha256 + size）。 */
function snapshot(root, rels) {
  const out = [];
  for (const rel of rels) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else out.push({ rel: path.relative(root, p).split(path.sep).join("/"), size: fs.statSync(p).size, hash: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") });
        }
      };
      walk(abs);
    } else {
      out.push({ rel, size: st.size, hash: crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex") });
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

console.log("── ① 干跑必须**一个字节都不写** ──");
{
  const { dir } = makeV2Project();
  const before = fs.readdirSync(dir).sort();
  const r = migrateToV3(dir, { dryRun: true });
  const after = fs.readdirSync(dir).sort();
  ok("① 迁移函数已导出", typeof migrateToV3 === "function", typeof migrateToV3);
  if (typeof migrateToV3 === "function") {
    ok("① ★★ 干跑返回 ok", r?.ok === true, JSON.stringify(r).slice(0, 300));
    ok("① ★★★★ 干跑**没有**新建/删除任何东西（目录快照前后一致）", JSON.stringify(before) === JSON.stringify(after), `${before} → ${after}`);
    ok("① ★★ 干跑给出了计划（要搬哪些、搬到哪）", Array.isArray(r?.plan?.moves) && r.plan.moves.length > 0, JSON.stringify(r?.plan)?.slice(0, 300));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n── ② 正常路径：复制 → 校验 → 改名 → 改清单 ──");
{
  if (typeof migrateToV3 === "function") {
    const { dir } = makeV2Project();
    const r = migrateToV3(dir, { apply: true });
    ok("② 迁移返回 ok", r?.ok === true, JSON.stringify(r).slice(0, 400));

    const memDir = `${path.basename(dir)}-ledger-memory`;
    const memAbs = path.join(dir, memDir);
    ok("② ★★ 记忆目录已建出（正式名，不是 .partial）", fs.existsSync(memAbs) && !fs.existsSync(`${memAbs}.partial`), memAbs);
    ok("② 台账在新位置", fs.existsSync(path.join(memAbs, "LEDGER.md")));
    ok("② 卡片目录也搬了", fs.existsSync(path.join(memAbs, "decisions", "D1.md")) && fs.existsSync(path.join(memAbs, "decisions", "D2.md")));
    ok("② 归档带子目录一起搬了", fs.existsSync(path.join(memAbs, "_ledger-archive", "2026-10", "week3", "x.md")));

    const m = JSON.parse(fs.readFileSync(path.join(dir, ".dsh-ledger.json"), "utf8"));
    ok("② ★★★★ 清单**最后一步**才改，且已写入 memoryRoot", m.memoryRoot === memDir, String(m.memoryRoot));
    ok("② 清单**仍在项目根**（没被搬走）", fs.existsSync(path.join(dir, ".dsh-ledger.json")));

    // ★ 内容必须逐字节相同
    const oldLedger = "# 台账\n\n- 一条状态\n";
    ok("② ★★★ 搬过去的内容逐字节相同", fs.readFileSync(path.join(memAbs, "LEDGER.md"), "utf8") === oldLedger);

    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n── ③ 旧文件：必须搬去 _retired，**不是删掉**（用户拍板）──");
{
  if (typeof migrateToV3 === "function") {
    const { dir } = makeV2Project();
    const r = migrateToV3(dir, { apply: true });
    ok("③ 迁移 ok", r?.ok === true, JSON.stringify(r).slice(0, 300));
    // ★ 项目根上不该再有旧的记忆文件（否则就是两个权威源）
    ok("③ ★★★ 项目根上**不再有**旧的 LEDGER.md", !fs.existsSync(path.join(dir, "LEDGER.md")));
    ok("③ ★★★ 项目根上**不再有**旧的 decisions/", !fs.existsSync(path.join(dir, "decisions")));
    // ★ 但它们**没被删**（搬去了 retired）
    ok("③ ★★★★ 旧文件被搬到 `_retired`（不是删除）", typeof r?.retiredTo === "string" && fs.existsSync(r.retiredTo), String(r?.retiredTo));
    if (typeof r?.retiredTo === "string" && fs.existsSync(r.retiredTo)) {
      ok("③ ★★ retired 里能找回旧台账", fs.existsSync(path.join(r.retiredTo, "LEDGER.md")));
    }
    fs.rmSync(dir, { recursive: true, force: true });
    // ★ 清理 retired 里那份临时项目
    try {
      if (typeof r?.retiredTo === "string") fs.rmSync(path.dirname(r.retiredTo), { recursive: true, force: true });
    } catch {
      /* 清不掉无所谓 */
    }
  }
}

console.log("\n── ④ 中断在「改清单」之前 ⇒ 插件行为完全没变，且能安全重试 ──");
{
  if (typeof migrateToV3 === "function") {
    const { dir } = makeV2Project();
    const beforeManifest = fs.readFileSync(path.join(dir, ".dsh-ledger.json"), "utf8");
    // ★ 模拟：复制+改名做完，但在改清单前崩了
    const r1 = migrateToV3(dir, { apply: true, stopBeforeManifest: true });
    ok("④ 模拟中断返回 ok:false（明确停下，不是假装成功）", r1?.ok === false, JSON.stringify(r1).slice(0, 300));
    const afterManifest = fs.readFileSync(path.join(dir, ".dsh-ledger.json"), "utf8");
    ok("④ ★★★★ 清单**一个字节都没变**（旧清单仍指旧位置）", beforeManifest === afterManifest);
    // ★ 旧文件还在原位 ⇒ 插件照旧能读
    ok("④ ★★★ 旧台账仍在项目根（插件行为完全没变）", fs.existsSync(path.join(dir, "LEDGER.md")));

    // ★ 重试：必须能接着做完
    const r2 = migrateToV3(dir, { apply: true });
    ok("④ ★★★★ 重跑能接着做完（幂等/可续）", r2?.ok === true, JSON.stringify(r2).slice(0, 400));
    const m = JSON.parse(fs.readFileSync(path.join(dir, ".dsh-ledger.json"), "utf8"));
    ok("④ 重跑后清单正确", m.memoryRoot === `${path.basename(dir)}-ledger-memory`, String(m.memoryRoot));
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      if (typeof r2?.retiredTo === "string") fs.rmSync(path.dirname(r2.retiredTo), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log("\n── ⑤ 已经是 V3 的项目：必须说「不用迁」，不许重复搬 ──");
{
  if (typeof migrateToV3 === "function") {
    const { dir } = makeV2Project();
    migrateToV3(dir, { apply: true });
    const m1 = fs.readFileSync(path.join(dir, ".dsh-ledger.json"), "utf8");
    const r = migrateToV3(dir, { apply: true });
    ok("⑤ ★★ 二次迁移明确说「已经迁过了」", r?.ok === false && /已/.test(String(r?.reason ?? "")), JSON.stringify(r).slice(0, 300));
    ok("⑤ ★★★ 清单没有被二次改写", fs.readFileSync(path.join(dir, ".dsh-ledger.json"), "utf8") === m1);
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      if (typeof r?.retiredTo === "string") fs.rmSync(path.dirname(r.retiredTo), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log("\n── ⑥ 迁移绝不产生「清单指向内容不对的目录」这个状态 ──");
{
  if (typeof migrateToV3 === "function") {
    const { dir } = makeV2Project();
    const memDir = `${path.basename(dir)}-ledger-memory`;
    const mp = path.join(dir, ".dsh-ledger.json");

    // 先迁一遍拿到合法 V3，再把清单改回 V2 形态并**留一个内容不对的影子目录**。
    migrateToV3(dir, { apply: true });
    const m = JSON.parse(fs.readFileSync(mp, "utf8"));
    delete m.memoryRoot;
    fs.writeFileSync(mp, JSON.stringify(m, null, 2), "utf8");
    const partialAbs = path.join(dir, `${memDir}.partial`);
    fs.mkdirSync(partialAbs, { recursive: true });
    fs.writeFileSync(path.join(partialAbs, "LEDGER.md"), "# 坏内容，不该被采用\n", "utf8");
    if (!fs.existsSync(path.join(dir, "LEDGER.md"))) {
      fs.writeFileSync(path.join(dir, "LEDGER.md"), "# 台账\n\n- 一条状态\n", "utf8");
    }

    const beforeManifest = fs.readFileSync(mp, "utf8");
    const r = migrateToV3(dir, { apply: true });

    // ★★★★★ 本组真正要钉的判据，**不是"它成功了"**，而是：
    //   **绝不允许出现「清单说在 A，而 A 里的内容是错的」这个状态。**
    //   ★ 两条合法出路，各自断言：
    //     · 成功 ⇒ 内容必须来自项目根那份真的（坏 .partial 被清掉重来）
    //     · 失败 ⇒ 清单一个字节没变（旧结构原样可用）
    if (r?.ok === true) {
      const got = fs.readFileSync(path.join(dir, memDir, "LEDGER.md"), "utf8");
      ok("⑥ 成功时内容来自项目根（不是那份坏的）", got.includes("一条状态") && !got.includes("坏内容"), got.slice(0, 60));
      ok("⑥ 成功时清单指向它", JSON.parse(fs.readFileSync(mp, "utf8")).memoryRoot === memDir);
    } else {
      ok("⑥ ★★★★ 失败时清单**一个字节都没变**", fs.readFileSync(mp, "utf8") === beforeManifest);
      ok("⑥ ★★ 失败时明确说了原因", typeof r?.reason === "string" && r.reason.length > 0, JSON.stringify(r).slice(0, 200));
    }
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      if (typeof r?.retiredTo === "string") fs.rmSync(path.dirname(r.retiredTo), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log("\n── ⑦ 执行位 / 可读性：搬过去的文件必须仍是**普通文件且可读** ──");
{
  if (typeof migrateToV3 === "function") {
    const { dir } = makeV2Project();
    const r = migrateToV3(dir, { apply: true });
    const memAbs = path.join(dir, `${path.basename(dir)}-ledger-memory`);
    ok("⑦ 迁移 ok", r?.ok === true, JSON.stringify(r).slice(0, 200));
    // ★ 不是符号链接、不是零字节
    const f = path.join(memAbs, "decisions", "D1.md");
    const st = fs.lstatSync(f);
    ok("⑦ ★★ 搬过去的是**普通文件**（不是链接）", st.isFile() && !st.isSymbolicLink(), `isFile=${st.isFile()} isLink=${st.isSymbolicLink()}`);
    ok("⑦ ★★ 内容非空且可读", fs.readFileSync(f, "utf8").includes("决策一"));
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      if (typeof r?.retiredTo === "string") fs.rmSync(path.dirname(r.retiredTo), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log("\n── ⑧ ★★★★★ 校验失败这条路：必须真的被走到，且必须拦住 ──");
//
// ★★★ 这一组是**做反向验证时才补出来的**，过程和结论都值得记：
//
//   🔴 我先把"跳过校验"注进去，探针**照样 29 PASS 全绿**。
//     一查：**校验那段代码在正常路径上永远不会失败** —— 正常复制不会坏，
//     而旧 `.partial` 又会被主动清掉，所以我的夹具**造不出坏副本** ⇒ 那段代码从未被执行。
//     ⇒ **摘一处不红 ≠ 断言够硬**，也可能是**那处代码根本没被跑到**（纪律 10 的后半句）。
//
//   ⇒ 修法：给迁移器加一个**显式故障注入点** `injectCorruptCopy`（生产永不传），
//     让"复制完是坏的"这个状态可被造出来。★ 有了它，"跳过校验"那条回归才真的会红。
{
  if (typeof migrateToV3 === "function") {
    const { dir } = makeV2Project();
    const mp = path.join(dir, ".dsh-ledger.json");
    const beforeManifest = fs.readFileSync(mp, "utf8");
    const memDir = `${path.basename(dir)}-ledger-memory`;

    // ★ 注入：让影子目录里那份 LEDGER.md 变成坏内容 ⇒ 校验必须判不等
    const r = migrateToV3(dir, { apply: true, injectCorruptCopy: true });

    ok("⑧ ★★★★ 校验失败 ⇒ 迁移**明确拒绝**（ok:false）", r?.ok === false, JSON.stringify(r).slice(0, 400));
    ok("⑧ ★★★★ 校验失败时**清单一个字节都没变**", fs.readFileSync(mp, "utf8") === beforeManifest, "清单被改了");
    ok("⑧ ★★★ 校验失败时**没有正式名的记忆目录**（没改名）", !fs.existsSync(path.join(dir, memDir)), "竟然建出了正式目录");
    ok("⑧ ★★ 校验失败时**旧文件仍在项目根**（旧结构原样可用）", fs.existsSync(path.join(dir, "LEDGER.md")));
    ok("⑧ ★★ 失败回执里列出了问题（不是只说「失败了」）", Array.isArray(r?.problems) && r.problems.length > 0, JSON.stringify(r?.problems)?.slice(0, 200));

    // ★ 清掉坏影子目录后**重跑必须成功**（可恢复）
    const partialAbs = path.join(dir, `${memDir}.partial`);
    if (fs.existsSync(partialAbs)) fs.rmSync(partialAbs, { recursive: true, force: true });
    const r2 = migrateToV3(dir, { apply: true });
    ok("⑧ ★★★ 排除故障后重跑能成功", r2?.ok === true, JSON.stringify(r2).slice(0, 300));
    ok("⑧ ★★ 重跑后内容是对的", fs.readFileSync(path.join(dir, memDir, "LEDGER.md"), "utf8").includes("一条状态"));

    fs.rmSync(dir, { recursive: true, force: true });
    try {
      if (typeof r2?.retiredTo === "string") fs.rmSync(path.dirname(r2.retiredTo), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
