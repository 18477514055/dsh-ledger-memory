/**
 * ★★★★★ 2026-10-23（D303 · 用户拍板）：**清单双份 —— 项目根留权威，记忆子目录放镜像，必须同步。**
 *
 * 用户原话（逐字）：*"清单保留在外，也在子目录中复制一份（注意同步）"*
 *
 * 🔴 为什么需要这一层（两条约束在打架，必须同时满足）：
 *   · **任务书 §2.2 / §2.3** 要求"所有项目级记忆集中放在 `<项目名>-ledger-memory/`"，
 *     目录示图里 `.dsh-ledger.json` 就在子目录内部；
 *   · **寻址循环**（`part2.js` 里那条注释）：*"清单永远在项目根：它是寻址器，不能自己也被搬走
 *     （否则陷入『要读清单才能知道清单在哪』的循环）"*。
 *   ⇒ 上一轮的结论是"这是裁决题，三选一"。**用户选了第四条路：两份。**
 *
 * ★★★ 双份最危险的地方是**变成两个权威源**（任务书 §5.2 明令禁止）。所以本模块的纪律是死的：
 *
 *   ① **根那份是唯一权威**。`readManifest()` 只读根，**永不读镜像** —— 这条不许破。
 *   ② 镜像**只写不读**（对本插件而言）。它是给"人 / 别的工具 / 将来换寻址方式"看的一份副本，
 *      不是插件的数据来源。⇒ 即使镜像被手改成垃圾，插件行为也**完全不变**（只会报"不同步"）。
 *   ③ **写序不可颠倒：先写根（原子），成功了才写镜像。**
 *      根写失败 ⇒ 一个字节都不碰镜像（否则镜像比权威还新，那是最坏的一种"同步"）。
 *   ④ 镜像写失败**不回滚根**（根已经是对的），但必须**如实回报** `mirrorFailed` —— 不许静默。
 *   ⑤ 镜像内容与根**逐字节相同**（同一个 `text` 写两处），这样"同步"这件事可以用一次字符串比较验证。
 *
 * ★ 为什么它是**叶子模块**（只依赖 node 内建）：
 *   `lib/` 的 import 图是高度成环的（part2 → part1/part3/part4/part8，part1 → part2，…）。
 *   新模块若 import 任何 partN，就有把求值顺序改坏的风险（本项目栽过）。只依赖 `fs`/`path` 则不可能成环。
 */

import fs from "node:fs";
import path from "node:path";

/**
 * ★★★★★ 2026-10-23（D310，审计员010 F-04 实锤）：**写清单 + 同步镜像的唯一出口。**
 *
 * 🔴 病（4 处，全是同一个形状）：`writeManifestMode`(part1) · `registerGoalsInManifest`(part2) ·
 *   `registerPrinciplesInManifest`(part2) · `registerCardDirInManifest`(card-ops)
 *   —— 每处都自己 `fs.writeFileSync(根清单)`，**既不是原子写，也不调 `syncManifestMirror`**。
 *   ⇒ 用户切一次 `/ledger mode`、建一次目标树、授权一次原则、拆一次卡片，镜像当场 stale。
 *   ⇒ 「两份清单必须同步」那条铁律（D303）在这 4 条路径上**根本不成立**。
 *
 * ★★ 为什么必须收敛成**一个函数**（而不是在 4 处各补两行）：
 *   这 4 处的共同点是"**只补字段、只写一次**"。既然行为完全一样，
 *   就让它们**都走这一条路** —— 以后再加第 5 处调用时，同步是**自动的**，
 *   不需要靠"记得补"。这正是 D289 收口时的同一条判据（改 1 处 vs 改 N 处）。
 *   ★ 反过来：如果留 4 份复制粘贴，第 5 处一定漏 —— 本轮这 4 处就是这么漏出来的。
 *
 * @param {string} projectRoot 项目根（权威清单所在）
 * @param {object} manifest 要写下去的**完整**清单对象
 * @returns {{ok:boolean, reason?:string, mirror?:object}}
 *   · 根写失败 ⇒ `ok:false`，**一个字节都不碰镜像**（写序不可颠倒）
 *   · 根写成功、镜像写失败 ⇒ `ok:true` + `mirrorFailed`（根是对的，不回滚，但如实报）
 */
export function writeManifestSynced(projectRoot, manifest) {
  // ★ 文本**只序列化一次**，根与镜像写的是**同一个字符串** ⇒ 同步可以用一次比较验证。
  //   （各写各的 JSON.stringify 也能得到同样结果，但"同一个变量"这件事可证，不必去推。）
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const abs = path.join(projectRoot, MANIFEST_MIRROR_NAME);
  // ① 原子写根（`.tmp` + rename）—— 根是权威，绝不能出现"写到一半"的清单
  const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(tmp, text, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 没建出来就没什么可清 */ }
    return { ok: false, reason: `写清单临时文件失败：${String((e && e.message) || e)}` };
  }
  try {
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖真因 */ }
    return { ok: false, reason: `清单原子替换失败：${String((e && e.message) || e)}` };
  }
  // ② 根已成功 ⇒ 才碰镜像（顺序不可颠倒）
  const mirror = syncManifestMirror(projectRoot, manifest, text);
  return { ok: true, mirror };
}

