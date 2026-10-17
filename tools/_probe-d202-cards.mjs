/**
 * ★★★★★ 行为探针（D202）：**卡片化 —— 一卡一文件**，先验"无损"再验"取得到"
 *
 * 用户原话（逐字）：*"所以这就是我的想法，也是我一开始提出来的，所有的台账类别全部变成文件夹，
 * 然后各种内容变成卡片类和区块化。"* + *"问题是实现之后他们就是一整个文件，导致模型有时候很难读取"*
 *
 * ★★★ 本探针的**第一条、也是最重要的一条**是**无损性**：
 *   迁移会动一个 474K 的大文件 ⇒ 若切片丢字，那是**不可逆的记忆损坏**。
 *   ⇒ 判据：**所有卡片拼回去 == 原文件**（忽略空行差异），并且**逐字节复算**。
 *   ★ 而且这一条要在**真文件**（本项目 DECISIONS.md，13,641 行）上验，不只在小夹具上
 *     —— 大文件才会暴露"边界切错/前言丢掉"这类问题。
 *
 * 第二条：**安全边界**。`entry` 会变成**文件名** ⇒ 必须挡路径穿越。
 * ★ 判据：拿 `../../x`、`a/b`、`..`、空串**真的打一遍**，必须全被拒。
 *
 * 第三条：**取得到**（卡片模式的读取，与单文件模式返回同一形状）。
 *
 * ★ 只读真项目文件（迁移只在 %TEMP% 夹具上跑）。
 * 跑法：node tools/_probe-d202-cards.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const bar = (s) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
let bad = 0;
const check = (ok, label, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
};

const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const T = mod.__test;
const CLEAN = [];
const mk = (tag) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `cards-${tag}-`)); CLEAN.push(d); return d; };
process.on("exit", () => { for (const d of CLEAN) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } } });

// ── ① ★★★★★ 无损性（在**真文件**上验）────────────────────────────────
bar("① ★★★★★ 无损性：把**真的** `DECISIONS.md`（13,641 行）切开，拼回去必须等于原文");
{
  const raw = fs.readFileSync(path.join(ROOT, "DECISIONS.md"), "utf8");
  const parts = T.splitIntoCardParts(raw, "decisions");
  console.log(`  切出 ${parts.length} 张卡 · 原文件 ${raw.length} 字符`);
  // ★★★ 尺子修正（我第一版在这里**误报"丢内容了"**，必须留档）：
  //   第一版我比"整份字符串"，而切片时每张卡**各自去掉尾空白**⇒ 卡与卡交界处的**空行**被规范化
  //   ⇒ 差 202 字符 ⇒ 判"丢内容"。★ 而诊断（`_diag-d202-split`）证明：**逐段全部对得上**，
  //   差的**全是空行**。⇒ **空行是排版，不是内容**。
  //   ★ 正解：**比"非空行序列"**（那才是内容）；空行差异单独报、不当失败。
  const nonBlank = (s) => s.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "");
  const aLines = nonBlank(raw);
  const bLines = nonBlank(parts.map((p) => p.text).join("\n"));
  const lossless = aLines.length === bLines.length && aLines.every((l, i) => l === bLines[i]);
  check(parts.length > 190, "★ 切出的卡片数与预期同量级（>190）", `${parts.length} 张`);
  check(lossless, "★★★★★ **拼回去逐行等于原文**（比「非空行序列」—— 空行是排版不是内容）",
    lossless ? `${aLines.length} 非空行全等` : `**丢内容了**：原文 ${aLines.length} 行 / 拼回 ${bLines.length} 行`);
  if (!lossless) {
    const i = aLines.findIndex((l, k) => l !== bLines[k]);
    console.log(`      第一个不同在第 ${i + 1} 行：`);
    console.log(`        原文: ${JSON.stringify((aLines[i] ?? "").slice(0, 90))}`);
    console.log(`        拼回: ${JSON.stringify((bLines[i] ?? "").slice(0, 90))}`);
  }
  // ★★ 逐段复核（这才是"无损"的真正判据：**每一段都与它在原文里的那段逐字相同**）
  {
    const lines = raw.split(/\r?\n/);
    const re = /^##\s*D(\d+)(?![\dA-Za-z])/;
    const starts = [];
    lines.forEach((l, i) => { const m = re.exec(l); if (m !== null) starts.push(i); });
    let mismatched = 0;
    for (let i = 0; i < starts.length; i++) {
      const expect = lines.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : lines.length).join("\n").replace(/\s+$/, "");
      const got = parts[i]?.text ?? "";
      // 第一张卡多带一段前言 ⇒ 用"以它结尾"判
      const ok = i === 0 ? got.endsWith(expect) : got === expect;
      if (!ok) mismatched++;
    }
    check(mismatched === 0, "★★★★★ **逐段复核：每张卡与原文对应段逐字相同**（比「总长度相等」硬得多）", `${starts.length} 段，${mismatched} 段不符`);
  }
  // ★ 前言没丢（文件头那些说明句）
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim() !== "" && !/^##\s*D\d+/.test(l));
  if (firstLine !== undefined && firstLine.startsWith("#")) {
    check(parts[0].text.includes(firstLine.trim()), "★ 文件头（前言）**并进了第一张卡**，没有丢", firstLine.slice(0, 40));
  }
  // ★★★ 重复编号：**如实报出来**（这是源文件的真缺陷 ——「引用必达」守卫查不出，因为它去重）
  const keyCount = new Map();
  for (const p of parts) keyCount.set(p.key, (keyCount.get(p.key) ?? 0) + 1);
  const dupKeys = [...keyCount.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k}×${n}`);
  console.log(`  ⚠️ 源文件里的**重复编号**：${dupKeys.length === 0 ? "（无）" : dupKeys.join(", ")}`);
  check(true, "（重复编号**不是切片错**：迁移会拒绝并在错误里报出两处行号 —— 见下面 ③ 的负向对照）", dupKeys.join(", ") || "无");
  // ★ 抽样：D195 那一张的内容必须含它自己的正文
  const d195 = parts.find((p) => p.key === "D195");
  check(d195 !== undefined && d195.text.includes("D195") && /契约|可见性/.test(d195.text), "★ 抽验：`D195` 那张的内容确实是 D195 的正文", d195 ? `${d195.text.length} 字符` : "**找不到**");
}

// ── ② ★★★★ 安全边界：`entry` 会变成文件名 ⇒ 必须挡路径穿越 ─────────────
bar("② ★★★★ 安全边界：路径穿越串**必须全被拒**（`entry` 会变成文件名）");
{
  const BAD = ["../../etc/passwd", "..", ".", "", "a/b", "a\\b", "D1.md", "D 1", "D1;rm", "~x", "D1\nD2"];
  const GOOD = ["D1", "D195", "L1", "E7", "g4", "a.b-c_d", "D202"];
  for (const b of BAD) {
    check(T.isSafeCardKey(b) === false, `拒绝 ${JSON.stringify(b)}`);
  }
  for (const g of GOOD) {
    check(T.isSafeCardKey(g) === true, `接受 ${JSON.stringify(g)}`);
  }
  // ★★ 纵深防御：即使键过了白名单，`cardFileAbs` 也必须保证结果还在目录内
  const tmp = mk("traverse");
  fs.mkdirSync(path.join(tmp, "decisions"), { recursive: true });
  const esc = T.readCard(tmp, "decisions", "../../evil");
  check(esc === undefined, "★★ 纵深防御：`readCard` 拿穿越键 ⇒ 返回 undefined（不读目录外）", String(esc));
}

// ── ②b ★★★★ 重复编号：必须**拒绝**并报出行号（不许静默覆盖 = 丢卡）────────
bar("②b ★★★★ 重复编号 ⇒ **拒绝迁移**并报出两处行号（静默覆盖 = 丢一张卡）");
{
  const root = mk("dup");
  fs.writeFileSync(
    path.join(root, "DECISIONS.md"),
    "# 决策\n\n## D1 · 第一条\n\n甲。\n\n## D2 · 第二条\n\n乙。\n\n## D1 · 又一条 D1（重号！）\n\n丙。\n",
    "utf8"
  );
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
  fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
  fs.writeFileSync(path.join(root, ".dsh-ledger.json"), JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", revision: 0 }, null, 2), "utf8");
  const r = T.splitFileIntoCards(root, { decisionsRel: "DECISIONS.md" }, "decisions", { apply: true, dir: "cards_dup" });
  check(r.ok === false, "★★★★ 重号 ⇒ **拒绝**（`ok:false`）", r.reason?.slice(0, 40));
  check(/重复编号/.test(r.reason ?? ""), "★ 原因写清了「重复编号」", "");
  check(Array.isArray(r.duplicates) && r.duplicates.length === 1 && r.duplicates[0].key === "D1", "★★★★ **报出重复的那个键 + 两处行号**（可行动的报错）", JSON.stringify(r.duplicates));
  check(typeof r.duplicates?.[0]?.first === "number" && typeof r.duplicates?.[0]?.second === "number", "★★ 行号是数字且两处不同", `${r.duplicates?.[0]?.first} / ${r.duplicates?.[0]?.second}`);
  check(!fs.existsSync(path.join(root, "cards_dup")), "★★★★★ **拒绝时一个文件都没写**（连目录都没建）", fs.existsSync(path.join(root, "cards_dup")) ? "**建了！**" : "没建");
}

// ── ③ 端到端：真迁移一次（在 %TEMP% 夹具上），再验三种读法 ─────────────
bar("③ 端到端：夹具上真拆一次 ⇒ 卡片模式读得到、单文件模式也还在");
{
  const root = mk("split");
  // 造一个"单文件模式"的项目（含前言 + 3 条决策 + 一条超长）
  const head = "# 关键决策（长期保留）\n\n> 说明句一\n> 说明句二\n\n";
  const d1 = "## D1 · 第一条\n\n正文一。\n";
  const d2 = "## D2 · 第二条\n\n" + "很长的一段。".repeat(500) + "\n";
  const d10 = "## D10 · 第十条（编号两位数 ⇒ 排序要看数字不看字典序）\n\n正文十。\n";
  fs.writeFileSync(path.join(root, "DECISIONS.md"), head + d1 + "\n" + d2 + "\n" + d10, "utf8");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
  fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", revision: 0 }, null, 2),
    "utf8"
  );
  const run = { tools: new Map() };
  const ctx = {
    tools: { register: (d) => run.tools.set(d.name, d) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on: () => () => {},
    inject: () => undefined,
    get: () => undefined,
    webServer: { register: () => () => {} },
    configEditor: { entries: () => [], configuration: () => [], edit: async () => {} },
  };
  mod.apply(ctx, {});
  const ex = { agent: { session: { header: { id: "s-d202", cwd: root } } } };
  const read = (a) => run.tools.get("ledger_read").execute(a, ex);

  // 迁移前：单文件模式读 D1
  const before = await read({ target: "decisions", entry: "D1" });
  check(before.found === true && before.mode === "file", "★ 迁移前：单文件模式读得到 `D1`", `mode=${before.mode}`);

  // ① 预览（dry-run）**不许写任何东西**
  const info = mod.__test ? undefined : undefined;
  // ★ 直接调内部集合：用 ledger_migrate 的 dry-run 路径
  const srcBefore = fs.readFileSync(path.join(root, "DECISIONS.md"), "utf8");
  const dry = run.tools.get("ledger_migrate").execute
    ? await run.tools.get("ledger_migrate").execute({ root: undefined, apply: false }, ex)
    : undefined;
  // ledger_migrate 目前是"检测旧格式"，卡片迁移走它自己的入口（下面用 __test 直调）
  check(dry === undefined || dry.ok !== undefined, "（`ledger_migrate` 仍在——它管「旧格式检测」，与本条不冲突）", dry === undefined ? "未调用" : `ok=${dry.ok}`);

  // ★ 真拆：用 __test 直调（工具入口在下一步再加）
  const det = {
    decisionsRel: "DECISIONS.md", decisionsDir: undefined,
    lessonsRel: undefined, lessonsDir: undefined, goalsRel: undefined, goalsDir: undefined,
  };
  const dryRun = T.splitFileIntoCards(root, det, "decisions", { apply: false });
  check(dryRun.ok === true && dryRun.dryRun === true, "★★ **预览**成功（dry-run）", `将拆 ${dryRun.cards} 张`);
  check(fs.readFileSync(path.join(root, "DECISIONS.md"), "utf8") === srcBefore, "★★★★ 预览**一个字节都没写**（连目录都没建）", fs.existsSync(path.join(root, "decisions")) ? "**建目录了！**" : "没建");
  check(dryRun.verify.lossless === true, "★★★★ 预览里已**逐字校验无损**", JSON.stringify(dryRun.verify));

  const applied = T.splitFileIntoCards(root, det, "decisions", { apply: true, dir: "decisions" });
  check(applied.ok === true, "★★ 真拆成功", applied.ok ? `写了 ${applied.written} 张` : applied.reason);
  check(fs.existsSync(path.join(root, "decisions", "D1.md")), "★ 卡片文件真的在（`decisions/D1.md`）");
  check(fs.readFileSync(path.join(root, "DECISIONS.md"), "utf8") === srcBefore, "★★★★★ **原文件一个字都没动**（它是迁移前快照）");
  // ★★ 清单被登记 ⇒ 之后 `inspect` 会认它是卡片模式
  const man = JSON.parse(fs.readFileSync(path.join(root, ".dsh-ledger.json"), "utf8"));
  check(man.decisionsDir === "decisions", "★★ 清单登记了 `decisionsDir`（登记之后才被当作卡片模式）", JSON.stringify(man.decisionsDir));

  // 幂等/防覆盖：再拆一次必须**拒**
  const again = T.splitFileIntoCards(root, { decisionsRel: "DECISIONS.md" }, "decisions", { apply: true });
  check(again.ok === false && /已存在且非空/.test(again.reason ?? ""), "★★★★ 目标目录已存在且非空 ⇒ **拒绝**（不覆盖、不合并）", again.reason?.slice(0, 50));

  // 卡片模式读：必须**直接开那个小文件**
  const after = await read({ target: "decisions", entry: "D1" });
  check(after.found === true && after.mode === "card", "★★★★ 迁移后：**卡片模式**读得到 `D1`", `mode=${after.mode} · fromCard=${after.fromCard}`);
  check((after.text ?? "").includes("正文一"), "★ 内容对得上", (after.text ?? "").slice(0, 30));
  // ★★★ 大卡也一样（卡片化就是为了治"大"）
  const big = await read({ target: "decisions", entry: "D2" });
  check(big.found === true && (big.text ?? "").length > 3000, "★★★ **超长卡**也读得到（这正是卡片化要治的）", `${(big.text ?? "").length} 字符`);
  // ★ 不存在的卡：如实说没有 + 给目录
  const miss = await read({ target: "decisions", entry: "D999" });
  check(miss.found === false && miss.toc !== undefined, "★★ 取不存在的卡 ⇒ 如实报 + 给**卡片目录**（不是文件 toc）", `toc=${miss.toc?.count} 张`);
  // ★★ 目录排序：D10 **不许**排在 D2 前面（字典序会错）
  const keys = (miss.toc?.cards ?? []).map((c) => c.key);
  check(keys.indexOf("D2") < keys.indexOf("D10"), "★★★★ 目录按**数字**排序（`D2` 在 `D10` 前 —— 字典序会反）", JSON.stringify(keys));
}

// ── ④ ★★★★ 索引表：每个文件夹里那张「多维分区块」 ──────────────────────
bar("④ ★★★★ 索引表：卡片文件夹里的 `INDEX.md`（用户拍板：「按之前搞的那多重维度分区块」）");
{
  const root = mk("idx");
  const decisions = path.join(root, "decisions");
  fs.mkdirSync(decisions, { recursive: true });
  // ★ 三张卡：小/大/带星，且**故意乱序**（索引必须自己排出来）
  fs.writeFileSync(path.join(decisions, "D1.md"), "## D1 · 小卡\n\n一句话。\n", "utf8");
  fs.writeFileSync(path.join(decisions, "D2.md"), "## D2 · 大卡 ★★★\n\n" + "内容。".repeat(400) + "\n", "utf8");
  fs.writeFileSync(path.join(decisions, "D10.md"), "## D10 · 中等卡\n\n" + "中。".repeat(50) + "\n", "utf8");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
  fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", decisionsDir: "decisions", archiveDir: "_ledger-archive", revision: 0 }, null, 2),
    "utf8"
  );
  const run = { tools: new Map() };
  const ctx = {
    tools: { register: (d) => run.tools.set(d.name, d) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on: () => () => {},
    inject: () => undefined,
    get: () => undefined,
    webServer: { register: () => () => {} },
    configEditor: { entries: () => [], configuration: () => [], edit: async () => {} },
  };
  mod.apply(ctx, {});
  const ex = { agent: { session: { header: { id: "s-idx", cwd: root } } } };
  const idxTool = run.tools.get("ledger_index");
  check(idxTool !== undefined, "★ `ledger_index` 工具已注册", String(idxTool !== undefined));

  const show = await idxTool.execute({ kind: "decisions" }, ex);
  check(show.ok === true && show.count === 3, "★★ 现算出 3 张卡的索引", `count=${show.count}`);
  console.log("  ── 现算的索引表 ──");
  for (const l of (show.markdown ?? "").split("\n")) console.log(`    ${l}`);
  // ★★ 四维必须真的参与（"为什么这个位置"那列非空 ⇒ 说明算的是融合分，不是随便排）
  check(show.rows.every((r) => typeof r.why === "string" && r.why.length > 0), "★★★★ 每行都给**「为什么这个位置」**（四维融合的可解释性）", show.rows[0]?.why?.slice(0, 60));
  // ★ 按分降序
  const scores = show.rows.map((r) => r.score);
  check(scores.every((s, i) => i === 0 || scores[i - 1] >= s), "★★ 按融合分**降序**（相对位置落地）", JSON.stringify(scores));
  // ★★★ 默认 **op 不传 = 只读** ⇒ 不许落盘
  check(!fs.existsSync(path.join(decisions, "INDEX.md")), "★★★★★ 默认（`op` 不传）**不落盘**（只读重算 —— 派生物不当权威）", fs.existsSync(path.join(decisions, "INDEX.md")) ? "**写盘了！**" : "没写");
  // 显式 write 才落盘
  const wrote = await idxTool.execute({ kind: "decisions", op: "write" }, ex);
  check(wrote.ok === true && wrote.wrote === true && fs.existsSync(path.join(decisions, "INDEX.md")), "★ `op:\"write\"` 才落盘成 `decisions/INDEX.md`", wrote.indexPath ?? "");
  const md = fs.readFileSync(path.join(decisions, "INDEX.md"), "utf8");
  // ★★★ 尺子修正（第二次）：第一版查 `从不读它`，而文件里写的是 `从*不读它*`
  //   （markdown 斜体把词切开了）⇒ **断言假红**。★ 判据：**别断言带格式的整句**，
  //   断言"几个关键词都在"（缓存 / 权威 / 不读）—— 那才是要守的意思。
  check(
    md.includes("只是缓存") && md.includes("权威") && /从.?不读它/.test(md),
    "★★★ 落盘那份**自带「这只是缓存」声明**（防止后人把它当权威）",
    md.split("\n").filter((l) => l.includes("缓存"))[0]?.slice(0, 50)
  );
  // ★★ 反向对照：没有卡片目录的项目 ⇒ 明确拒绝（不许假装有索引）
  const legacy = mk("idx-legacy");
  fs.writeFileSync(path.join(legacy, "DECISIONS.md"), "# 决策\n\n## D1 · x\n\n正文\n", "utf8");
  fs.writeFileSync(path.join(legacy, "LEDGER.md"), "# 台账\n", "utf8");
  fs.mkdirSync(path.join(legacy, "_ledger-archive"), { recursive: true });
  fs.writeFileSync(path.join(legacy, ".dsh-ledger.json"), JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", revision: 0 }, null, 2), "utf8");
  const run2 = { tools: new Map() };
  mod.apply({ ...ctx, tools: { register: (d) => run2.tools.set(d.name, d) } }, {});
  const noCards = await run2.tools.get("ledger_index").execute({}, { agent: { session: { header: { id: "s-idx2", cwd: legacy } } } });
  check(noCards.ok === false && /没有卡片目录/.test(noCards.reason ?? ""), "★★★★ 负向对照：没有卡片目录 ⇒ **明确拒绝**（并指向 `ledger_migrate` 拆分）", noCards.reason?.slice(0, 40));
}

// ── ⑤ 反向对照：**不许**把"单文件模式"当成坏了 ─────────────────────────
bar("⑤ 反向对照：没登记卡片目录的项目，**照旧走单文件**（既有用户一个字节都不动）");
{
  const root = mk("legacy");
  fs.writeFileSync(path.join(root, "DECISIONS.md"), "# 决策\n\n## D1 · 老项目\n\n老内容。\n", "utf8");
  fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n", "utf8");
  fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".dsh-ledger.json"),
    JSON.stringify({ version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", revision: 0 }, null, 2),
    "utf8"
  );
  const run = { tools: new Map() };
  const ctx = {
    tools: { register: (d) => run.tools.set(d.name, d) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on: () => () => {},
    inject: () => undefined,
    get: () => undefined,
    webServer: { register: () => () => {} },
    configEditor: { entries: () => [], configuration: () => [], edit: async () => {} },
  };
  mod.apply(ctx, {});
  const ex = { agent: { session: { header: { id: "s-legacy", cwd: root } } } };
  const r = await run.tools.get("ledger_read").execute({ target: "decisions", entry: "D1" }, ex);
  check(r.found === true && r.mode === "file", "★★★★★ **老项目照旧**（`mode:file`）—— 卡片化**不是破坏性升级**", `mode=${r.mode}`);
  check((r.text ?? "").includes("老内容"), "★ 内容读得到");
}

bar(`结  论：${bad === 0 ? "全部通过" : `${bad} 项不符合预期`}`);
console.log("  ★ 通过意味着：**大文件切片无损**（拼回去逐字等于原文）· **路径穿越全挡** ·");
console.log("    **一卡一文件读得到**（含超长卡）· **老项目照旧**（不是破坏性升级）· **原文件不删**。");
