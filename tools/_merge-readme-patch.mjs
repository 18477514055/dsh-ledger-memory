#!/usr/bin/env node
/**
 * 把外发交付的 README 补丁合并进 `README.md`（12 处）。
 *
 * ★ 为什么要写成脚本而不是手改：
 *   12 处里大多是**逐字块替换**，手改一处就会错一个字，而错字不会报错、只会让文档悄悄变样。
 *   脚本每次替换都断言「原文在全文里恰好出现 1 次」——  命中 0 次 = 我抄错了，
 *   命中多次 = 锚点不唯一（外发任务单 §五 第 3 条要求的正是这个判据）。
 *
 * ★★ 与交付件的两处**有意偏离**（外发方那两个缺陷，验收报告第五节）：
 *   ① 改动 1：外发方锚点只覆盖第 161 行，替换后第 162 行会变成悬空残句
 *      （「**注入**、**台账与日志**、**胶囊与回读**、**高级阈值**。主要可调项包括：…」）。
 *      ⇒ 这里把 **161+162 两行一起消费**，并把「主要可调项包括：」的引导语留在结尾，
 *        好让第 163 行「收尾硬门、回合末卡片、…」自然接上。
 *   ② 改动 6：外发方写「单文件型模式使用 `extensions/<id>/content.md`」——
 *      实测 `EXT_MODES` 里 4 个单文件型**只有 `plain` 用 content.md**
 *      （`active`→`LEDGER.md`、`journal`→`JOURNAL.md`、`principles`→`PRINCIPLES.md`）。
 *      ⇒ 这里按真值逐模式写出文件名。
 *
 * 用法：node tools/_merge-readme-patch.mjs [--apply]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TARGET = path.join(ROOT, "README.md");
const APPLY = process.argv.includes("--apply");

const orig = fs.readFileSync(TARGET);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let text = orig.toString("utf8");

// ── 备份（本项目纪律：replace 前先备份并记 sha256）──────────────────────────
const bak = path.join(os.tmpdir(), `README.md.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.writeFileSync(bak, orig);

const CHANGES = [];

/** 逐字替换，断言恰好命中 1 次。 */
const rep = (label, from, to) => CHANGES.push({ label, from, to });

// ── 改动 1（重写：消费 161+162 两行）──────────────────────────────────────
rep(
  "① 设置面板 42 项/六组 → 43 项/四页",
  [
    "**设置 → 项目台账（台账 / 压缩 / 日志）**，共 **42 项**配置，分为六组：**谁说了算**、**压缩**、",
    "**注入**、**台账与日志**、**胶囊与回读**、**高级阈值**。主要可调项包括：配置优先级、压缩水位、",
  ].join("\n"),
  "**设置 → 项目台账（台账 / 压缩 / 日志）**，共 **43 项**配置，分为四页：**常规**、**注入**、**扩展记忆**、**高级**。" +
    "主要可调项包括：配置优先级、压缩水位、"
);

// ── 改动 2：工具数标题 21 → 22 ────────────────────────────────────────────
rep("② 标题 二十一个工具 → 二十二个工具", "## 二十一个工具", "## 二十二个工具");

// ── 改动 3：工具表补 ledger_extension ─────────────────────────────────────
{
  const anchor =
    "| `ledger_index` | 为卡片目录生成**多维索引表**（融合模型判断、时间、稳定性与星级） |";
  rep(
    "③ 工具表补 ledger_extension",
    anchor,
    anchor +
      "\n| `ledger_extension` | 维护自定义**扩展记忆**（7 种模式，按需挂载项目专属记忆单元） |"
  );
}

