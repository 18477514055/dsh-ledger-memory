/**
 * ★★★★★ 2026-10-23（D307 第二刀）：**卡片操作区 —— 从 `part4.js` 拆出来。**
 *
 * 🔴 为什么拆：`part4.js` 260,525 B ⇒ 距 DSH STORE 单文件硬上限（262,144 B）**只剩 1,619 B**。
 *   第一刀把 `part2.js` 救出来了，这一刀轮到 part4。
 *
 * ★ 为什么是这一段（实测）：
 *   · 块内**零 import**（自足）· 只引用 **1 个** defs 常量（`MANIFEST_REL`）；
 *   · 其余依赖全是 `base.js` 的纯函数；
 *   · 块内互相调用（`cardDirAbs`/`cardFileAbs`/`listCards`/`readCard`/`isSafeCardKey`…）**都在块内** ⇒ 搬走不断链。
 *   ⇒ 本文件 import 只有 `node:fs`/`node:path`/`./base.js`/`./defs.js`，**不 import 任何 partN** ⇒ 不成环。
 *
 * ★ 语义没变：`part4.js` 里留 re-export，所有 `import … from "./part4.js"` 的调用方一个都不改。
 *
 * ★★ 本文正文是**逐字切出来的**，不是重打（注释/空行/标点与原文完全一致）；
 *    迁移脚本自带"前后段都逐字还在 + block 逐字进了新文件"的字节级校验。
 */
import fs from "node:fs";
import path from "node:path";

import { MANIFEST_REL } from "./defs.js";
import {
  ensureDir,
  isUnder,
  isUnderReal,
  lossless,
  memoryBaseOf,
  readTextSafe,
  stamp,
  toGitRel,
  writeFileAtomic,
} from "./base.js";
// ★★ 2026-10-23（D307 收尾 · 第五次同型）：`fnv1a` / `weightBlocks` 与 `readManifest` 也缺。
//   🔴 我上一版只补了 `memoryBaseOf` 就收工 —— 因为我是**逐个看 ReferenceError** 在修，
//     而它们在**别的函数里**（`renderCardIndex` 与 `readKindRaw`），一跑别的用例才炸。
//   ★ 正解 = 用 `tools/_probe-unbound-after-split.mjs`（剥注释 + 剥字面量后做精确绑定检查）
//     **一次性列全**，别再一次一个。判据：**同类问题必须一次查完，逐个试错是最贵的修法。**
//   ★ 注意它报的 `name` / `apply` 是假阳性：`e.name` 是属性访问、`const apply =` 是局部变量 ——
//     判据要能区分"属性名"与"自由标识符"，所以那两个**不补**。
import { fnv1a, weightBlocks } from "./part1.js";
import { readManifest } from "./part2.js";
// ★★★★★ 2026-10-23（D310）：清单写入的唯一出口（原子写 + 同步镜像）。叶子模块，不成环。
import { writeManifestSynced } from "./manifest-mirror.js";

/** 卡片键的**白名单**（唯一的合法性出口 —— 所有读写都必须过它）。 */

export function isSafeCardKey(key) {
  if (typeof key !== "string") return false;
  const k = key.trim();
  if (k === "" || k === "." || k === "..") return false;
  if (!/^[A-Za-z0-9._-]+$/.test(k)) return false; // ★ 路径分隔符、空格、引号一律不许
  if (k.startsWith("..")) return false;           // ★ 双保险（`..x` 也挡住）
  // ★ 不许以 `.md` 结尾 ⇒ 否则会生成 `D1.md.md`（不危险，但会让人困惑；
  //   而且"键"与"文件名"就不再是同一件事了 —— 卡片化要的正是这个一致性）。
  if (/\.md$/i.test(k)) return false;
  return true;
}

/**
 * 卡片目录的**绝对路径**。
 *
 * ★★★★★ 2026-10-18（D267 · 修 review v1.2.7 的 F02）：**这里必须自己再查一次边界**。
 *
 * 🔴 病（review 实测）：原注释写"调用方保证 rel 已登记且 isUnder 过"——
 *   而 `cardFileAbs` 只检查**生成的文件在卡片目录内**，**从来没检查卡片目录本身在项目内**。
 *   复现：清单里写 `"decisionsDir": "../outside-cards"` ⇒ 普通
 *   `ledger_write({target:'decisions'})` 就在**项目的兄弟目录**生成了 `outside-cards/D1.md`，
 *   还返回 `ok:true`。
 *
 * ★ 为什么"清单加载时校验过"不算数（review 那句很关键）：
 *   清单可能来自**手工编辑 / 仓库拉取 / 旧版本**。不能因为"正常初始化路径可能拦过"
 *   就把清单当成可信输入。⇒ **判据放在最终出口**，每一次读写都过。
 *
 * ★ 为什么返回 `path.resolve(...)` 而不是抛：这个函数被十几处调用（读、写、删、列目录），
 *   抛异常会让"列目录"这种只读操作也崩。⇒ 保留原签名，边界检查由
 *   `cardDirIsSafe` 承担，真正需要拦的地方（写/删）调它。
 */

export function cardDirAbs(root, dirRel) {
  return path.resolve(root, dirRel);
}

/**
 * ★ 卡片目录是否真的在项目内（词法 + 真实路径两道）。
 * @returns {{ok:boolean, why?:string}}
 */

export function cardDirIsSafe(root, dirRel) {
  if (typeof dirRel !== "string" || dirRel.trim() === "") {
    return { ok: false, why: "卡片目录名是空的" };
  }
  if (path.isAbsolute(dirRel)) {
    return { ok: false, why: `卡片目录必须是**相对路径**，不能用绝对路径：${dirRel}` };
  }
  const r = isUnderReal(root, cardDirAbs(root, dirRel));
  if (r.ok !== true) return { ok: false, why: r.why };
  return { ok: true };
}

/** 一张卡的绝对路径（**先过白名单**，非法返回 undefined）。 */

