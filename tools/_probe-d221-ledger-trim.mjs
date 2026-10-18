// D221 · 把活跃台账里**已完整存在于卡片**的那一块移进归档（腾出行数给 D221）
//
// ★ 为什么用 Node 而不是 PowerShell：本机硬规矩 —— **绝不用 shell 对含中文的文件
//   做"读取→替换→写回"**（PowerShell 的 > 会写成 UTF-16、编码会被拆坏，已栽过）。
//   Node + 显式 utf8 是本项目推荐做法。
//
// 被移走的块：「为什么我们这档不能自动更新」（活跃台账 §D216 那一节）
//   ★ 它的**完整正文一直在 `decisions/D216.md` §十** ⇒ 移出不丢信息。
// 归档去处：`_ledger-archive/2026-10/week3/`（按期间分桶，只追加）
//
// 用法：node tools/_probe-d221-ledger-trim.mjs [--apply]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const LEDGER = path.join(ROOT, "LEDGER.md");
const APPLY = process.argv.includes("--apply");

// ★ D221 第二轮：再移走「D216 全程」那一整块（它的完整正文同样在 `decisions/D216.md` §六~§九）。
//   用 `--block=216` 选它。
const BLOCK = (process.argv.find((s) => s.startsWith("--block=")) ?? "--block=update").split("=")[1];

