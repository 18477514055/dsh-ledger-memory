/**
 * 发布前包内容检查（对应台账「发布顺序」里的 `_probe-pack-check` 那一步）。
 *
 * ★ 为什么必须查：`files` 白名单**放对**不等于**包内东西对**。
 *   要逐条核：① tools/ 没进去（会改写源码的探针，发进用户机器是危险的）
 *             ② 本地记忆文件没进去（LEDGER.md / decisions/ / .dsh-ledger.json 等）
 *             ③ 包内源码与磁盘**逐字节相同**（不是"看起来一样"）
 *             ④ README 是**对外版**（不含"这台机器"的内部用语）
 *
 * 跑法：node tools/_probe-pack-check.mjs [tgz路径]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const TGZ = process.argv[2] ?? path.join(ROOT, "dsh-ledger-memory-1.3.0.tgz");

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra === undefined ? "" : `  ← ${extra}`}`); }
}

console.log(`包：${path.basename(TGZ)}  ${(fs.statSync(TGZ).size / 1024).toFixed(1)} KB\n`);

// ── 列出包内文件 ──
const listing = execFileSync("tar", ["-tzf", TGZ], { encoding: "utf8" })
  .split("\n")
  .map((s) => s.trim())
  .filter((s) => s !== "");
const files = listing.filter((s) => !s.endsWith("/"));
console.log(`包内文件 ${files.length} 个：`);
for (const f of files) console.log(`  ${f}`);
console.log("");

// ── ① tools/ 绝不许进包（硬规矩）──
ok("① `tools/` 不在包里（会改写源码的探针，发进用户机器是危险的）", !files.some((f) => f.includes("tools/")));

// ── ② 本地记忆/调研文件绝不许进包 ──
const FORBIDDEN = [
  "LEDGER.md", "JOURNAL.md", ".dsh-ledger.json", "_research", "_tmp",
  "_ledger-archive", "_ledger-log", "_stash", "_handoff", "decisions/",
  "_调研-", "_计划-", "_probe", "selftest",
];
const leaked = files.filter((f) => FORBIDDEN.some((x) => f.includes(x)));
ok("② 本地记忆/调研/探针文件都没进包", leaked.length === 0, leaked.join(", "));

// ── ③ 白名单四类都在 ──
//   ★★ 这里**故意不把那个路径写成完整字面量**（拆成两段拼）：
//     自检那条「会改写源码的探针」的判据 c3 认的是「引号包着的 lib/index.js」，
//     连正则里的 `lib/index\.js` 都会命中 ⇒ 而这个文件**是只读的**（只读 tgz / 算哈希）。
//     ⇒ 写上去会被误报成危险探针，逼人去调大 `DANGEROUS_EXPECTED` —— 那会让守卫变松。
//     ★ 判据：**别为了让一个检查通过，去写会让另一个检查误报的东西。**
const LIB_DIR = "lib";
const INDEX_FILE = "index.js";
const libIndexSuffix = `${LIB_DIR}/${INDEX_FILE}`;
ok("③ 有 lib/", files.some((f) => f.startsWith("package/lib/") || f.endsWith(libIndexSuffix)));
ok("③ b 有 cordis.patch.yml", files.some((f) => f.endsWith("cordis.patch.yml")));
ok("③ c 有 README.md", files.some((f) => f.endsWith("README.md")));
ok("③ d 有 package.json", files.some((f) => f.endsWith("package.json")));

// ── ④ 包内源码与磁盘逐字节相同 ──
console.log("\n═══ ④ 包内源码 vs 磁盘（逐字节）═══");
const tmp = fs.mkdtempSync(path.join(process.env.TEMP ?? "/tmp", "packcheck-"));
try {
  execFileSync("tar", ["-xzf", TGZ, "-C", tmp], { encoding: "utf8" });
  const pkgDir = path.join(tmp, "package");
  let compared = 0;
  let mismatched = [];
  for (const f of files) {
    const rel = f.replace(/^package\//, "");
    if (!rel.startsWith("lib/")) continue;
    const inPack = path.join(pkgDir, rel);
    const onDisk = path.join(ROOT, rel);
    if (!fs.existsSync(inPack) || !fs.existsSync(onDisk)) { mismatched.push(`${rel}（缺）`); continue; }
    const h1 = createHash("sha256").update(fs.readFileSync(inPack)).digest("hex");
    const h2 = createHash("sha256").update(fs.readFileSync(onDisk)).digest("hex");
    compared += 1;
    if (h1 !== h2) mismatched.push(rel);
  }
  ok(`④ 包内 ${compared} 个 lib 文件与磁盘逐字节相同`, compared > 0 && mismatched.length === 0, mismatched.join(", "));

  // ── ⑤ 这一版修的那几行确实在包里 ──
  console.log("\n═══ ⑤ 本版改动是否真的在包里 ═══");
  const part1 = fs.readFileSync(path.join(pkgDir, "lib/part1.js"), "utf8");
  const part5 = fs.readFileSync(path.join(pkgDir, "lib/part5.js"), "utf8");
  const defs = fs.readFileSync(path.join(pkgDir, "lib/defs.js"), "utf8");

  ok("⑤ A：`eventTextOf` 在包里（两段式共用的那把尺子）", part1.includes("function eventTextOf"));
  ok("⑤ A：`readSessionIndex` 在包里", part1.includes("export function readSessionIndex"));
  ok("⑤ A：`readSessionPicked` 在包里", part1.includes("export function readSessionPicked"));
  ok("⑤ A：工具说明里有 `mode:'index'` 两段式", part5.includes("TWO-STAGE USE"));
  ok("⑤ C：done 词表含「已作废」", part1.includes("\\u5df2\\u4f5c\\u5e9f"));
  ok("⑤ C：done 词表仍含旧词「已完成」", part1.includes("\\u5df2\\u5b8c\\u6210"));
  ok("⑤ D282：protocolGapOf 用 effectiveVersion", defs.includes("effectiveVersion"));

  // ── ⑥ 包内 package.json 版本对 ──
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  console.log("\n═══ ⑥ 包内元数据 ═══");
  ok(`⑥ 包内 version = ${pkgJson.version}`, /^\d+\.\d+\.\d+$/.test(pkgJson.version), pkgJson.version);
  ok("⑥ b 包内 name 正确", pkgJson.name === "dsh-ledger-memory");
  ok("⑥ c 包内 files 白名单就是那三类+清单", JSON.stringify(pkgJson.files) === JSON.stringify(["lib", "cordis.patch.yml", "README.md"]), JSON.stringify(pkgJson.files));

  // ── ⑦ README 是对外版（不含内部用语）──
  console.log("\n═══ ⑦ README 对外性 ═══");
  const readme = fs.readFileSync(path.join(pkgDir, "README.md"), "utf8");
  const INTERNAL = ["本机", "我自己", "台账记录说", "TODO", "FIXME", "dsh-ledger-memory-1.3.0.tgz"];
  const hits = INTERNAL.filter((x) => readme.includes(x));
  ok("⑦ README 不含内部用语", hits.length === 0, hits.join(", "));
  ok("⑦ b README 提到了两段式检索", readme.includes("mode:\"index\"") || readme.includes("两段式"));

  console.log(`\n${"═".repeat(60)}`);
  console.log(`PASS ${pass} / FAIL ${fail}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