export function cardFileAbs(root, dirRel, key) {
  if (!isSafeCardKey(key)) return undefined;
  const abs = path.resolve(cardDirAbs(root, dirRel), `${key.trim()}.md`);
  // ★ 第三道：即使白名单被绕过，也要求结果**仍在目录内**（纵深防御）。
  if (!isUnder(cardDirAbs(root, dirRel), abs)) return undefined;
  return abs;
}

/** 列出卡片目录里的全部卡（按**数字后缀**排序 ⇒ `D2` 排在 `D10` 前，不靠字典序）。 */

export function listCards(root, dirRel) {
  const dir = cardDirAbs(root, dirRel);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    // ★★★ 必须**排除索引表自己**（`INDEX.md`）—— 否则它会被当成一张"卡"出现在目录里
    //   （实测：`toc` 报出 4 张，其中一张叫 `INDEX`）。★ 索引是**派生物**，不是内容。
    if (/^INDEX\.md$/i.test(e.name)) continue;
    const key = e.name.slice(0, -3);
    if (!isSafeCardKey(key)) continue; // ★ 目录里混进怪名字 ⇒ 跳过（不猜）
    let chars = 0;
    try {
      chars = fs.readFileSync(path.join(dir, e.name), "utf8").length;
    } catch {
      /* 读不到就是 0 —— 不因为一张坏卡而让整个目录列不出来 */
    }
    out.push({ key, chars });
  }
  // ★ 数字后缀排序：`D2` < `D10`（字典序会反过来）—— 与 `entryTocOf` 的"给人读"口径一致。
  return out.sort((a, b) => {
    const na = Number((/(\d+)$/.exec(a.key) ?? [])[1] ?? NaN);
    const nb = Number((/(\d+)$/.exec(b.key) ?? [])[1] ?? NaN);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.key.localeCompare(b.key);
  });
}

/** 读一张卡（返回**原文**；不存在返回 undefined）。 */

export function readCard(root, dirRel, key) {
  const abs = cardFileAbs(root, dirRel, key);
  if (abs === undefined) return undefined;
  return readTextSafe(abs);
}

/** 写一张卡（**原子写**：先写临时文件再 rename —— 与 `upsertGoalCard` 同一套做法）。 */

export function writeCard(root, dirRel, key, text) {
  const abs = cardFileAbs(root, dirRel, key);
  if (abs === undefined) return { ok: false, reason: `卡片键不合法（只允许字母数字与 . _ -）：${key}` };
  // ★ D267（review F02）：**写之前查一次卡片目录本身在不在项目内**。
  //   原来这里只查了"文件在目录内"，而目录可以来自清单里的 `../outside-cards`。
  const safe = cardDirIsSafe(root, dirRel);
  if (safe.ok !== true) {
    return {
      ok: false,
      reason: `卡片目录 \`${dirRel}\` 不安全，一个字节都没写：${safe.why}`,
      unsafeCardDir: true,
    };
  }
  const w = writeFileAtomic(abs, text);
  if (w.ok !== true) return { ok: false, reason: `写卡片 ${key} 失败：${w.reason}`, atomic: true };
  return { ok: true, path: abs, relative: toGitRel(root, abs) };
}

/** 删一张卡（**只在确有该卡时**删；返回是否删掉了）。 */

export function removeCard(root, dirRel, key) {
  const abs = cardFileAbs(root, dirRel, key);
  if (abs === undefined || !fs.existsSync(abs)) return false;
  // ★ D267（review F02/F03）：**删也必须过边界** —— 越界删比越界写更不可逆。
  if (cardDirIsSafe(root, dirRel).ok !== true) return false;
  fs.unlinkSync(abs);
  return true;
}

/**
 * ★★★ 卡片目录的**目录**（每卡一行：`D195 · 标题`）—— 这是"小索引"，**可以推行**。
 *
 * ★ 与 `entryTocOf` 的区别：那个是**现读大文件、现切标题行**（474K 要先进内存）；
 *   这个是**念目录**（`readdir` + 每卡读首行）。★ 卡片化的性能收益主要就在这里。
 * ★ 有界：最多 `limit` 行（超出如实说还有多少）。
 */

export function renderCardToc(root, dirRel, limit = 120, label = "卡片") {
  const cards = listCards(root, dirRel);
  const shown = cards.slice(0, limit);
  const lines = shown.map((c) => {
    const text = readCard(root, dirRel, c.key) ?? "";
    const title = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").replace(/^#+\s*/, "").trim();
    return { key: c.key, title, chars: c.chars };
  });
  return {
    dir: dirRel,
    count: cards.length,
    shown: lines.length,
    cards: lines,
    ...(cards.length > limit ? { more: `另有 ${cards.length - limit} 张未列出` } : {}),
    label,
  };
}

/**
 * ★★★★★ 2026-10-14（D202，用户拍板）：**每个卡片文件夹里放一张索引表**。
 *
 * 用户原话（逐字）：*"而且最好也在每个文件夹里面有一张索引表，
 * 这张索引表是用来按之前搞的那多重维度分区块的。"*
 *
 * ★★★ **"之前搞的那多重维度"就是 D136 的 `weightBlocks`** —— 我不另造一套，
 *   直接把每张卡当成一个**块**喂给它（卡片天然是块：有标题、有正文、有哈希）。
 *   ⇒ 四维融合原样复用：**模型判分(3.0) · 时间(1.5) · 稳定(0.8) · 星值(1.0)**。
 *
 * ★★ **三种用法、各读哪一份**（这条定死，避免"两处算分必然分叉"）：
 *   · **注入里推行**（每回合）⇒ **现算**（`renderCardIndex`）—— 因为注入要的是"此刻的排序"，
 *     而它是**纯函数**、几毫秒，且**不依赖任何文件存在**（静态索引会过期）；
 *   · **人用 / 索引文件**（`INDEX.md`）⇒ **落盘**那份，带时间戳，供人翻、供 grep；
 *   · **`ledger_read` 的目录**⇒ 现算的**轻量版**（只要 key+标题，**不跑打分**，
 *     因为"取某一类卡"不需要权重排序，跑打分反而慢）。
 *
 * ★ 判据：**落盘的 `INDEX.md` 永远只是缓存** —— 插件**从不读它来做决定**
 *   （它可能过期/被手改）。这与本项目那条"派生物不当权威"一致。
 */