/** 镜像文件名 —— 与根那份**同名**（用户说的"复制一份"，同名才看得出是同一件东西）。 */
export const MANIFEST_MIRROR_NAME = ".dsh-ledger.json";

/**
 * 算出镜像该落在哪。**V2 返回 `undefined`**（没有 `memoryRoot` ⇒ 没有子目录 ⇒ 不该有镜像）。
 *
 * ★ 校验规则与 `inspect()` / `ledger_init` 里的 `memoryRoot` 校验**同源**
 *   （相对路径 · 不出项目 · 不许 `..`）—— 三处各写一套必然分叉，
 *   而那类分叉的表现是"init 建得出、镜像写不进"，最难查。
 *
 * @returns {string|undefined} 镜像的绝对路径；V2 / 非法 memoryRoot ⇒ undefined
 */
export function manifestMirrorPath(projectRoot, manifest) {
  if (typeof projectRoot !== "string" || projectRoot === "") return undefined;
  const raw = typeof manifest?.memoryRoot === "string" ? manifest.memoryRoot.trim() : "";
  if (raw === "") return undefined;
  if (path.isAbsolute(raw)) return undefined;
  const norm = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (norm === "") return undefined;
  // 逐段查 `..` 与空段（`a//b` 这种也要拒 —— 与 memoryRootIgnoreLines 同一条判据）
  if (norm.split("/").some((seg) => seg === "" || seg === "..")) return undefined;
  return path.join(projectRoot, ...norm.split("/"), MANIFEST_MIRROR_NAME);
}

/** 读文件；不存在/读不了 ⇒ undefined（**不抛** —— 镜像问题绝不许连累主流程）。 */
function readSafe(abs) {
  try {
    if (!fs.existsSync(abs)) return undefined;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * 把清单的镜像写到记忆子目录（**幂等**：内容已相同就跳过，不制造无意义的 mtime 变化）。
 *
 * @param {string} projectRoot 项目根
 * @param {object} manifest 清单对象（要能读出 `memoryRoot`）
 * @param {string} [text] 已写进根的**逐字文本**；不给则按同一格式重新序列化
 * @returns {{skipped:true, reason:string} | {skipped:false, path:string, created:boolean, changed:boolean, failed?:string}}
 *   ★ **绝不抛**。调用方拿 `failed` 决定怎么如实回报。
 */
export function syncManifestMirror(projectRoot, manifest, text) {
  const target = manifestMirrorPath(projectRoot, manifest);
  if (target === undefined) {
    return { skipped: true, reason: "V2（清单里没有 memoryRoot）⇒ 没有镜像，行为与改造前逐字一致" };
  }
  const body = typeof text === "string" && text !== "" ? text : `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    const prev = readSafe(target);
    const created = prev === undefined;
    // ★ 幂等判据用**逐字节比较**，不是"文件在不在"：
    //   文件在但与根不同 = 不同步 = **必须重写**（那正是本功能要治的病）。
    if (prev === body) {
      return { skipped: false, path: target, created: false, changed: false };
    }
    // ★ 原子写（`.tmp` + rename）：镜像被截断的后果是"看起来有一份、其实是垃圾"，
    //   比"没有镜像"更坏 —— 因为人/工具会去信它。
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, target);
    return { skipped: false, path: target, created, changed: true };
  } catch (e) {
    return { skipped: false, path: target, created: false, changed: false, failed: String((e && e.message) || e) };
  }
}

/**
 * 核对镜像与权威是否一致（**只读，不修**）。
 *
 * ★ 用途有两个：① 探针/诊断能看见"不同步"；② 将来放进 `ledger_status` 让人一眼看到。
 * ★ **它绝不负责修复**：修复只发生在写入路径上（`syncManifestMirror`）。
 *   读的时候顺手修会造出一个"读操作偷偷写盘"的入口，那是本项目一直在避免的东西。
 *
 * @returns {{hasMirror:boolean, path?:string, state:string, detail?:string}}
 *   `state` ∈ `"v2"`（V2 项目，本就该没有）· `"missing"`（该有却没有）·
 *   `"stale"`（有但内容与权威不同）· `"in-sync"`（一致）· `"unreadable"`（读不了）
 */
export function verifyManifestMirror(projectRoot, manifest, text) {
  const target = manifestMirrorPath(projectRoot, manifest);
  if (target === undefined) return { hasMirror: false, state: "v2" };
  const body = typeof text === "string" && text !== "" ? text : `${JSON.stringify(manifest, null, 2)}\n`;
  const got = readSafe(target);
  if (got === undefined) {
    // ★ 区分"文件不存在"与"存在但读不了"：前者是 missing，后者 unreadable。
    //   混成一句"没有镜像"会让权限问题被当成"还没建"，永远修不好。
    let exists = false;
    try {
      exists = fs.existsSync(target);
    } catch {
      exists = false;
    }
    return exists
      ? { hasMirror: true, path: target, state: "unreadable", detail: "文件存在但读不出内容" }
      : { hasMirror: false, path: target, state: "missing" };
  }
  if (got === body) return { hasMirror: true, path: target, state: "in-sync" };
  return {
    hasMirror: true,
    path: target,
    state: "stale",
    detail: `镜像 ${Buffer.byteLength(got)} B / 权威 ${Buffer.byteLength(body)} B`,
  };
}
