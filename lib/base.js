/**
 * ★★★★★ 2026-10-23（D307）：**纯基础函数 —— 从 `part2.js` 拆出来的叶子模块。**
 *
 * 🔴 为什么拆（不是审美，是硬墙）：DSH STORE 单文件上限 **262,144 B**
 *   （`tools/_pack-channels.mjs` 的 `maxFileBytes` / `tools/_probe-pack-check.mjs` 都会拦）。
 *   拆之前 `part2.js` 261,100 B ⇒ **余量 1,044 B**；再加几行注释就会在**发布那一刻**才炸。
 *
 * ★ 为什么是这 16 个（判据：**只依赖 node 内建**）：
 *   实测它们**零引用** `defs.js` 的常量，彼此只互相调用
 *   （`isUnderReal`→`isUnder`/`realpathOf`/`nearestExistingAncestor`；
 *     `writeFileAtomic`→`ensureDir`；`stampSec`→`stamp`）。
 *   ⇒ 本文件**只 import `node:fs` / `node:path`** ⇒ 在 `lib/` 那张高度成环的 import 图里
 *     它是**叶子**，不可能改坏求值顺序（这是本项目挑新模块的第一条判据）。
 *
 * ★ 调用方**一个都不用改**：`part2.js` 里留了一行
 *   `export { … } from "./base.js";`
 *   ⇒ 所有 `import { … } from "./part2.js"` 照旧成立。
 *   ★ 这是刻意的：本项目的 import 图成环严重，改路径/改签名的风险远大于加一条 re-export。
 *
 * ★★ 搬迁纪律：本文件正文是**逐字切出来的**，不是重打一遍 ——
 *   注释、空行、标点全部与 `part2.js` 原文相同（迁移脚本自带"拼回去 === 原文"的字节级校验）。
 */
import fs from "node:fs";
import path from "node:path";

/** 把任意值渲染成一条 text ContentBlock。 */

export function textOut(value) {
  return [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ];
}

/** 统一的中文错误信息。 */

export function fail(message) {
  return new Error(String(message));
}

/**
 * 目标是否在 root 之内（含 root 自身）。
 *
 * ★ 这条是本插件**唯一**的路径安全闸门：所有读写都先过它。
 *   用 path.relative 判定而不是字符串前缀 —— 前缀判定会被
 *   `D:\proj-evil` 冒充 `D:\proj` 骗过去（session-workspaces 已踩过同类坑）。
 */