const BLOCKS = {
  // 「为什么我们这档不能自动更新」—— 正文在 decisions/D216.md §十
  update: {
    start: "### ★★★ 「为什么我们这档不能自动更新」",
    end: "\n> ★★★ **20:1x ",
    label: "为什么这档不能自动更新（D216§十）",
    card: "decisions/D216.md §十",
  },
  // 「D216 全程」整块 —— 正文在 decisions/D216.md §六~§九
  216: {
    start: "## ★★★ D216 全程（**四条指控已全解**）",
    end: "\n> ★★★ **20:1x ",
    label: "D216全程-四条指控全解（正文在D216.md）",
    card: "decisions/D216.md §六~§九",
  },
  // 「D213 + D216（发布线）」整块 —— 正文在 decisions/D213.md 与 D216.md §一/§七/§九
  d213: {
    start: "## ★★ D213 + D216（**发布线**）",
    end: "\n\n## ★★ D214 + D215",
    label: "D213-D216发布线（正文在D213与D216卡片）",
    card: "decisions/D213.md · decisions/D216.md §一/§七/§九",
  },
  // 「D206–D212」整块 —— 七节正文分别在各卡片里
  d206: {
    start: "## ★★ D206–D212（**已完成**）",
    end: "\n\n## ★★ D214 + D215",
    label: "D206-D212一览（正文在各卡片）",
    card: "decisions/D206.md ~ decisions/D212.md",
  },
  // 「D214 + D215」整块 —— 正文在 decisions/D214.md 与 D215.md
  d214: {
    start: "## ★★ D214 + D215：",
    end: "\n\n> ★★★ **20:1x ",
    label: "D214-D215上下文已压缩根因（正文在卡片）",
    card: "decisions/D214.md · decisions/D215.md",
  },
  // ★ D224 新增：「D223（进行中）」那一整块 —— 它已被紧随其后的「D223 收尾」**逐条取代**
  //   （"市场未同步 / 正在补建 Release / tarball 仍指 v1.2.1" 全部已作废）。
  //   ★ 完整正文在 decisions/D223.md；此处为**逐字副本**。
  d223wip: {
    start: "## ★★★★ D223（进行中）：",
    end: "\n\n### ★★★ D223 收尾",
    label: "D223进行中-已被收尾取代（正文在D223.md）",
    card: "decisions/D223.md",
  },
  // ★ D224 新增：D221 那一整块（含「同轮修掉三处探针陈旧」子节）——
  //   ① 它的**完整正文一直在 `decisions/D221.md`**；
  //   ② 它讲的"唯一阻塞=服务端授权边界"**已被 D224 撤掉**（官方改口）⇒ 活跃台账不必留全程。
  d221: {
    start: "## ★★★★★ D221：接住 DSH STORE 复核",
    end: "\n\n## ★★★★★ D222",
    label: "D221接住复核-授权边界（正文在D221.md）",
    card: "decisions/D221.md",
  },
  // ★ D226 新增：D224 那一整块（复核两轨 + D222 漏点清单）——
  //   正文全在 `decisions/D224.md`，且它的"核对"已在 D226 落地（审计探针）。
  d224: {
    start: "## ★★★★★ D224：接住 DSH STORE 对 1.2.3 的复核",
    end: "\n## 变更登记（插件自动维护）",
    label: "D224-复核两轨与D222漏点（正文在D224.md）",
    card: "decisions/D224.md",
  },
  // ★ D227 新增：D226 前半块（授权卡片首通 + 10 处文案）—— 正文全在 `decisions/D226.md`。
  d226: {
    start: "## ★★★★★ D226：授权卡片**首次真正走通**",
    end: "\n\n## 变更登记（插件自动维护）",
    label: "D226-授权卡片首通与10处文案（正文在D226.md）",
    card: "decisions/D226.md",
  },
  // ★ D229 新增：D227 那一整块（全量盘点）—— 正文全在 `decisions/D227.md`。
  d227: {
    start: "## ★★★★★ D227（盘点完成）",
    end: "\n\n## ★★★★★ D228",
    label: "D227-全量盘点与累赘候选（正文在D227.md）",
    card: "decisions/D227.md",
  },
  // ★ D230 新增：D228 + D229 两块 —— 正文分别在 `decisions/D228.md` / `D229.md`。
  // ★ D230 新增：D228 + D229 两块 —— 正文分别在 `decisions/D228.md` / `D229.md`。
  d228d229: {
    start: "## ★★★★★ D228（已查清）",
    end: "\n## 变更登记（插件自动维护）",
    label: "D228-D229问题记录落点与通用名（正文在D228与D229.md）",
    card: "decisions/D228.md · decisions/D229.md",
  },
  // ★ D231 新增：D222 的完整块 —— 正文全在 `decisions/D222.md`（已完成、1.2.3 已发布）。
  //   ★ 为什么挑它：它是台账里**最长的已完成块**（33 行），且正文与卡片**逐条对应**，
  //     移出**不丢信息**。台账已 405/400，必须先腾地方。
  d222: {
    start: "## ★★★★★ D222（已完成 · **1.2.3 已发布**）",
    end: "\n\n\n\n### ★★★ D223 收尾",
    label: "D222-谁说了算总开关（正文在D222.md）",
    card: "decisions/D222.md",
  },
  // ★ D231 新增：D230 的完整块 —— 正文全在 `decisions/D230.md`（已完成、已核实）。
  d230: {
    start: "## ★★★★★ D230（已核实）",
    end: "\n\n## ★★★★★ D231",
    label: "D230-官方回复已到与未生效错判更正（正文在D230.md）",
    card: "decisions/D230.md",
  },
  // ★ D232 新增：D223 收尾块（三条渠道同步完毕）—— 正文全在 `decisions/D223.md`（已完成）。
  //   注意它是**三级标题**（`###`），不是二级 —— 锚点写错就定位不到（夹具故障，不是结论）。
  d223: {
    start: "### ★★★ D223 收尾（**已完成**）",
    end: "\n\n## ★★★★★ D231",
    label: "D223-三条渠道同步收尾（正文在D223.md）",
    card: "decisions/D223.md",
  },
  // ★ D232 新增：D231 的**落地纪要**块 —— 与上面那张 D231 卡片**不是同一块**：
  //   上面那块是"为什么/怎么修"（保留），这一块是"本轮改了什么/怎么验的"（已被 D232 取代）。
  //   ★ 正文全在 `decisions/D231.md` 与 `_ledger-log` 的 L1 里 ⇒ 移出不丢信息。
  d231wip: {
    start: "## ★★★★★ D231 落地纪要（[<会话>]",
    end: "\n\n## 变更登记（插件自动维护）",
    label: "D231-落地纪要与台账裁剪（正文在D231.md与L1）",
    card: "decisions/D231.md",
  },
  // ★ D233 新增：D232 整块（本地提交 + 三渠道分发包）—— 正文在 L1 与 `_dist/<ver>/CHANNELS.md`。
  d232: {
    start: "## ★★★★★ D232（[<会话>]",
    end: "\n\n## 变更登记（插件自动维护）",
    label: "D232-本地提交与三渠道分发包（正文在L1与CHANNELS.md）",
    card: "_ledger-log 的 L1 · _dist/<ver>/CHANNELS.md",
  },
  // ★ D234 新增：D234 的**实现细节**块（现象/根因/候选/附带发现那一整段）——
  //   ★ 与 `decisions/D234.md` 卡片**不是同一块**：卡里是"为什么这么做、怎么做、边界在哪"（完整），
  //     台账里那几段是它的**摘要**。正文已在卡片里 ⇒ 移出不丢信息。
  //   ★ 为什么移它：它当时是全台账最大的一块（约 50 行），而台账已 392/400。
  d234detail: {
    start: "### ★ 现象（本次真实发生）",
    end: "\n\n## 变更登记（插件自动维护）",
    label: "D234-检索止步的实现细节（现象/根因/候选/附带发现，正文在D234.md）",
    card: "decisions/D234.md",
  },
  // ★ D235 新增：D231 的三段**实现细节**（"做不到"的理由 / ①欠账落盘 / ②自相矛盾）——
  //   正文全在 `decisions/D231.md`，台账里那几段只是摘要。★ 本轮要写 63 行、台账已 391 ⇒ 先腾地方。
  d231detail: {
    start: "### ★ 先如实回答：",
    end: "\n\n## ★★★★★ D234（[<会话>]",
    label: "D231-收尾义务实现细节（做不到的理由/欠账落盘/自相矛盾，正文在D231.md）",
    card: "decisions/D231.md",
  },
  // ★ D236 新增：D235 发布块 —— 正文全在 `decisions/D235.md`。
  //   ★ 台账已 400/400 满，而 D236 这一轮（bug 调查）内容很多 ⇒ 必须先腾地方。
  d235publish: {
    start: "## ★★★★★ D235 发布（[<会话>]",
    end: "\n\n## 变更登记（插件自动维护）",
    label: "D235-1.2.5三渠道发布（正文在D235.md）",
    card: "decisions/D235.md",
  },
  // ★ D236 新增：D234 **落地纪要**整块（做了什么/两次混类/第26次尺子错/边界/补卡）——
  //   ★ 正文全在 `decisions/D234.md`（那条卡比台账这块详细得多）⇒ 移出不丢信息。
  d234landing: {
    start: "## ★★★★★ D234 落地（[<会话>]",
    // ★ END 用"变更登记"而不是"D235"—— 因为 D235 块**已被归档移走**了。
    //   ★ 这正是"夹具前提错了"的现场：我先写 END=下一个小节，而那个小节已经不在了。
    end: "\n\n## 变更登记（插件自动维护）",
    label: "D234-落地纪要（六维锚定做了什么/两次混类/第26次尺子错/边界，正文在D234.md）",
    card: "decisions/D234.md",
  },
  // ★ D240 新增：D236 整块（切模型 bug 真根因 + retainTokens 根源）——
  //   ★ 正文已完整写进 `decisions/D236.md`（新卡，比台账这块更细）⇒ 移出不丢信息。
  d236bug: {
    start: "## ★★★★★ D236（[<会话>]",
    end: "\n\n## 变更登记（插件自动维护）",
    label: "D236-切模型致会话不可用真根因与retainTokens根源（正文在D236.md）",
    card: "decisions/D236.md",
  },
  // ★ D241 新增：D240 的**方案块**（三件事/①设计/②参数/③清单）——
  //   ★ 正文已完整写进 `decisions/D240.md` ⇒ 移出不丢信息。
  d240plan: {
    start: "## ★★★★★ D240（[<会话>] 2026-10-17 23:3x）",
    end: "\n\n## 变更登记（插件自动维护）",
    label: "D240-回合内提醒暂停与retainTokens方案（正文在D240.md）",
    card: "decisions/D240.md",
  },
};

