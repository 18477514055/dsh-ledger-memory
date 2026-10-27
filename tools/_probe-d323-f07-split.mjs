/**
 * _probe-d323-f07-split.mjs —— D323：005 报告 F-07（`part2.js` 撞 262,144 B 硬上限）的守卫
 *
 * 守三件事，缺一件这个搬家就不算成功：
 *   ① **容量真的回到了安全区**（part2 余量 ≥ 20 KB，settings-http 余量 ≥ 20 KB）；
 *   ② **调用面零改动**（part2 仍把 9 个入口转发导出；index.js 仍从 part2 import）；
 *   ③ **两层授权没被搬掉一层**（搬过去那份里 authorizeRequest 与 assertAuthorized 都在，
 *      且 saveSettings 里那次自查仍在落盘之前）。
 *
 * ★★ 为什么 ②③ 必须一起守：搬家的**收益**是容量，**代价**是可能把接线搬断。
 *   只量收益（① 绿了）而不管代价，就是本项目的"D167 把失败说成没发生"同型。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAP = 262144;
const SAFE = 20 * 1024; // 判据：余量至少 20 KB，否则下一次改动还会撞线

const results = [];
/**
 * ★★★ 2026-10-25（D323）：**参数顺序是 (条件, 标题, 详情)**。
 *
 *   🔴 我第一版有三处写成了 `ok("标题", 条件, 详情)` —— 于是"条件"位置拿到一个
 *     **非空字符串**，恒为真 ⇒ 那三条断言**永远 PASS**，包括本该变红的
 *     「saveSettings 自查必须在落盘之前」。
 *   ★ 它是在**反向验证**里暴露的：我故意把自查挪到 `.edit(` 之后，探针仍然全绿
 *     —— 而屏幕上那行明细明明印着 `assertRel=2701 editRel=1779`（显然是错的）。
 *   ⇒ 判据：**"PASS/FAIL 与明细自相矛盾" 就是断言写错了**，不是被测对象没问题。
 *   ⇒ 现在 `ok()` 自己会挡住这种误用（条件不是布尔就抛），不许它静默变绿。
 */
const ok = (c, label, detail) => {
  if (typeof c !== "boolean") {
    throw new TypeError(
      `ok() 的第一个参数必须是布尔条件，收到 ${typeof c}：${JSON.stringify(c)?.slice(0, 60)}` +
        `（标题=${JSON.stringify(label)?.slice(0, 60)}）—— 参数顺序写反了？`
    );
  }
  results.push({ c, label, detail });
};

const sizeOf = (rel) => fs.statSync(path.join(ROOT, rel)).size;
const readOf = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ═══ ① 容量回到安全区 ═══
{
  const p2 = sizeOf("lib/part2.js");
  ok(
    CAP - p2 >= SAFE,
    "F-07① part2.js 余量回到安全区（≥20 KB）",
    `${p2} B / ${CAP} B，余 ${CAP - p2} B`
  );

  const sh = path.join(ROOT, "lib", "settings-http.js");
  ok(fs.existsSync(sh), "F-07① b 搬出的实现存在（lib/settings-http.js）", fs.existsSync(sh) ? "存在" : "🔴 不存在");
  if (fs.existsSync(sh)) {
    const s = fs.statSync(sh).size;
    ok(CAP - s >= SAFE, "F-07① c settings-http.js 自己也留足余量（≥20 KB）", `${s} B，余 ${CAP - s} B`);
  }

  // 全 lib 都不许贴线（这条比"part2 一个文件"更本质：贴线是结构问题，不是单点问题）
  const tight = [];
  for (const f of fs.readdirSync(path.join(ROOT, "lib")).filter((x) => x.endsWith(".js"))) {
    const s = fs.statSync(path.join(ROOT, "lib", f)).size;
    if (CAP - s < 8192) tight.push(`${f}=${s}(余 ${CAP - s})`);
  }
  ok(tight.length === 0, "F-07① d 没有任何 lib 文件余量 < 8 KB（不许再有第二个贴线的）", tight.join(", ") || "全部 ≥8 KB");
}

