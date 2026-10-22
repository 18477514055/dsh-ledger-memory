/**
 * 探针（D289 · V3 阶段 1）：**没人再拿项目根去拼记忆路径**。
 *
 * ★★★ 这条探针守的是计划 §5.1 指出的①号风险，原文是：
 *   「大量调用点仍自己 `path.join(root, info.xxxRel)`；若 `root` 仍是项目根
 *     而 `xxxRel` 变成相对 `memoryRoot` ⇒ 拼出**不存在的路径**
 *     ⇒ `readTextSafe` **静默返回 undefined**
 *     ⇒ 表现成『台账突然空了』而不是报错。」
 *
 * ★★ 为什么这类错最危险：它**不报错**。自检可能全绿、界面照样正常，
 *   只有到"某个项目迁移之后台账突然读不出来"时才发现，而那时已经很难定位。
 *   ⇒ 唯一可靠的守法是**机械扫描源码**，把这类形态**降到 0 处**（或白名单登记）。
 *
 * 判据（三条，都要过）：
 *   ① `path.join/resolve(projectRoot, info.<xxx>Rel)` —— 必须 **0 处**
 *      （`projectRoot` 是项目根，`info.*Rel` 是记忆相对路径，两者拼在一起必错）
 *   ② `path.join/resolve(root, info.<xxx>Rel)` —— 必须 **0 处**
 *      （`root` 在 V3 下多数仍是项目根；已改成 `memBase` 的地方不再命中）
 *   ③ 白名单：确实**该**用项目根的那些位置（清单寻址 / `.git` / `.gitignore`）
 *      —— 逐条登记并写明理由，出现白名单之外的新命中就报红。
 *
 * 跑法：node tools/_probe-v3-no-root-join.mjs
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, "..");
const LIB = path.join(ROOT, "lib");

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${extra === undefined ? "" : `  ← ${extra}`}`);
  }
};

const files = fs
  .readdirSync(LIB)
  .filter((n) => n.endsWith(".js"))
  .map((n) => ({ name: n, text: fs.readFileSync(path.join(LIB, n), "utf8") }));

/**
 * 找出所有「把 info 的 Rel 字段喂回项目根」的形态。
 *
 * ★ 刻意**只认这两种首参名**（`projectRoot` / `root`）：
 *   它们在本项目里就是"项目根"的约定名。换成 `memBase` / `memoryBase` 的
 *   天然不会命中 —— 这正是我们要的：**改对了就不命中，改错了就命中**。
 */