export function buildCardBlocks(root, dirRel) {
  return listCards(root, dirRel).map((c) => {
    const text = readCard(root, dirRel, c.key) ?? "";
    const heading = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").replace(/^#+\s*/, "").trim();
    return {
      key: c.key,
      heading,
      hash: fnv1a(text),
      lines: text === "" ? 0 : text.split(/\r?\n/).length,
      text,
      chars: text.length,
    };
  });
}

/**
 * ★ 渲染那张**多维索引表**（供落盘 `INDEX.md` 与人读）。
 *
 * @param {object} opts `{ modelAnswers, histByHash, nowMs, limit }`
 *   ★ `modelAnswers` / `histByHash` 由**调用方**给（`state` 只在调用方可见）——
 *     渲染层刻意不碰 state（本文件一贯的分层）。
 */

export function renderCardIndex(root, dirRel, opts) {
  const blocks = buildCardBlocks(root, dirRel);
  if (blocks.length === 0) return { ok: true, count: 0, markdown: "", rows: [] };
  const weighted = weightBlocks(blocks, opts?.modelAnswers, opts?.histByHash, opts?.nowMs);
  // ★ 按融合分**降序**（最该先看的在前）—— 这就是"相对位置"的落地。
  const rows = weighted
    .map((w) => ({
      key: w.key,
      heading: w.heading ?? w.key,
      lines: w.lines,
      chars: w.chars,
      hash: w.hash,
      score: Math.round(w.weight?.score ?? 0),
      why: (w.weight?.why ?? []).join("；"),
    }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const limit = Number.isFinite(opts?.limit) ? opts.limit : 200;
  const shown = rows.slice(0, limit);
  const md = [
    `| 卡 | 标题 | 行 | 分 | 为什么这个位置 |`,
    `|---|---|---|---|---|`,
    ...shown.map((r) => `| \`${r.key}\` | ${r.heading.replace(/\|/g, "/").slice(0, 60)} | ${r.lines} | **${r.score}** | ${r.why.replace(/\|/g, "/")} |`),
    ...(rows.length > limit ? [`| … | 另有 ${rows.length - limit} 张未列出 | | | |`] : []),
  ].join("\n");
  return { ok: true, count: rows.length, shown: shown.length, markdown: md, rows };
}

/**
 * 把索引表**落盘**成 `<dir>/INDEX.md`（带时间戳；**永远只是缓存**）。
 * ★ 写在 `cards` **之后**、登记清单**之前** —— 这样"索引"绝不会先于内容存在。
 */

export function writeCardIndex(root, dirRel, label, extra) {
  const r = renderCardIndex(root, dirRel, extra);
  if (r.count === 0) return { ok: false, reason: "没有卡片可索引。" };
  const md =
    `# 索引 · ${label}\n\n` +
    `> ★ 这张表由插件在**每次写卡后**自动重算（当前 ${stamp(new Date())}）。\n` +
    "> ★★ **它只是缓存**：插件从*不读它*来做决定（它可能过期、可能被你手改）——\n" +
    "> 权威永远是**卡片文件本身**；要最新排序就用 `ledger_index` 重算或`ledger_read` 现算。\n" +
    "> ★ 打分维度 = **模型判分 3.0 · 时间 1.5 · 稳定 0.8 · 星值 1.0**（D136 的四维秩融合，\n" +
    "> 相对位置 ⇒ 同一张卡在别的目录里分数可能不同，那是**故意的**）。\n\n" +
    r.markdown +
    "\n";
  const abs = path.resolve(cardDirAbs(root, dirRel), "INDEX.md");
  if (!isUnder(cardDirAbs(root, dirRel), abs)) return { ok: false, reason: "索引路径逃出目录" };
  ensureDir(path.dirname(abs));
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, md, "utf8");
  fs.renameSync(tmp, abs);
  return { ok: true, path: abs, count: r.count, shown: r.shown };
}

// ═══════════════════════════════════════════════════════════════════════════
// 卡片层的**读写入口**（双模式：卡片目录 或 单文件 —— 后者是既有项目，必须继续支持）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 取某类记忆的**存储形态**：卡片目录优先，否则单文件。
 *
 * ★ 判据：**`manifest.<kind>Dir` 有没有登记**。登记了 ⇒ 卡片模式。
 * ★★ 为什么不做"自动探测"（目录存在就是卡片模式）：**猜测是本次会话碰巧成立**的推断，
 *   而 `inspect` 里已有同一条教训（`decisionsSource === "guess"` 被判成不合规）——
 *   登记过的才可靠。⇒ 迁移由一个**显式动作**（`ledger_migrate` + 用户确认）完成。
 */

export function cardModeOf(info, kind) {
  const dirRel =
    kind === "decisions" ? info.decisionsDir : kind === "lessons" ? info.lessonsDir : info.goalsDir;
  if (typeof dirRel !== "string" || dirRel === "") return { card: false, fileRel: kindToRel(info, kind) };
  return { card: true, dirRel };
}

/** `kind` ⇒ 单文件模式下它的相对路径（卡片模式下作为**迁移来源**）。 */

export function kindToRel(info, kind) {
  return kind === "decisions" ? info.decisionsRel : kind === "lessons" ? info.lessonsRel : info.goalsRel;
}

/**
 * ★★★★★ 统一读一"条"（卡片模式与单文件模式**同一个返回形状**）。
 *
 * @returns {{ok:boolean, found:boolean, text?:string, heading?:string, fromCard?:boolean, ...}}
 */

export function readEntryUnified(root, info, kind, entry) {
  const mode = cardModeOf(info, kind);
  if (mode.card) {
    // ★★★★★ 2026-10-23（D310，审计员010 第二份报告 F-01 实锤）：**卡片是记忆 ⇒ 基准必须是 `memoryBase`。**
    //
    //   🔴 病（真实生产复现）：本项目记忆目录里有 **299 张决策卡**，
    //     而 `ledger_read({target:"decisions", entry:"D300"})` 恒回 `found:false`
    //     —— 因为这里传的是 `root`（项目根），根目录下**根本没有** `decisions/`。
    //   ★ 这是 D289「V3 收口」漏掉的一处：同文件的 `readKindRaw`(412) / `readCard`(445)
    //     / `writeKindCard`(464) / `splitFileIntoCards`(511) 都已经改成 `memoryBaseOf`，
    //     唯独**按条目读**这一条路没改。⇒ 后果比"读不到"更重：
    //     **卡片可以写进去、却读不回来** —— 写侧与读侧用了两个基准。
    //   ★★ 判据（值得记）：**同一类记忆的所有读写路径必须问同一个基准**；
    //     "改了几处"不等于"改完了"，要按**入口个数**点一遍，不是按报错修一遍。
    //     （我上一轮就是这么修的：逐个看 ReferenceError ⇒ 漏掉这个不报错、只返回 false 的）
    const memBase = memoryBaseOf(info, root);
    const text = readCard(memBase, mode.dirRel, entry);
    if (text === undefined) {
      return {
        ok: true, found: false, entry, mode: "card",
        dir: mode.dirRel,
        reason: `卡片目录 \`${mode.dirRel}\` 里没有「${entry}」这张卡。`,
        toc: renderCardToc(memBase, mode.dirRel, 120, kind),
      };
    }
    const heading = (text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").replace(/^#+\s*/, "").trim();
    return {
      ok: true, found: true, entry, mode: "card", fromCard: true,
      dir: mode.dirRel,
      path: cardFileAbs(memBase, mode.dirRel, entry),
      heading,
      chars: text.length,
      text,
    };
  }
  // ── 单文件模式：走已有的 `entry` 切片 ──────────────────────────────────
  const rel = mode.fileRel;
  if (rel === undefined) return { ok: true, found: false, entry, reason: "这一类记忆没有登记（既无目录也无文件）" };
  // ★ V3（D289）：单文件也是**记忆** ⇒ 基准 `memoryBase`。
  const mBaseE = memoryBaseOf(info, root);
  const abs = path.resolve(mBaseE, rel);
  if (!isUnder(mBaseE, abs)) return { ok: true, found: false, entry, reason: "路径逃出项目根" };
  const raw = readTextSafe(abs);
  if (raw === undefined) return { ok: true, found: false, entry, reason: `文件读不到：${rel}` };
  const seg = sliceEntryByKey(raw, entry);
  if (seg === undefined) {
    return {
      ok: true, found: false, entry, mode: "file", relative: rel,
      reason: `没有找到条目「${entry}」。★ 认：\`D<n>\` · \`L<n>\`/\`E<n>\` · \`g<n>\` · 或小标题关键字。`,
      toc: entryTocOf(raw),
    };
  }
  return {
    ok: true, found: true, entry, mode: "file",
    path: abs, relative: rel, heading: seg.heading,
    startLine: seg.startLine, endLine: seg.endLine,
    chars: seg.text.length, text: seg.text,
  };
}

/** 卡片目录的**人读标签**（`INDEX.md` 标题、提示文案共用一处）。 */

export function cardDirLabel(kind) {
  return kind === "decisions" ? "关键决策" : kind === "lessons" ? "经验与教训" : "目标树";
}

/**
 * ★★★★★ 2026-10-14（D203）：**把"这一类记忆"整份读出来**（卡片模式下 = 虚拟整份）。
 *
 * ★★★ 为什么必须有它（**这正是"迁移会造出两份真源"那个缺口的正面修法**）：
 *   卡片化只是**存储布局**变了，而解析器（`parseGoalCards` / `parseLessonEntries` /
 *   `sliceEntryByKey`）全都吃"一整份文本"。若读侧仍去读**那个留在盘上的旧文件**，
 *   迁移后就会变成：**卡片是新真源、旧文件是快照，而读的人拿的是快照** ——
 *   模型会读到一份**冻结的历史**，还以为那是现状（比"读不到"更危险）。
 *   ⇒ 判据：**凡是"整份读"的地方，都必须问一句"这一类现在住在哪"**。
 *
 * ★ 形态：卡片模式 ⇒ 按**文件名序**把每张卡拼起来（`listCards` 已按数字后缀排序，
 *   所以 `D2` 在 `D10` 前）；单文件模式 ⇒ 老实读那个文件。
 * ★ 返回 `mode` 让调用方**知道自己在哪一种**（写侧要靠它决定往哪落）。
 */

export function readKindRaw(root, info, kind) {
  const mode = cardModeOf(info, kind);
  // ★ V3（D289）：卡片目录与单文件都是**记忆** ⇒ 基准 `memoryBase`。
  //   ★ 收口在这里（而不是 30 个调用点）：`readKindRaw` / `writeKindCard` / `removeKindCard`
  //     是卡片读写的**三个总闸**，`part2.js` 里那 30 处调用全都从这里过。
  //     改 3 处 vs 改 30 处 —— 而且下次再有人加调用点时，**自动就是对的**。
  const memBase = memoryBaseOf(info, root);
  if (mode.card === true) {
    const cards = listCards(memBase, mode.dirRel);
    const chunks = [];
    for (const c of cards) {
      const t = readCard(memBase, mode.dirRel, c.key);
      if (t === undefined) continue;
      chunks.push(t.replace(/\s+$/, ""));
    }
    return {
      mode: "card",
      dirRel: mode.dirRel,
      cardCount: cards.length,
      raw: chunks.length === 0 ? "" : `${chunks.join("\n\n")}\n`,
    };
  }
  const rel = mode.fileRel;
  if (typeof rel !== "string" || rel === "") return { mode: "none", raw: "", cardCount: 0 };
  const abs = path.resolve(memBase, rel);
  if (!isUnder(memBase, abs)) return { mode: "none", raw: "", cardCount: 0 };
  return { mode: "file", rel, abs, raw: readTextSafe(abs) ?? "" };
}

/**
 * 把**一条**（决策 / 教训 / 目标卡）落到正确的位置。
 * ★ 卡片模式 ⇒ 写一个**小文件**（键就是地址）；单文件模式 ⇒ 返回 `null`，
 *   由调用方走原来那套"就地改写大文件"的路（**既有项目一行都不改**）。
 */

export function writeKindCard(root, info, kind, key, text) {
  const mode = cardModeOf(info, kind);
  if (mode.card !== true) return null;
  // ★ V3（D289）：卡片是**记忆** ⇒ 基准 `memoryBase`（收口在这里，调用方不必各自判断）。
  const memBase = memoryBaseOf(info, root);
  const r = writeCard(memBase, mode.dirRel, key, text);
  if (r.ok !== true) return { ok: false, reason: r.reason, card: key };
  // ★ 索引表跟着刷新（**只是缓存**，失败不挡写卡 —— 权威永远是卡片本身）。
  let indexed = false;
  try {
    indexed = writeCardIndex(memBase, mode.dirRel, cardDirLabel(kind), {}).ok === true;
  } catch {
    /* 索引失败不算写卡失败 */
  }
  return { ok: true, card: key, dirRel: mode.dirRel, path: r.path, indexRefreshed: indexed };
}

/** 删**一条**（卡片模式才接；单文件模式返回 `null`）。 */

export function removeKindCard(root, info, kind, key) {
  const mode = cardModeOf(info, kind);
  if (mode.card !== true) return null;
  // ★ V3（D289）：同上 —— 基准 `memoryBase`。
  const memBase = memoryBaseOf(info, root);
  const gone = removeCard(memBase, mode.dirRel, key);
  if (gone === true) {
    try {
      writeCardIndex(memBase, mode.dirRel, cardDirLabel(kind), {});
    } catch {
      /* 同上 */
    }
  }
  return { ok: true, removed: gone, card: key, dirRel: mode.dirRel };
}

/** 这一类在注入 / 契约里**该怎么被指路**（卡片模式给目录，单文件给文件）。 */

export function kindLocationOf(info, kind) {
  const mode = cardModeOf(info, kind);
  if (mode.card === true) return { card: true, rel: mode.dirRel };
  const rel = mode.fileRel;
  return typeof rel === "string" && rel !== "" ? { card: false, rel } : { card: false, rel: undefined };
}

/**
 * ★★★★★ 2026-10-14（D202，用户拍板）：**把单文件拆成卡片**（迁移本体）。
 *
 * ★★★ 安全规则（这条路径会**动用户的大文件**，所以规则定死）：
 *   ① **只切片、不改字** —— 每张卡的内容 = 原文件里那一段**逐字**（含它的 `## D195 · …` 标题）。
 *      ⇒ 判据：**所有卡片拼起来必须等于原文件**（忽略空行差异）——情形 88④ 真跑这个断言。
 *   ② **绝不删原文件** —— 原文件**原样留着**（它成为"迁移前快照"）。
 *      ★★ 为什么：万一卡片层有 bug，用户的记忆**还在**。删不删由**用户**决定（我不替他删）。
 *   ③ **先写卡、后登记清单** —— 顺序不能反：
 *      若先登记了目录、写卡却失败，项目会进入"清单说有卡片目录、目录却是空的"这种**半死**状态。
 *   ④ **不是幂等就拒** —— 目标目录已存在且非空 ⇒ **拒绝**（不覆盖、不合并）。
 *
 * @returns {{ok:boolean, dryRun:boolean, cards?:number, written?:number, dir?:string, reason?:string, verify?:object}}
 */

export function splitFileIntoCards(root, info, kind, opts) {
  const apply = opts?.apply === true;
  const mode = cardModeOf(info, kind);
  if (mode.card) {
    return { ok: false, reason: `这一类已经是卡片模式（目录：${mode.dirRel}），无需迁移。` };
  }
  const rel = mode.fileRel;
  if (typeof rel !== "string" || rel === "") {
    return { ok: false, reason: `这一类没有登记单文件，无法迁移（kind=${kind}）。` };
  }
  // ★ V3（D289）：迁移的源是**记忆** ⇒ 基准 `memoryBase`。
  const mBaseS = memoryBaseOf(info, root);
  const srcAbs = path.resolve(mBaseS, rel);
  if (!isUnder(mBaseS, srcAbs)) return { ok: false, reason: "源文件逃出项目根。" };
  const raw = readTextSafe(srcAbs);
  if (raw === undefined) return { ok: false, reason: `源文件读不到：${rel}` };

  // ── 目标目录名（默认：与源文件同级的子目录）─────────────────────────────
  const defaultDir =
    kind === "decisions" ? "decisions" : kind === "lessons" ? "lessons" : "goals";
  const dirRel = typeof opts?.dir === "string" && opts.dir.trim() !== "" ? opts.dir.trim() : defaultDir;
  // ★ V3（D289）：目标卡片目录也是**记忆** ⇒ 同一个基准 `mBaseS`。
  const dirAbs = cardDirAbs(mBaseS, dirRel);
  if (!isUnder(mBaseS, dirAbs)) return { ok: false, reason: `目标目录逃出项目根：${dirRel}` };

  // ④ 目标目录已存在且非空 ⇒ 拒绝（不覆盖、不合并）
  if (fs.existsSync(dirAbs)) {
    let n = 0;
    try { n = fs.readdirSync(dirAbs).length; } catch { n = 0; }
    if (n > 0) {
      return { ok: false, reason: `目标目录 \`${dirRel}\` 已存在且非空（${n} 项）—— 拒绝覆盖。请换一个目录名，或先人工确认。`, dir: dirRel };
    }
  }

  // ── 切片：按"条目起始行"切开（**不改字**）──────────────────────────────
  const parts = splitIntoCardParts(raw, kind);
  if (parts.length === 0) return { ok: false, reason: `按 ${kind} 的形状切不出任何卡片（文件格式可能不合预期）。` };

  // ③ 先算好全部卡片，**逐张写**，最后才登记清单
  const plan = parts.map((p) => ({
    key: p.key,
    text: p.text,
    chars: p.text.length,
    line: p.lineNo,
  }));
  const badKeys = plan.filter((c) => !isSafeCardKey(c.key)).map((c) => c.key);
  if (badKeys.length > 0) return { ok: false, reason: `有不合法的卡片键（会变成文件名）：${badKeys.join(", ")}` };
  // ★★★★★ 重复键 ⇒ **拒绝**，并把**行号**报出来（可行动），绝不静默覆盖。
  //
  //  ★★★ 为什么不是"自动加后缀"（`D189b`）：那会**掩盖一个真缺陷** ——
  //    同一个编号出现两次，说明这份记忆**自己就有重号**（本项目实测有 **2 处**：
  //    `D71` 与 `D189`），而"引用必达"那条守卫**查不出来**（它用 Set 去重，重号被吃掉）。
  //  ★ 正解有两条，都交给看得懂内容的一方：① 把后一条改成子标题 `### D189 补遗`（同一决策的续写）；
  //    ② 或把它改成另一个编号。⇒ 迁移**不替它决定**，只把证据摆出来。
  const seen = new Map();
  const dups = [];
  for (const c of plan) {
    if (seen.has(c.key)) dups.push({ key: c.key, first: seen.get(c.key), second: c.line });
    else seen.set(c.key, c.line);
  }
  if (dups.length > 0) {
    const detail = dups.map((d) => `\`${d.key}\`（第 ${d.first} 行 与 第 ${d.second} 行）`).join(" · ");
    return {
      ok: false,
      reason:
        `切片后出现**重复编号** ⇒ 拒绝写入（覆盖 = 静默丢一张卡）：${detail}\n` +
        "★★ 这是**源文件自己的缺陷**（同一编号出现两次），不是切片错 —— 而「引用必达」守卫查不出它（它去重）。\n" +
        "★ 两条修法（二选一，都很快）：\n" +
        "  ① 若后一条是**同一决策的续写** ⇒ 把它的 `## D189 · …` 改成 `### D189 补遗 · …`（降级成子标题）；\n" +
        "  ② 若它其实是另一条决策 ⇒ 给它一个**未用过**的编号。\n" +
        "改完再跑一次 `op:\"split\"`。",
      duplicates: dups,
      dir: dirRel,
    };
  }

  // ★★ 逐字校验（**写盘前**就算一遍）：**按非空行比**（空行是排版，不是内容 ——
  //   这一条我在探针里先误报过一次"丢内容"，诊断证明差的 202 字符**全是卡片边界的空行**）。
  //   ★ 判据：**比"非空行序列"**，那才是内容；空行差异不构成"丢内容"。
  const nonBlank = (s) => s.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
  const aLines = nonBlank(raw);
  const bLines = nonBlank(plan.map((c) => c.text).join("\n"));
  const verify = {
    parts: parts.length,
    cards: plan.length,
    srcChars: raw.length,
    cardChars: plan.reduce((a, c) => a + c.chars, 0),
    srcLines: aLines.length,
    cardLines: bLines.length,
    lossless: aLines.length === bLines.length && aLines.every((l, i) => l === bLines[i]),
  };

  if (!apply) {
    return { ok: true, dryRun: true, kind, dir: dirRel, from: rel, cards: plan.length, verify,
      sample: plan.slice(0, 5).map((c) => c.key),
      note: "这是**预览**（没有写任何东西）。★ 原文件**不会被删**，它会作为迁移前的快照留着。" };
  }

  // ① 写卡（原文件一个字都不动）
  // ★★★★★ 2026-10-23（D310，审计员010 F-03 实锤）：**写卡 / 写索引 / 登记清单统一用 `mBaseS`。**
  //   🔴 病：上面第 511/522 行已经正确算出 `mBaseS` 并**在记忆目录里**做越界与"目录非空"检查，
  //     但真正落盘这三处传的却是 `root` ⇒ 卡片、`INDEX.md` **全写进项目根**，
  //     而记忆目录里空着 ⇒ **检查的是 A、写的是 B**（这比"两处都没检查"更难发现：
  //     检查会通过，因为 A 确实不存在）。
  //   ★★ 判据：**凡是"先检查、后写"的地方，检查与写必须用同一个变量** ——
  //     中间隔了十几行就容易接错，所以这里把 `mBaseS` 直接从上面沿用，不重算。
  let written = 0;
  for (const c of plan) {
    const r = writeCard(mBaseS, dirRel, c.key, c.text);
    if (r.ok !== true) return { ok: false, reason: `写卡片 ${c.key} 失败：${r.reason}`, written, dir: dirRel };
    written++;
  }
  // ③ 再写**索引表**（`INDEX.md`）—— ★ 它在卡片之后、登记之前：
  //   这样"索引"绝不会先于内容存在（若写卡失败，我们早就 return 了）。
  const idx = writeCardIndex(mBaseS, dirRel, kind === "decisions" ? "关键决策" : kind === "lessons" ? "经验与教训" : "目标树", {});
  // ④ 最后登记清单（`<kind>Dir`）—— 登记之前这些卡对插件**还不存在**（可安全重试）
  //
  // ★★★ 2026-10-23（D313，GPT 静态审查 001 的 F04）：**必须看返回值，不能只 try/catch。**
  //   🔴 病：`writeManifestSynced` 失败时**返回 `{ok:false}`、不抛**，而原来这里只 `try/catch`
  //     ⇒ catch 是死代码 ⇒ **卡片写了、清单没登记，却回 `ok:true`**（实测复现）。
  //   ★ 修法：**读返回值**；失败时回 `ok:false` 并**说清"卡片已写出但还不是读取来源"**。
  //     ★ 不做破坏性回滚（卡片留着，人工/重试都更容易）；原单文件也留着。
  {
    let reg;
    try {
      reg = registerCardDirInManifest(root, info, kind, dirRel);
    } catch (e) {
      // ★ 万一将来它改成会抛，这条也要留住（两道都守，不是二选一）
      reg = { ok: false, reason: String(e?.message ?? e) };
    }
    if (reg?.ok !== true) {
      return {
        ok: false,
        partial: true, // ★ 明确"部分完成"：卡片在、登记没成
        reason:
          `卡片已写 **${written} 张**（在 \`${dirRel}/\`），但**清单登记失败** ⇒ 它们**还不是读取来源**。` +
          `原因：${String(reg?.reason ?? "未给原因").slice(0, 200)}` +
          `\n★ 已写出的卡片**保留**（没有回滚）；修好权限/占用问题后**直接重试**即可（登记是幂等的）。` +
          `\n★ 也可人工在清单里加 \`${kind}Dir: "${dirRel}"\`。`,
        written,
        dir: dirRel,
        verify,
        manifestWrite: { ok: false, reason: reg?.reason ?? null },
      };
    }
  }
  return { ok: true, dryRun: false, kind, dir: dirRel, from: rel, written, cards: plan.length, verify,
    index: idx.ok === true ? { path: idx.path, count: idx.count } : { error: idx.reason },
    note: `已拆成 ${written} 张卡片（在 \`${dirRel}/\`），并生成了索引表 \`${dirRel}/INDEX.md\`。★ **原文件 \`${rel}\` 原样留着**（迁移前快照）—— 确认无误后你可以自己删，我不替你删。` };
}

/**
 * 把一段文本按**条目**切成卡片段（**逐字**保留每段原文，含它的标题行）。
 *
 * ★ 与 `sliceEntryByKey` 的**区别**：那个是"按 key 找一段"，这个是"把整份切成 N 段"。
 * ★★ 两者必须**认同一套形状**（否则"切出来的卡"与"按 key 取"对不上）——
 *   所以判据共用 `cardKeysOf` 那套正则，**不各写一份**（本项目最忌"两处各写一份"）。
 * ★ 卡片之外的内容（文件头、分隔线等）挂到**第一张卡之前**的前言里 ——
 *   **绝不丢**（拼回去必须等于原文）。
 */

export function splitIntoCardParts(raw, kind) {
  const src = typeof raw === "string" ? raw : "";
  const lines = src.split(/\r?\n/);
  const re =
    kind === "decisions"
      ? /^##\s*D(\d+)(?![\dA-Za-z])/
      : kind === "lessons"
        ? /^##\s*(经验|教训)\s+([LE]\d+)(?![\dA-Za-z])/i
        : /^##\s*目标\s+([A-Za-z0-9._-]+)/;
  const starts = [];
  lines.forEach((l, i) => {
    const m = re.exec(l);
    if (m !== null) {
      const key = kind === "lessons" ? m[2] : kind === "decisions" ? `D${m[1]}` : m[1];
      // ★ 记下**行号**（1-based，给人读）—— 重复编号时要把证据摆出来（见下面 dups）。
      starts.push({ key, line: i, lineNo: i + 1 });
    }
  });
  if (starts.length === 0) return [];
  const parts = [];
  // ★ 前言（第一张卡之前的全部内容）挂到 `_intro` —— 它不是一个"卡片键"，
  //   所以**不写成 `_intro.md`**（那是文件），而是**并入第一张卡**的前面。
  //   ★ 理由：正文里那句"# 关键决策 / > 说明…"是**给人读的头**，
  //     单独一个 `_intro.md` 会在目录里显示成一张"卡"，容易误导。
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i].line;
    const to = i + 1 < starts.length ? starts[i + 1].line : lines.length;
    let text = lines.slice(from, to).join("\n").replace(/\s+$/, "");
    if (i === 0 && starts[0].line > 0) {
      const intro = lines.slice(0, starts[0].line).join("\n").replace(/\s+$/, "");
      if (intro.trim() !== "") text = `${intro}\n\n${text}`;
    }
    parts.push({ key: starts[i].key, text, lineNo: starts[i].lineNo });
  }
  return parts;
}