const spec = BLOCKS[BLOCK];
if (spec === undefined) {
  console.error(`★ 未知的 --block=${BLOCK}（可选：${Object.keys(BLOCKS).join(" / ")}）`);
  process.exit(2);
}

const src = fs.readFileSync(LEDGER, "utf8");
const START = spec.start;
const END = spec.end;

const a = src.indexOf(START);
const b = src.indexOf(END, a);
if (a < 0 || b < 0) {
  console.error("★ 没定位到要移走的那一块 —— 夹具故障，不是结论");
  console.error(`  START 命中：${a}   END 命中：${b}`);
  process.exit(2);
}

const removed = src.slice(a, b).replace(/\s+$/, "") + "\n";
const kept = src.slice(0, a) + src.slice(b + 1); // +1 去掉 END 前那个 \n

const beforeLines = src.split("\n").length;
const afterLines = kept.split("\n").length;
const removedLines = removed.split("\n").length;

console.log(`═══ 台账裁剪（block=${BLOCK}：把已存在于卡片的那一块移进归档）═══`);
console.log(`  移走 ${removedLines} 行 · 台账 ${beforeLines} → ${afterLines} 行`);
console.log(`  移走块的首行：${removed.split("\n")[0]}`);
console.log(`  移走块的末行：${removed.trimEnd().split("\n").pop()}`);
console.log(`  裁剪后紧邻内容：${kept.slice(a, a + 60).split("\n")[0]}`);