// ── 改动 4：记忆分类前说明 V3 记忆目录下沉 ────────────────────────────────
{
  const from = '**判定依据：语义不同的内容分别存放。** 将"当前状态"与"历史流水"置于同一文件会相互干扰';
  rep(
    "④ 记忆分类前补 memoryRoot 说明",
    from,
    "**判定依据：语义不同的内容分别存放。** 在 V3 架构下（清单声明 `memoryRoot`），" +
      "所有记忆文件与目录统一存放在 `<项目名>-ledger-memory/` 专用子目录中，与项目源码严格物理隔离；" +
      'V2 项目则保持在项目根目录（向后兼容）。将"当前状态"与"历史流水"置于同一文件会相互干扰'
  );
}

// ── 改动 5：记忆分类表补 extensions/ ─────────────────────────────────────
{
  const anchor =
    '| `decisions/` | 长期决策（**一卡一文件**） | 只追加，不参与归档 | 摘要见台账 | `ledger_write({target:"decisions"})` |';
  rep(
    "⑤ 记忆分类表补 extensions/",
    anchor,
    anchor +
      "\n| `extensions/` | 自定义**扩展记忆**（7 种模式，注册表 `registry.json`） | 按模式定义（只追加或可覆盖） | 摘要可选注入 | `ledger_extension` |"
  );
}

// ── 改动 6（修正版）：新增「扩展记忆（7 种模式）」一节 ────────────────────
{
  const anchor =
    '**判定依据**：**询问"它存储在磁盘何处" ⇒ 卡片轴；询问"本回合向模型推送多少" ⇒ 区块轴。**';
  const section = [
    "",
    "### 扩展记忆（7 种模式）",
    "",
    "为满足项目特有的记忆需求（游戏机制、专有术语、规范清单等），同时避免污染核心记忆体系，插件支持**用户自定义的扩展记忆**：",
    "",
    "- **存储形态**：统一存放在记忆目录的 `extensions/` 下，以 `registry.json` 为注册表真源。",
    "  · **卡片型**（`decisions` / `goals` / `lessons`）：`extensions/<id>/cards/<key>.md`，一卡一文件。",
    "  · **单文件型**：文件名随模式而定 —— `principles` → `PRINCIPLES.md`、`active` → `LEDGER.md`、",
    "    `journal` → `JOURNAL.md`、`plain` → `content.md`。",
    "- **七种模式**（顺序固定，受保护的排最前，看得见）：",
    "  1. `principles`（根本原则型）：单文件，受严格保护，修改需使用者明确授权，模型仅可提议。",
    "  2. `decisions`（决策型）：卡片型，编号即地址（如 `D1.md`）。",
    "  3. `active`（活跃台账型）：单文件，可覆盖与精简，适合维护当前业务状态。",
    "  4. `journal`（流水记录型）：单文件，只追加、不改旧条目。",
    "  5. `goals`（目标树型）：卡片型，一卡一节点，记录目标演进。",
    "  6. `lessons`（经验教训型）：卡片型，沉淀经验与踩坑教训。",
    "  7. `plain`（普通独立记忆型）：单文件，普通读写，无特殊约束。",
    "- **隔离与防冲突**：扩展记忆**不得占用**核心保留名（`ledger` / `decisions` / `journal` / `goals` /",
    "  `lessons` / `principles`），也不得改变基础模板；可通过工具 `ledger_extension` 或设置面板的",
    "  「扩展记忆」页管理。",
  ].join("\n");
  rep("⑥ 新增扩展记忆（7 种模式）一节", anchor, anchor + "\n" + section);
}

// ── 改动 7：能力边界补 extensions/ ───────────────────────────────────────
rep(
  "⑦ 能力边界说明补 extensions/",
  "> **能力边界说明**：`goals/` 与 `lessons/` 属于**可选能力**，并非所有项目自动具备。",
  "> **能力边界说明**：`goals/`、`lessons/` 以及 `extensions/` 均属于**可选能力**，并非所有项目自动具备。"
);

