// D226 · 过期文本审计（宽口径 · 只读）
// ★ 为什么要另起一个：`_probe-d216-docs-audit.mjs` 只核 README/description/少数关键词
//   ⇒ **D224 那 7 处旧口径它全绿**（用户正是怀疑还有一堆这类）。
// ★ 本探针只报「哪儿写着什么、与代码真值差在哪」，**不擅自改**。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return undefined; } };

// ── 代码真值（从 lib/ 数出来）─────────────────────────────────────────────
const libFiles = fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js"));
const libSrc = libFiles.map((f) => fs.readFileSync(path.join(ROOT, "lib", f), "utf8")).join("\n");

const toolNames = [...new Set([...libSrc.matchAll(/\bname:\s*"((?:ledger_|CHECKPOINT)[a-z_]*)"|\[(?:CHECKPOINT_TOOL|PRINCIPLE_GRANT_TOOL)\b/g)]
  .map((m) => m[1]).filter(Boolean))];
const specsSrc = libSrc.slice(libSrc.indexOf("export const SETTING_SPECS"), libSrc.indexOf("export const SETTING_KEYS"));
const settingCount = [...specsSrc.matchAll(/^\s{2}\{\s*$/gm)].length;
const version = JSON.parse(read("package.json")).version;

console.log("═══ 代码真值 ═══");
console.log(`  版本 ${version} · 设置项（粗数）${settingCount} · lib 文件 ${libFiles.length} 个`);

// ── ① 面板文案里的「谁说了算」旧口径（D224 的核心）────────────────────────
console.log("\n═══ ① 面板 / 注入文案里的「项目优先」旧口径（D222 已反转成「面板优先」）═══");
const phrases = [
  { re: /两者不一致时以「项目」为准/g, why: "注入快照脚注：D222 后默认是**面板赢**" },
  { re: /只影响新项目/g, why: "面板徽标：panel 模式下**改了立刻生效**（不只影响新项目）" },
  { re: /这一项对已有项目无效/g, why: "面板醒目提示：panel 模式下**对已有项目有效**" },
  { re: /只决定新项目登记成什么/g, why: "面板引言：panel 模式下**不是**只影响新项目" },
  { re: /不会影响已有项目/g, why: "设置项 hint：同上" },
  { re: /那个才管用/g, why: "设置项 hint：panel 模式下**清单里那个不管用**" },
];
const targets = ["lib/client.js", "lib/defs.js", "lib/part3.js", "lib/part2.js", "README.md"];
let hit1 = 0;
for (const rel of targets) {
  const src = read(rel);
  if (src === undefined) continue;
  const lines = src.split("\n");
  for (const p of phrases) {
    lines.forEach((line, i) => {
      // 只看**非注释行**（注释里写"改成…"是解释，不是对用户的文案）
      const t = line.trim();
      if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return;
      if (p.re.test(line)) {
        hit1 += 1;
        console.log(`  ⚠️ ${rel}:${i + 1}  ${JSON.stringify(t.slice(0, 96))}`);
        console.log(`      理由：${p.why}`);
      }
      p.re.lastIndex = 0;
    });
  }
}
if (hit1 === 0) console.log("  ✅ 没有命中");
else console.log(`  ⇒ 共 ${hit1} 处**对用户可见**的旧口径`);

// ── ② 死代码：D222 拆掉调用点后没删的函数 ────────────────────────────────
console.log("\n═══ ② 死代码（定义了但没人调）═══");
for (const fn of ["pick"]) {
  const def = new RegExp(`(?:function\\s+${fn}\\b|const\\s+${fn}\\s*=)`, "g");
  const call = new RegExp(`[^a-zA-Z0-9_.]${fn}\\s*\\(`, "g");
  const defs = (libSrc.match(def) ?? []).length;
  const calls = (libSrc.match(call) ?? []).length;
  console.log(`  ${fn}：定义 ${defs} 次 · 出现调用形状 ${calls} 次 ${calls <= defs ? "⚠️ 疑似死代码" : ""}`);
}

// ── ③ 各文档里写死的数字与真值对账 ──────────────────────────────────────
console.log("\n═══ ③ 文档里写死的工具/设置/子命令数（与代码真值对账）═══");
const docs = ["README.md"];
for (const rel of docs) {
  const src = read(rel) ?? "";
  const nums = [
    { label: "工具", truth: 21, re: /二十二个工具|二十一个工具|二十个工具|十九个工具|十四个工具|八个工具/g },
    { label: "设置项", truth: 39, re: /(\d+)\s*项设置/g },
  ];
  for (const n of nums) {
    n.re.lastIndex = 0;
    const found = [...src.matchAll(n.re)].map((m) => m[0]);
    console.log(`  ${rel} ${n.label}：真值 ${n.truth} · 文里出现 ${found.length ? found.join(" / ") : "(没写)"}`);
  }
}
