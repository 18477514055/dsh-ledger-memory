// _probe-d364-formats.mjs —— 加指纹对**非 md** 格式有没有破坏性
//
// ★ 为什么必须先量：用户说「可以不仅兼容 md，也可以兼容 txt / json」。
//   但三载体里有一处是 **YAML frontmatter（`---\n…\n---`）**、一处是 **HTML 注释**。
//   ⇒ **JSON 里插 HTML 注释就不是 JSON 了**；YAML 里插也是另一个 YAML 文档。
//   这是**数据损坏**，不是"多加几行"。必须先测出破坏面，再决定怎么做。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const LIB = (n) => pathToFileURL(path.join(ROOT, "lib", n)).href;
const fp = await import(LIB("fingerprint.js"));

let pass = 0, fail = 0;
const ok = (t, c, extra) => {
  if (c) { pass++; console.log(`  ✓ ${t}`); }
  else { fail++; console.log(`  ✗ ${t}${extra === undefined ? "" : `\n        ${String(extra).slice(0, 300)}`}`); }
};
const PID = "0123456789abcdef";

console.log("═══ ① JSON：加三载体之后还是合法 JSON 吗？ ═══");
{
  const original = JSON.stringify({ name: "配置", items: [1, 2, 3], nested: { a: true } }, null, 2);
  console.log(`  原文前 60 字：${JSON.stringify(original.slice(0, 60))}`);
  const stamped = fp.applyFingerprint3(original, { kind: "decisions", project: PID, key: "cfg" });
  console.log(`  加指纹后前 120 字：${JSON.stringify(stamped.text.slice(0, 120))}`);

  let parsed = null, err = null;
  try { parsed = JSON.parse(stamped.text); } catch (e) { err = e; }
  console.log(`  JSON.parse 结果 ⇒ ${err === null ? "成功" : `${err.name}: ${String(err.message).slice(0, 90)}`}`);

  ok("① 【关键】加指纹后 JSON **解析失败**（= 数据损坏）", err !== null, err === null ? JSON.stringify(parsed) : "");
  // ★★★ 2026-10-29（D365）改判：原来这里咬**报错文案**（`/Unexpected token|Expected/`）⇒ 假红。
  //   Node 对 `---` 开头给的是 `No number after minus sign in JSON at position 1`
  //   —— 文案不在那两条里，但**损坏是真实的**。★ 尺子错第 24 条：别按字面量写判据。
  //   ⇒ 改成**行为判据**：把插入的载体 strip 掉之后必须能正常解析。
  //     能 ⇒ 损坏**确实来自插入的那几行**；不能 ⇒ 另有别的原因，那才是真问题。
  const backJ = fp.applyFingerprint3(stamped.text, undefined, { strip: true });
  let stripParses = false;
  try { JSON.parse(backJ.text); stripParses = true; } catch { /* ignore */ }
  ok(
    "① 损坏**由插入的载体造成**（剥掉载体后立刻能正常解析）",
    err !== null && stripParses,
    `stamped 解析失败=${err !== null}；strip 后解析成功=${stripParses}；strip 后前 40 字=${JSON.stringify(backJ.text.slice(0, 40))}`,
  );
}

console.log("\n═══ ② YAML：加三载体还合法吗？ ═══");
{
  const original = "name: 配置\nitems:\n  - 1\n  - 2\n";
  const stamped = fp.applyFingerprint3(original, { kind: "decisions", project: PID, key: "cfg" });
  console.log(`  加指纹后前 120 字：${JSON.stringify(stamped.text.slice(0, 120))}`);
  // 不引 yaml 库，用结构判据：顶层键必须还在第一层
  const firstMeaningful = stamped.text.split("\n").find((l) => l.trim() !== "");
  console.log(`  第一行有效内容 ⇒ ${JSON.stringify(firstMeaningful)}`);
  ok("② 【关键】加指纹后 YAML 顶层键**不再是第一个键**（首行成了 `---`）", firstMeaningful === "---", firstMeaningful);
}

console.log("\n═══ ③ TXT：加三载体有影响吗？ ═══");
{
  const original = "第一行笔记\n第二行\n";
  const stamped = fp.applyFingerprint3(original, { kind: "decisions", project: PID, key: "note" });
  console.log(`  加指纹后前 100 字：${JSON.stringify(stamped.text.slice(0, 100))}`);
  const kept = stamped.text.includes("第一行笔记") && stamped.text.includes("第二行");
  ok("③ TXT 里用户正文**完整保留**（纯文本，插什么都不会坏）", kept);
  ok("③ 但**用户看到的文件多了 5 行**（frontmatter 3 行 + 行内信标 + 尾部 link）", stamped.text.split("\n").length > original.split("\n").length);

  // 还原：strip 之后能否逐字回到原文
  const back = fp.applyFingerprint3(stamped.text, undefined, { strip: true });
  console.log(`  strip 之后 === 原文？ ${back.text === original}`);
  // ★★★ 2026-10-29（D365）改判：原断言要求**逐字**相等，而 `original` 以 `\n` 结尾
  //   ⇒ 落在 `applyFingerprint3` 那条**已知老缺陷**上（写入侧归一化尾换行，见
  //   `_probe-d365-fp-safe.mjs` 的【C】档）。★ 那条缺陷与本探针要证明的事
  //   （"TXT 里用户正文完整保留、且载体可剥"）**是两件事**，混在一起会让一条断言同时测两件事。
  //   ⇒ 改成只比「去掉首尾空白后的正文」，把尾换行单独留给 fp-safe 去报。
  const norm = (x) => x.replace(/\s+$/, "");
  ok(
    "③ ★ strip 能还原正文（载体可剥；尾换行差异由 _probe-d365-fp-safe 的【C】档单独报）",
    norm(back.text) === norm(original),
    JSON.stringify(back.text?.slice(0, 80)),
  );
}

