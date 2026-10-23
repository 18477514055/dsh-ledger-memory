import fs from "node:fs";
import path from "node:path";

import { inspect, isUnder, isUnderReal, memoryBaseOf, readTextSafe, stamp, writeFileAtomic } from "./part2.js";
import { cardDirAbs, isSafeCardKey, listCards, readCard, writeCard } from "./part4.js";

/**
 * ★★★★★ 2026-10-21（D299 · V3 阶段 4）：**项目专属的自定义扩展记忆**（1.5.0）。
 *
 * 用户口径（任务书 §六）：**插件保留完整且稳定的基础记忆协议，用户只负责根据自己项目的需要
 * 添加额外记忆类型。** 扩展是**附加层**，不是替代品 —— 这句话决定了本文件的全部设计。
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ★★★ 一条贯穿全文的判据：**扩展只能"借用"基础记忆的管理语义，不能"改变"它。**
 *
 *   用户建一个「Boss机制记录」并选「决策型」，意思是"按决策卡那套规则来管"，
 *   **不是**"让插件以后把所有决策都当成 Boss 记录"。
 *   ⇒ 所以本文件里的每个模式都**只映射到一个独立的存储位置**，
 *     绝不回写 `decisions/` / `LEDGER.md` / `JOURNAL.md` 这些核心位置。
 *   ★ 探针里有一条专门打这个：**建满 7 种模式的扩展之后，核心文件必须一个字节没变。**
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ★★★ 存储布局（**全部住在 `memoryBase` 里**，绝不写项目根）：
 *
 *   <memoryBase>/extensions/registry.json          ← 注册表（唯一真源）
 *   <memoryBase>/extensions/<id>/cards/<key>.md    ← 卡片型模式（decisions/lessons/goals）
 *   <memoryBase>/extensions/<id>/content.md        ← 单文件型模式（active/journal/plain）
 *   <memoryBase>/extensions/<id>/PRINCIPLES.md     ← 原则型（仅用户授权可改）
 *
 * ★ 为什么注册表放在 `extensions/` 下、而不是塞进 `.dsh-ledger.json`：
 *   清单是**寻址**用的（指路），扩展是**内容**（记忆）。两者混在一起会让"清单坏了"
 *   与"记忆坏了"变成同一件事。★ 与 D183「状态与历史分文件」是同一条judgment。
 */

// ═══════════════════════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════════════════════

/** 扩展树在记忆目录里的相对位置。 */
export const EXT_DIR = "extensions";
/** 注册表文件名。 */
export const EXT_REGISTRY = "registry.json";
/** 注册表 schema 版本（将来加字段时用它判断怎么读）。 */
export const EXT_SCHEMA_VERSION = 1;

/**
 * ★★★ **六种模式**（任务书 §6.2 字段三；★ **D311 去掉了「原则型」，7 → 6**）。
 *
 * `storage` 决定它长什么样、怎么读写：
 *   · `card`    —— 一卡一文件（复用 `listCards`/`readCard`/`writeCard`）
 *   · `single`  —— 单文件整份读写
 * `protect` 为 true ⇒ **模型不能直接写**，必须走用户授权。
 * `append`  为 true ⇒ **只追加、不覆盖**（流水型）。
 *
 * ★ 为什么把这三样做成数据而不是 if/else 分支：
 *   以后加模式只改这张表；而 if/else 散在各处时，**漏一处就有一条路绕过保护**。
 *   ★ 本机已栽过：D267 的 F02 就是"只查了文件、没查目录"。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★★★★ 2026-10-23（D311 · 用户拍板）：**去掉「原则型」扩展模式（7 → 6）。**
 *
 * 用户原话（逐字）：*"先去掉扩展记忆中的原则吧，感觉首先原则这个文件就不大，
 * 没必要在用户自己额外扩展一个。"*
 * 随后补了一句关键的现场事实（逐字）：*"事实上我从现在开发出这个以来，从来没有用过任何的
 * 扩展的原则啊，所有的原则都是经过授权后由模型在根本原则文件中写的。"*
 *
 * 🔴 为什么该去掉（三条，第一条是用户说的，第二三条是审计实测）：
 *   ① **没有语义**：原则本来就只有一个出处（核心 `PRINCIPLES.md`），
 *      "再额外扩展一个原则"这件事本身说不通；
 *   ② **它是个填不进去的空壳**（审计员 010 的 F-06，我已复现）：
 *      `writeExtension` 对 `protect === true` **一律拒绝**（这是对的），
 *      而全系统**没有任何第二条路**——面板 `POST /extensions.json` 只收 `create`/`update`/`delete`
 *      （**没有写正文的 op**）；核心那条授权闸（`ledger_principles_access` +
 *      `ledger_propose_principle` + `/ledger principles approve`）**只服务核心文件，一个字没接给扩展**。
 *      ⇒ 用户建了它，只会得到一个永远填不进去的文件；
 *   ③ **它从未被用过**：本机 `D:\Deepseek工作区` 下 **0 个 `registry.json`**；
 *      而 npm 上 `latest = 1.3.0`、**1.5.0 从未发布**，扩展记忆整个功能都还没到过任何用户手上。
 *
 * ★★★ **所以这里可以"真删"，而不是"退役保留"** —— 但**判据必须说清楚**，
 *   因为一字之差就是数据丢失：
 *     · 我第一版写的是「保留模式 + 标记 `retired: true`（不许新建，但老数据仍可读/可删）」。
 *       那个方案的**前提是"外面可能已经有人的原则型扩展"**。
 *     · 用户这句话 + 我实测的两条（0 个 registry / 1.5.0 未发布）把这个前提**证伪了**。
 *     · 前提不存在 ⇒ 兼容层就是在保护**不存在的数据**，而代价是留一条永远走不通的旧路。
 *   ⇒ 判据：**兼容层的代价必须由"真的存在的数据"来付**；
 *     没有存量时，"保留旧路径"不是稳妥，是**留下一个假的现在时**。
 *   ★ 反过来说：如果哪天 1.5.0 已经发出去过、且有人建过原则型扩展，
 *     那就**必须**走"退役保留"那条路（否则 `normalizeRegistry` 的
 *     `EXT_MODE_KEYS.includes(e.mode)` 过滤会让那些条目**静默消失**：
 *     文件还在磁盘上，却列表里看不见、注入里不出现、连删都删不掉）。
 *     ★ 判据：**"不再提供" 与 "不再承认" 是两件事** —— 前者是产品决定，后者是数据丢失。
 */