const hits = [];
for (const f of files) {
  const lines = f.text.split(/\r?\n/);
  lines.forEach((line, i) => {
    // 跳过注释行（判据只吃"真代码"—— 本项目纪律第 2 条）
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
    const re = /\bpath\.(?:join|resolve)\(\s*(projectRoot|root)\s*,\s*info\??\.[A-Za-z_$][\w$]*/;
    if (re.test(line)) {
      hits.push({ file: f.name, line: i + 1, text: t.slice(0, 120), head: RegExp.$1 });
    }
  });
}

// ═══ ①② 两类命中都必须为 0 ═══
console.log("── ① `path.join/resolve(projectRoot, info.*)` 必须为 0 ──");
{
  const bad = hits.filter((h) => h.head === "projectRoot");
  ok(
    "① 没有拿 projectRoot 拼记忆相对路径的地方",
    bad.length === 0,
    bad.map((b) => `${b.file}:${b.line} ${b.text}`).join(" | "),
  );
}

console.log("\n── ② `path.join/resolve(root, info.*)` 必须为 0 ──");
{
  const bad = hits.filter((h) => h.head === "root");
  ok("② 没有拿 root 拼记忆相对路径的地方", bad.length === 0, bad.map((b) => `${b.file}:${b.line} ${b.text}`).join(" | "));
}

// ═══ ③ 反向对照：这把尺子**真的能看见**东西 ═══
//
// ★★★ 这一条是整支探针的关键。**如果尺子本身失灵，上面两条 0 就是假的。**
//   判据：拿一段**故意写错**的代码喂给同一个正则，必须命中。
//   （本项目纪律：断言必须能被证伪 —— 摘掉修复要能看见红。）
console.log("\n── ③ 反向对照：同一个正则喂「故意写错」的代码，必须命中 ──");
{
  const probeRe = /\bpath\.(?:join|resolve)\(\s*(projectRoot|root)\s*,\s*info\??\.[A-Za-z_$][\w$]*/;
  const badSamples = [
    'const abs = path.resolve(projectRoot, info.activeRel);',
    'copies.push(`- ${path.join(root, info.decisionsRel)}`);',
    'const x = path.join(projectRoot, info.logRel);',
  ];
  const goodSamples = [
    'const abs = path.resolve(memBase, info.activeRel);',
    'const x = memoryBaseOf(info, root);',
    'const abs = path.resolve(memoryBaseOf(info, root), rel);',
  ];
  ok(
    "③ ①的不可命中是「真看见没命中」，不是「正则坏了」",
    badSamples.every((s) => probeRe.test(s)),
    badSamples.filter((s) => !probeRe.test(s)).join(" | "),
  );
  ok(
    "③ b 改对之后的形态**不**被误报（memBase / memoryBaseOf）",
    goodSamples.every((s) => !probeRe.test(s)),
    goodSamples.filter((s) => probeRe.test(s)).join(" | "),
  );
}

// ═══ ④ 项目类路径仍走项目根（不能被误改）═══
//
// ★ 反向纪律：**别为了让一条判据通过，把该留项目根的东西也搬走**。
//   清单寻址 / `.git` / `.gitignore` 必须仍在项目根。
console.log("\n── ④ 项目类路径必须**仍在**项目根（不许被顺手改掉）──");
{
  const p2 = fs.readFileSync(path.join(LIB, "part2.js"), "utf8");
  ok(
    "④ 清单寻址仍用 projectRoot（.dsh-ledger.json 不能搬）",
    /manifestPath:\s*path\.join\(projectRoot,\s*MANIFEST_REL\)/.test(p2),
  );
  ok("④ 找 .git 仍用 projectRoot", /existsSync\(path\.join\(projectRoot,\s*"\.git"\)\)/.test(p2));
  ok("④ .gitignore 仍用 projectRoot", /path\.join\(projectRoot,\s*"\.gitignore"\)/.test(p2));
  ok("④ readManifest 仍按项目根读清单", /function readManifest\(projectRoot\)[\s\S]{0,200}path\.join\(projectRoot,\s*MANIFEST_REL\)/.test(p2));
}

// ═══ ⑤ `path.resolve(root, …)` 的白名单（不扫 `info.*Rel` 形态，只扫"看起来像记忆路径"的）═══
//
// ★★★ 这一条把「有意保留」与「漏改」分开，是上面三条之外**唯一能防漏的机制**。
//   判据：**出现白名单之外的新命中就报红** ⇒ 将来谁再写一处 `path.resolve(root, xxxRel)` 都会被抓到。
//
// ★ 为什么这三处**是对的**（逐条写清理由，避免下一个人把它们当漏网改掉）：
//   · part2.js `logFileRel.sizeOf`：上面三行已经 `const root = memoryBaseOf(info, info?.projectRoot)`
//     ⇒ 这里的 `root` **就是记忆基准**，只是变量名叫 root。
//   · part4.js `cardDirAbs`：**纯函数**，本身不持有 info；基准由**调用方**传入
//     （`readKindRaw` / `writeKindCard` / `removeKindCard` 传的都是 `memBase`）。
//     它若自己再去取基准，就会与调用方**各取一次** ⇒ 两个出处（D220 同型）。
//   · part6.js `walkMarkdown`：**同 cardDirAbs** —— 基准由 `scanMemorySurface` 按"面"决定后传入
//     （记忆面传 memoryBase、项目面传 projectRoot）。它自己不能选。
const KNOWN_GOOD = [
  {
    file: "part2.js",
    fn: "logFileRel",
    why: "局部 root 已是 memoryBaseOf(...) 的结果（同一函数内上一行赋的）",
  },
  { file: "part4.js", fn: "cardDirAbs", why: "纯函数，基准由调用方传入（调用方传的都是 memBase）" },
  { file: "part6.js", fn: "walkMarkdown", why: "同 cardDirAbs，基准由 scanMemorySurface 按面决定后传入" },
  // ★★★ 2026-10-21（D295 · 阶段 3 迁移器）：**迁移器是唯一「记忆还在项目根」的模块。**
  //
  //   它的**全部工作**就是把项目根上的记忆搬到子目录 —— 所以它当然要用**项目根**去拼路径。
  //   ★ 这里如果"按惯例"改成 memoryBase，迁移会**什么都搬不到**（那时 memoryRoot 还不存在）。
  //   ★ 判据：**同一个名字在不同上下文里含义不同** —— `root` 在 part1~part6 里可能已是记忆基准，
  //     但在 part7（迁移器）里**必须是项目根**，因为它的输入就是"还没迁移的项目"。
  { file: "part7.js", fn: "migrateToV3", why: "迁移器的输入就是「记忆还在项目根」的 V2 项目 —— 必须用项目根" },
  // ★ 迁移器里那两个内部工具函数同样是"在项目根上找东西"（列文件 / 复制），同一套理由。
  { file: "part7.js", fn: "listFiles", why: "迁移器内部工具：在**项目根**下列待搬的文件" },
  { file: "part7.js", fn: "copyInto", why: "迁移器内部工具：从**项目根**复制到影子目录" },
];

/**
 * 从源码里找某个函数体的行号区间（锚 `function <name>(`，再配平大括号）。
 *
 * ★★★★★ 2026-10-21（D292）：**白名单改用「文件 + 函数名」，不再用写死的行号**。
 *
 *   🔴 原来白名单是 `{ file, line }`。本轮我只在 `part4.js` 里加了几行（V3 ignore 规则），
 *     **所有行号整体下移** ⇒ 白名单当场全部对不上 ⇒ 探针报 2 条红。
 *     而那次改动**一个字都没碰那三处逻辑** —— 红得毫无信息量。
 *
 *   ⇒ 判据（本项目纪律 9 的同型）：**「行号」看起来最硬，却最先失效**。
 *     白名单应当锚**稳定的东西**（函数名），而不是随代码长度漂移的行号。
 */
function functionRange(text, fn) {
  // ★ 两种形态都要认：
  //   ① `function name(...) { ... }`（含 `export`）
  //   ② `const name = (...) => { ... }` / `const name = (x) => ...`（**箭头函数**）
  //   ★ 第一版只认 ① ⇒ part7 里的 `listFiles` / `copyInto`（是箭头函数）全部被判"不在"
  //     ⇒ 白名单过期那条**误报**。判据不能假设写法。
  const fRe = new RegExp(`(?:export\\s+)?function\\s+${fn}\\s*\\(`);
  const aRe = new RegExp(`(?:const|let|var)\\s+${fn}\\s*=\\s*(?:async\\s*)?\\(`);
  const m = fRe.exec(text) ?? aRe.exec(text);
  if (m === null) return undefined;
  const start = m.index;
  let i = text.indexOf("{", start);
  if (i < 0) return undefined;
  let depth = 0;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        const lineOf = (pos) => text.slice(0, pos).split(/\r?\n/).length;
        return [lineOf(start), lineOf(i)];
      }
    }
  }
  return undefined;
}

