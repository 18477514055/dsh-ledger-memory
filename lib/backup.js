/**
 * ★★★★★ 2026-10-30（D366 · 用户拍板）：**热文件的稳定备份**。
 *
 * ── 用户原话（逐字）────────────────────────────────────────────────────
 *   *"至少保证那些经常被修改的文件有一个备份，但是又不能直接复制整套体系，
 *     最好就是针对像活跃台账这种留一个稳定备份，你看你这已经连续弄坏好几次了。"*
 *
 * ── 为什么必须有它（不是"以防万一"，是"已经发生过两次"）──────────────
 *   · D362：`ledger_archive` 的 `newActive` 填成占位符 ⇒ 台账 **400 行 → 19 行**；
 *   · D365：同一类错**又犯一次** ⇒ **385 行 → 19 行**。
 *   ★★ 两次都**没有盘上可恢复件**：`LEDGER.md` 被 `.gitignore` 忽略、也不在版本库里
 *      ⇒ 只能靠会话日志里历次注入的台账正文去"捞"（D362 为此写了 6 个恢复脚本，
 *      解 120.6 MB 多帧 zstd）。**那是运气，不是机制。**
 *
 * ── 设计取舍（三条，每条都对应一个真实约束）────────────────────────────
 *   ① **只备份"会被整份重写"的那几个单例，不复制整套体系。**
 *      用户的顾虑是对的：把 `decisions/`（220 张卡）、`_ledger-log/`（数千条）全备一份
 *      等于**把仓库翻一倍**，而且那些文件本来就有归档/追加语义，不需要快照。
 *      ⇒ 白名单只放**"会被整份重写"的单例**：`LEDGER.md` / `DECISIONS.md` / `JOURNAL.md` /
 *        `LESSONS.md` / `GOALS.md` / `PRINCIPLES.md` / `SECURITY.md`。
 *      ★ 判据：**只有"整份替换"的写入才会一次抹掉全部历史** —— 卡片化目录是逐卡写的，
 *        归档是只追加的，日志是只追加的 ⇒ 它们**结构上就不可能被一次写坏**，不需要备份。
 *   ② **稳定备份 = 一份"上一个已知好版本"，不是一堆快照。**
 *      ⇒ 固定路径 `<memoryBase>/_backup/<相对路径>.bak`，每次写入前覆盖。
 *      ★ 为什么不是带时间戳的多份：多份会**无限长**（本插件每回合都写台账），
 *        而且恢复时还要"挑哪一份"，那正是半夜出事时最不该有的步骤。
 *      ★ 为什么"上一个"就够：真正的灾难形状是**一次错误的整份替换**（两次都是这个），
 *        它的特征就是"新版本与旧版本**天差地别**"。⇒ 只要保住**紧邻的上一版**，
 *        那一次就能退回去。★ 连续两次写坏同一个文件才会连丢两版——而这已由
 *        「骤降安全网」（D206）在写入前拦掉了。
 *   ③ **备份绝不参与指纹、绝不进扫描面、绝不进版本库。**
 *      这三条必须在别处**显式排除**（见下面的 `BACKUP_DIR` 被谁引用）：
 *      · `fingerprint.js#identityOfPath` ⇒ 返回 `undefined`（备份必须**逐字节不变**，
 *        打上指纹就等于把备份一起改坏，那就不是备份了）；
 *      · `part6.js#scanMemorySurface` 的 `sysDirs` ⇒ 否则被扫进「记忆目录稿」污染锚定榜；
 *      · `defs.js#DEFAULT_IGNORE_LINES` ⇒ 否则备份（含用户原话）会被提交进版本库。
 *
 * ── 铁律：备份失败**绝不能让写入失败** ──────────────────────────────────
 *   与 `writeFileAtomic` 里的加指纹同一条纪律：备份是"锦上添花"，写主文件才是本职。
 *   任何异常都吞掉并如实回传（`{ok:false, reason}`），**调用方不许因为它而中断**。
 *   ★ 反过来也不行：**备份比新内容还新**是最坏的一种状态（恢复时反而把好内容覆盖掉）
 *     ⇒ 顺序必须是**先备份旧内容、再写新内容**，且备份内容**逐字取自磁盘**。
 *
 * ── 为什么是叶子模块（只依赖 node 内建）──────────────────────────────
 *   `lib/` 的 import 图高度成环（part2 → part1/part3/part4/part8，part1 → part2…）。
 *   新模块若 import 任何 partN，就有把求值顺序改坏的风险（本项目栽过）。
 *   只依赖 `fs`/`path` 则**不可能成环**。★ 与 `manifest-mirror.js` 同一条纪律。
 */