export const EXT_MODES = Object.freeze({
  decisions: {
    label: "决策型",
    storage: "card",
    dir: "cards",
    protect: false,
    append: false,
    hint: "参照长期决策：一卡一文件，编号即地址（如 `D1.md`）。",
  },
  active: {
    label: "活跃台账型",
    storage: "single",
    file: "LEDGER.md",
    protect: false,
    append: false,
    hint: "参照当前状态台账：可覆盖 / 可精简，适合持续变化的项目状态。",
  },
  journal: {
    label: "流水记录型",
    storage: "single",
    file: "JOURNAL.md",
    protect: false,
    append: true,
    hint: "参照回合流水：**只追加、不改旧条目**。",
  },
  goals: {
    label: "目标树型",
    storage: "card",
    dir: "cards",
    protect: false,
    append: false,
    hint: "参照目标树：一卡一节点，卡片可改。",
  },
  lessons: {
    label: "经验教训型",
    storage: "card",
    dir: "cards",
    protect: false,
    append: false,
    hint: "参照经验与教训：一卡一文件（如 `L1.md` / `E2.md`）。",
  },
  plain: {
    label: "普通独立记忆型",
    storage: "single",
    file: "content.md",
    protect: false,
    append: false,
    hint: "保守的普通读写：整份覆盖，无特殊保护。",
  },
});

/** 模式白名单（外部输入一律过它）。 */
export const EXT_MODE_KEYS = Object.freeze(Object.keys(EXT_MODES));

/**
 * ★★★ **保留名**：这些名字属于核心记忆，扩展**不许**占用。
 *
 * ★ 为什么必须挡：用户如果建一个叫 `decisions` 的扩展，模型在列表里看到两个
 *   "决策"，**永远说不清该往哪个里写** —— 那正是「两个权威源」的病。
 *   ★ 与任务书 §6.5「自定义扩展不能改变基础模板」是同一条。
 */
export const EXT_RESERVED_NAMES = Object.freeze([
  "ledger",
  "decisions",
  "journal",
  "goals",
  "lessons",
  "principles",
  "extensions",
  "registry",
  "stash",
  "handoff",
  "archive",
  "log",
  "logs",
]);

/** 扩展 id 的**白名单**（它会成为目录名）。与卡片键同一套规则 + 长度上限。 */
export function isSafeExtId(id) {
  if (typeof id !== "string") return false;
  const k = id.trim();
  if (k === "" || k === "." || k === "..") return false;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(k)) return false; // 小写字母数字与连字符
  if (k.length > 64) return false;
  if (k.startsWith("..")) return false;
  return true;
}

/**
 * 从用户填的**名称**派生一个稳定 id。
 *
 * ★ 中文名不能直接当目录名（跨平台风险 + 路径可读性），所以：
 *   名称里有 ASCII 字母数字 ⇒ 取那些；否则用 `ext-<hash>`。
 *   ★ **id 一旦定下就不再改**（改名只改 `name`）—— 否则已有的卡全成孤儿。
 */