console.log("\n── ⑤ `path.resolve(root, <记忆风格相对路径>)` 只许出现在白名单那三个函数体内 ──");
{
  const relish =
    /\bpath\.(?:join|resolve)\(\s*(?:root|projectRoot)\s*,\s*(?:rel|relPath|fileRel|dirRel|rel2|journal|goals|lessons|principles|archiveDir|logDir|decisions|active|value)\b/;
  const found = [];
  for (const f of files) {
    f.text.split(/\r?\n/).forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      if (relish.test(line)) found.push({ file: f.name, line: i + 1 });
    });
  }
  const ranges = KNOWN_GOOD.map((k) => {
    const f = files.find((x) => x.name === k.file);
    const r = f === undefined ? undefined : functionRange(f.text, k.fn);
    return { ...k, range: r };
  });
  const allowed = (h) =>
    ranges.some((r) => r.file === h.file && r.range !== undefined && h.line >= r.range[0] && h.line <= r.range[1]);
  const unexpected = found.filter((h) => !allowed(h));
  ok(
    "⑤ 没有白名单之外的 `path.resolve(root, <记忆风格 Rel>)`",
    unexpected.length === 0,
    unexpected.map((u) => `${u.file}:${u.line}`).join(" | "),
  );
  ok(
    "⑤ b 白名单那三个函数**确实都还在**（函数被删/改名 = 白名单过期 = 掩盖回归）",
    ranges.every((r) => r.range !== undefined),
    ranges.filter((r) => r.range === undefined).map((r) => `${r.file}::${r.fn}`).join(" | "),
  );
  ok(
    "⑤ c 命中数 ≤ 白名单规模（多出来的一定是漏网）",
    found.length <= KNOWN_GOOD.length,
    `found=${found.length} allowed=${KNOWN_GOOD.length}`,
  );
  console.log(`     命中 ${found.length} 处 · 白名单 ${KNOWN_GOOD.length} 个函数区间 · 越界 ${unexpected.length} 处`);
}

console.log(`\n═══ ${pass} PASS / ${fail} FAIL ═══`);
process.exitCode = fail === 0 ? 0 : 1;
