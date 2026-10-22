import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MANIFEST_REL, STASH_DIR } from "./defs.js";
import { ensureDir, readManifest, stamp, stampSec, writeFileAtomic } from "./part2.js";

/**
 * ★★★★★ 2026-10-21（D295 · V3 阶段 3）：**事务化迁移 V2 → V3。**
 *
 * 🔴 为什么必须事务化（任务书 §5.2 禁止「两个可被同时写入的权威源」）：
 *
 *   最直观的做法是「边搬边改」—— 把 `LEDGER.md` 搬到子目录，改一行清单，再搬下一个。
 *   **那样会在中途出现一个状态：一部分记忆在根、一部分在子目录，而清单只说得清一半。**
 *   那一刻如果中断（或有人写入），就**同时存在两个权威源** —— 之后没人能说清哪个是真的。
 *
 * ⇒ 本实现的核心性质：**切换点只有「改清单」那一次原子写。**
 *   在这之前，**旧清单仍指旧位置** ⇒ 插件行为**完全没变** ⇒ 中断在任何一步都能安全重试。
 *
 * 五个阶段（每个阶段都可重入）：
 *   ① 影子目录 `<项目名>-ledger-memory.partial/`
 *   ② 全量复制 + **逐项校验**（文件数 / 每个文件的 sha256）
 *   ③ **原子改名**（`.partial` → 正式名）—— 一次 `rename`，要么全成要么全不成
 *   ④ **最后一步才改清单**（`memoryRoot`）
 *   ⑤ 旧文件搬到 `$DSH_HOME\plugin-data\dsh-ledger-memory\_retired\<项目名>\`（**不是删除**）
 *
 * ★★★ 三个刻意的设计选择：
 *
 *   · **干跑是默认**（不传 `apply` 就只出计划）。这是"先看再动"的保证 ——
 *     迁移是唯一会移动真实记忆的操作，不该有一个"手一滑就执行"的默认。
 *   · **校验不过就不改名**。带着坏副本往前冲，比不迁更糟。
 *   · **旧文件搬到 `_retired`，不删**。用户拍板：挪到插件数据目录下按项目名归档。
 *     理由：迁移本身可能出错，**删了就不可逆**；而留着只占磁盘。
 *
 * @param {string} projectRoot 项目根
 * @param {{apply?:boolean, stopBeforeManifest?:boolean, dryRun?:boolean}} [opts]
 */
