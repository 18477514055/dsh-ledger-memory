#!/usr/bin/env node
/**
 * D365 **守卫/取证合一** —— 逐条核对 `docs/Gemini静态审查019.md` 的 9 项发现（20 个子项）。
 *
 * ★★★ 断言一律写成「**缺陷不应该存在**」。⇒ 同一个文件两用，且两用都是真的：
 *   · 跑在**未修**代码上 ⇒ 大面积 FAIL（本机实测基线 `e8edc6c`：**PASS 5 · FAIL 19**）
 *     —— 这就是"报告属实、且本判据**可被证伪**"的证据（不是只写了张断言表）；
 *   · 跑在**已修**代码上 ⇒ 全绿 —— 这才是守卫。
 *   ★ 判据：**一条断言如果它在修前修后都绿，它就没在守任何东西**（尺子错第 21 条「断言也会过期」同型）。
 *   ⇒ 因此**基线红数必须记进 decision 卡**，否则下一个人无法判断这份守卫是否退化。
 *
 * ★ 那 5 条修前也 PASS 的全是**对照项**（"修完不能一刀切、把该留的也关掉"）——
 *   它们必须在修前修后**都绿**，否则修法就是把功能删掉冒充修好。
 *
 * ★★ 判据方向：**「报告说有」≠「本机真有」** —— 每一条都要真调函数/真建夹具看结果，
 *   不许照抄报告里的行号当成事实（D324 / 尺子错第 24 条）。
 * ★★ 夹具纪律（D286 连踩三次那条）：F-08a 必须**先确认卡上真有指纹**再断言行数，
 *   否则量到的是"夹具没盖指纹"，会被当成"被测对象的缺陷"。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let pass = 0;
let fail = 0;
const rows = [];
function ok(title, cond, detail) {
  if (cond) {
    pass += 1;
    rows.push(`PASS  ${title}${detail === undefined ? "" : ` — ${detail}`}`);
  } else {
    fail += 1;
    rows.push(`FAIL  ${title}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}
function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `d365-${tag}-`));
}

const fp = await import("../lib/fingerprint.js");
const part6 = await import("../lib/part6.js");

// ═══════════════════════════════════════════════════════════════════════
// F-03c（最要命的一条）：V2 flat 布局下 identityOfPath 兜底把整库源码判成 custom
// ═══════════════════════════════════════════════════════════════════════
{
  const root = tmpdir("f03c");
  // V2：清单没有 memoryRoot ⇒ memoryBase === projectRoot
  const info = {
    memoryBase: root,
    projectRoot: root,
    active: "LEDGER.md",
    journal: "JOURNAL.md",
  };
  const pkg = path.join(root, "package.json");
  fs.writeFileSync(pkg, '{"name":"x"}\n', "utf8");
  const src = path.join(root, "src");
  fs.mkdirSync(src, { recursive: true });
  const idx = path.join(src, "index.js");
  fs.writeFileSync(idx, "export const a = 1;\n", "utf8");

  const pkgId = fp.identityOfPath(info, pkg);
  const srcId = fp.identityOfPath(info, idx);
  ok(
    "F-03c V2 flat：源码根上的 package.json 不应被判成记忆身份",
    pkgId === undefined,
    `identityOfPath(package.json) = ${JSON.stringify(pkgId)}`,
  );
  ok(
    "F-03c V2 flat：src/index.js 不应被判成记忆身份",
    srcId === undefined,
    `identityOfPath(src/index.js) = ${JSON.stringify(srcId)}`,
  );

  // ★ 对照：V3（有独立 memoryRoot）下 memoryRoot 内的自建文件**必须**有身份
  const mem = path.join(root, "proj-ledger-memory");
  fs.mkdirSync(path.join(mem, "我的笔记"), { recursive: true });
  const mine = path.join(mem, "我的笔记", "想法.txt");
  fs.writeFileSync(mine, "随手记\n", "utf8");
  const v3 = { memoryBase: mem, projectRoot: root, active: "LEDGER.md", journal: "JOURNAL.md" };
  const mineId = fp.identityOfPath(v3, mine);
  ok(
    "F-03c 对照：V3 下 memoryRoot 里的自建 txt 仍必须给身份（不能一刀切关掉）",
    mineId !== undefined && mineId.kind === "custom",
    `identityOfPath(<mem>/我的笔记/想法.txt) = ${JSON.stringify(mineId)}`,
  );

  // F-03a：V3 记忆目录下的隐藏清单 .dsh-ledger.json / 诊断日志
  const mirror = path.join(mem, ".dsh-ledger.json");
  fs.writeFileSync(mirror, "{}\n", "utf8");
  const mirrorId = fp.identityOfPath(v3, mirror);
  ok(
    "F-03a V3 记忆目录里的 .dsh-ledger.json 不应被判成 custom（它是清单镜像，不是记忆）",
    mirrorId === undefined,
    `identityOfPath(<mem>/.dsh-ledger.json) = ${JSON.stringify(mirrorId)}`,
  );

  // F-03b：extensions/registry.json 与 extensions/<id>/cards/INDEX.md
  const reg = path.join(mem, "extensions", "registry.json");
  fs.mkdirSync(path.dirname(reg), { recursive: true });
  fs.writeFileSync(reg, "{}\n", "utf8");
  const regId = fp.identityOfPath(v3, reg);
  ok(
    "F-03b extensions/registry.json 不应被判成 extension（它是注册表元数据）",
    regId === undefined,
    `identityOfPath(<mem>/extensions/registry.json) = ${JSON.stringify(regId)}`,
  );
  const cardsIdx = path.join(mem, "extensions", "e1", "cards", "INDEX.md");
  fs.mkdirSync(path.dirname(cardsIdx), { recursive: true });
  fs.writeFileSync(cardsIdx, "# 目录\n", "utf8");
  const cardsIdxId = fp.identityOfPath(v3, cardsIdx);
  ok(
    "F-03b extensions/<id>/cards/INDEX.md 不应被判成 extension（缓存不盖指纹）",
    cardsIdxId === undefined,
    `identityOfPath(<mem>/extensions/e1/cards/INDEX.md) = ${JSON.stringify(cardsIdxId)}`,
  );
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════
// F-02a：walkMarkdown 根面把 package.json / cordis.patch.yml 当材料扫进来
// ═══════════════════════════════════════════════════════════════════════
{
  const root = tmpdir("f02a");
  const mem = path.join(root, "proj-ledger-memory");
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 台账\n", "utf8");
  fs.writeFileSync(path.join(mem, ".dsh-ledger.json"), '{"projectId":"abcdef"}\n', "utf8");
  // 项目根上的标准工程配置
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"x"}\n', "utf8");
  fs.writeFileSync(path.join(root, "cordis.patch.yml"), "plugins: []\n", "utf8");
  fs.writeFileSync(path.join(root, "_调研-某件事.md"), "# 调研\n", "utf8");

  const info = {
    memoryBase: mem,
    projectRoot: root,
    active: "LEDGER.md",
    journal: "JOURNAL.md",
    archiveRel: "_ledger-archive",
    notesAbs: path.join(root, "问题记录"),
    handoffAbs: path.join(mem, "_handoff"),
  };
  const files = part6.scanMemorySurface(root, info);
  const rels = files.map((f) => `${f.surface}::${f.rel}`);
  ok(
    "F-02a 根面不应把 package.json 当记忆材料",
    !rels.some((r) => r.endsWith("::package.json")),
    `扫到 ${rels.length} 份；含 package.json? ${rels.some((r) => r.endsWith("::package.json"))}`,
  );
  ok(
    "F-02a 根面不应把 cordis.patch.yml 当记忆材料",
    !rels.some((r) => r.endsWith("::cordis.patch.yml")),
    `含 cordis.patch.yml? ${rels.some((r) => r.endsWith("::cordis.patch.yml"))}`,
  );
  ok(
    "F-02a 对照：根面上真正的调研稿仍要被扫到（不能靠「全都不要」蒙过去）",
    rels.some((r) => r.endsWith("::_调研-某件事.md")),
    `含 _调研-某件事.md? ${rels.some((r) => r.endsWith("::_调研-某件事.md"))}`,
  );
  ok(
    "F-02a 记忆目录里的 .dsh-ledger.json 不应被当记忆材料",
    !rels.some((r) => r.endsWith("::.dsh-ledger.json")),
    `含 .dsh-ledger.json? ${rels.some((r) => r.endsWith("::.dsh-ledger.json"))}`,
  );
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════
// F-02c：V3 下 memoryBase 根 / 用户自建子目录扫不到（这是 D363 缺口 B 的残留）
// ═══════════════════════════════════════════════════════════════════════
{
  const root = tmpdir("f02c");
  const mem = path.join(root, "proj-ledger-memory");
  fs.mkdirSync(path.join(mem, "我的笔记"), { recursive: true });
  fs.writeFileSync(path.join(mem, "LEDGER.md"), "# 台账\n", "utf8");
  fs.writeFileSync(path.join(mem, "我的笔记", "想法.txt"), "随手记\n", "utf8");
  fs.writeFileSync(path.join(mem, "零散笔记.txt"), "根上的笔记\n", "utf8");

  const info = {
    memoryBase: mem,
    projectRoot: root,
    active: "LEDGER.md",
    journal: "JOURNAL.md",
    archiveRel: "_ledger-archive",
    handoffAbs: path.join(mem, "_handoff"),
  };
  const files = part6.scanMemorySurface(root, info);
  const rels = files.map((f) => f.rel);
  ok(
    "F-02c V3：memoryBase 下用户自建子目录里的 txt 必须扫得到（D363 缺口 B）",
    rels.some((r) => r.includes("想法")),
    `扫到 ${rels.length} 份：${rels.slice(0, 8).join(", ")}`,
  );
  ok(
    "F-02c V3：memoryBase 根上用户放的 txt 必须扫得到",
    rels.some((r) => r === "零散笔记.txt"),
    `含 零散笔记.txt? ${rels.includes("零散笔记.txt")}`,
  );
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════
// F-02d：citationCountOf 只剥离 .md ⇒ 非 md 文件引用度恒 0
// ═══════════════════════════════════════════════════════════════════════
{
  const corpus = [{ rel: "SECURITY.md", text: "见 我的调研笔记 那一段。" }];
  const n = part6.citationCountOf("docs/我的调研笔记.txt", corpus);
  ok("F-02d 非 md 文件的被引用度不应恒为 0", n > 0, `citationCountOf(我的调研笔记.txt) = ${n}`);
  const n2 = part6.citationCountOf("docs/我的调研笔记.md", corpus);
  ok("F-02d 对照：md 文件引用度仍然正常", n2 > 0, `citationCountOf(我的调研笔记.md) = ${n2}`);
}

// ═══════════════════════════════════════════════════════════════════════
// F-05a/b/c：代码围栏与坏载体
// ═══════════════════════════════════════════════════════════════════════
{
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const r = fp.readFingerprint3(readme, { root: ROOT });
  ok(
    "F-05a README.md 里代码块内的示例载体不应被判成「载体格式损坏」",
    !(r.ok === false && String(r.reason || "").includes("损坏")),
    `ok=${r.ok} reason=${String(r.reason || "").slice(0, 120)} corrupt=${JSON.stringify(r.corrupt || null)}`,
  );
}

{
  // F-05b：双空格硬换行被无差别清除
  const src = "第一行  \n第二行  \n第三行\n";
  const out = fp.applyFingerprint3(src, undefined, { strip: true }).text;
  const hardBreaks = out.split("\n").filter((l) => l.endsWith("  ")).length;
  ok(
    "F-05b applyFingerprint3 不应清除正文行尾双空格（Markdown 硬换行）",
    hardBreaks === 2,
    `保留双空格行数 = ${hardBreaks}（期望 2）；输出=${JSON.stringify(out)}`,
  );
}

{
  // F-05c①：旧版 HTML 注释载体损坏 ⇒ 必须进 corrupt
  const bad = "# 标题\n\n<!-- dsh-ledger-fp: 这不是合法载荷 -->\n正文\n";
  const r = fp.readFingerprint3(bad, { root: ROOT });
  ok(
    "F-05c① 损坏的旧版 <!-- dsh-ledger-fp: --> 必须记入 corrupt",
    Array.isArray(r.corrupt) && r.corrupt.includes("legacy"),
    `ok=${r.ok} corrupt=${JSON.stringify(r.corrupt || null)} reason=${String(r.reason || "").slice(0, 100)}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// F-08a：buildCardBlocks 把指纹算进行数/字符/哈希
// ═══════════════════════════════════════════════════════════════════════
{
  const root = tmpdir("f08a");
  const mem = path.join(root, "proj-ledger-memory");
  const dir = path.join(mem, "decisions");
  fs.mkdirSync(dir, { recursive: true });
  // ★★★ 夹具纪律（D286 连踩三次那条）：`writeCard` 走 `projectOf(root)`，
  //   拿不到 projectId 就**不盖指纹**。上一版我忘了建清单 ⇒ 卡上根本没有指纹
  //   ⇒ 探针"行数相等"是**夹具故障**，不是被测对象的问题。
  //   ⇒ 先把清单写出来，确认卡上**真有** `dsh-fp-front:` 再断言。
  fs.writeFileSync(
    path.join(mem, ".dsh-ledger.json"),
    JSON.stringify({ projectId: "abcdef0123456789", active: "LEDGER.md" }, null, 2) + "\n",
    "utf8",
  );
  const { writeCard, buildCardBlocks } = await import("../lib/card-ops.js");
  writeCard(mem, "decisions", "D1", "## D1 · 测试卡\n\n正文一行\n", { kind: "decisions" });
  const raw = fs.readFileSync(path.join(dir, "D1.md"), "utf8");
  const fpOn = /dsh-fp-front:|dsh-fp-link:/.test(raw);
  ok("F-08a 夹具自检：卡上必须真的盖上了三载体指纹（否则下面的行数断言无意义）", fpOn, `卡原文前 100 字 = ${JSON.stringify(raw.slice(0, 100))}`);
  const blocks = buildCardBlocks(mem, "decisions");
  const b = blocks.find((x) => String(x.key || "").includes("D1")) ?? blocks[0];
  const rawLines = raw.split("\n").length;
  ok(
    "F-08a 卡片索引里的行数必须按「剥离指纹后」的正文算",
    b && b.lines < rawLines - 1,
    `blocks[0].lines = ${b && b.lines}；含指纹原文行数 = ${rawLines}`,
  );
  ok(
    "F-08a 卡片索引里的正文不得泄漏 dsh-fp-front / dsh-fp-link",
    b && !/dsh-fp-front|dsh-fp-link|dsh-id:/.test(String(b.text || "")),
    `text 前 120 字 = ${JSON.stringify(String((b && b.text) || "").slice(0, 120))}`,
  );
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════
// F-04：ensureProjectId 在 lib/ 里是否真的零调用（本机静态核，不是报告说了算）
// ═══════════════════════════════════════════════════════════════════════
{
  const libDir = path.join(ROOT, "lib");
  const hits = [];
  for (const name of fs.readdirSync(libDir)) {
    if (!name.endsWith(".js")) continue;
    const text = fs.readFileSync(path.join(libDir, name), "utf8");
    if (/ensureProjectId\s*\(/.test(text)) {
      // 排除它自己的定义行
      const lines = text.split("\n");
      lines.forEach((l, i) => {
        if (/ensureProjectId\s*\(/.test(l) && !/export\s+function\s+ensureProjectId/.test(l)) {
          hits.push(`${name}:${i + 1}`);
        }
      });
    }
  }
  ok(
    "F-04 ensureProjectId 必须在生产里真被调用（不能是零调用孤岛）",
    hits.length > 0,
    `生产调用点 = ${hits.length} 处：${hits.slice(0, 6).join(", ") || "（无）"}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// F-07：bucketFor 残留旧 memBase（会话中途 V2→V3 迁移）
// ═══════════════════════════════════════════════════════════════════════
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "log-collector.js"), "utf8");
  const onlyIfEmpty = /\}\s*else\s+if\s*\(\s*typeof\s+b\.memBase\s*!==\s*"string"\s*\|\|\s*b\.memBase\s*===\s*""\s*\)\s*\{/.test(src);
  ok(
    "F-07 bucketFor 不应「只在 memBase 为空时才赋值」（V2→V3 迁移后会写回源码根）",
    onlyIfEmpty === false,
    `检出"仅在空时才赋值"写法 = ${onlyIfEmpty}`,
  );
}

// F-01：installPreCommitHook 是否校验 hooks 路径边界
{
  const src = fs.readFileSync(path.join(ROOT, "lib", "part2.js"), "utf8");
  const i = src.indexOf("installPreCommitHook");
  const seg = i >= 0 ? src.slice(i, i + 4000) : "";
  const hasGuard = /isUnderReal\s*\(\s*projectRoot\s*,\s*hooksDir/.test(seg);
  ok(
    "F-01a installPreCommitHook 必须校验 hooksDir 落在项目根内",
    hasGuard,
    `检出 isUnderReal(projectRoot, hooksDir) = ${hasGuard}`,
  );
  const baseSrc = fs.readFileSync(path.join(ROOT, "lib", "base.js"), "utf8");
  const dangling = /if\s*\(\s*fs\.existsSync\(abs\)\s*&&\s*fs\.lstatSync\(abs\)\.isSymbolicLink\(\)\s*\)/.test(baseSrc);
  ok(
    "F-01c writeFileAtomic 不应把悬空符号链接放过去（existsSync 对悬空链返回 false）",
    dangling === false,
    `检出 "existsSync(abs) && lstatSync(...).isSymbolicLink()" 写法 = ${dangling}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════════════════
console.log(rows.join("\n"));
console.log("─".repeat(72));
console.log(`合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
process.exit(0);