if (!APPLY) {
  console.log("\n（dry-run —— 加 --apply 才真的写）");
  process.exit(0);
}

// ① 归档（只追加）
const now = new Date();
const yyyy = now.getFullYear();
const mm = String(now.getMonth() + 1).padStart(2, "0");
const weekOfMonth = Math.ceil(now.getDate() / 7);
const archDir = path.join(ROOT, "_ledger-archive", `${yyyy}-${mm}`, `week${weekOfMonth}`);
fs.mkdirSync(archDir, { recursive: true });
const stamp = `${yyyy}-${mm}-${String(now.getDate()).padStart(2, "0")}`;
// ★★★ 2026-10-17（D230）：**`label` 会被拼进文件名，必须先消毒。**
//   ★ 我踩过：给 D228+D229 那个块写 `label: "…（正文在D228/D229.md）"` ——
//     里面那个 **`/` 在 path.join 里被当成路径分隔符** ⇒ 归档路径指向一个**不存在的子目录**
//     ⇒ `ENOENT`，归档那一步抛错。
//   ★★ **幸而没有损坏台账**：顺序是"先写归档、再写台账"，归档一抛错就中断，
//     `LEDGER.md` 一个字节没动（事后核过：382 行、两块都还在、归档里没有半成品）。
//     ⇒ **这个顺序本身就是一道保护**（写失败时不做不可逆的那一步），值得保留。
//   ★ 判据：**凡是"由人写的字符串"要塞进路径，先消毒**（本项目 L30 那一族）。
const safeLabel = String(spec.label).replace(/[\\/:*?"<>|]/g, "-");
const archFile = path.join(archDir, `${stamp}-台账§-${safeLabel}.md`);
// ★ D224：题头里的"正文在哪"必须跟着 spec 走（原来写死 D216，选别的块就会指错地方）。
const header = fs.existsSync(archFile)
  ? ""
  : `# 台账归档 · ${stamp}\n\n> 由 \`tools/_probe-d221-ledger-trim.mjs\` 从活跃台账移出。\n> ★ 完整正文在 \`${spec.card}\`；此处为**逐字副本**。\n\n`;
fs.appendFileSync(archFile, header + removed + "\n", "utf8");
console.log(`\n  ① 已追加到归档：${path.relative(ROOT, archFile)}`);

// ② 写回裁剪后的台账
fs.writeFileSync(LEDGER, kept, "utf8");
console.log(`  ② 已写回 LEDGER.md（${afterLines} 行）`);