// ═══ ② 调用面零改动 ═══
{
  const p2 = readOf("lib/part2.js");
  const REEXPORTS = [
    "sendJson",
    "readBody",
    "handleFor",
    "deriveSettingsView",
    "findSettingsEntry",
    "authorizeRequest",
    "assertAuthorized",
    "installSettingsRoutes",
    "saveSettings",
  ];
  // 必须是**一条** export {...} from "./settings-http.js"
  const line = p2.split("\n").find((l) => /^export\s*\{[^}]*\}\s*from\s*["']\.\/settings-http\.js["']/.test(l));
  ok(line !== undefined, "F-07② part2 有指向 settings-http.js 的转发导出", line ? "有" : "🔴 没有");
  if (line) {
    const missing = REEXPORTS.filter((n) => !new RegExp(`\\b${n}\\b`).test(line));
    ok(missing.length === 0, "F-07② b 9 个入口**全部**转发（少一个调用方就崩）", missing.join(", ") || "9/9");
  }

  // part2 里那些实体的 `export function` 必须**不再存在**（否则就是两份实现）
  const dup = REEXPORTS.filter((n) => new RegExp(`^export function ${n}\\(`, "m").test(p2));
  ok(dup.length === 0, "F-07② c part2 里没有留下重复实现（搬家不是复制）", dup.join(", ") || "0 个重复");

  // 调用方仍然从 part2 拿（证明"调用面零改动"不是自说自话）
  const idx = readOf("lib/index.js");
  ok(
    /from\s*["']\.\/part2\.js["']/.test(idx) && /\binstallSettingsRoutes\b/.test(idx) && /\bderiveSettingsView\b/.test(idx),
    "F-07② d index.js 仍从 **part2** import 这些入口（调用面确实没改）",
    "index.js: part2.js"
  );
}

// ═══ ③ 两层授权没被搬掉一层 ═══
{
  const src = readOf("lib/settings-http.js");
  ok(/^export function authorizeRequest\(/m.test(src), "F-07③ authorizeRequest 在搬过去的那份里", "有");
  ok(/^export function assertAuthorized\(/m.test(src), "F-07③ b assertAuthorized 在搬过去的那份里", "有");
  ok(/^export function saveSettings\(/m.test(src), "F-07③ c saveSettings 在搬过去的那份里", "有");

  // 位置判据：saveSettings 里 assertAuthorized 必须在 .edit( 之前
  const at = src.indexOf("export function saveSettings");
  const seg = at >= 0 ? src.slice(at, at + 8000) : "";
  const editRel = seg.indexOf(".edit(");
  const assertRel = seg.indexOf("assertAuthorized");
  ok(
    at >= 0 && assertRel >= 0 && editRel > assertRel,
    "F-07③ d saveSettings 内部自查仍在**落盘之前**（位置判据，不只看有没有）",
    `assertRel=${assertRel} editRel=${editRel}`
  );

  // fail-closed 三档仍在
  ok(
    /status:\s*503/.test(src) && /status:\s*403/.test(src) && /return\s*\{\s*allowed:\s*true\s*\}/.test(src),
    "F-07③ e fail-closed 三档仍在（503 / 403 / allowed:true 唯一放行）",
    "503 + 403 + allowed:true"
  );
}

// ═══ ④ 搬家是「逐字复制」而不是「重写」（可用 diff 形状核对）═══
{
  // 实现体里那几段**特征串**必须原样存在（重写最容易改掉的就是它们）
  const src = readOf("lib/settings-http.js");
  const FINGERPRINTS = [
    "请求体过大（上限 ${limit} 字节）",
    "content-type",
    "nosniff",
    "没有在组合里找到本插件的配置行",
    "本机没有 configEditor 服务，无法保存（插件功能不受影响）。",
  ];
  const lost = FINGERPRINTS.filter((s) => !src.includes(s));
  ok(lost.length === 0, "F-07④ 实现体的特征串原样保留（证明是逐字搬、不是重写）", lost.join(" | ") || "5/5");
}

console.log("═══ D323 · F-07 搬家守卫 ═══");
let pass = 0;
for (const r of results) {
  console.log(`  ${r.c ? "PASS" : "FAIL"}  ${r.label}  —— ${r.detail ?? ""}`);
  if (r.c) pass++;
}
const fail = results.length - pass;
console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail === 0 ? 0 : 1);