import fs from "node:fs";
import path from "node:path";

/** 备份目录名（在 `memoryBase` 之下）。★ 这个名字被三处显式排除引用，改名要一起改。 */
export const BACKUP_DIR = "_backup";

/**
 * 哪些文件值得备份 —— **只收"会被整份重写"的单例**。
 *
 * ★ 白名单而不是黑名单：黑名单会让**以后新增**的记忆文件**默认没有备份**，
 *   而那正是最容易忘的一类（D364 咬过一次：放宽兜底后 `INDEX.md` 被当卡片）。
 * ★ 卡片目录 / 归档 / 日志 / 分流**故意不在名单里**：它们要么逐卡写、要么只追加，
 *   结构上不可能被一次写坏。
 */
export const HOT_FILES = new Set([
  "LEDGER.md",
  "DECISIONS.md",
  "JOURNAL.md",
  "LESSONS.md",
  "GOALS.md",
  "PRINCIPLES.md",
  "SECURITY.md",
]);

/**
 * 备份文件落点：`<memBase>/_backup/<rel>.bak`
 *
 * ★ 为什么保留相对目录结构（`a/b.md` ⇒ `_backup/a/b.md.bak`）：V3 里这些单例都在
 *   记忆根上，但 V2（flat）与自定义 `active` 路径可能带子目录 ⇒ 压平会导致**同名撞车**
 *   （两个 `LEDGER.md` 互相覆盖，而用户以为各自有备份）。
 *
 * @param {string} memBase 记忆基准（V3 = 记忆子目录；V2 = 项目根）
 * @param {string} rel 相对 `memBase` 的路径（正斜杠或反斜杠都行）
 * @returns {string|undefined} 绝对路径；`rel` 不合法时返回 undefined（**不猜、不兜底**）
 */
export function backupPathOf(memBase, rel) {
  if (typeof memBase !== "string" || memBase === "") return undefined;
  if (typeof rel !== "string" || rel.trim() === "") return undefined;
  // 越界 / 跨平台绝对路径（含 Windows 盘符与 UNC）⇒ 不给路径（调用方必须当"跳过"处理）
  if (/^[A-Za-z]:[\\/]|^[\\/]/.test(rel)) return undefined;
  const clean = rel.replace(/\\/g, "/");
  if (clean === "" || clean.split("/").some((p) => p === "" || p === "." || p === "..")) return undefined;
  const baseAbs = path.resolve(memBase, BACKUP_DIR);
  const abs = path.resolve(baseAbs, `${clean}.bak`);
  const relToBackup = path.relative(baseAbs, abs);
  if (relToBackup === "" || relToBackup.startsWith("..") || path.isAbsolute(relToBackup)) return undefined;
  return abs;
}

/**
 * 校验 `<memBase>/_backup/...` 路径链路上是否存在符号链接或真实路径逃逸。
 * ★ 保持 `backup.js` 零内部依赖（只调 `fs`/`path`），同时补齐 `isUnderReal` 等级的物理边界防线。
 */
function verifyBackupPathReal(memBase, abs) {
  let realBase;
  try {
    realBase = fs.realpathSync(path.resolve(memBase));
  } catch {
    return { ok: false, reason: "记忆根目录不存在或无法解析真实路径" };
  }
  const baseResolved = path.resolve(memBase);
  const relFromBase = path.relative(baseResolved, abs);
  if (relFromBase === "" || relFromBase.startsWith("..") || path.isAbsolute(relFromBase)) {
    return { ok: false, reason: "备份落点越出记忆根" };
  }
  const segs = relFromBase.split(path.sep).filter(Boolean);
  let cur = baseResolved;
  for (const seg of segs) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e && e.code === "ENOENT") continue;
      return { ok: false, reason: `备份路径状态检查失败：${String((e && e.message) || e)}` };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, reason: `备份路径含符号链接（拒绝越界跟随）：${cur}` };
    }
    try {
      const realCur = fs.realpathSync(cur);
      const r = path.relative(realBase, realCur);
      if (r.startsWith("..") || path.isAbsolute(r)) {
        return { ok: false, reason: `备份真实路径越出记忆根：${realCur}` };
      }
    } catch (e) {
      return { ok: false, reason: `备份真实路径解析失败：${String((e && e.message) || e)}` };
    }
  }
  return { ok: true };
}

/**
 * 这个文件值不值得备份（按**文件名**判，不看目录）。
 * @param {string} rel
 */