/**
 * 把 `<kind>Dir` 登记进清单（**只补字段**，绝不动别的 —— 与 `registerGoalsInManifest` 同一套）。
 *
 * @returns {{ok:boolean, skipped?:boolean, reason?:string, mirror?:object}}
 *   ★★★ 2026-10-23（D313，GPT 静态审查 001 的 F04）：**必须把写盘结果交出去。**
 *
 *   🔴 病（真缺陷）：原来本函数**不返回任何东西**，而调用方 `splitFileIntoCards`
 *     用 `try/catch` 判失败 —— 但 `writeManifestSynced` 写失败时**返回 `{ok:false}`、不抛异常**
 *     ⇒ catch 永远不触发 ⇒ **卡片写了、清单没登记，而迁移回 `ok:true`（误报完整成功）**。
 *   ★ 这条是我 2026-10-23 当天引入的：D310 把 4 处裸写"收敛成统一出口"时，
 *     只换了**写**的方式，**没同步改"怎么读返回值"** —— 出口统一了，契约没统一。
 *   ★★★ 判据：**换掉一个函数的实现时，必须重新检查它所有调用方怎么"判成败"** ——
 *     原来靠 `throw` 的，换成 `return {ok:false}` 之后，那些 `try/catch` 就全成了摆设。
 */
