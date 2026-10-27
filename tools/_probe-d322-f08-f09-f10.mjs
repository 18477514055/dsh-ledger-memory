/**
 * _probe-d322-f08-f09-f10.mjs —— D322：Gemini 004 的 F-08 / F-09 / F-10
 *
 * F-08：13 处手写「临时文件 + rename」收敛到 `writeFileAtomic`（它带 wx + 两段 unlinkSync）
 * F-09：删掉 `part4.js → index.js` 这条**死边**（全库唯一 partN→入口的反向依赖）
 * F-10：① engines 已覆盖 `import.meta.dirname` 所需版本；② 变异探针从 `npm run probes` 分离
 *
 * ★ 每条都要能"摘掉修复就变红"，见 `_reverse-verify-d322.mjs`。
 */
import fs from "node:fs";
import path from "node:path";

const results = [];
const ok = (c, label, detail) => results.push({ c, label, detail });
const LIB = "lib";
const files = fs.readdirSync(LIB).filter((f) => f.endsWith(".js"));

// ═══ F-08：手写原子写应收敛 ═══
//
// ★★★★★ 2026-10-25（D323 · 005 报告复核）：**这里原来是个假判据，我改掉了**。
//
//   🔴 原判据是「豁免 `manifest-mirror.js` 的**全部行号**」。005 报告给的修法把它换成
//      `allowed.length <= 2`（**只数条数**）。我实测过：那个修法**只是看起来修好了** ——
//      把 `syncManifestMirror` 那处**退化成裸写**（去掉 wx + unlinkSync）后，
//      数量仍是 2 ⇒ **探针照样绿**，而它的说明文字还印着
//      「manifest-mirror 两处均具备 wx + unlinkSync 强保护」—— **它根本没检查这件事**。
//      ★ 实测见 `tools/_probe-v005-classify.mjs` 情形②：改前 exit=0（假绿）。
//
//   ⇒ 判据的错**不在阈值，在它测的东西**：数个数永远测不出「这一处质量变了」。
//     这正是本项目那条纪律的同型复发：**记录存在 ≠ 记录准确**（记录写着验过，其实没验）。
//
//   ★ 正确判据：**逐处**把那一块的源码切出来，**在块内**找 `wx` 与 `unlinkSync`。
//     判据只吃"被测对象自己"的那部分文本 —— 不许拿文件级存在性顶替（尺度错第 31 次）。
{
  const handWritten = [];
  const details = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(LIB, f), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/fs\.writeFileSync\(tmp\w*\s*,/.test(lines[i])) continue;
      const below = lines.slice(i, i + 7).join("\n");
      if (!/fs\.renameSync\(tmp\w*\s*,/.test(below)) continue;
      // ★ 切"这一处"的块：从写 tmp 往上取 3 行（拿到 try/wx 那行），往下取 10 行（拿到 catch/unlink）。
      //   范围故意小 —— 取大了就会把**隔壁那处**的 wx 借过来，等于又变成文件级判据。
      const block = lines.slice(Math.max(0, i - 4), i + 11).join("\n");
      const hasWx = /flag:\s*["']wx["']/.test(block);
      const hasUnlink = /fs\.unlinkSync\(\s*tmp\w*\s*\)/.test(block);
      handWritten.push({ at: `${f}:${i + 1}`, hasWx, hasUnlink });
    }
  }
  // 允许保留的只有 `manifest-mirror.js` 里那些**逐处都过了 wx + unlinkSync** 的。
  //   ★ 注意：**不是"这个文件里的都放行"**，而是"这一处自己验过了才放行"。
  const allowed = handWritten.filter((h) => /^manifest-mirror\.js:\d+$/.test(h.at) && h.hasWx && h.hasUnlink);
  const bad = handWritten.filter((h) => !allowed.includes(h));
  ok(
    bad.length === 0,
    "F-08 手写「临时文件+rename」已收敛到 writeFileAtomic（manifest-mirror 保留处**逐处**具备 wx + unlinkSync）",
    bad.length
      ? `🔴 不合规：${bad.map((h) => `${h.at}(wx=${h.hasWx},unlink=${h.hasUnlink})`).join(", ")}`
      : `剩 ${allowed.length} 处，逐处均已具备 wx + unlinkSync`
  );
  for (const h of allowed) details.push(h.at);
  if (details.length > 0) console.log(`  · 保留的白名单（逐处已验）：${details.join(", ")}`);
}

