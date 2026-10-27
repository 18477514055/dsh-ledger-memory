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
 * ★★★ 2026-10-23（D316 · Gemini 审查 002 的 GAP-03③ a）：**跨平台的"这是绝对路径吗"**。
 *
 * 🔴 病：`path.isAbsolute("C:\\evil")` 在 **Linux/macOS 上是 `false`** ——
 *   于是同一个清单值在 Windows 被拒、在干净克隆的 Linux 上被放行。
 *   ★ 判据：**安全判据不许随运行平台变松**。Windows 盘符形式在**任何**平台上都必须当成绝对路径。
 *   ★ 这不是"为了过自检"，是因为**别人可能把 Windows 上做的清单拷到别处用**：
 *     在 Linux 上它不会被 `path.isAbsolute` 认出来，就会被拼进项目根 —— 那不是"相对路径"。
 */
export function isAbsoluteAnywhere(v) {
  if (typeof v !== "string" || v === "") return false;
  if (path.isAbsolute(v)) return true;
  // `C:\...` / `C:/...` / `\\server\share` —— 后三种 Win 形式也要认
  if (/^[A-Za-z]:[\\/]/.test(v)) return true;
  if (/^\\/.test(v)) return true;
  return false;
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
  //
  // ★★★★★ 2026-10-23（D313）：**`root` 自己也可能是"即将被创建"的**（真实回归）。
  //   🔴 病（我自己修 F01 时当场撞出）：`ledger_init` 建新 V3 项目时，
  //     `memRootAbs`（记忆目录）**还不存在** ⇒ `realpathOf(root)` 返回 undefined
  //     ⇒ 这里回 `unknown-root` ⇒ **`ledger_init` 直接报"逃出了项目根"**
  //     ⇒ **正常新建项目全被拒**（那是比原来那个漏洞更严重的回归）。
  //   ★ 判据：**"基准不存在" 不等于 "路径不安全"** —— 前者是"还没建"，后者是"建到外面去了"。
  //     把两者混成同一个 `ok:false`，就会用"安全"的名义把正常功能锁死。
  //   ⇒ 修法：root 不存在时，**改用 root 的最近已存在祖先**做基准（一致性由词法层保证：
  //     目标词法上在 root 内 ⇒ 真实位置必在同一祖先内，除非中间有符号链接 —— 而那正是
  //     下面"逐段解真实路径"要查的）。
  //   ★ 为什么仍然安全：`anchor`（目标的最近已存在祖先）与 root 的祖先**必须一致**——
  //     若不一致（说明中间某段把路径带出去了），下面 `isUnder(anchorReal, targetReal)` 会拒。
  const rootReal = realpathOf(root);
  const rootAnchor = rootReal === undefined ? nearestExistingAncestor(root) : undefined;
  const rootBase = rootReal ?? (rootAnchor === undefined ? undefined : realpathOf(rootAnchor));
  if (rootBase === undefined) {
    // 连 root 的祖先都解析不出来（权限/全不存在）⇒ 不猜，报不可判定（调用方按拒绝处理）
    return { ok: false, why: `基准路径（及其祖先）都解析不出真实路径：${String(root)}`, lexical: "unknown-root" };
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
  if (!isUnder(rootBase, targetReal)) {
    return {
      ok: false,
      why:
        `路径越界（**真实路径**）：${String(target)} 词法上在项目内，但真实位置是 ${targetReal}，` +
        `落在 ${rootBase} 之外。★ 这通常意味着项目内有一处符号链接/Junction 指向了外部。`,
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
  // ② 跨卷：先判源是目录还是文件（含嵌套目录递归复制 + 逐文件字节校验，严拒符号链接）
  let st;
  try {
    st = fs.lstatSync(fromAbs);
  } catch (e) {
    return { ok: false, reason: `跨卷复制时读源属性失败（源文件未动）：${String(e?.message ?? e)}` };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, reason: `跨卷复制拒绝符号链接（源文件未动）：${fromAbs}` };
  }
  if (st.isDirectory()) {
    const copyDirVerified = (sDir, dDir) => {
      ensureDir(dDir);
      for (const ent of fs.readdirSync(sDir, { withFileTypes: true })) {
        const sChild = path.join(sDir, ent.name);
        const dChild = path.join(dDir, ent.name);
        if (ent.isSymbolicLink()) throw new Error(`目录内含符号链接：${sChild}`);
        if (ent.isDirectory()) {
          copyDirVerified(sChild, dChild);
        } else if (ent.isFile()) {
          const b = fs.readFileSync(sChild);
          fs.writeFileSync(dChild, b);
          const chk = fs.readFileSync(dChild);
          if (chk.length !== b.length || !chk.equals(b)) {
            throw new Error(`文件字节校验不一致：${dChild}`);
          }
        }
      }
    };
    try {
      copyDirVerified(fromAbs, toAbs);
    } catch (e) {
      return { ok: false, reason: `跨卷复制目录失败（源目录未删）：${String(e?.message ?? e)}` };
    }
    try {
      fs.rmSync(fromAbs, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, reason: `跨卷复制目录成功但删源失败（两份都在）：${String(e?.message ?? e)}` };
    }
    return { ok: true, how: "copy" };
  }
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

/**
 * ★★★★★ 2026-10-23（D316 · Gemini 审查 002 的 GAP-01）：**`memoryRoot` 越界时，一切写记忆的入口统一拒绝**。
 *
 * 🔴 病（对照 Git 审查 001 的 F-02 只修了一半）：我在 `writeLedger` 里加了拒绝守卫，
 *   但 `ledger_handoff` / `ledger_log_write` / `ledger_extension` / `ledger_archive` /
 *   `ledger_goals` / `ledger_lessons` **一个都没加** —— 而 `inspect()` 在 `memoryRoot` 越界时
 *   会把 `memoryBase` **降级回 `projectRoot`**。
 *   ⇒ 于是这些工具**照样 `ok:true`，把 `_handoff/` / 日志 / `extensions/` 写进源码根**。
 *   ★ 实测（`_probe-gemini002-findings.mjs` GAP-01）：源码根真的出现了 `_handoff/`、日志目录、`extensions/`。
 *
 * ★ 判据：**"同一个隐患，必须在所有入口用同一种处置"** ——
 *   只在最常用的那个入口设防，等于给其它入口留了一扇更大的门（因为用户会以为"这个功能是安全的"）。
 *   ★ 这与 D183「新增一类记忆必须同步问它该不该进公开仓库」是同一条纪律的两面：
 *     **同一类东西，必须用同一条规则**，逐点设防一定会漏。
 *
 * @param {object} info `inspect(root)` 的返回值
 * @returns {{ok:false, reason:string, hint?:string}|undefined} undefined = 安全，可以继续写
 */
export function refuseIfMemoryRootUnsafe(info, watchFields = []) {
  const unsafe = Array.isArray(info?.unsafePaths) ? info.unsafePaths : [];
  // ★★★★★ 2026-10-25（D320 · Gemini 审查 004 的 F-05 第二半）：
  //   **清单坏档时也必须拒绝写**，而不只是拒绝 `memoryRoot` 越界。
  //
  //   🔴 为什么必须在这里拦：清单坏掉 ⇒ `inspect` 读不出 `memoryRoot` ⇒ `memoryBase` 退回
  //     源码根 ⇒ 一切"写记忆"的路径都会**写进源码树**，而它们**全都**已经会调本函数。
  //     ⇒ 把坏档并进同一个拒绝口，就**一次性挡住了全部写入点**，不用在十几处各加一条。
  //     （这正是 D316 那条纪律正着用：同一隐患，所有入口同一种处置 —— 而"所有入口"
  //       指的就是"都走这一个函数"。）
  //   ★ 判据：**能复用的闸门就别新开一扇**；新开一扇必然漏掉某些入口。
  const badManifest = unsafe.find((u) => u && u.field === "manifest");
  if (badManifest !== undefined) {
    return {
      ok: false,
      reason:
        "`.dsh-ledger.json` **存在但读不出来**，所以这一次**什么都没写**：\n" +
        `  · 文件：\`${String(badManifest.value)}\`\n  · 原因：${String(badManifest.why)}\n` +
        "★ 为什么不能继续：读不出清单 ⇒ 拿不到 `memoryRoot` ⇒ 记忆基准会退回**项目源码根**，\n" +
        "  于是记忆会写进源码树，还会被 `git add` / npm 打包一起带走 —— 这是**泄露**，不是降级。\n" +
        "★ 修法：把 `.dsh-ledger.json` 修成合法 JSON（常见原因：尾随逗号 / 中文标点 / 少了 `active`），" +
        "或删掉它让插件按新项目处理。",
      hint: "fix-manifest-json",
    };
  }
  const bad = unsafe.find((u) => u && u.field === "memoryRoot");
  if (bad !== undefined) {
    return {
      ok: false,
      reason:
        `清单里的 \`memoryRoot\` 被拒绝，所以这一次**什么都没写**：\n` +
        `  · 值：\`${String(bad.value)}\`\n  · 原因：${String(bad.why)}\n` +
        "★ 为什么不继续（把记忆写回项目源码根）：那会让**你以为记忆隔离在子目录、实际全在源码根**，\n" +
        "  而且会被 `git add` / npm 打包一起带走 —— 这是**泄露**，不是降级。\n" +
        "★ 修法：把 `.dsh-ledger.json` 里的 `memoryRoot` 改成**项目内部的相对路径**（例如 `<项目名>-ledger-memory`），再重试。",
      unsafeManifestPath: bad,
      nothingWritten: true,
    };
  }
  const fields = Array.isArray(watchFields) ? watchFields : [watchFields];
  for (const f of fields) {
    const u = unsafe.find((x) => x && x.field === f);
    if (u !== undefined) {
      return {
        ok: false,
        reason:
          `清单里的 \`${u.field}\` 被拒绝，所以这一次**什么都没写**：\n  · 值：\`${String(u.value)}\`\n  · 原因：${String(u.why)}\n` +
          "★ 为什么不继续（降级成单文件写或改写别处）：那会让**你以为写到了配置的目标、实际写去了另一个文件** ——\n" +
          "  静默降级比直接报错更危险。\n" +
          `★ 修法：把 \`.dsh-ledger.json\` 里的 \`${u.field}\` 改成**项目内部的相对路径**，再重试。`,
        unsafeManifestPath: u,
        nothingWritten: true,
      };
    }
  }
  return undefined;
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