export function deriveExtId(name, taken) {
  const used = taken instanceof Set ? taken : new Set(Array.isArray(taken) ? taken : []);
  const base =
    String(name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "ext";
  // 中文名会被压成 `ext` ⇒ 加一个短哈希，避免全叫 ext、ext-2、ext-3
  let candidate = base;
  if (candidate === "ext") {
    let h = 0;
    const s = String(name ?? "");
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    candidate = `ext-${h.toString(36).slice(0, 6)}`;
  }
  let out = candidate;
  let n = 2;
  while (used.has(out)) {
    out = `${candidate}-${n}`;
    n += 1;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 路径（**唯一出口** —— 别在别处拼 extensions/...）
// ═══════════════════════════════════════════════════════════════════════════

/** 扩展树根（绝对路径）。★ 基准是 `memoryBase`，不是项目根（D289/D298 的同一条判据）。 */
export function extRootAbs(info, fallbackRoot) {
  const r = resolveInfo(info, fallbackRoot);
  if (r.ok !== true) return "";
  const realRoot = r.info.projectRoot ?? fallbackRoot;
  const base = memoryBaseOf(r.info, realRoot);
  if (typeof base !== "string" || base === "") return "";
  return path.resolve(base, EXT_DIR);
}

/** 注册表绝对路径。 */
export function extRegistryAbs(info, fallbackRoot) {
  return path.join(extRootAbs(info, fallbackRoot), EXT_REGISTRY);
}

/**
 * 某个扩展的目录绝对路径。
 * ★ 这里做**两道**边界检查（D267/F02 的教训）：id 白名单 + 结果仍必须落在记忆根内。
 *
 * ★★★ 2026-10-21（D299 · 探针当场抓到的真缺陷）：**边界检查的锚点必须是"已经存在的"
 *   那个目录**。第一版我写成 `isUnderReal(扩展树根, 目标)`，而 `extensions/` 在**第一次创建时
 *   还不存在** ⇒ `isUnderReal` 报 `unknown-root` ⇒ **整个扩展功能一个字都建不出来**。
 *   ⇒ 锚点改成 **`memoryBase`**（它一定存在，因为台账就在里面），目标仍在它下面
 *     ⇒ 既保留了"不许越界"的语义，又不会因为"中间目录还没建"而把功能锁死。
 *   ★ 教训与 `isUnderReal` 自己的注释同源：**对尚不存在的目标，要解析最近的已存在祖先** ——
 *     我在这里把"锚点"当成目标去解析了。
 */
export function extDirAbs(info, fallbackRoot, id) {
  if (!isSafeExtId(id)) return undefined;
  const r = resolveInfo(info, fallbackRoot);
  if (r.ok !== true) return undefined;
  const realRoot = r.info.projectRoot ?? fallbackRoot;
  const memBase = memoryBaseOf(r.info, realRoot);
  if (typeof memBase !== "string" || memBase === "") return undefined;
  const root = path.resolve(memBase, EXT_DIR);
  const abs = path.resolve(root, id);
  // ★ 词法先判（挡住 `../`），再对**记忆根**做真实路径校验（它一定存在）。
  if (!isUnder(root, abs)) return undefined;
  if (!isUnderReal(memBase, abs).ok) return undefined;
  return abs;
}

// ═══════════════════════════════════════════════════════════════════════════
// 注册表读写
// ═══════════════════════════════════════════════════════════════════════════

/** 空注册表。 */
function emptyRegistry() {
  return { schemaVersion: EXT_SCHEMA_VERSION, extensions: [] };
}

/**
 * ★★★★★ 2026-10-21（D299）：**把 `(info, fallbackRoot)` 归一成 info 的唯一出口。**
 *
 * 🔴 为什么需要它（这是 D298 那个病的预防针）：
 *   `part8` 的每个函数都收 `(info, fallbackRoot)`，而工具层手里**只有 root**。
 *   如果调用方图省事传 `null`，`memoryBaseOf(null, root)` 会**默默退回项目根** ——
 *   V3 项目里扩展就跑到项目根去了，而且**不报错**（D298 一字不差地重演）。
 *
 * ⇒ 判据：**"我不知道 info" 这种状态不许存在**。传了 root 就在这里 `inspect` 一次，
 *   让 `memoryBase` 永远来自唯一那个出处。
 *   ★ 传了 info 就用 info（省一次 inspect）；**两个都没传** ⇒ 明确报错，不猜。
 */
function resolveInfo(info, fallbackRoot) {
  if (info !== null && typeof info === "object") return { ok: true, info };
  if (typeof fallbackRoot === "string" && fallbackRoot !== "") {
    return { ok: true, info: inspect(fallbackRoot) };
  }
  return { ok: false, reason: "内部错误：既没有 info 也没有项目根 —— 拒绝猜路径。" };
}

/**
 * 读注册表。
 *
 * ★★★ **失败语义必须能区分**（D290/D293 的同一条）：
 *   · 文件不存在 ⇒ `{ ok: true, registry: 空, missing: true }` —— "还没建过"，正常；
 *   · 文件存在但读不了/JSON 坏了 ⇒ `{ ok: false, reason }` —— **绝不能当成"没有扩展"**，
 *     那会让"注册表坏了"看起来像"用户还没建"，**而模型会以为可以随便重建**。
 */
export function readRegistry(info, fallbackRoot) {
  const abs = extRegistryAbs(info, fallbackRoot);
  if (!fs.existsSync(abs)) {
    return { ok: true, registry: emptyRegistry(), missing: true, path: abs };
  }
  const text = readTextSafe(abs);
  if (typeof text !== "string") {
    return { ok: false, reason: `注册表读不出来（无权限或不是文本）：${abs}`, path: abs };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      reason: `注册表不是合法 JSON —— **不要自己重建它**，先把损坏的文件备份出来给人看：${String(
        (e && e.message) || e,
      )}`,
      path: abs,
    };
  }
  return { ok: true, registry: normalizeRegistry(parsed), path: abs };
}

/**
 * 把外部读进来的注册表**规整成可用的形状**。
 * ★ 不抛错：坏条目**跳过并记下来**，不因为一条坏数据让整个扩展体系不可用。
 */
export function normalizeRegistry(parsed) {
  const out = emptyRegistry();
  if (parsed === null || typeof parsed !== "object") return out;
  if (typeof parsed.schemaVersion === "number") out.schemaVersion = parsed.schemaVersion;
  const list = Array.isArray(parsed.extensions) ? parsed.extensions : [];
  for (const e of list) {
    if (e === null || typeof e !== "object") continue;
    if (!isSafeExtId(e.id)) continue;
    if (!EXT_MODE_KEYS.includes(e.mode)) continue;
    out.extensions.push({
      id: e.id,
      name: typeof e.name === "string" ? e.name : e.id,
      description: typeof e.description === "string" ? e.description : "",
      mode: e.mode,
      inject: e.inject === true,
      createdAt: typeof e.createdAt === "string" ? e.createdAt : "",
      updatedAt: typeof e.updatedAt === "string" ? e.updatedAt : "",
    });
  }
  return out;
}

/** 原子写注册表。 */
export function writeRegistry(info, fallbackRoot, registry) {
  const abs = extRegistryAbs(info, fallbackRoot);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return writeFileAtomic(abs, `${JSON.stringify(registry, null, 2)}\n`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 校验
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 校验"要新建的扩展"。
 *
 * ★ 每条错误都**说清为什么**，因为这是给用户看的（面板会把 reason 回显）。
 * ★ 重名判据：**按名称小写比对**（`Boss` 与 `boss` 是同一个东西，人不会觉得是两个）。
 */
export function validateNewExtension(info, fallbackRoot, input) {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  const description = typeof input?.description === "string" ? input.description.trim() : "";
  const mode = typeof input?.mode === "string" ? input.mode.trim() : "";

  if (name === "") return { ok: false, reason: "记忆名称不能为空。" };
  if (name.length > 60) return { ok: false, reason: "记忆名称最多 60 个字符。" };
  if (/\s{2,}|\n|\r|\t/.test(name)) {
    return { ok: false, reason: "记忆名称里不要有连续空白或换行。" };
  }
  // ★ 名称会显示给模型看 ⇒ 挡住控制字符与明显的路径符号（不要求像 id 那么严）
  if (/[\\/<>:"|?*\u0000-\u001f]/.test(name)) {
    return { ok: false, reason: "记忆名称里不能有路径符号或控制字符（\\ / < > : \" | ? *）。" };
  }
  if (description === "") return { ok: false, reason: "用途说明不能为空 —— 模型要靠它判断该不该用这个扩展。" };
  if (description.length > 500) return { ok: false, reason: "用途说明最多 500 个字符。" };
  if (!EXT_MODE_KEYS.includes(mode)) {
    return { ok: false, reason: `记忆模式必须是这些之一：${EXT_MODE_KEYS.join(" / ")}。` };
  }
  if (EXT_RESERVED_NAMES.includes(name.toLowerCase())) {
    return {
      ok: false,
      reason: `「${name}」是核心记忆的保留名，不能拿来做扩展 —— 否则同一个名字会指两个地方，模型永远说不清该写哪个。`,
    };
  }

  const r = readRegistry(info, fallbackRoot);
  if (r.ok !== true) return { ok: false, reason: r.reason };

  const lower = name.toLowerCase();
  if (r.registry.extensions.some((e) => e.name.toLowerCase() === lower)) {
    return { ok: false, reason: `已经有一个叫「${name}」的扩展了 —— 重名会让模型分不清该往哪个写。` };
  }

  return {
    ok: true,
    draft: { name, description, mode, inject: input?.inject === true },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 创建 / 更新 / 删除
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 创建一个扩展：**先建文件、再登记**。
 *
 * ★★★★★ 顺序不能反（任务书 §6.3 第 10 条：禁止"界面显示成功但文件不存在"）：
 *   先登记后建文件 ⇒ 中间失败会留下**指向空目录的注册记录**，模型会以为有内容。
 *   先建文件后登记 ⇒ 中间失败只留下**一个没人引用的目录**，无害，且下次能覆盖。
 *   ⇒ 判据同 D290：**失败时宁可留下一坨垃圾，也不能留下一句谎话。**
 */
export function createExtension(info, fallbackRoot, input) {
  const v = validateNewExtension(info, fallbackRoot, input);
  if (v.ok !== true) return { ok: false, reason: v.reason };

  const r = readRegistry(info, fallbackRoot);
  if (r.ok !== true) return { ok: false, reason: r.reason };
  const registry = r.registry;

  const taken = new Set(registry.extensions.map((e) => e.id));
  const id = deriveExtId(v.draft.name, taken);
  if (!isSafeExtId(id)) return { ok: false, reason: `派生出的 id 不合法：${id}` };

  const dirAbs = extDirAbs(info, fallbackRoot, id);
  if (dirAbs === undefined) return { ok: false, reason: "扩展目录越界 —— 拒绝创建。" };

  const mode = EXT_MODES[v.draft.mode];
  let created = [];
  try {
    fs.mkdirSync(dirAbs, { recursive: true });
    if (mode.storage === "card") {
      const cardDir = path.join(dirAbs, mode.dir);
      fs.mkdirSync(cardDir, { recursive: true });
      // ★ 卡片目录必须非空才算"存在"（listCards 对空目录返回 []）
      //   ⇒ 放一张 README 说明，也让人一眼知道这是干什么的。
      const readme = path.join(cardDir, "README.md");
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(
          readme,
          `# ${v.draft.name}\n\n${v.draft.description}\n\n` +
            `> 这是**自定义扩展记忆**（模式：${mode.label}）的卡片目录。\n` +
            `> 一卡一文件，文件名即键。**它不是项目的 \`decisions/\` 目录** —— 两者互不影响。\n`,
          "utf8",
        );
        created.push(path.relative(fallbackRoot, readme));
      }
    } else {
      const file = path.join(dirAbs, mode.file);
      if (!fs.existsSync(file)) {
        fs.writeFileSync(
          file,
          `# ${v.draft.name}\n\n${v.draft.description}\n\n` +
            `> **自定义扩展记忆**（模式：${mode.label}）。${mode.hint}\n\n---\n\n`,
          "utf8",
        );
        created.push(path.relative(fallbackRoot, file));
      }
    }
  } catch (e) {
    return { ok: false, reason: `建文件失败：${String((e && e.message) || e)}` };
  }

  // ★ 文件就位之后才登记。
  const now = stamp(new Date());
  const entry = {
    id,
    name: v.draft.name,
    description: v.draft.description,
    mode: v.draft.mode,
    inject: v.draft.inject === true,
    createdAt: now,
    updatedAt: now,
  };
  registry.extensions.push(entry);
  const w = writeRegistry(info, fallbackRoot, registry);
  if (w?.ok === false) {
    // ★ 登记失败 ⇒ 把刚建的目录清掉，别留孤儿（这次是**空目录**，删了没损失）。
    try {
      fs.rmSync(dirAbs, { recursive: true, force: true });
    } catch {
      /* 删不掉就算了，至少不要把失败报成成功 */
    }
    return { ok: false, reason: `登记失败：${w.reason || "未知"} —— 已回滚刚建的目录。` };
  }

  return {
    ok: true,
    created: entry,
    storagePath: path.relative(fallbackRoot, dirAbs),
    files: created,
    modeLabel: mode.label,
    modeHint: mode.hint,
  };
}

/** 更新一个扩展的**说明与配置**（不含内容）。 */
export function updateExtension(info, fallbackRoot, id, patch) {
  if (!isSafeExtId(id)) return { ok: false, reason: "扩展 id 不合法。" };
  const r = readRegistry(info, fallbackRoot);
  if (r.ok !== true) return { ok: false, reason: r.reason };
  const registry = r.registry;
  const idx = registry.extensions.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, reason: `找不到扩展 ${id}（注册表里没有）。` };

  const cur = registry.extensions[idx];
  const next = { ...cur };

  if (patch?.name !== undefined) {
    const name = String(patch.name).trim();
    if (name === "") return { ok: false, reason: "记忆名称不能为空。" };
    if (/[\\/<>:"|?*\u0000-\u001f]/.test(name)) return { ok: false, reason: "记忆名称里有非法字符。" };
    if (EXT_RESERVED_NAMES.includes(name.toLowerCase())) {
      return { ok: false, reason: `「${name}」是核心记忆的保留名。` };
    }
    const lower = name.toLowerCase();
    if (registry.extensions.some((e, i) => i !== idx && e.name.toLowerCase() === lower)) {
      return { ok: false, reason: `已经有一个叫「${name}」的扩展了。` };
    }
    next.name = name;
  }
  if (patch?.description !== undefined) {
    const d = String(patch.description).trim();
    if (d === "") return { ok: false, reason: "用途说明不能为空。" };
    if (d.length > 500) return { ok: false, reason: "用途说明最多 500 个字符。" };
    next.description = d;
  }
  if (patch?.inject !== undefined) next.inject = patch.inject === true;
  // ★★★ **mode 不许改**：改了它，已有内容的存储形状就对不上了
  //   （卡片目录 vs 单文件）。要换模式 ⇒ 删了重建，**数据迁移必须由人决定**。
  if (patch?.mode !== undefined && patch.mode !== cur.mode) {
    return {
      ok: false,
      reason:
        "记忆模式不能修改 —— 换了模式，已有内容的存储形状（卡片目录 / 单文件）就对不上了。" +
        " 要换请删掉这个扩展再新建，并自己搬运内容。",
    };
  }

  next.updatedAt = stamp(new Date());
  registry.extensions[idx] = next;
  const w = writeRegistry(info, fallbackRoot, registry);
  if (w?.ok === false) return { ok: false, reason: w.reason || "写注册表失败。" };
  return { ok: true, updated: next };
}

/**
 * 删除一个扩展。
 *
 * ★★★ **有内容就必须显式确认**（任务书 §6.4）。判据：
 *   · 空（只有模板文件 / 卡片目录里只有 README）⇒ 直接删；
 *   · 有内容 ⇒ 必须 `confirm: true`，否则**拒绝**，并把"里面有多少东西"报出来。
 * ★ 删除**只删自己那一份**，核心记忆一个字节都不动（任务书 §6.5）。
 */
export function deleteExtension(info, fallbackRoot, id, opts) {
  if (!isSafeExtId(id)) return { ok: false, reason: "扩展 id 不合法。" };
  const r = readRegistry(info, fallbackRoot);
  if (r.ok !== true) return { ok: false, reason: r.reason };
  const registry = r.registry;
  const idx = registry.extensions.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, reason: `找不到扩展 ${id}。` };

  const entry = registry.extensions[idx];
  const mode = EXT_MODES[entry.mode];
  const dirAbs = extDirAbs(info, fallbackRoot, id);
  if (dirAbs === undefined) return { ok: false, reason: "扩展目录越界 —— 拒绝删除。" };

  // ★ 2026-10-23（D311）：`mode` 可能是 undefined（注册表里有本版本不认识/已删掉的模式）。
  //   **删除这条路必须仍然走得通** —— 否则那个条目就永远删不掉了：
  //   用户唯一的出路是去手改 `registry.json`，而那正是本项目一直在避免的事。
  //   ⇒ 未知模式时**按目录整体计为"有内容"**（保守：宁可多问一次 confirm，
  //     也不能在不知道结构的情况下判定"里面没东西"就直删）。
  let usage;
  if (mode === undefined) {
    let n = 0;
    try {
      n = fs.existsSync(dirAbs) ? fs.readdirSync(dirAbs).length : 0;
    } catch {
      n = 0;
    }
    usage = {
      hasContent: n > 0,
      fileCount: n,
      detail: `未知模式 \`${String(entry.mode)}\`；目录里 ${n} 项（按整体内容计）`,
    };
  } else {
    usage = extUsageOf(dirAbs, mode);
  }
  if (usage.hasContent && opts?.confirm !== true) {
    return {
      ok: false,
      needConfirm: true,
      reason:
        `扩展「${entry.name}」里已经有内容（${usage.detail}）—— **必须显式确认才能删**。` +
        " 传 `confirm: true` 重发一次即可；不想删就什么都不做。",
      usage,
    };
  }

  // ★ 先把目录改名成 `.deleting-<stamp>`（同卷 rename），再删注册表，最后删目录。
  //   顺序的理由：若中途失败，**注册表还指着一个暂存目录**，比"注册表已删但目录还在"
  //   更容易恢复 —— 后者会让人以为数据没了，其实还在，只是没人认得它。
  let staged;
  try {
    if (fs.existsSync(dirAbs)) {
      staged = `${dirAbs}.deleting-${Date.now()}`;
      fs.renameSync(dirAbs, staged);
    }
  } catch (e) {
    return { ok: false, reason: `暂存目录失败：${String((e && e.message) || e)}` };
  }

  const next = { ...registry, extensions: registry.extensions.filter((_, i) => i !== idx) };
  const w = writeRegistry(info, fallbackRoot, next);
  if (w?.ok === false) {
    // ★ 注册表没写成 ⇒ 把目录改回来，保持"注册表与文件一致"。
    try {
      if (staged !== undefined) fs.renameSync(staged, dirAbs);
    } catch {
      /* 改不回来就只能如实报 */
    }
    return { ok: false, reason: `删注册表失败：${w.reason || "未知"} —— 已尝试还原目录。` };
  }

  try {
    if (staged !== undefined) fs.rmSync(staged, { recursive: true, force: true });
  } catch {
    /* 目录删不掉不影响注册表已经干净 */
  }

  return { ok: true, deleted: entry, usage };
}

/** 统计一个扩展目录里"有多少真内容"（排除模板文件）。 */
export function extUsageOf(dirAbs, mode) {
  const files = [];
  const walk = (d) => {
    let es;
    try {
      es = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dirAbs);

  // ★ 模板文件不算内容：卡片模式的 `README.md`、单文件模式的"只有标题与说明"。
  const contentFiles = files.filter((f) => {
    const base = path.basename(f);
    if (/^README\.md$/i.test(base)) return false;
    let text = "";
    try {
      text = fs.readFileSync(f, "utf8");
    } catch {
      return true;
    }
    // 单文件模式：只有我们写的那段模板（含 `> **自定义扩展记忆**`）⇒ 算空
    if (/自定义扩展记忆/.test(text) && text.split("\n").filter((l) => l.trim() !== "").length <= 6) {
      return false;
    }
    return true;
  });

  const totalChars = contentFiles.reduce((s, f) => {
    try {
      return s + fs.statSync(f).size;
    } catch {
      return s;
    }
  }, 0);

  return {
    hasContent: contentFiles.length > 0,
    fileCount: contentFiles.length,
    totalChars,
    detail: contentFiles.length === 0 ? "只有模板" : `${contentFiles.length} 个文件 / 约 ${totalChars} 字符`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 内容读写（**按模式分派**）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 读扩展内容。
 *
 * @param {string} id
 * @param {{key?:string, limit?:number}} [opts] 卡片模式必须给 key；不给就返回清单
 */
export function readExtension(info, fallbackRoot, id, opts) {
  if (!isSafeExtId(id)) return { ok: false, reason: "扩展 id 不合法。" };
  const r = readRegistry(info, fallbackRoot);
  if (r.ok !== true) return { ok: false, reason: r.reason };
  const entry = r.registry.extensions.find((e) => e.id === id);
  if (entry === undefined) return { ok: false, reason: `找不到扩展 ${id}。` };

  const mode = EXT_MODES[entry.mode];
  const dirAbs = extDirAbs(info, fallbackRoot, id);
  if (dirAbs === undefined) return { ok: false, reason: "扩展目录越界。" };

  // ★ 2026-10-23（D311）：未知模式 ⇒ **如实报**，不猜它的结构。
  if (mode === undefined) {
    return {
      ok: false,
      reason: `扩展「${entry.name ?? id}」的模式 \`${String(entry.mode)}\` 在本版本里不存在 —— 读不出结构（请升级插件，或用 delete 删掉它）。`,
    };
  }

  if (mode.storage === "card") {
    const cards = listCards(dirAbs, mode.dir);
    const key = opts?.key;
    if (key === undefined || key === "") {
      return {
        ok: true,
        id,
        name: entry.name,
        mode: entry.mode,
        modeLabel: mode.label,
        storage: "card",
        cards,
        hint: mode.hint,
      };
    }
    const text = readCard(dirAbs, mode.dir, key);
    if (text === undefined) return { ok: false, reason: `扩展「${entry.name}」里没有这张卡：${key}` };
    return { ok: true, id, name: entry.name, mode: entry.mode, storage: "card", key, text };
  }

  const file = path.join(dirAbs, mode.file);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, reason: `扩展文件不存在：${path.relative(fallbackRoot, file)}` };
  }
  const limit = typeof opts?.limit === "number" && opts.limit > 0 ? opts.limit : undefined;
  const truncated = limit !== undefined && text.length > limit;
  return {
    ok: true,
    id,
    name: entry.name,
    mode: entry.mode,
    modeLabel: mode.label,
    storage: "single",
    text: truncated ? text.slice(0, limit) : text,
    chars: text.length,
    truncated,
  };
}

/**
 * 写扩展内容。
 *
 * ★★★ 保护在这里实现（**一处实现，所有模式共用**）：
 *   ① 流水型 ⇒ **只追加**（`append:true` 是唯一允许的）
 *   ② 越界 / 非法 key ⇒ 拒绝
 *
 * ★★★★★ 2026-10-23（D311）：**「原则型不许写」那条分支已随模式一起删除。**
 *   不是"忘了保护"，而是**那个模式已经不存在了** —— 现在没有任何模式的 `protect` 为 true。
 *   ★ 但这里必须留一个**兜底**：`EXT_MODES[entry.mode]` 若为 `undefined`
 *     （注册表里有本版本不认识的模式），下面 `mode.protect` 会抛 TypeError。
 *     那种"注册表比代码新"的情形必须**如实报**，不能崩、也不能当成能写。
 *     ⇒ 见下面那条 `if (mode === undefined)`。
 */
export function writeExtension(info, fallbackRoot, id, opts) {
  if (!isSafeExtId(id)) return { ok: false, reason: "扩展 id 不合法。" };
  const r = readRegistry(info, fallbackRoot);
  if (r.ok !== true) return { ok: false, reason: r.reason };
  const entry = r.registry.extensions.find((e) => e.id === id);
  if (entry === undefined) return { ok: false, reason: `找不到扩展 ${id}。` };

  const mode = EXT_MODES[entry.mode];
  // ★ D311 兜底：注册表里有一个本版本不认识的模式（例如将来回滚到旧版本、
  //   而注册表里留着新版本的条目）⇒ **明确拒绝并说清原因**，不崩、不猜。
  if (mode === undefined) {
    return {
      ok: false,
      reason: `扩展「${entry.name ?? id}」的模式 \`${String(entry.mode)}\` 在本版本里不存在 —— 拒绝写入（不是把它当成普通记忆）。`,
    };
  }
  const dirAbs = extDirAbs(info, fallbackRoot, id);
  if (dirAbs === undefined) return { ok: false, reason: "扩展目录越界。" };
  const dirRel = path.relative(fallbackRoot, dirAbs);

  // ① 原则型：模型一律不许写
  // ① ★ 2026-10-23（D311）：原来这里是「原则型：模型一律不许写」的分支。
  //   那个模式已被用户拍板去掉（全系统已无 `protect === true` 的模式），
  //   所以这里**不再是"少了一道保护"，而是"保护的对象不存在了"**。
  //   ★ 判据：删保护之前先问"它保护的还有东西吗" —— 有 ⇒ 不许删；
  //     没有 ⇒ **留着才是问题**（它会让后人以为还存在一种需要授权的扩展模式）。

  // ② 流水型：只许追加
  const wantAppend = opts?.append === true;
  if (mode.append === true && !wantAppend) {
    return {
      ok: false,
      reason:
        `扩展「${entry.name}」是**流水记录型** —— 只追加、不改旧条目。` +
        " 请用 `append: true` 重发，内容是**要追加的那一段**，不是全文。",
      appendOnly: true,
    };
  }
  if (mode.append !== true && wantAppend) {
    return {
      ok: false,
      reason: `扩展「${entry.name}」是 ${mode.label}，不是流水型 —— 它不支持追加，请传整份内容替换。`,
    };
  }

  const content = typeof opts?.content === "string" ? opts.content : "";
  if (!wantAppend && content === "") return { ok: false, reason: "内容不能为空。" };

  if (mode.storage === "card") {
    const key = opts?.key;
    if (!isSafeCardKey(key)) {
      return {
        ok: false,
        reason: `卡片键不合法（只允许字母数字与 . _ -，且不能以 .md 结尾）：${String(key)}`,
      };
    }
    const w = writeCard(dirAbs, mode.dir, key, content);
    if (w?.ok === false) return { ok: false, reason: w.reason || "写卡失败。" };
    return { ok: true, id, storage: "card", key, path: `${dirRel}/${mode.dir}/${key}.md` };
  }

  const file = path.join(dirAbs, mode.file);
  let nextText = content;
  if (wantAppend) {
    let prev = "";
    try {
      prev = fs.readFileSync(file, "utf8");
    } catch {
      prev = "";
    }
    nextText = prev === "" ? content : `${prev.replace(/\n*$/, "\n")}${content}`;
  }
  const w = writeFileAtomic(file, nextText);
  if (w?.ok === false) return { ok: false, reason: w.reason || "写文件失败。" };
  return {
    ok: true,
    id,
    storage: "single",
    appended: wantAppend,
    path: `${dirRel}/${mode.file}`,
    chars: nextText.length,
  };
}

/**
 * 列出所有扩展（给人看 / 给模型看）。
 * ★ 附带 `dirExists` —— **注册表说有、磁盘上没有**是一件必须被看见的事
 *   （任务书 §6.4「注册表与实际文件保持一致」）。不在这里修，只如实报。
 */
export function listExtensions(info, fallbackRoot) {
  const r = readRegistry(info, fallbackRoot);
  if (r.ok !== true) return { ok: false, reason: r.reason };

  const out = r.registry.extensions.map((e) => {
    const mode = EXT_MODES[e.mode];
    const dirAbs = extDirAbs(info, fallbackRoot, e.id);
    const dirExists = dirAbs !== undefined && fs.existsSync(dirAbs);
    let usage = { hasContent: false, fileCount: 0, detail: "目录不存在" };
    // ★ 2026-10-23（D311）：未知模式**必须照样列出来**（而不是 `mode.label` 抛错或悄悄跳过）。
    //   ★ 判据：`list` 是用户唯一能看见"这条东西还在"的地方 ——
    //     条目在注册表里、却不出现在 `list` 里，就等于它对人**不存在了**（而文件还在）。
    if (mode === undefined) {
      let n = 0;
      try {
        n = dirExists ? fs.readdirSync(dirAbs).length : 0;
      } catch {
        n = 0;
      }
      return {
        ...e,
        modeLabel: "⚠️ 未知模式",
        modeHint: `本版本不认识 \`${String(e.mode)}\`（可能来自更新的插件）—— 只列出，不解释。`,
        modeUnknown: true,
        dirExists,
        usage: { hasContent: n > 0, fileCount: n, detail: `未知模式；目录里 ${n} 项` },
        storagePath: dirAbs === undefined ? undefined : path.relative(fallbackRoot, dirAbs),
      };
    }
    if (dirExists) usage = extUsageOf(dirAbs, mode);
    return {
      ...e,
      modeLabel: mode.label,
      modeHint: mode.hint,
      dirExists,
      usage,
      storagePath: dirAbs === undefined ? undefined : path.relative(fallbackRoot, dirAbs),
    };
  });

  return {
    ok: true,
    extensions: out,
    count: out.length,
    inconsistent: out.filter((e) => !e.dirExists).map((e) => e.id),
    registryPath: path.relative(fallbackRoot, extRegistryAbs(info, fallbackRoot)),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 注入
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 生成**给模型看**的扩展清单（短、可常驻）。
 *
 * ★★★ 任务书 §6.6 的要求原话：
 *   「模型在后续该项目会话中，至少应该知道：当前项目存在一个名为 X 的扩展记忆，
 *     适合保存 Y，采用 Z 规则，可按需读取和写入。」
 *   ⇒ 这里只给**名单 + 用途 + 模式 + 怎么读**，**绝不注入全文**。
 *     「不因为扩展数量增多就无条件注入全部扩展全文」—— 这是硬要求。
 *
 * ★ 注入开关（`inject`）**只影响上下文提供方式，不影响数据是否保存**（任务书 §6.2 字段四）。
 *   关的时候：仍然列出"存在这个扩展 + 怎么按需读"，只是不塞内容。
 *   开的时候：额外附上**该扩展当前内容的前若干字符**（有上限）。
 */
export function renderExtensionInjection(info, fallbackRoot, opts) {
  const r = readRegistry(info, fallbackRoot);
  if (r.ok !== true) {
    // ★ 注册表坏了要**说出来**，不能让模型以为"这个项目没有扩展"。
    return (
      "### ⚠️ 自定义扩展记忆（注册表读不出来）\n\n" +
      `${r.reason}\n` +
      "★ **不要自己重建注册表** —— 先把损坏的文件备份出来给人看。\n"
    );
  }
  if (r.registry.extensions.length === 0) return "";

  const maxChars = typeof opts?.maxChars === "number" && opts.maxChars > 0 ? opts.maxChars : 600;
  const lines = ["### 自定义扩展记忆（本项目有这些**额外**记忆类型）", ""];
  lines.push("★ 它们**不是**核心记忆的替代品 —— 核心的台账/决策/流水等规则一个字都没变。");
  lines.push("");

  for (const e of r.registry.extensions) {
    const mode = EXT_MODES[e.mode];
    const dirAbs = extDirAbs(info, fallbackRoot, e.id);
    const exists = dirAbs !== undefined && fs.existsSync(dirAbs);
    // ★ 2026-10-23（D311）：注册表里可能有本版本不认识的模式（回滚 / 将来加过又删掉的）。
    //   原来这里直接读 `mode.label` ⇒ **一个坏条目就让整段注入抛 TypeError**
    //   （而 `normalizeRegistry` 已经按 `EXT_MODE_KEYS` 过滤过，理论上到不了这里；
    //    但"理论上到不了"正是本项目栽过很多次的那句话 —— 所以显式兜底）。
    if (mode === undefined) {
      lines.push(`- **${e.name}**（id \`${e.id}\` · ⚠️ **未知模式 \`${String(e.mode)}\`**）`);
      lines.push("  · 本版本不认识这个模式 ⇒ **不注入内容、也不给出写法**（避免给出错的命令）。");
      lines.push("  · 处理：用 `ledger_extension({op:\"delete\", id:…})` 删掉它，或升级插件。");
      continue;
    }
    lines.push(`- **${e.name}**（id \`${e.id}\` · ${mode.label}）${exists ? "" : " ⚠️ **目录不存在**"}`);
    lines.push(`  · 用途：${e.description}`);
    lines.push(`  · 规矩：${mode.hint}`);
    if (mode.storage === "card") {
      lines.push(`  · 读法：\`ledger_extension({op:"read", id:"${e.id}"})\` 列出卡片；加 \`key\` 取某一张。`);
      lines.push(`  · 写法：\`ledger_extension({op:"write", id:"${e.id}", key:"…", content:"…"})\``);
    } else {
      lines.push(`  · 读法：\`ledger_extension({op:"read", id:"${e.id}"})\``);
      lines.push(
        `  · 写法：\`ledger_extension({op:"write", id:"${e.id}", content:"…"})` +
          `${mode.append ? "`（只追加，内容是要追加的那段）" : "`（整份替换）"}`,
      );
    }
    // ★ 只在用户**明确打开注入**时才附内容，且**有上限**。
    if (e.inject === true && exists) {
      let snippet = "";
      try {
        if (mode.storage === "card") {
          const cards = listCards(dirAbs, mode.dir);
          snippet = cards.length === 0 ? "（还没有卡片）" : `（${cards.length} 张卡：${cards.slice(0, 8).map((c) => c.key).join(", ")}${cards.length > 8 ? " …" : ""}）`;
        } else {
          const text = fs.readFileSync(path.join(dirAbs, mode.file), "utf8");
          snippet = text.length > maxChars ? `${text.slice(0, maxChars)}…（已截断）` : text;
        }
      } catch {
        snippet = "（读不出来）";
      }
      lines.push("  · 📥 **已开启自动注入**，当前内容：");
      lines.push(
        snippet
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    } else if (e.inject !== true) {
      lines.push("  · （未开启自动注入 ⇒ 需要时按上面的读法去取，不会自动塞进上下文）");
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