export function isUnder(root, target) {
  const r = path.resolve(root);
  const t = path.resolve(target);
  const rel = path.relative(r, t);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * ★★★★★ 2026-10-18（D266 · 修 review v1.2.7 的 F03）：**词法判定之后再解析真实路径**。
 *
 * 🔴 病（review F03 实测，Linux 复现）：`isUnder` 只用 `path.resolve` + `path.relative`，
 *    **不解析符号链接**。项目内放一个 `linked/` 指向外部目录，`linked/LEDGER.md`
 *    在字符串层面仍在项目内 ⇒ **普通 active replace 就覆盖了项目外的 LEDGER.md**。
 *    ★ 这是本插件**唯一**的路径安全闸门 ⇒ 它漏了，整条链都漏。
 *
 * ★ 修法（两道关，顺序不能反）：
 *    ① **先做词法判定** —— 挡住普通 `../` 穿越（这一层原来就有，保留，不放松）；
 *    ② **再解析真实路径** —— 对已存在的目标用 `realpath`；对**尚不存在**的目标，
 *       解析**最近的已存在祖先**（否则"新建文件"永远过不了②，等于把功能锁死）。
 *    ★ 为什么必须解析"最近的已存在祖先"：`write` 的目标经常还不存在，
 *      `realpath(不存在)` 会直接抛 —— 那不是"不安全"，是"问不出来"。
 *      review 的原话是「新文件检查最近的已存在父目录与实际父目录边界」，这里是同一件事。
 *
 * ★ 拒绝时的两条硬要求（review 验收里写的）：
 *    · 外部文件内容与目录结构**保持原样**（所以我们**只判不写**，判完才动文件）；
 *    · 给出**明确原因**（不能只说 ok:false）。
 *
 * @returns {{ok:boolean, why:string, real?:string, lexical?:string}}
 */

export function isUnderReal(root, target) {
  const lexical = isUnder(root, target);
  if (!lexical) {
    return {
      ok: false,
      why: `路径越界（词法判定）：${String(target)} 不在 ${String(root)} 之内`,
      lexical: "out",
    };
  }
  // ② 真实路径：从目标往上找**第一个存在的**祖先，对它做 realpath
  const rootReal = realpathOf(root);
  if (rootReal === undefined) {
    // 连项目根本身都解析不出来（不存在 / 权限）⇒ 不猜，报不可判定（调用方按拒绝处理）
    return { ok: false, why: `项目根解析不出真实路径：${String(root)}`, lexical: "unknown-root" };
  }
  const anchor = nearestExistingAncestor(target);
  if (anchor === undefined) {
    return { ok: false, why: `找不到任何已存在的祖先路径：${String(target)}`, lexical: "no-anchor" };
  }
  const anchorReal = realpathOf(anchor);
  if (anchorReal === undefined) {
    return { ok: false, why: `祖先路径的真实路径解析失败：${anchor}`, lexical: "unreadable" };
  }
  // 用"已存在祖先的真实路径 + 剩余的相对尾段"算出目标的真实位置
  const tail = path.relative(path.resolve(anchor), path.resolve(target));
  const targetReal = tail === "" ? anchorReal : path.join(anchorReal, tail);
  if (!isUnder(rootReal, targetReal)) {
    return {
      ok: false,
      why:
        `路径越界（**真实路径**）：${String(target)} 词法上在项目内，但真实位置是 ${targetReal}，` +
        `落在项目根 ${rootReal} 之外。★ 这通常意味着项目内有一处符号链接/Junction 指向了外部。`,
      lexical: "in",
      real: targetReal,
    };
  }
  return { ok: true, why: "ok", lexical: "in", real: targetReal };
}

/** 解析真实路径；拿不到就 undefined（**永不抛** —— 它只用于判定，不该自己变成故障源）。 */

export function realpathOf(p) {
  try {
    return fs.realpathSync.native(path.resolve(p));
  } catch {
    try {
      return fs.realpathSync(path.resolve(p));
    } catch {
      return undefined;
    }
  }
}

/** 从 target 自己开始往上找**第一个存在的**路径（找不到返回 undefined）。 */

export function nearestExistingAncestor(target) {
  let cur = path.resolve(target);
  for (let i = 0; i < 64; i++) {
    try {
      fs.lstatSync(cur);
      // ★ lstat 成功即可 —— 哪怕它自己就是个符号链接，realpath 会把它解开，
      //   这正是我们要的（判断的是"最终落在哪"）。
      return cur;
    } catch {
      const up = path.dirname(cur);
      if (up === cur) return undefined;
      cur = up;
    }
  }
  return undefined;
}

/**
 * ★★★★★ 2026-10-18（D266 · 修 review v1.2.7 的 F06）：**统一的原子写**。
 *
 * 🔴 病（review F06 的故障注入实测）：活跃台账、归档 active、修订号清单**都是直接
 *    `fs.writeFileSync(abs, next)`**。注入"先写 8 字节再抛异常" ⇒ **旧内容已丢，文件只剩
 *    `# NEW AC`**。
 *    ★★ 而卡片 / 原则 / 各种状态库**早就**用了 tmp+rename —— 偏偏**最该保护的那份没做**。
 *    本项目 2026-10-09 真出过一次同类事故（台账被写成 `orem ipsum`，抹掉 114 行）。
 *
 * ★ 为什么抽成一个函数而不是逐处补：原来那套 tmp+rename **被手抄了 8 遍**
 *   （part1 五处 + part2 四处 + part4 两处）。手抄的代价已经付过：
 *   **每一处都得自己想一遍"要不要 fsync、临时名会不会撞"**，而只要有一处想漏，
 *   那处的保护就是假的。⇒ 收敛到一个出口，判据才能只守一处。
 *
 * ★ 语义保证（按 review 的验收写）：
 *    ① **要么旧版本完整可读，要么新版本完整写入** —— 绝不留半截；
 *    ② 写失败时**临时文件必须被清掉**（否则下一轮的"最近已存在祖先"会被它带偏）；
 *    ③ 返回 `{ok, reason}`，**不抛** —— 调用方要据此如实报失败，不许假装成功。
 *
 * ★ 为什么用 `rename` 而不是 `copy`：同目录下 `rename` 是**原子替换**（POSIX 保证；
 *   Windows 上 Node 用的是 MoveFileEx-风格，同样不会留下半截）。
 *
/**
 * ★★★★★ 2026-10-23（D310，审计员010 F-05 实锤）：**跨卷安全移动**（先试 rename，遇 EXDEV 降级）。
 *
 * 🔴 病（实测抓现行）：`migrateToV3` 把旧文件搬到 `$DSH_HOME\plugin-data\...\_retired\`，
 *   用的是裸 `fs.renameSync`。而**本机 `$DSH_HOME` 在 C:、项目常在 D:** ——
 *   跨卷 rename 必抛 `EXDEV: cross-device link not permitted`。
 *   实测回执：`retireFailed=EXDEV ... 'D:\audit011-f05-…\LEDGER.md' -> 'C:\Users\…\.dsh\...'`
 *   后果比"搬不走"严重：迁移已把清单指向新位置、旧文件却还在根目录
 *   ⇒ **两份可同时写入的权威源**（任务书 §5.2 明令禁止的那件事）。
 *
 * ★ 判据：**"原子移动"只在同一卷上是原子的**。跨卷没有免费午餐，只能
 *   「复制 → 校验字节 → 删源」。而校验这一步**不能省**：
 *   没校验就删源 = 用"我以为复制成功了"换掉唯一副本。
 *
 * @returns {{ok:true, how:"rename"|"copy"} | {ok:false, reason:string}}
 *   ★ 失败时**源文件一定还在**（删源只在校验通过后才发生）。
 */

export function moveAcrossVolumes(fromAbs, toAbs) {
  // ① 同卷：rename 是真原子操作，最快也最安全
  try {
    ensureDir(path.dirname(toAbs));
    fs.renameSync(fromAbs, toAbs);
    return { ok: true, how: "rename" };
  } catch (e) {
    const code = String(e?.code ?? "");
    // ★ 只对 EXDEV 降级。别的错误（权限 / 目标被占）**不该**被"我帮你复制一下"掩盖 ——
    //   那会把一个明确报错换成一个更难查的半成品。
    if (code !== "EXDEV") return { ok: false, reason: `${code || "rename 失败"}：${String(e?.message ?? e)}` };
  }
  // ② 跨卷：复制 → 逐字节校验 → 才删源
  let buf;
  try {
    buf = fs.readFileSync(fromAbs);
  } catch (e) {
    return { ok: false, reason: `跨卷复制时读源失败（源文件未动）：${String(e?.message ?? e)}` };
  }
  try {
    ensureDir(path.dirname(toAbs));
    fs.writeFileSync(toAbs, buf);
  } catch (e) {
    return { ok: false, reason: `跨卷复制写目标失败（源文件未动）：${String(e?.message ?? e)}` };
  }
  // ③ 校验：**字节级**比较（长度 + 内容），不是"文件存在就算成"
  let back;
  try {
    back = fs.readFileSync(toAbs);
  } catch (e) {
    return { ok: false, reason: `跨卷复制后读不回目标（源文件未动）：${String(e?.message ?? e)}` };
  }
  if (back.length !== buf.length || !back.equals(buf)) {
    return { ok: false, reason: `跨卷复制后内容不一致（源文件未动）：目标 ${back.length} B / 源 ${buf.length} B` };
  }
  // ④ 只有校验通过才删源
  try {
    fs.unlinkSync(fromAbs);
  } catch (e) {
    return { ok: false, reason: `跨卷复制成功但删源失败（两份都在）：${String(e?.message ?? e)}` };
  }
  return { ok: true, how: "copy" };
}

/**
 * 原子写文本文件（`.tmp` + rename），**不做 fsync**。
 *
 * ★ 语义保证：① 要么旧版本完整可读、要么新版本完整写入，绝不留半截；
 *   ② 写失败时临时文件必须被清掉；③ 返回 `{ok, reason}`，**不抛**。
 * ★ 为什么用 `rename` 而不是 `copy`：同目录下 `rename` 是原子替换。
 * ★ 为什么不做 fsync：它会显著拖慢每一次台账写入（本插件每回合都写），
 *   而它防的是掉电这种更罕见的场景；tmp+rename 已足够。★ 有意的取舍。
 * ★★ 2026-10-23（D310）：我上一版在这个函数上方插入新函数时，
 *   `old_string` 把它的**文档尾段与签名一起吃掉**了 ⇒ 只剩孤立函数体（语法上根本不成立）。
 *   ★ 教训：`edit` 的 `old_string` 若以注释中段为锚，**必须整段读到 `\n}\n` 再动** ——
 *     否则"插一段"会变成"吃掉一段"。这里已按功能逐字重建签名与文档。
 */
export function writeFileAtomic(file, data, opts) {
  const abs = path.resolve(file);
  const tmp = `${abs}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    ensureDir(path.dirname(abs));
  } catch (e) {
    return { ok: false, reason: `创建目录失败：${String((e && e.message) || e)}` };
  }
  try {
    // ① 独占创建（`wx`）：临时名撞了就直接失败，绝不覆盖别人的临时文件
    fs.writeFileSync(tmp, data, { encoding: "utf8", flag: "wx" });
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 连临时文件都没建出来，没什么可清的 */
    }
    return { ok: false, reason: `写临时文件失败：${String((e && e.message) || e)}`, tmp };
  }
  try {
    // ② 原子替换
    fs.renameSync(tmp, abs);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清理失败不掩盖真正的原因 */
    }
    return { ok: false, reason: `原子替换失败：${String((e && e.message) || e)}`, tmp };
  }
  if (opts?.mode !== undefined) {
    try {
      fs.chmodSync(abs, opts.mode);
    } catch {
      /* 权限位设不上不影响内容 */
    }
  }
  return { ok: true };
}


/** 数行数（末尾换行不算多一行）。 */

export function countLines(text) {
  if (typeof text !== "string" || text === "") return 0;
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n").length;
}

/** 读文本；不存在或读不了 ⇒ undefined（**永不抛**）。 */

export function readTextSafe(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * ★★★★★★ 2026-10-14（D207）：**把返回值里所有 `undefined` 换成"不写这个键"**。
 *
 * ★ 为什么必须有它（这个病**已经复发两次**，别再打单点补丁了）：
 *   ① D188 ①：`ledger_init` 的返回值里带 `undefined`（`gitignore:false` 时）
 *      ⇒ 内核判 `value is not lossless JSON` ⇒ **拒收整个调用**（而文件其实已写好）；
 *   ② D203/L31：`ledger_read` 的卡片分支里写死 `totalLines: undefined` ⇒ 同一个病；
 *   ③ D207：`ledger_goals({op:"tree"})` 把 `parseGoalCards` 的卡**原样 `...c` 摊开**，
 *      而老格式的卡**没有 `- 更新于:`** ⇒ `updatedAt` 是 `undefined` ⇒ 又被拒收。
 *   ★★ 三次的形状**完全一样**：**JS 里 `undefined` 是合法值、可读、可展开，
 *      而它一旦跨过内核那道 JSON 化就会被丢掉、并被判"不是无损 JSON"。**
 *   ⇒ 判据：**工具的返回值在"离开本进程"之前，必须自己清理一遍** ——
 *      不许把"本进程内合法"当成"能出去"。
 *
 * ★ 实现：**递归删掉值为 `undefined` 的键**（数组里的 `undefined` 换成 `null`，
 *   因为数组元素不能"不写"——否则长度会变、位置会错）。
 * ★ 行为面**完全不变**：它只去掉"本来就等于不存在"的那些键。
 * ★ `null` 一律保留（它是**有意的语义**：例如"父子树的 parent 是 null"）。
 */

export function lossless(value) {
  if (value === undefined) return null; // 顶层/数组元素：用 null 占位（不改变长度）
  if (value === null) return null;
  const t = typeof value;
  if (t === "function" || t === "symbol" || t === "bigint") return String(value);
  if (Array.isArray(value)) return value.map((x) => lossless(x));
  if (t === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue; // ★ 核心：**不写这个键**（而不是写 undefined）
      out[k] = lossless(v);
    }
    return out;
  }
  return value;
}

/** 确保目录存在。 */

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 转成 Git 友好的相对路径（相对项目根，正斜杠）。 */

/**
 * ★★★★★ 2026-10-21（D289 · V3 阶段 1）：**记忆文件的解析基准 —— 唯一出口。**
 *
 * 判据（背下来，别每次重新推）：
 *   · **要碰记忆文件**（台账/决策/归档/日志/流水/原则/目标/教训/交接单/分流）⇒ 用它；
 *   · **要碰项目本身**（`.git` / `.gitignore` / **`.dsh-ledger.json` 的寻址**）⇒ 用 `info.projectRoot`。
 *
 * ★ 为什么必须是一个函数、不能各处自己 `info.memoryBase ?? root`：
 *   那等于**两个出处**（D220 撞过的正是这个）—— 迟早有一处写成 `?? projectRoot` 之外的形态，
 *   而它又不报错，只会**读不到、静默返回空**。收成一处，判据就只有一个。
 *
 * ★ `fallback` 存在的理由：自检/探针里有**手工拼的 info**（如 `{ activeRel: undefined }`），
 *   它们没有 `memoryBase`。此时退回调用方给的 `root` ⇒ 与 V2 逐字一致，不会因为升级而红。
 *
 * @param {object} info `inspect()` 的结果（可能缺 `memoryBase`）
 * @param {string} [fallback] 退路（通常是该函数拿到的 `root`）
 */
export function memoryBaseOf(info, fallback) {
  const b = info?.memoryBase;
  if (typeof b === "string" && b !== "") return b;
  if (typeof fallback === "string" && fallback !== "") return fallback;
  return typeof info?.projectRoot === "string" ? info.projectRoot : "";
}

export function toGitRel(projectRoot, abs) {
  return path.relative(projectRoot, abs).split(path.sep).join("/");
}

/** 当期归档子目录：`YYYY-MM/weekN`。 */

export function archiveStamp(now, weekMode) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const mm = String(m).padStart(2, "0");
  // ★ weekMode 决定 weekN 的算法。默认 "month"（week-of-month，1..5）——
  //   路径里已经有 YYYY-MM 了，再放"年内第几周"会让两段信息冗余；
  //   放"月中第几周"才是与 YYYY-MM 互补的那个读法。
  const week =
    weekMode === "year"
      ? Math.ceil(
          ((now - new Date(y, 0, 1)) / 86400000 + new Date(y, 0, 1).getDay() + 1) / 7
        )
      : Math.floor((d - 1) / 7) + 1;
  return { dir: `${y}-${mm}/week${week}`, label: `${y}-${mm} week${week}` };
}

/** 时间戳（本地，精确到分）。 */

export function stamp(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

/** 时间戳（本地，精确到秒）—— 日志用：同一分钟内可能有很多条。 */

export function stampSec(now) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${stamp(now)}:${pad(now.getSeconds())}`;
}