// ═══ F-08b：writeFileAtomic 必须真的被 import（不是只加进 re-export 列表）═══
//
//   ★★★ 第一版这里**报了假红**：我只匹配了 `from "./base.js"`，而 `part1.js` 是
//     从 **`part2.js`** 里 import 的（part2 转手 re-export 了 base 的实现）——
//     同样合法、同样有本地绑定。
//   ★ 判据：**"真的 import 了它"就够了，不必限定从哪个模块** —— 判"有没有绑定"，
//     不要判"从谁那儿绑"。限定来源等于把"合法的转发"误判成缺陷。
{
  const bad = [];
  for (const f of ["part1.js", "part2.js", "card-ops.js"]) {
    const t = fs.readFileSync(path.join(LIB, f), "utf8");
    const callCount = (t.match(/writeFileAtomic\(/g) || []).length;
    if (callCount === 0) continue;
    // 从**任何**模块 import 进来都算（base.js 直取 / part2.js 转手都合法）
    const hasImport = /import\s*\{[^}]*\bwriteFileAtomic\b[^}]*\}\s*from\s*"\.\/[\w-]+\.js"/s.test(t);
    if (!hasImport) bad.push(f);
  }
  ok(bad.length === 0, "F-08b 用到 writeFileAtomic 的文件都**真的 import** 了它（D307 型坑）", bad.length ? `🔴 缺 import：${bad.join(", ")}` : "全部已 import");
}

// ═══ F-09：不能有 partN → index 的反向边 ═══
{
  const bad = [];
  for (const f of files) {
    const t = fs.readFileSync(path.join(LIB, f), "utf8");
    const code = t.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    if (/from\s+"\.\/index\.js"/.test(code)) bad.push(f);
  }
  ok(bad.length === 0, "F-09 没有「partN → index.js」的反向边（强连通环的那个口子已切）", bad.length ? `🔴 还在：${bad.join(", ")}` : "0 处");
}

// ═══ F-09b：`part4` 里 `apply` 不是被当函数用的（证明删它是安全的）═══
{
  const t = fs.readFileSync(path.join(LIB, "part4.js"), "utf8");
  const code = t.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const called = /(?<![.\w])apply\s*\(/.test(code);
  ok(!called, "F-09b part4 里 `apply` 确实**从未被当函数调用**（所以删 import 无行为变化）", called ? "🔴 有调用" : "0 处调用");
}

// ═══ F-10：engines 覆盖 import.meta.dirname 所需版本 ═══
{
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const eng = String(pkg?.engines?.node ?? "");
  // import.meta.dirname 需要 >= 20.11.0
  const m = /^>=\s*(\d+)\.(\d+)\.(\d+)/.exec(eng);
  let covers = false;
  if (m) {
    const [maj, min] = [Number(m[1]), Number(m[2])];
    covers = maj > 20 || (maj === 20 && min >= 11);
  }
  ok(covers, "F-10 engines 覆盖 `import.meta.dirname`（需 ≥20.11.0）", `engines=${eng}`);
}

// ═══ F-10b：变异探针已从日常 probes 分离 ═══
{
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const s = pkg?.scripts ?? {};
  const inDaily = /_probe-assertion-can-fail/.test(String(s.probes ?? ""));
  const hasDedicated = typeof s["probes:mutation"] === "string" && /_probe-assertion-can-fail/.test(s["probes:mutation"]);
  ok(!inDaily && hasDedicated, "F-10b 变异探针已从 `npm run probes` 分离到 `probes:mutation`", `probes含=${inDaily} 专项目=${hasDedicated}`);
}

let pass = 0;
let fail = 0;
for (const r of results) {
  console.log(`  ${r.c ? "PASS" : "FAIL"}  ${r.label}  —— ${r.detail}`);
  if (r.c) pass++;
  else fail++;
}
console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