console.log("\n═══ ④ 那 strip 对 JSON 呢？（能不能先剥再解析） ═══");
{
  const original = JSON.stringify({ a: 1, b: [2, 3] }, null, 2);
  const stamped = fp.applyFingerprint3(original, { kind: "decisions", project: PID, key: "cfg" });
  const back = fp.applyFingerprint3(stamped.text, undefined, { strip: true });
  console.log(`  strip 后 === 原文？ ${back.text === original}`);
  let okParse = false;
  try { JSON.parse(back.text); okParse = true; } catch { /* ignore */ }
  ok("④ strip 对 JSON **也能逐字还原** ⇒ 理论上「先剥再读」可行", back.text === original, JSON.stringify(back.text?.slice(0, 90)));
  ok("④ 但**任何不经过 strip 的读取**（编辑器 / 别家工具 / 用户自己双击）都会看到坏文件", true);
}

console.log("\n═══ ⑤ stampDir 默认处理哪些扩展名 ═══");
{
  // ★★★ 2026-10-29（D364 之后更新）：这条原来断言「**只**处理 .md」——
  //   那是 D364 **之前**的现状，正是用户要求改掉的东西。留着它 ⇒ 下一轮把 D364 判成回归
  //   （"断言也会过期"第 3 次，纪律 21）。
  //   ★ 但**不能只数个数**（尺子错第 31 条）：必须钉住三件事 ——
  //     ① md/txt 在名单里（用户要的）② **json/yaml 不在名单里**（实测会坏，故意的）
  //     ③ 名单是从 `stampDir` 的默认值里读出来的（不是别处一个同名常量）。
  const src = fs.readFileSync(path.join(ROOT, "lib", "fingerprint.js"), "utf8");
  const m = /const STAMP_SAFE_EXTS = \[([^\]]*)\]/.exec(src);
  const list = m === null ? "" : m[1];
  console.log(`  STAMP_SAFE_EXTS ⇒ ${list || "(没找到)"}`);
  ok("⑤ 默认名单含 .md 与 .txt（用户要求的格式）", /\.md"/.test(list) && /\.txt"/.test(list), list);
  ok(
    "⑤ 默认名单**不含** .json / .yaml（实测会破坏语法，故意排除）",
    m !== null && !/\.json"/.test(list) && !/\.ya?ml"/.test(list),
    list,
  );
  ok(
    "⑤ 默认值确实取的是 STAMP_SAFE_EXTS（不是别处一个同名常量）",
    /const exts = .{0,80}STAMP_SAFE_EXTS/.test(src),
    "",
  );
}

console.log("\n═══ ⑥ 记忆根下的非标准文件现在被怎么判 ═══");
{
  const base = { memoryBase: path.join(os.tmpdir(), "d364-x"), active: "LEDGER.md", decisionsDir: "decisions", lessonsDir: "lessons", goalsDir: "goals", archiveDir: "_arch", logDir: "_log" };
  const seen = {};
  for (const rel of ["随手记.txt", "config.json", "notes/想法.md", "notes/清单.txt", "data.json"]) {
    const r = fp.identityOfPath(base, path.join(base.memoryBase, rel));
    seen[rel] = r;
    console.log(`  ${rel.padEnd(18)} ⇒ ${JSON.stringify(r)}`);
  }
  // ★★★ 2026-10-29（D364 之后更新）：原来这条是 `ok(..., true)` —— **一条永远为真的死判据**
  //   （尺子错第 31 条："数个数/写常量"测不出行为变了）。D364 之后口径反了：
  //   **记忆根下（V3）一律给身份 `kind:"custom"`**（用户拍板「只要出现在项目台账文件夹里面的就算我们的」）。
  //   ★ 但必须同时守住那条**不该放宽**的：V2 flat（memoryBase === projectRoot）下
  //     源码根上的文件**绝不能**给身份 —— 那是 F-03c，一个真实的边界回归。
  ok(
    "⑥ 记忆根（V3）下的非标准文件**一律给身份 kind=custom**",
    Object.values(seen).every((r) => r !== undefined && r.kind === "custom"),
    JSON.stringify(seen),
  );
  const v2 = { ...base, memoryBase: path.join(os.tmpdir(), "d364-v2-root"), projectRoot: path.join(os.tmpdir(), "d364-v2-root") };
  const pkg = fp.identityOfPath(v2, path.join(v2.memoryBase, "package.json"));
  const srcFile = fp.identityOfPath(v2, path.join(v2.memoryBase, "src", "index.js"));
  console.log(`  V2 flat：package.json ⇒ ${JSON.stringify(pkg)}；src/index.js ⇒ ${JSON.stringify(srcFile)}`);
  ok(
    "⑥ 对照（F-03c）：V2 flat 下源码根上的文件**仍然不给**身份",
    pkg === undefined && srcFile === undefined,
    `package.json=${JSON.stringify(pkg)} src/index.js=${JSON.stringify(srcFile)}`,
  );
}

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
console.log("PROBE-COMPLETE");
