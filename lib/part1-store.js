/**
 * part1 的「磁盘 store 与路径」子模块（D376 从 part1.js 拆出）。
 *
 * ★ 为什么单独一个文件：`part1.js` 距 241,664 紧线只剩 8,113 B，
 *   而这一簇（dshHome / lock / anchor / owed / blockHistory / capsule store …）
 *   **全是"算路径 + 读/写一个小 JSON"**，与设置归一化、压缩判定几乎无耦合 ⇒ 边界干净。
 * ★ 行为零变化：原 `part1.js` 用 `export { … } from "./part1-store.js"` 原样转出。
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANCHOR_STORE_FILE, BLOCK_HEADING_RE, BLOCK_HISTORY_FILE, BLOCK_HISTORY_MAX, BLOCK_HISTORY_TTL_MS, CAPABILITY_STORE_FILE, CAPSULE_STORE_FILE, LOCK_STORE_DIRNAME, LOCK_STORE_FILE, LOCK_STORE_PKG, LOCK_STORE_VERSION, OWED_STORE_FILE, OWED_STORE_MAX, PRINCIPLE_GRANT_TOOL, protocolGapOf } from "./defs.js";
import { ensureDir, readTextSafe, stamp, writeFileAtomic } from "./base.js";
import { isFingerprintLine, isFingerprintLinkLine, isInlineBeaconIn } from "./fingerprint.js";



export function dshHome() {
  const home = process.env.DSH_HOME;
  return typeof home === "string" && home !== "" ? home : path.join(os.homedir(), ".dsh");
}

/**
 * 锁记录文件路径。
 *
 * ★ 也**不**去读 `$DSH_HOME\sessions\`、`storages\`（红线）—— 这里只写自己的
 *   `plugin-data\<包名>\` 一个目录，与别家插件同一套规矩。
 *   ⚠️ 例外：`officialSessionPath()` 会**算**官方 sessions 的路径，
 *     但那只是**给模型一个指针**（我们既不读也不写它）—— 见那个函数的说明。
 */

export function lockStorePath() {
  return path.join(dshHome(), LOCK_STORE_DIRNAME, LOCK_STORE_PKG, LOCK_STORE_FILE);
}

/** 锁记录的形态版本（将来改结构时用来识别旧文件）。 */

export function readLockStore() {
  const empty = { version: LOCK_STORE_VERSION, bySession: {} };
  const raw = readTextSafe(lockStorePath());
  if (raw === undefined) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    const by = parsed.bySession;
    if (by === null || typeof by !== "object") return empty;
    // ★ 逐条校验：只收"sid→{root}"的条目，坏条目**丢掉而不是整份作废**
    //   （与 `parseLevels` 同一条纪律：一个坏字段不该毁掉整份配置）。
    const clean = {};
    for (const [sid, rec] of Object.entries(by)) {
      if (typeof sid !== "string" || sid === "") continue;
      if (rec === null || typeof rec !== "object") continue;
      if (typeof rec.root !== "string" || rec.root === "") continue;
      clean[sid] = {
        root: rec.root,
        cwd: typeof rec.cwd === "string" ? rec.cwd : undefined,
        at: typeof rec.at === "string" ? rec.at : undefined,
      };
    }
    return { version: LOCK_STORE_VERSION, bySession: clean };
  } catch {
    return empty;
  }
}

/**
 * 写锁记录（**吞错**：写不进去只影响"记不住"，绝不影响本次锁定生效）。
 *
 * ★ 用 `临时文件 + rename`（原子替换）：直接覆写时若进程被杀，
 *   会留下一份截断的 JSON ⇒ 下次读不出来 ⇒ **所有锁一起丢**。
 */

export function writeLockStore(store) {
  const file = lockStorePath();
  try {
    ensureDir(path.dirname(file));
    const _w = writeFileAtomic(file, JSON.stringify(store, null, 2) + "\n");
    if (_w.ok !== true) return { ok: false, path: file, reason: String(_w.reason ?? "原子写失败") };
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, path: file, reason: String((e && e.message) || e) };
  }
}

/**
 * ★★★ 增量压缩的**锚点也必须落盘**（2026-10-11，与项目锁同一处存）。
 *
 * 为什么：`state.deltaAnchor` 是**进程内 Map** ⇒ **内核每次重启就清空**，
 * 而判据是
 *
 *     const since = anchor === undefined ? pressure.ratio : pressure.ratio - anchor;
 *
 * ⇒ 锚点一空，`since` **退化成整个水位**（例如 41%）⇒ 20 点的闸门形同虚设
 *   ⇒ **重启后的第一次压缩必然触发**，而且插件会报"涨了 41 点"（恰好等于当时水位）。
 *
 * ★ 这是实测出来的，不是推测（2026-10-10，会话 fada6e5f 的官方日志）：
 *
 *     压缩时刻     压前水位   报"涨了 N 点"     判定
 *     12:03:07      50.2%        26            ✅ 真增量
 *     15:39:08      50.1%        28            ✅ 真增量
 *     16:12:23      35.4%        35            ★ N == 水位（锚点空）
 *     17:48:47      37.8%        38            ★ N == 水位（锚点为 1 分钟前重启清空）
 *     18:04:12      33.6%        34            ★ N == 水位
 *     18:33:41      41.2%        41            ★ N == 水位（内核 18:30:56 刚重启）
 *
 * ⇒ 与项目锁**同一个病灶**（进程内状态被重启清空），所以**用同一处存**：
 *   `$DSH_HOME\plugin-data\dsh-ledger-memory\anchors.json`。
 *   ★ 仍然**不碰用户的工作区**（那条红线不变）。
 */