// ── 改动 8：_stash/ 路径 ────────────────────────────────────────────────
rep(
  "⑧ _stash/ 路径改记忆目录",
  "  写入项目的 `_stash/` 目录，**永不注入**，按需检索。",
  "  写入记忆目录的 `_stash/` 目录（V3 下位于 `<项目名>-ledger-memory/` 内），**永不注入**，按需检索。"
);

// ── 改动 9：卡片化范围补扩展记忆 ─────────────────────────────────────────
rep(
  "⑨ 卡片化范围补卡片型扩展记忆",
  "**卡片化**：`decisions/`、`goals/`、`lessons/` 均采用**一卡一文件**（文件名如 `D195.md` / `g1.md` / `L3.md`），",
  "**卡片化**：核心记忆（`decisions/`、`goals/`、`lessons/`）以及**卡片型扩展记忆**均采用**一卡一文件**（文件名如 `D195.md` / `g1.md` / `L3.md`），"
);

// ── 改动 10：活动日志目录路径 ───────────────────────────────────────────
rep(
  "⑩ 活动日志目录改记忆目录",
  "写入使用者为项目登记的日志目录，**只追加、永不改写**，且**从不注入上下文**（按需查询）：",
  "写入项目登记的日志目录（V3 下位于 `<项目名>-ledger-memory/` 内），**只追加、永不改写**，且**从不注入上下文**（按需查询）："
);

// ── 改动 11：ledger_migrate 支持 op:v3 ──────────────────────────────────
rep(
  "⑪ ledger_migrate 补 op:v3",
  "| `ledger_migrate` | 反向的那一半：检测**旧架构**并给出拆分/搬家步骤 |",
  '| `ledger_migrate` | 反向的那一半：检测**旧架构**并给出拆分/搬家步骤（`op:"split"` 拆卡片 · `op:"v3"` 迁入记忆子目录，两者默认干跑） |'
);

// ── 改动 12：已知边界补 V3 Git 隔离说明 ─────────────────────────────────
{
  const anchor =
    '- 压缩服务仅可通过 `agentPresets.serviceFor(agent, "compaction")` 取得，`ctx.get("compaction")` 恒为 `undefined`。';
  rep(
    "⑫ 已知边界补 V3 Git 隔离与安全边界",
    anchor,
    anchor +
      "\n- V3 记忆目录的 Git 隔离由**三层**共同负责：`.gitignore` 规则 · 插件内部的结构性拒绝暂存（V3 项目一律不自动 `git add`）· 目录与源码物理分离。" +
      "记忆目录内的 `SECURITY.md` 只是**给模型的安全准则**，不构成技术隔离，也不应被当作唯一防线。"
  );
}

// ── 执行 ────────────────────────────────────────────────────────────────
console.log("═".repeat(72));
console.log("合并 README 补丁（12 处）");
console.log("═".repeat(72));
console.log(`原文件：${Buffer.byteLength(orig, "utf8")} B / ${text.split("\n").length} 行 / sha ${sha(orig)}`);
console.log(`备份  ：${bak}\n`);

let bad = 0;
for (const c of CHANGES) {
  const n = text.split(c.from).length - 1;
  if (n !== 1) {
    bad += 1;
    console.log(`  ✗ ${c.label}  —— 原文命中 ${n} 次（必须恰好 1 次）`);
    continue;
  }
  text = text.replace(c.from, c.to);
  console.log(`  ✓ ${c.label}`);
}

if (bad > 0) {
  console.log(`\n✗ 有 ${bad} 处锚点不唯一 ⇒ **什么都没写**（文件保持原样）`);
  process.exit(1);
}

const out = Buffer.from(text, "utf8");
console.log(`\n新文件：${Buffer.byteLength(out, "utf8")} B / ${text.split("\n").length} 行`);

if (!APPLY) {
  console.log("\n（dry-run；加 --apply 才真写）");
  process.exit(0);
}
fs.writeFileSync(TARGET, out);
console.log("✓ 已写入 README.md");
console.log(`  新 sha ${sha(out)}`);