export function registerCardDirInManifest(root, info, kind, dirRel) {
  const cur = readManifest(root) ?? {};
  const field = kind === "decisions" ? "decisionsDir" : kind === "lessons" ? "lessonsDir" : "goalsDir";
  // ★ 已经登记过 ⇒ 视为成功（幂等），但要**说清**是 skipped，别让调用方以为"刚写进去"
  if (typeof cur[field] === "string" && cur[field] !== "") {
    return { ok: true, skipped: true, reason: `\`${field}\` 已登记为 \`${cur[field]}\`` };
  }
  const next = { ...cur, [field]: dirRel };
  // ★ 走统一出口（原子写 + 同步镜像），**并把结果交出去**。
  const w = writeManifestSynced(root, next);
  if (w?.ok !== true) {
    return { ok: false, reason: w?.reason ?? "清单写入失败（未给原因）" };
  }
  return { ok: true, skipped: false, mirror: w.mirror };
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★ 2026-10-23（D307 收尾）：**`sliceEntryByKey` / `entryTocOf` 从 part4 搬到这里。**
//   🔴 病：`readEntryUnified`（就在本文件里）要调它们，而它们留在 part4 ⇒ **双向依赖**
//     ⇒ 运行期 `ReferenceError`。而"card-ops ← part4"是**真环**（会改求值顺序），不能走。
//   ⇒ 正解：把它们也搬进来。它们本来就是**纯字符串函数**，与卡片区同源、不碰 ctx/服务。
//   ★ 搬完 part4 里留 re-export ⇒ 调用面一个都不改；本文件仍**不 import 任何 partN** ⇒ 环消失。
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ★★★★★ 2026-10-14（D201，用户拍板"提高召回率"）：**按条目取正文**（entry-level read）。
 *
 * ★★★ 病（实测 `tools/_probe-d201-recall-gap.mjs`）：
 *   `DECISIONS.md` 474,180 字符 / 13,577 行，而一次读取上限 60,000 字符
 *   ⇒ **只够到 12.7%**；而**台账引用的 44 个 D 号里，够得到的只有 2 个**。
 *   ★ 关键：那些引用写的是 `见 D195` —— **它是精确的，不需要任何模糊匹配**。
 *     缺的是**取回能力**。⇒ 所以本函数按**语义单位**切片，不按字节偏移。
 *
 * ★★ 认的形状（按此顺序判，先具体后笼统）：
 *   ① `D<n>`     ⇒ `## D<n> · …` 那一条（本项目决策的固定形状）
 *   ② `L<n>`/`E<n>` ⇒ `## 教训 L<n> · …` / `## 经验 E<n> · …`（经验教训的固定形状）
 *   ③ `g<n>`     ⇒ `## 目标 <id> · …` 那张卡（目标树）
 *   ④ 其它字符串 ⇒ 当作**小标题关键字**（匹配 `## …` 里含它的那一段）
 *
 * ★ 边界：从命中标题的**下一行**起，到**下一个同级或更高级标题**为止
 *   （`##` 对 `##`；`###` 对 `##`/`###`）—— 这样"取 D195"不会把 D196 也带进来。
 * ★ 找不到 ⇒ 返回 `undefined`（调用方**如实报** + 给目录，**绝不猜一条相近的**）。
 */

export function sliceEntryByKey(raw, key) {
  const src = typeof raw === "string" ? raw : "";
  const lines = src.split(/\r?\n/);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // ── 先定"要找哪种标题"（顺序：决策 → 经验/教训 → 目标卡 → 泛化关键字）──────
  let matcher;
  const mD = /^D(\d+)$/i.exec(key);
  const mL = /^([LE])(\d+)$/i.exec(key);
  const mG = /^g([A-Za-z0-9._-]+)$/i.exec(key);
  if (mD !== null) {
    // ★ 用 `(?![\dA-Za-z])` 而不是 `\b` —— `\b` 在中文后不匹配（本文件栽过多次，见 L1/情形 86）。
    matcher = new RegExp(`^##\\s*D${esc(mD[1])}(?![\\dA-Za-z])`);
  } else if (mL !== null) {
    const word = mL[1].toUpperCase() === "L" ? "教训" : "经验";
    matcher = new RegExp(`^##\\s*${word}\\s+${mL[1]}${esc(mL[2])}(?![\\dA-Za-z])`, "i");
  } else if (mG !== null) {
    // ★★ 这里我**当场写错过一次，必须留档**：第一版用 `mG[1]`，而正则的捕获组是
    //   `/^g([A-Za-z0-9._-]+)$/` ⇒ 对 "g1" 它捕获的是 **"1"**（**"g" 被吃在组外**）
    //   ⇒ 拼出来是 `^##\s*目标\s+1` ⇒ **一个都匹配不到**（真形状是 `## 目标 g1 · …`）。
    //   ⇒ 正解：**用整个 key**（`esc(key)`），不要用那个"看起来更干净"的捕获组。
    //   ★ 判据：**凡是"用捕获组拼回一个键"，都要拿真键回读一遍**（组里少了前缀这种错，
    //     代码读起来完全正常 —— 与 L1 的 `\b` 同属"看起来对、其实永不匹配"那一类）。
    matcher = new RegExp(`^##\\s*目标\\s+${esc(key)}(?![A-Za-z0-9._-])`);
  } else {
    matcher = new RegExp(`^#{2,4}\\s*.*${esc(key)}`);
  }

  const start = lines.findIndex((l) => matcher.test(l));
  if (start < 0) return undefined;
  const level = (/^(#{2,4})/.exec(lines[start])?.[1] ?? "##").length;
  // ── 向后找到"下一个同级或更高级标题"为止 ──────────────────────────────
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const hm = /^(#{2,4})\s/.exec(lines[i]);
    if (hm !== null && hm[1].length <= level) { end = i; break; }
  }
  const text = lines.slice(start, end).join("\n").replace(/\s+$/, "");
  return { heading: lines[start].trim(), startLine: start + 1, endLine: end, text };
}

/**
 * ★★★ 2026-10-14（D201）：给一份长文件生成**只列标题行**的小目录。
 *
 * ★ 用途有两个，都是"别让模型在黑暗里"：
 *   ① 读取被截断时 ⇒ 告诉它"其余部分在哪、怎么按需取"（D79：小索引 + 按需翻页）；
 *   ② `entry` 没命中时 ⇒ 给一张目录让它挑，**比让它猜关键词有用**。
 * ★ 有界：最多 `limit` 行（超出如实说"还有 N 条"）—— 目录也可能很长。
 */

export function entryTocOf(raw, limit = 120) {
  const lines = (typeof raw === "string" ? raw : "").split(/\r?\n/);
  const heads = [];
  for (const l of lines) {
    if (/^#{2,4}\s/.test(l)) heads.push(l.trim());
    if (heads.length > limit) break;
  }
  const all = lines.filter((l) => /^#{2,4}\s/.test(l)).length;
  return {
    count: all,
    shown: Math.min(heads.length, limit),
    entries: heads.slice(0, limit),
    ...(all > limit ? { more: `另有 ${all - limit} 条未列出` } : {}),
  };
}