export function migrateToV3(projectRoot, opts) {
  const apply = opts?.apply === true;
  const manifestPath = path.join(projectRoot, MANIFEST_REL);
  const manifest = readManifest(projectRoot) ?? {};

  // ★ 已经是 V3 ⇒ 明确说「不用迁」。**不许重复搬**（那会造出第二个权威源）。
  if (typeof manifest.memoryRoot === "string" && manifest.memoryRoot !== "") {
    return {
      ok: false,
      reason: `这个项目**已经是 V3 形态**（清单里 memoryRoot = ${manifest.memoryRoot}），无需迁移。`,
      alreadyV3: true,
    };
  }
  if (Object.keys(manifest).length === 0) {
    return { ok: false, reason: "没有清单（.dsh-ledger.json）—— 这个项目还没建台账，先 ledger_init。" };
  }

  const baseName = path.basename(projectRoot);
  const memDirName = `${baseName}-ledger-memory`;
  const memAbs = path.join(projectRoot, memDirName);
  const partialAbs = `${memAbs}.partial`;

  // ★ 要搬的东西：**清单里登记过的 + 记忆目录本身**。
  //   判据：清单说「这一类记忆在哪」就说搬哪 —— 不猜、不扩大范围。
  const rels = [];
  const pushRel = (v) => {
    if (typeof v === "string" && v !== "" && !rels.includes(v)) rels.push(v);
  };
  pushRel(manifest.active);
  pushRel(manifest.decisions);
  pushRel(manifest.decisionsDir);
  pushRel(manifest.journal);
  pushRel(manifest.goals);
  pushRel(manifest.goalsDir);
  pushRel(manifest.lessons);
  pushRel(manifest.lessonsDir);
  pushRel(manifest.principles);
  pushRel(manifest.archiveDir);
  pushRel(manifest.logDir);
  pushRel(STASH_DIR); // 分流细节
  pushRel(manifest.handoffDir ?? "_handoff");

  const existing = rels.filter((r) => fs.existsSync(path.join(projectRoot, r)));
  if (existing.length === 0) {
    return { ok: false, reason: "清单里登记的路径一个都不存在 —— 没有东西可迁（先确认台账结构）。" };
  }

  // ★ 边界：只搬**项目内**的相对路径。绝对路径 / 越界一律拒绝（清单是用户可编辑的）。
  for (const r of existing) {
    if (path.isAbsolute(r) || r.split(/[\\/]/).some((s) => s === "..")) {
      return { ok: false, reason: `清单里的路径 \`${r}\` 不是项目内的相对路径 —— 拒绝迁移（先修清单）。` };
    }
  }

  // ── ① 计划 ────────────────────────────────────────────────────────────────
  const plan = {
    target: memDirName,
    moves: existing.map((r) => ({ from: r, to: `${memDirName}/${r}` })),
  };

  if (!apply) {
    return { ok: true, dryRun: true, plan, note: "干跑：只出计划，**一个字节都没写**。确认后传 apply: true。" };
  }

  // ── ② 复制到影子目录 + 逐项校验 ───────────────────────────────────────────
  //
  // ★ 为什么用 `.partial` 而不是直接写正式名：
  //   复制过程中若中断，正式名目录会**半满**，而之后没人能分清"半满"与"本来就少"。
  //   `.partial` 这个名字本身就是"我还没做完"的标记。
  const hashOf = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

  /** 递归列出 rel 下所有文件（相对 root）。 */
  const listFiles = (root, rel) => {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return [rel];
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out.push(path.relative(root, p).split(path.sep).join("/"));
      }
    };
    walk(abs);
    return out;
  };

  /** 把 root 下的 rel 复制到 destRoot 下的同一 rel。 */
  const copyInto = (destRoot, rel) => {
    const from = path.join(projectRoot, rel);
    const to = path.join(destRoot, rel);
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      ensureDir(to);
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        copyInto(destRoot, `${rel}/${e.name}`);
      }
    } else {
      ensureDir(path.dirname(to));
      fs.copyFileSync(from, to);
    }
  };

  // ★ 重入：若上次留下 `.partial`，先清掉重来（它是"没做完"的产物，不是真数据）
  if (fs.existsSync(partialAbs)) {
    fs.rmSync(partialAbs, { recursive: true, force: true });
  }
  ensureDir(partialAbs);

  const expected = [];
  for (const rel of existing) {
    for (const f of listFiles(projectRoot, rel)) {
      expected.push({ rel: f, size: fs.statSync(path.join(projectRoot, f)).size, hash: hashOf(path.join(projectRoot, f)) });
    }
    copyInto(partialAbs, rel);
  }

  // ★★★ 2026-10-21（D295 · **仅供探针使用的故障注入点**）：
  //   为什么生产代码里要留一个"能故意造坏"的入口？
  //
  //   🔴 因为**校验那段代码在正常路径上永远不会失败**。我第一次做反向验证时，
  //     注入"跳过校验"的回归 ⇒ 探针**照样全绿** —— 那段代码**根本没被执行过**。
  //     （正常复制不会坏，而旧 `.partial` 又会被主动清掉，所以造不出坏副本。）
  //   ⇒ 纪律 10 的直接应用：**看不见红的断言不是断言**。
  //     要让"校验不过就不改名"这条**可被验证**，就必须有一个**能让复制真的坏掉**的入口。
  //
  //   ★ 它**只在显式传 `injectCorruptCopy` 时动作**，生产永远不传 ⇒ 零风险。
  //   ★ 名字里带 `inject` 是刻意的：任何人看到都知道这是测试钩子，不是功能。
  if (opts?.injectCorruptCopy === true) {
    const victim = expected[0];
    if (victim !== undefined) {
      fs.writeFileSync(path.join(partialAbs, victim.rel), "★ 被故意写坏的内容（探针注入）\n", "utf8");
    }
  }

  // ★★★ 校验：**逐文件比 sha256**，不是只比数量。
  //   比数量只能发现"少复制了"，发现不了"内容坏了"。
  const problems = [];
  for (const e of expected) {
    const p = path.join(partialAbs, e.rel);
    if (!fs.existsSync(p)) {
      problems.push(`缺文件：${e.rel}`);
      continue;
    }
    const st = fs.statSync(p);
    if (st.size !== e.size) {
      problems.push(`大小不符：${e.rel}（${e.size} → ${st.size}）`);
      continue;
    }
    if (hashOf(p) !== e.hash) problems.push(`内容不符：${e.rel}`);
  }
  if (problems.length > 0) {
    // ★ 校验不过 ⇒ **不改名、不改清单**，把影子目录留着便于排查。
    return {
      ok: false,
      reason: `复制校验未通过（${problems.length} 项）⇒ **没有改名、没有改清单**，旧结构原样可用。`,
      problems: problems.slice(0, 20),
      partialPath: partialAbs,
    };
  }

  // ── ③ 原子改名 ────────────────────────────────────────────────────────────
  //
  // ★ `rename` 在同一卷上是原子的：要么整个目录出现在正式名下，要么完全没有。
  //   若目标已存在（上次改名成功但后续中断），**直接沿用** —— 那也是合法状态。
  if (!fs.existsSync(memAbs)) {
    fs.renameSync(partialAbs, memAbs);
  } else {
    // 正式名已存在（上次做完了改名）⇒ 影子目录是多余的，清掉
    fs.rmSync(partialAbs, { recursive: true, force: true });
  }

  // ★★ 探针用的"在改清单之前停下"—— 模拟中断，验证旧清单仍可用。
  if (opts?.stopBeforeManifest === true) {
    return {
      ok: false,
      stoppedBeforeManifest: true,
      reason:
        "已在**改清单之前**停下（这是刻意模拟的中断）。★ 清单没变 ⇒ 插件仍按旧位置工作 ⇒ 重跑可接着做完。",
      targetDir: memAbs,
    };
  }

  // ── ④ 最后一步：改清单（唯一的切换点）────────────────────────────────────
  const next = { ...manifest, memoryRoot: memDirName, updatedAt: stamp(new Date()) };
  const w = writeFileAtomic(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
  if (w?.ok === false) {
    return { ok: false, reason: `改清单失败：${w.reason || "未知"}`, targetDir: memAbs };
  }

  // ── ⑤ 旧文件搬到 _retired（**不是删除**）──────────────────────────────────
  //
  // ★ 用户拍板：旧文件挪到 `$DSH_HOME\plugin-data\dsh-ledger-memory\_retired\<项目名>\`。
  //   ★ 为什么不删：迁移本身可能出错，**删了就不可逆**；留着只占磁盘。
  //   ★ 为什么不留在项目里：那会与记忆目录形成**两个权威源**（任务书 §5.2 明令禁止）。
  let retiredTo;
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
    const retiredRoot = path.join(home, "plugin-data", "dsh-ledger-memory", "_retired", baseName);
    retiredTo = path.join(retiredRoot, stampSec(new Date()).replace(/[: ]/g, "-"));
    ensureDir(retiredTo);
    for (const rel of existing) {
      const from = path.join(projectRoot, rel);
      if (!fs.existsSync(from)) continue;
      const to = path.join(retiredTo, rel);
      ensureDir(path.dirname(to));
      fs.renameSync(from, to);
    }
  } catch (e) {
    // ★ 搬旧文件失败**不影响迁移本身**（清单已经指向新位置）—— 但要如实报出来。
    return {
      ok: true,
      targetDir: memDirName,
      manifestUpdated: true,
      retireFailed: String((e && e.message) || e),
      note: "迁移已生效（清单已指向新位置），但**旧文件的归档搬运失败** —— 请手动处理，别让两份共存。",
    };
  }

  return {
    ok: true,
    targetDir: memDirName,
    manifestUpdated: true,
    retiredTo,
    fileCount: expected.length,
    note:
      "迁移完成。★ 旧文件已搬到 `_retired`（**没删**），项目根上不再有记忆文件 ⇒ 只有一个权威源。",
  };
}