export function isHotFile(rel) {
  if (typeof rel !== "string" || rel === "") return false;
  const base = path.basename(rel.replace(/\\/g, "/"));
  return HOT_FILES.has(base);
}

/**
 * ★★★★ **把"当前磁盘上的内容"存成备份** —— 必须在写新内容**之前**调用。
 *
 * `prevText` 由调用方传入（它刚刚读过），**不在这里重读**：
 *   ★ 若要重读，就会出现"调用方读到 A、这里读到 B"的窗口（并发/外部编辑器），
 *     结果是**备份的是 B、覆盖的是 A 之后的内容** ⇒ 备份与它声称保护的那一版不一致。
 *     ⇒ 判据：**备份必须与"调用方即将覆盖掉的那一份"逐字相同**。
 *
 * 返回 `{ok, path?, rel?, reason?, skipped?}`，**永不抛**。
 *
 * @param {{memBase:string, rel:string, prevText:string|undefined, forceHot?:boolean}} p
 */
export function backupBeforeWrite(p) {
  const memBase = p?.memBase;
  const rawRel = p?.rel;
  const rel = typeof rawRel === "string" ? rawRel.replace(/^(?:\.[\\/])+/, "") : rawRel;
  const prevText = p?.prevText;
  const forceHot = p?.forceHot === true;
  // 不热 ⇒ 不备份（如实报 skipped，不假装做了）
  if (!forceHot && isHotFile(rel) !== true) return { ok: false, skipped: true, reason: "不是热文件（按白名单）" };
  // 文件还不存在（首次创建）⇒ 没有"上一个好版本"可存，这是正常的，不是失败
  if (typeof prevText !== "string" || prevText === "") {
    return { ok: false, skipped: true, reason: "旧文件不存在或为空 ⇒ 没有上一版可备份" };
  }
  const abs = backupPathOf(memBase, rel);
  if (abs === undefined) return { ok: false, reason: "备份落点算不出来（路径不合法）" };
  const preReal = verifyBackupPathReal(memBase, abs);
  if (!preReal.ok) return { ok: false, reason: preReal.reason };
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
  } catch (e) {
    return { ok: false, reason: `建备份目录失败：${String((e && e.message) || e)}` };
  }
  const postDirReal = verifyBackupPathReal(memBase, abs);
  if (!postDirReal.ok) return { ok: false, reason: postDirReal.reason };
  // ★ 用 tmp + rename（与 writeFileAtomic 同一套保证）：备份本身也绝不留半截。
  //   半截备份比没有备份更坏 —— 恢复时会把一个残文件当成"上一版好版本"。
  const rand = Math.random().toString(36).slice(2, 8);
  const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}-${rand}`;
  try {
    fs.writeFileSync(tmp, prevText, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 连临时文件都没建出来 */
    }
    return { ok: false, reason: `写备份临时文件失败：${String((e && e.message) || e)}` };
  }
  try {
    fs.renameSync(tmp, abs);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖真正原因 */
    }
    return { ok: false, reason: `备份改名失败：${String((e && e.message) || e)}` };
  }
  // ★ 落盘后**读回校验字节数**：rename 成功不等于内容对（同 writeFileAtomic 的纪律）。
  try {
    const got = fs.readFileSync(abs, "utf8");
    if (got !== prevText) {
      return { ok: false, path: abs, reason: "备份读回与旧内容**不一致** ⇒ 这份备份不可信" };
    }
  } catch (e) {
    return { ok: false, path: abs, reason: `备份读回失败：${String((e && e.message) || e)}` };
  }
  return { ok: true, path: abs, rel: `${BACKUP_DIR}/${rel.replace(/\\/g, "/")}.bak`, bytes: Buffer.byteLength(prevText, "utf8") };
}

/**
 * 读出某个热文件当前可用的备份（给恢复路径 / 体检用）。
 * @param {string} memBase
 * @param {string} rel
 * @returns {{exists:boolean, path?:string, text?:string, lines?:number, reason?:string}}
 */
export function readBackup(memBase, rawRel) {
  const rel = typeof rawRel === "string" ? rawRel.replace(/^(?:\.[\\/])+/, "") : rawRel;
  const abs = backupPathOf(memBase, rel);
  if (abs === undefined) return { exists: false, reason: "备份落点算不出来" };
  const realChk = verifyBackupPathReal(memBase, abs);
  if (!realChk.ok) return { exists: false, path: abs, reason: realChk.reason };
  let text;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (e) {
    return { exists: false, path: abs, reason: String((e && e.code) || e) };
  }
  const lines = text === "" ? 0 : text.split("\n").length;
  return { exists: true, path: abs, text, lines };
}