export function anchorStorePath() {
  return path.join(path.dirname(lockStorePath()), ANCHOR_STORE_FILE);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★★ 2026-10-14（D196，用户拍板）：**功能清单**（capabilities）
// ═══════════════════════════════════════════════════════════════════════════
//
//  用户原话（逐字）：*"对了，我建议就是每个使用我们插件的都维护一个小的功能清单，
//  不然的话你插件更新之后，其他对话都不知道，然后还是用此前的规格去建这个系统。
//  就无法跟着更新。**但是我们插件维护的小的功能清单，不要把文件混杂到别人项目的文件里面**。"*
//
// ★★★ 这条正好补上 **D195 的反面**（两轮合起来才完整）：
//   · **D195**：**已登记**的能力 ⇒ 必须在契约里可见（否则模型不知道该用）；
//   · **D196**：**未登记**的能力 ⇒ **也必须让模型知道它存在**（否则旧项目永远升不上来）。
//   ★ 病根：契约里每条都带 `info.xxxRel !== undefined` 门控（"没登记就不出现"）——
//     这本身**是对的**（契约不许承诺不存在的东西），**但副作用是**：
//     **按旧规格建的项目，永远收不到"后来多了哪些能力"的通知** ⇒ 插件更新对它等于没发生。
//   ★ 实测（`tools/_probe-d196-capability-gap.mjs`）：造一个"旧规格项目"（只登记 active+decisions），
//     注入正文里**5/5 项新能力一个都没提**（目标树 / 回合流水 / 根本原则 / 经验与教训 / 活动日志）。
//     ⇒ ★ 这不是"少写一句"，而是**升级通道断了**：老项目只会照它当年那套规格一直跑。
//
// ★★ 用户的硬约束（**必须遵守，且正好与既有惯例对齐**）：
//   *"不要把文件混杂到别人项目的文件里面"* ⇒ 清单**不进任何项目目录**，
//     落在插件自己的家：`$DSH_HOME\plugin-data\dsh-ledger-memory\`
//     （`locks.json` / `anchors.json` / `blocks.json` … 本来就都在那儿，与别家插件同一套规矩）。
//   ★ 为什么放这里而不是每个项目里各放一份：项目目录是**用户的**（红线），
//     而这个清单是**插件自己的元数据**（"我这一版有哪些能力"），它跟**插件**走，不跟项目走。
//     ⇒ 换项目、删项目、项目还没建，清单都照旧有效。
//
// ★★★ 为什么还要**推行到注入**（光有文件不够 —— 与 D195 同一条纪律）：
//   清单文件存在 ≠ 模型会去读它。**"恢复必须是推给模型的"**（D46）。
//   ⇒ 所以下面既**写**清单，也把它**注入**进每回合的契约里。
//
// ⚠️ 如实说明它**照不到**的地方（不夸大）：`plugin-data` 是**本机**的。
//   若某个项目是在**另一台机**上用旧规格建的，这台机的清单照不到它 ——
//   但那种情况由**注入**覆盖（每个会话都会拿到当前版本的清单）。

/** 功能清单文件名（**插件自己的家**，不进用户项目）。 */

export function capabilityKinds() {
  return [
    {
      key: "active", infoField: "activeRel", label: "活跃台账", since: "0.1.0",
      usage: "`ledger_write({target:\"active\"})` 写，`ledger_read({target:\"active\"})` 读",
    },
    {
      key: "decisions", infoField: "decisionsRel", dirField: "decisionsDir", label: "关键决策", since: "0.1.0",
      usage: "`ledger_write({target:\"decisions\"})` 追加（不参与归档）",
    },
    {
      key: "archive", infoField: "archiveRel", label: "归档目录", since: "0.1.0",
      usage: "`ledger_archive` 归档；`ledger_read({target:\"archive\"})` 查",
    },
    {
      key: "log", infoField: "logRel", label: "活动日志", since: "D7",
      usage: "自动采集；`ledger_log` 按需查、`ledger_log_write` 写 L1 —— ★ 永不注入",
    },
    {
      key: "goals", infoField: "goalsRel", dirField: "goalsDir", label: "目标树", since: "D181",
      usage: "`ledger_goals`（卡片联成树；完成一个目标时补一条教训）",
    },
    {
      key: "journal", infoField: "journalRel", label: "回合流水", since: "D183",
      usage: "`ledger_write({target:\"journal\"})` 追加；`ledger_read({target:\"journal\"})` 查 —— ★ 不注入",
    },
    {
      key: "principles", infoField: "principlesRel", label: "根本原则", since: "D180",
      usage:
        "**只有用户能改**；你只能 `ledger_propose_principle` 提议，或 `" +
        PRINCIPLE_GRANT_TOOL +
        "` 请用户授权",
    },
    {
      key: "lessons", infoField: "lessonsRel", dirField: "lessonsDir", label: "经验与教训", since: "D192",
      usage: "`ledger_lessons`（教训 `cause` 必填 / 经验 `source` 必填；动手前先 `list` 一遍）",
    },
  ];
}

/**
 * 算"这个项目启用了哪些能力"（**只读** `info`，不碰磁盘）。
 *
 * ★ 保留判据与 `inspect` 一致：该字段是**非空字符串**才算登记。
 *
 * ★★★ **这里我当场栽过一次，必须留档**（D196）：
 *   第一版用 `${c.key}Rel` **拼**字段名。而 `key` 我写的是 `archiveDir` / `logDir`
 *   ⇒ 拼出来是 `archiveDirRel` / `logDirRel` —— **`inspect` 里根本没有这两个字段**
 *   （它给的是 `archiveRel` / `logRel`）。
 *   ⇒ 后果：**归档目录与活动日志永远被判成"未启用"**，
 *     连"全部启用"的项目也会被反复告知"你还没启用归档/日志"。
 *   ★★ 它**不会报错**（读 `undefined` 只是 falsy），所以是一类**静默的假阴性**：
 *     要让 `enabledKeysOf` 真报出 `info` 里确实有的字段，才测得出来。
 *   ⇒ 正解：**显式写 `infoField`**，不靠字符串拼 —— 拼出来的名字**没有任何东西保证它存在**。
 *     ★ 这正是本项目那条老纪律的形态：**字段名是"约定"，不是"查证过的接口"**。
 */

export function enabledKeysOf(info) {
  const on = new Set();
  for (const c of capabilityKinds()) {
    const v = info?.[c.infoField];
    const d = c.dirField === undefined ? undefined : info?.[c.dirField];
    if ((typeof v === "string" && v !== "") || (typeof d === "string" && d !== "")) on.add(c.key);
  }
  return on;
}

/**
 * 取**插件版本号**（唯一出口）。
 *
 * ★ 为什么读自己的 `package.json` 而不是写一个常量：写常量**一定会漂**
 *   （发了 1.2.0 忘了改常量 ⇒ 清单报旧版本，正是"记录存在≠记录准确"）。
 * ★★ 读不到就**如实返回 undefined**（不编一个版本号）——
 *   注入里会因此**不显示版本**，而不是显示一个假的。
 */

export function pluginVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // lib/
    const pkgPath = path.join(here, "..", "package.json");
    const raw = readTextSafe(pkgPath);
    if (raw === undefined) return undefined;
    const pkg = JSON.parse(raw);
    const v = pkg?.version;
    return typeof v === "string" && v !== "" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 功能清单文件路径（**插件自己的家** —— 用户的硬约束：不混进别人的项目）。
 */

export function capabilityStorePath() {
  return path.join(path.dirname(lockStorePath()), CAPABILITY_STORE_FILE);
}

/**
 * ★★★ 把"本版本有哪些能力"落盘成清单（**幂等**：内容没变就不写）。
 *
 * ★ 为什么每次都要能算出来并且**更新**：清单的意义就是**跟着插件版本走**。
 *   升了版本、加了能力 ⇒ 清单应当自动跟上（用户要的正是这个"跟着更新"）。
 * ★ 为什么幂等（内容相同不重写）：避免每次注入都动一次磁盘（无谓 IO +
 *   让"文件变新"这件事失去信息量）。
 * ★ 失败**绝不抛**（与 `locks.json` / `anchors.json` 同一口径）：
 *   清单写不出去不该让插件起不来或让注入失败。
 *
 * @returns {{path: string, written: boolean, version: string|undefined, count: number}}
 */

export function writeCapabilityManifest() {
  const p = capabilityStorePath();
  const version = pluginVersion();
  const payload = {
    schema: 1,
    plugin: LOCK_STORE_PKG,
    version: version ?? null,
    at: stamp(new Date()),
    // ★ 清单本身就是"功能清单"的正文：每项都带**怎么用**（否则只是一串名字）
    capabilities: capabilityKinds().map((c) => ({
      key: c.key,
      label: c.label,
      since: c.since,
      usage: c.usage,
    })),
  };
  let written = false;
  try {
    const prev = readTextSafe(p);
    // ★ 比较时**掐掉时间戳**：否则每次都会"看起来变了"⇒ 幂等失效。
    const strip = (s) => (s === undefined ? "" : s.replace(/^\s*"at":\s*"[^"]*",?\s*$/m, ""));
    const nextText = JSON.stringify(payload, null, 2) + "\n";
    if (strip(prev) !== strip(nextText)) {
      ensureDir(path.dirname(p));
      const _w = writeFileAtomic(p, nextText);
      if (_w.ok === true) written = true;
    }
  } catch {
    /* 清单写失败不挡任何事（与锁/锚点同一口径） */
  }
  return { path: p, written, version, count: capabilityKinds().length };
}

/**
 * ★★★★★ 渲染"**还没启用的能力**"那一段（D196 的核心产出）。
 *
 * ★ 判据：只报**本版本有、而这个项目没启用**的那些。
 *   ⇒ 模型看到它就会知道：**"这个插件还有这些能力，我可以问用户要不要用"**。
 *   ★★ 这正是"跟着更新"的机制：老项目不会永远停在旧规格上。
 *
 * ★ 两条文案纪律：
 *   ① **不催**：不写成"你应该启用" —— 启不启用是用户的决定（本插件一贯"不擅自创建"）；
 *   ② **给路径**：每条都带**怎么启用**，否则模型只知道"有这个东西"却不知道怎么开。
 *   ⇒ 与 D195 那条判据同源：**只列名字不够，必须带用法**。
 *
 * @returns {string} 渲染好的 Markdown 片段（没有可报的就返回空串）
 */

export function renderUnenabledCapabilities(info) {
  const on = enabledKeysOf(info);
  const off = capabilityKinds().filter((c) => !on.has(c.key));
  if (off.length === 0) return "";
  const v = pluginVersion();
  return (
    "\n### ★ 这个插件**还有这些能力**，本项目尚未启用（D196 · 功能清单）\n" +
    (v === undefined ? "" : `（当前插件版本：\`${v}\`）\n`) +
    "★ 以下是**本版本插件带、但本项目清单里没登记**的记忆能力 —— 上面没列它们**不代表没有**。\n" +
    "★ 用途：**你在按旧规格维持这个项目时，要能知道后来多了什么**（否则插件更新对你等于没发生）。\n" +
    "★ **要不要启用由用户决定** —— 想用就**问用户**，别自己往项目里加文件（本插件不擅自创建）。\n\n" +
    off.map((c) => `- **${c.label}**（自 ${c.since}）—— ${c.usage}`).join("\n") +
    "\n"
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★★ 2026-10-14（D197，用户拍板）：**骨架 + 协议** —— 让每条记忆都"填得对"
// ═══════════════════════════════════════════════════════════════════════════
//
//  用户原话（逐字）：*"最好就是插件本体在被指定项目之后就会**自动生成所需要的各项文件**，
//  然后由 AI 填写就可以了。然后 AI 自己也要从清单那里知道，**并且他要知道协议**，
//  也就是**他连协议都不知道的话，就很难去填这些东西**，以及按照插件的更新
//  去把老版本的文件拆分成新的文件。或者是按照新版本去更新新的台账系统和日志系统。"*
//
// ★★★ 这是 D196 的**下一层**（两轮递进，别混为一谈）：
//   · **D196**：模型知不知道该能力**存在**（可见性）；
//   · **D197**：模型知不知道每个文件的**格式协议**（能不能填对）。
//     ⇒ 用户那句"**不知道协议就很难去填**"是**准的**，而且实测比"能不能填对"更严重：
//       实测**协议 7/7 项都没推行**（`tools/_probe-d197-protocol-gap.mjs`）。
//
// ★★ 必须分清"协议"的两种形态（我核过，别把已经有的报成缺的）：
//   · **A. 工具参数协议**：走 `ledger_goals({op:"upsert",…})` 时，字段由**工具 schema** 定，
//     而工具定义**本来就在模型上下文里** ⇒ **这一面不缺**。
//   · **B. 文件正文协议**：模型**直接写文件内容**时（`initial*` 参数、以及**把老文件拆成新文件**）
//     才需要 ⇒ **这一面缺**。
//   ⇒ 判据：**哪些文件的格式是插件自己解析的，那些格式就必须算"协议"，必须推行。**
//     · `goals` ⇒ 插件 `parseGoalCards` 解析 ⇒ **格式固定**；
//     · `lessons` ⇒ 插件 `parseLessonEntries` 解析 ⇒ **格式固定**；
//     · `decisions` ⇒ 自检按 `^## D(\d+)` 查**引用必达** ⇒ **格式固定**；
//     · `journal` ⇒ 只追加、不解析 ⇒ 格式较自由（仍给形状）；
//     · `active` ⇒ **用户明说"结构由 AI 设计"** ⇒ **不锁格式**（只给起手骨架）；
//     · `principles` ⇒ **用户的文件，模型无权创建**（D180）⇒ **绝不给骨架**。
//
// ★★★ 为什么还要**骨架**（不只是协议）：
//   协议告诉模型"该长什么样"，骨架**把文件先建出来**（带表头与格式提示）⇒
//   ① 模型不必"先想格式再落笔"，**照着填**即可；② 格式从一开始就是对的，
//   不会出现"写了半天、插件解析不到"（那正是"他连协议都不知道就很难填"的后果）。
//   ★ 与前几轮"不擅自创建"的界线：**`ledger_init` 是用户明确要建项目的动作**
//     （不是工具顺手创建）⇒ 在这里建骨架是用户要的；而 `ledger_goals`/`ledger_lessons`
//     **仍然不凭空创建**（那两个是"日常写"的工具，不是"建项目"的动作）。

/**
 * ★★★ **每种记忆文件的骨架与协议 —— 单一出处**（骨架与注入那一段都由它渲染）。
 *
 * ★ 为什么不手抄进文档：手抄必漂（纪律 11）。这里的字符串**就是**解析器认的形状。
 * ★★ `skeleton` 与 `protocol` 分开：骨架是**文件里的**（给人和 AI 看），
 *   协议是**注入里的**（每回合提醒模型"格式别写错"）。
 */

export function fileSpecs() {
  return {
    active: {
      label: "活跃台账",
      // ★ 唯一**不锁格式**的文件：用户明说"结构由 AI 自己设计"。
      //   ⇒ 骨架只给**起手提示**，不规定分节（那是 AI 的判断）。
      skeleton:
        "# 项目台账 · 当前状态\n\n" +
        "> ★ **结构由你（AI）按项目类型设计** —— 插件只做流程，不预设模板。\n" +
        "> ★ 建议包含：项目目标 / 已完成 / 进行中 / 下一步 / 关键锚点（自己调整）。\n" +
        "> ★ 保持精简（上限见下方注入的「台账约定」）；超了先用 `ledger_archive` 归档最旧的已完成条目。\n",
      protocol: "", // ★ 刻意留空：它的格式**不由插件解析** ⇒ 不进"协议"那一段
    },
    decisions: {
      label: "关键决策",
      skeleton:
        "# 关键决策（长期保留 · 不参与归档）\n\n" +
        "> ★ 每条一行标题：`## D<n> · <一句话标题>`（n 递增、**不重用**）。\n" +
        "> ★ 台账里会写 `见 D<n>` —— 自检**会核对「引用必达」**（引用了却没有正文 ⇒ 当场变红）。\n" +
        "> ★ 追加用 `ledger_write({target:\"decisions\", mode:\"append\"})`。\n",
      protocol:
        "每条 `## D<n> · <标题>`（n 递增不重用）。台账用 `D<n>` 引用 ⇒ **引用必达**（引用了必须有正文）。" +
        "追加：`ledger_write({target:\"decisions\", mode:\"append\"})`。",
    },
    journal: {
      label: "回合流水",
      skeleton: "# 回合流水（只追加 · 不注入上下文）\n\n> ★ 按天/按会话**只追加**；**不要改旧条目**（发生过就是历史）。\n" +
        "> ★ 它**不注入**——要查早期某一段时才用 `ledger_read({target:\"journal\"})`。\n",
      protocol: "只追加、**不改旧条目**。写：`ledger_write({target:\"journal\"})`（默认 append）；查：`ledger_read({target:\"journal\"})`。★ 它**不注入**。",
    },
    goals: {
      label: "目标树",
      skeleton: "# 目标树\n\n" +
        "> ★ **卡片格式固定**（插件按这个解析；格式错了就**读不到**）：\n" +
        "> ```\n> ## 目标 <id> · <状态>\n> - parent: <父id 或 ->\n> - title: 一句话目标\n> - 更新于: <YYYY-MM-DD HH:mm>   ← 插件写卡时自动加，别手改\n> - 关键结果: 可选 · 可多行\n> - 教训: 可选 · 可多行\n> ```\n" +
        "> ★ `<状态>` 只能取：`root` / `active` / `paused` / `done` / `dropped`。\n" +
        "> ★ 优先用 `ledger_goals`（它保证格式对）；手写文件时**照上面的形状**。\n",
      protocol:
        "**卡片格式固定**（插件按此解析）：`## 目标 <id> · <状态>` + `- parent: <父id 或 ->` + `- title: …`" +
        " + `- 更新于: <YYYY-MM-DD HH:mm>`（★ **插件写卡时自动加，别手改** —— 它决定「已完成」的权重衰减与「多久没动」）" +
        " + 可多行 `- 关键结果: …` / `- 教训: …`。★ 状态只能取 `root`/`active`/`paused`/`done`/`dropped`。" +
        "★ 优先用 `ledger_goals`（保证格式对）；**手写文件必须照这个形状**。",
    },
    lessons: {
      label: "经验与教训",
      skeleton: "# 经验与教训\n\n" +
        "> ★ **两类条目，格式固定**（插件按这个解析）：\n" +
        "> ```\n> ## 经验 E<n> · <机制|入口|约定|速查|其他>\n> - 标题: …\n> - 出处: <文件:行号 / 探针 / 实测命令>   ← **经验必填**\n> - 正解: …\n> ```\n" +
        "> ```\n> ## 教训 L<n> · <尺子错|夹具错|守卫错|假设错|记录错|其他>\n> - 标题: …\n> - 根因: …   ← **教训必填**\n> - 正解: …\n> ```\n" +
        "> ★ 两类**各自编号**（`L<n>` / `E<n>`，不重用）。\n",
      protocol:
        "**格式固定**：`## 经验 E<n> · <kind>` 或 `## 教训 L<n> · <kind>`，随后 `- 标题:` 起若干 `- key: value`。" +
        "★ 经验 kind ∈ 机制/入口/约定/速查/其他，**`- 出处:` 必填**；" +
        "教训 kind ∈ 尺子错/夹具错/守卫错/假设错/记录错/其他，**`- 根因:` 必填**。★ 优先用 `ledger_lessons`。",
    },
  };
}

/** 取某类文件的骨架（没有就给空串 —— **`active`/`principles` 刻意不给**）。 */

export function skeletonOf(key) {
  return fileSpecs()[key]?.skeleton ?? "";
}

/**
 * ★★★★★ 渲染"**格式协议**"那一段（D197 的核心产出）。
 *
 * ★ 判据：**只报这个项目真的启用了的文件**（没启用的由 D196 那一段负责介绍）。
 *   ⇒ 两条各管一面，不重复：D196 = "还有什么能用"；D197 = "在用的这些该怎么写"。
 * ★ 为什么必须**每回合**都在：模型随时可能直接写这些文件（改老文件、拆分、迁移），
 *   而它**不会记得**上一次看过的格式。这东西很小（几百字），代价远低于"写错格式"。
 *
 * @returns {string} 渲染好的 Markdown 片段（没有可报的就返回空串）
 */

/**
 * ★★★★★ 2026-10-19（D272，用户拍板）：**协议过期时的义务提示**。
 *
 * 用户原话（逐字）：*"如果不符合的话，模型会主动向用户提出要求，询问是否要更新当前的
 * 协议和结构……这就意味着模型不会把它当成一个任务去做。"*
 *
 * ★★ 与 `renderProtocolBlock` 的分工（**各管一面，刻意相邻而不重复**）：
 *   · `renderProtocolBlock`  = "你正在用的这些，格式该怎么写"（已启用）
 *   · `renderUnenabledCapabilities` = "这个版本还带了什么能用"（未启用）
 *   · **本函数** = "**你这个项目的架构本身旧了，这是需要你主动去做的一件事**"
 *
 * ★ 三条设计依据（都来自本项目已栽过的坑）：
 *   ① **义务句式而非告知句式**：写"你必须在开场问用户"而不是"这个项目是旧的"——
 *      后者会被模型当背景资料读过去（D195/D196 反复验证过这一点）。
 *   ② **必须在开场问**：把时机写死。否则模型会"等有空再说"，而那件事永远不会发生。
 *   ③ **说清代价**：只说"缺 decisionsDir"等于让人猜；要说清"不升会怎样"。
 *
 * ⚠️ 只在 `outdated` 时输出；`projectVersion > currentVersion` 时**输出空串**
 *   （别人用更新的插件建的项目，旧插件不催他回退 —— 不前向破坏）。
 */
export function renderProtocolUpgradeNotice(info) {
  // ★ D272 第三轮：用户已经答过「暂时不升级」⇒ 换成"现状陈述"，**不再命令他必须处理**。
  //   判据见 `renderProtocolDeclinedNote` 的注释（告知义务 ≠ 催促频率）。
  const declined = renderProtocolDeclinedNote(info);
  if (declined !== "") return declined;

  const g = protocolGapOf(info?.manifest);
  if (g.outdated !== true) return "";

  // ★ 缺口为空也是一种"过期"：清单里字段齐全，只是**没写 protocolVersion**。
  //   那时不该吓唬用户说"架构旧了"，而该说清"只需补一个版本号"。
  const hasGaps = g.missing.length > 0;
  const lines = [];
  lines.push(
    "\n### 🔴 本项目记忆协议**停在旧版本**（第 " + g.projectVersion + " 代 / 现为第 " + g.currentVersion + " 代）"
  );
  lines.push("");
  lines.push("★ **这是你本次开场必须主动处理的一件事**（不要等用户问、也不要当成背景资料读过去）。");
  if (hasGaps) {
    lines.push("");
    lines.push("**这个项目缺下列结构**，所以它一直停留在旧架构：");
    for (const m of g.missing) {
      lines.push(`- **${m.label}** —— ${m.why}`);
      lines.push(`  · 清单里缺：${m.keys.map((k) => `\`${k}\``).join(" / ")}`);
    }
    lines.push("");
    lines.push(
      "**你该做的**：在**本回合开头**就问用户——" +
        "「这个项目的记忆结构还是旧版（" +
        g.missing.map((m) => m.label).join(" / ") +
        "），要不要我升级成新结构？**只做加法**：补清单字段、建空目录，绝不改写或删除已有内容。」"
    );
    lines.push("★ **不要自己先动手** —— 建目录/改清单会改动用户项目结构，必须**先得到他同意**。");
    lines.push(
      "★ 他同意之后：补清单键 + 建空目录 + 把 `protocolVersion` 写成 " +
        g.currentVersion +
        "，然后**把已有内容搬进新结构**（例如把单文件拆成一卡一文件）。"
    );
  } else {
    lines.push("");
    lines.push("★ 结构其实已经齐全（卡片化 / 日志分片都在），**只是清单里没写协议版本号**。");
    lines.push(
      "**你该做的**：本回合开场问用户一句——「要不要我把协议版本补记成第 " +
        g.currentVersion +
        " 代？」他同意后，在清单里补 `protocolVersion: " +
        g.currentVersion +
        "` 即可（**纯加一个字段，不动任何内容**）。"
    );
  }
  // ★ 用 "\n" 连接 —— 每条 `lines` 是**一整行**，行与行之间必须换行。
  //   ▶ 其余 2 行详注已抽到 源码注释/part1.md（原 part1.js:946-948）
  return lines.join("\n") + "\n";
}

/**
 * ★★★★★ 2026-10-19（D272 第三轮）：**用户已经说了「不用改」之后，这段该怎么说。**
 *
 * 🔴 病（我在上面那个函数里埋的）：它每回合都写
 *   「★ **这是你本次开场必须主动处理的一件事**」。
 * 于是：
 *   ① 用户在合规卡上选了「不用改」 ⇒ `conformNext` 明确告诉他
 *      「**不要再动这个项目的台账结构**」；而下一回合注入又命令他
 *      「**你必须主动处理**」⇒ **两条指令直接打架**，而它们都来自我们。
 *   ② 就算用户没被问过（例如他根本没碰那张卡），每回合重复同一段"必须"，
 *      会让模型把这段当背景噪声读过去 —— **催得越勤，越没人听**。
 *
 * ★ 判据：**"告知义务"和"催促频率"是两件事。**
 *   · 告知：**每回合都要说**（否则模型会忘 —— D46 那条"推，不是等它来查"）；
 *   · 催促：**只在还没被答复过时说**，答复过就降级成"现状陈述 + 不要擅自改"。
 *
 * ★ 谁记"已经拒绝过"：`ledger_conform` 的答复走 `state.conformAsked`（会话级 Set）。
 *   这里拿不到那个 Set（`renderInjectionBody` 是纯函数），所以用**盘上的事实**判：
 *   清单里有没有 `protocolDeclined` 这个键（由拒绝那条路写下去）。
 *   ★ 用"盘上的事实"而不是"进程内状态"还有一个好处：**跨重启也记得**
 *     （用户说过一次不用改，不该因为重启就又被催一遍）。
 */
export function renderProtocolDeclinedNote(info) {
  const m = info?.manifest;
  if (m === null || typeof m !== "object") return "";
  const declinedAt = m.protocolDeclined;
  if (typeof declinedAt !== "string" || declinedAt === "") return "";
  const g = protocolGapOf(m);
  // 用户后来自行升级了（缺口没了）⇒ 这条提醒自然消失，不需要他再去清标记。
  if (g.outdated !== true) return "";
  return (
    "\n### 记忆协议：仍是旧版（**用户已知情并选择保持现状**）\n\n" +
    "★ 用户在 " +
    declinedAt +
    " 已经回答过这个问题：**暂时不升级**。\n" +
    "★ 所以：**不要再主动问他这件事**，也不要自己动手改结构（补键 / 建目录 / 迁移卡片）。\n" +
    "★ 但仍要知道现状：这个项目的记忆仍是第 " +
    g.projectVersion +
    " 代（现为第 " +
    g.currentVersion +
    " 代），" +
    (g.missing.length > 0
      ? "缺：" + g.missing.map((x) => x.label).join(" / ") + "。"
      : "结构齐全，只差版本号。") +
    "\n★ 什么情况下可以再提：用户自己问起、或他明确说要升级。**别的时候一个字都不用说。**\n"
  );
}

export function renderProtocolBlock(info) {
  const specs = fileSpecs();
  const on = enabledKeysOf(info);
  // ★ 只报**启用了**且**有固定协议**的那些（`active` 不锁格式、`principles` 无权创建）。
  //   ▶ 其余 2 行详注已抽到 源码注释/part1.md（原 part1.js:1003-1005）
  const items = ["decisions", "journal", "goals", "lessons"].filter(
    (k) => on.has(k) && specs[k] !== undefined && String(specs[k].protocol ?? "").trim() !== ""
  );
  if (items.length === 0) return "";
  return (
    "\n### ★ 文件格式协议（**写这些文件前先看这一节** · D197）\n" +
    "★ 这些文件的格式**是插件解析用的** —— **写错格式 = 插件读不到**（内容还在，但等于白写）。\n" +
    "★ 优先用对应工具（它保证格式对）；**手写 / 迁移 / 拆分老文件时，必须照下面的形状**。\n\n" +
    items.map((k) => `- **${specs[k].label}**：${specs[k].protocol}`).join("\n") +
    "\n"
  );
}

/** 读锚点记录：`{ version, bySession: { sid: ratio } }`（坏条目丢掉，不整份作废）。 */

export function readAnchorStore() {
  const empty = { version: 1, bySession: {} };
  const raw = readTextSafe(anchorStorePath());
  if (raw === undefined) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    const by = parsed.bySession;
    if (by === null || typeof by !== "object") return empty;
    const clean = {};
    for (const [sid, v] of Object.entries(by)) {
      if (typeof sid !== "string" || sid === "") continue;
      if (!Number.isFinite(v) || v < 0 || v > 1) continue;
      clean[sid] = v;
    }
    return { version: 1, bySession: clean };
  } catch {
    return empty;
  }
}

/** 写锚点记录（吞错 + 临时文件改名；写不进去只影响"记不住"）。 */

export function writeAnchorStore(store) {
  const file = anchorStorePath();
  try {
    ensureDir(path.dirname(file));
    const _w = writeFileAtomic(file, JSON.stringify(store, null, 2) + "\n");
    if (_w.ok !== true) return { ok: false, path: file, reason: String(_w.reason ?? "原子写失败") };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★★ 2026-10-17（D231，用户拍板方向②）：**「欠着的收尾义务」落盘**
// ═══════════════════════════════════════════════════════════════════════════
//
//  用户原话（逐字）：*"很多对话都是在下一个对话才补归档和分流，以及这些都是义务…
//  万一刚好结束对话的时候，落到压缩中的话，就会很麻烦。"*
//
//  ★★★ 病根（**读代码确认，不是推理**）：
//    义务提醒挂在 `agent/pre-step`（回合**开头**），而义务截止在回合**末尾** ——
//    走到回合末时插件**没有任何机会再出声**。
//    ⇒ 而记账用的 `state.turnObligationPending` 是**进程内 Map** ⇒
//      **进程一死（关窗口 / 崩溃 / 重启）就没了** ⇒ "上一条欠了什么"**跨进程不可见**。
//    ⇒ 所以他担心的"结束对话时正落入压缩"那一幕里，**连"欠着"这件事本身都会消失**。
//
//  ★ 修法：在 `turn/end` 那一刻把"欠了什么"**落盘**（`owed.json`）。
//    · 与 `locks.json` / `anchors.json` **同目录、同一套"临时文件 + 改名"、同一个吞错**；
//    · 只写 `$DSH_HOME\plugin-data\<包名>\`，**绝不碰用户工作区**（红线不变）；
//    · ⛔ **绝不在这里替模型写台账内容** —— 那会产出"看似完整其实空洞"的条目，
//      比欠着更坏（用户 D231 也否掉了这条路）。
//      ⇒ 落盘的只是**欠账凭据**，不是台账本身。
// ═══════════════════════════════════════════════════════════════════════════

/** 欠账记录文件路径（与锁、锚点同一个目录）。 */

export function owedStorePath() {
  return path.join(path.dirname(lockStorePath()), OWED_STORE_FILE);
}

/**
 * 读欠账记录：`{ version, bySession: { sid: { at, wrote, triaged, root, tag } } }`。
 *
 * ★ 全程吞错 + 逐条校验（坏条目丢掉而不是整份作废）—— 与 `readLockStore` 同一套。
 */

export function readOwedStore() {
  const empty = { version: 1, bySession: {} };
  const raw = readTextSafe(owedStorePath());
  if (raw === undefined) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    const by = parsed.bySession;
    if (by === null || typeof by !== "object") return empty;
    const clean = {};
    for (const [sid, rec] of Object.entries(by)) {
      if (typeof sid !== "string" || sid === "") continue;
      if (rec === null || typeof rec !== "object") continue;
      // ★ 只有"真的欠着"才收：两个都兑现的条目**不许留在盘上**（否则下次假报欠账）。
      if (rec.wrote === true && rec.triaged === true) continue;
      clean[sid] = {
        at: Number.isFinite(rec.at) ? rec.at : 0,
        wrote: rec.wrote === true,
        triaged: rec.triaged === true,
        root: typeof rec.root === "string" ? rec.root : undefined,
        tag: typeof rec.tag === "string" ? rec.tag : undefined,
      };
    }
    return { version: 1, bySession: clean };
  } catch {
    return empty;
  }
}

/** 写欠账记录（吞错 + 临时文件改名；写不进去只影响"记不住"，绝不影响主流程）。 */

export function writeOwedStore(store) {
  const file = owedStorePath();
  try {
    ensureDir(path.dirname(file));
    const _w = writeFileAtomic(file, JSON.stringify(store, null, 2) + "\n");
    if (_w.ok !== true) return { ok: false, path: file, reason: String(_w.reason ?? "原子写失败") };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/**
 * 记下 / 清掉一场对话的欠账 —— **唯一出口**（两个调用点都走这里，不许别处直接写盘）。
 *
 * ★ 为什么必须是唯一出口：本项目反复栽在"两处各写一套判据"上（D170/D222 都是）。
 *
 * @param {string} sid 会话编号
 * @param {{wrote:boolean, triaged:boolean, root?:string, tag?:string}} rec 本回合兑现情况
 * @returns {{ok:boolean, owed:boolean}}
 */

export function recordOwed(sid, rec) {
  if (typeof sid !== "string" || sid === "") return { ok: false, owed: false };
  const store = readOwedStore();
  const owed = rec?.wrote !== true || rec?.triaged !== true;
  if (!owed) {
    // 都兑现了 ⇒ 从盘上删掉（否则下一场会读到一条早已还清的假欠账）。
    if (store.bySession[sid] !== undefined) {
      delete store.bySession[sid];
      writeOwedStore(store);
    }
    return { ok: true, owed: false };
  }
  store.bySession[sid] = {
    at: Date.now(),
    wrote: rec?.wrote === true,
    triaged: rec?.triaged === true,
    root: typeof rec?.root === "string" ? rec.root : undefined,
    tag: typeof rec?.tag === "string" ? rec.tag : undefined,
  };
  // ★ 防无限增长：只留最近 `OWED_STORE_MAX` 场（欠账是"最近欠的"，老账没有意义）。
  const entries = Object.entries(store.bySession);
  if (entries.length > OWED_STORE_MAX) {
    entries.sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0));
    store.bySession = Object.fromEntries(entries.slice(0, OWED_STORE_MAX));
  }
  const w = writeOwedStore(store);
  return { ok: w.ok === true, owed: true };
}

/** 取一场对话在盘上有没有未还的欠账（**跨进程**可查）。 */

export function owedFor(sid) {
  if (typeof sid !== "string" || sid === "") return undefined;
  return readOwedStore().bySession[sid];
}

/**
 * 取这一场对话的压缩锚点（内存优先，其次落盘的那份）。
 * ★ **唯一的取锚点出口** —— 与项目锁同一条纪律：不许别处再直接读 Map
 *   （D51/D52 都是"写了新判定却漏了旧调用点"出的缺口）。
 */

export function anchorOf(state, key) {
  const mem = state?.deltaAnchor?.get(key);
  if (Number.isFinite(mem)) return mem;
  const disk = readAnchorStore().bySession[key];
  return Number.isFinite(disk) ? disk : undefined;
}

/** 记下这一场对话的锚点（内存 + 落盘各一份）。 */

export function setAnchor(state, key, ratio) {
  if (!Number.isFinite(ratio)) return;
  const v = Math.max(0, Math.min(1, ratio));
  state?.deltaAnchor?.set(key, v);
  const store = readAnchorStore();
  store.bySession[key] = v;
  writeAnchorStore(store);
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★★ 2026-10-12（D136）**区块变更史** —— 「权重可变」在磁盘上的支点
//
//   ★ 用户要求（逐字）：*"权重应该是可变的，正在处理的东西与所有底线与原则毫无疑问
//     是高分，已处理的、已过期的低分，**时间是打分标准之一**"*。
//
//   ★★★ 为什么必须有它（实测撞到，不是推断）：
//     `mechanicalWeight` 的时间分与"长期稳定分"都要问"这块上次什么时候变的"，
//     而没有变更史时它只能拿到 `undefined` ⇒ **时间分恒 0** ⇒ 25 块全落到同一档，
//     "可变"当场变成一句空话。★ 我上一版就是这么白测的（自己造了整齐的假历史 ⇒
//     算出 92.9% 必注，那个数**是假的**，已作废）。
//
//   ★ 存法**照抄已验证的 `anchors.json`**（同一目录、同一套"临时文件 + 改名"、
//     同一个吞错习惯）—— 本项目纪律：**别另发明一套持久化**。
//   ★ 仍然**不碰用户的工作区**：落在 `$DSH_HOME\plugin-data\`（那条红线不变）。
// ═══════════════════════════════════════════════════════════════════════════

export function blockHistoryPath() {
  return path.join(path.dirname(lockStorePath()), BLOCK_HISTORY_FILE);
}

/** 读区块变更史：`{ version, byRoot: { root: { writes, lastWriteAt, present, blocks } } }`。 */

export function readBlockHistory() {
  const empty = { version: 1, byRoot: {} };
  const raw = readTextSafe(blockHistoryPath());
  if (raw === undefined) return empty;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return empty;
    const by = parsed.byRoot;
    if (by === null || typeof by !== "object") return empty;
    return { version: 1, byRoot: by };
  } catch {
    return empty;
  }
}

/** 写区块变更史（吞错 + 临时文件改名；写不进去只影响"记不住"）。 */

export function writeBlockHistory(store) {
  const file = blockHistoryPath();
  try {
    ensureDir(path.dirname(file));
    const _w = writeFileAtomic(file, JSON.stringify(store) + "\n");
    if (_w.ok !== true) return { ok: false, path: file, reason: String(_w.reason ?? "原子写失败") };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ★★★ 胶囊素材落盘（D61 修复）—— 「重启后首次压缩的胶囊质量最差」的解药
//   与 `anchorStore` **同一个套路、同一个目录**（实证有效的先例，别另发明一套）。
// ═══════════════════════════════════════════════════════════════════════════

/** 胶囊素材记录文件路径（与锁/锚点同一个目录）。 */

export function capsuleStorePath() {
  return path.join(path.dirname(lockStorePath()), CAPSULE_STORE_FILE);
}
