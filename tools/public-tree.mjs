#!/usr/bin/env node
// 公开树守卫：把「哪些文件能进公开仓库」从人工记忆变成清单 + 判据。
//
//   node tools/public-tree.mjs --check            # 按本地 HEAD 算「将公开 / 被挡下」
//   node tools/public-tree.mjs --check <ref>      # 指定提交
//   node tools/public-tree.mjs --verify [<ref>]   # 与 origin/main 对比：会新增什么、会删掉什么
//
// ★ 判据只来自 .publicallow.json，不在这里硬编码任何路径或正则。
// ★ 只读：不改工作区、不碰远端。
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const GIT = "C:\\Program Files\\Git\\cmd\\git.exe";
const git = (...a) =>
  execFileSync(GIT, a, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// ── glob：只实现清单真正用到的两种通配 ────────────────────────────────
function toRe(glob) {
  let s = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` 吃掉任意层目录（含零层）；`**` 结尾 = 任意尾巴
        if (glob[i + 2] === "/") {
          s += "(?:.*/)?";
          i += 2;
        } else {
          s += ".*";
          i += 1;
        }
      } else {
        s += "[^/]*";
      }
    } else if (c === "?") {
      s += "[^/]";
    } else {
      s += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${s}$`);
}

const manifestPath = path.join(repo, ".publicallow.json");
if (!fs.existsSync(manifestPath)) {
  console.error("缺 .publicallow.json —— 拒绝在“没有清单”的状态下判定公开面。");
  process.exit(2);
}
const M = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const includeRes = (M.include ?? []).map(toRe);
const denyRes = (M.deny ?? []).map(toRe);
const patterns = (M.content?.denyPatterns ?? []).map((p) => ({
  ...p,
  severity: p.severity === "warn" ? "warn" : "block",
}));

const args = process.argv.slice(2);
const mode = args.find((a) => a.startsWith("--")) ?? "--check";
const rest = args.filter((a) => !a.startsWith("--"));
// ★ --build 的第一个位置参数是目标目录，不是 ref（否则 ref 会被当成路径 ⇒ git 报 not a valid object name）
const ref = mode === "--build" ? (rest[1] ?? "HEAD") : (rest[0] ?? "HEAD");

// ── 1. 候选文件（只看被跟踪的 ⇒ 未跟踪的本来就推不上去）───────────────
const all = git("ls-tree", "-r", ref, "--name-only", "-z").split("\0").filter(Boolean);

const rows = [];
for (const p of all) {
  const denied = denyRes.some((re) => re.test(p));
  const included = includeRes.some((re) => re.test(p));
  rows.push({ path: p, included, denied });
}
const inScope = rows.filter((r) => r.included && !r.denied);
const outside = rows.filter((r) => !r.included);
const deniedByRule = rows.filter((r) => r.denied);

// ── 2. 内容判据（一次 git grep / 每条规则，比逐文件 read 快两个数量级）──
const hitMap = new Map(); // path -> [{id, severity, why}]
for (const p of patterns) {
  let out = "";
  try {
    // ★ 必须用 -e 传模式：有些模式以 "-" 开头（如条目正文的 "- [xxxx] **"），
    //   直接跟在 -E 后面会被 git 当成命令行开关（本机实测报 unknown switch）。
    out = git("grep", "-l", "-I", "-E", "-e", p.re, ref, "--", ".");
  } catch (e) {
    if (e.status !== 1) throw e; // 1 = 没有命中，不是错
  }
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const file = line.startsWith(`${ref}:`) ? line.slice(ref.length + 1) : line;
    if (!hitMap.has(file)) hitMap.set(file, []);
    hitMap.get(file).push(p);
  }
}

const blocked = [];
const warned = [];
const exempt = [];
const pub = [];
// ★ 默认拒绝：命中内容判据就算脏；只有**显式登记过理由**的例外才放行。
//   例外的存在本身就是风险，所以报告里单独列出来，让它没法悄悄变多。
const exemptWhy = new Map((M.content?.exceptions ?? []).map((e) => [e.path, e.why ?? ""]));
for (const r of inScope) {
  const hits = hitMap.get(r.path) ?? [];
  const hard = hits.filter((h) => h.severity === "block");
  const soft = hits.filter((h) => h.severity === "warn");
  if (hard.length && !exemptWhy.has(r.path)) blocked.push({ path: r.path, hits: hard });
  else {
    pub.push(r.path);
    if (hard.length) exempt.push({ path: r.path, hits: hard });
    if (soft.length) warned.push({ path: r.path, hits: soft });
  }
}

// ── 4b. --guard <ref>：这是 pre-push 用的闸门 ─────────────────────────
// 它不问“白名单”，只问一件更硬的事：**这棵树里有没有带条目前缀的文件**（例外除外）。
// 因为白名单决定“应该有什么”，而泄露是“已经有什么” —— 已经混进去的脏文件，白名单拦不住。
// ★ 放在报告之前 ⇒ hook 里只看到一行结论，不被判定表刷屏。
if (mode === "--guard") {
  const guardRef = rest[0] ?? "HEAD";
  const gHits = hitsFor(guardRef);
  const files = git("ls-tree", "-r", guardRef, "--name-only", "-z").split("\0").filter(Boolean);
  const leak = files.filter((p) => {
    const hits = gHits.get(p) ?? [];
    return hits.some((h) => h.severity === "block") && !exemptWhy.has(p);
  });
  if (leak.length) {
    console.error(`✗ 公开树闸门：ref=${guardRef} 里有 ${leak.length} 个文件带台账条目前缀`);
    for (const p of leak.slice(0, 20)) console.error(`    ${p}`);
    if (leak.length > 20) console.error(`    …另有 ${leak.length - 20} 个`);
    console.error("  ⇒ 拒绝推送。先用 node tools/public-tree.mjs --build <目录> 生成干净树再提交。");
    process.exit(1);
  }
  console.log(`✓ 公开树闸门：ref=${guardRef} 扫了 ${files.length} 个文件，未发现台账条目前缀（例外 ${exemptWhy.size} 个已登记）`);
  process.exit(0);
}

// 按任意 ref 重扫（★ 不能用默认 ref 的结果去判另一棵树：那两棵树的文件集可能不同）
function hitsFor(r) {
  if (r === ref) return hitMap;
  const m = new Map();
  for (const p of patterns) {
    let out = "";
    try {
      out = git("grep", "-l", "-I", "-E", "-e", p.re, r, "--", ".");
    } catch (e) {
      if (e.status !== 1) throw e;
    }
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      const file = line.startsWith(`${r}:`) ? line.slice(r.length + 1) : line;
      if (!m.has(file)) m.set(file, []);
      m.get(file).push(p);
    }
  }
  return m;
};

const show = (arr, label, n = 15) => {
  if (!arr.length) return;
  console.log(`\n=== ${label}（${arr.length}）===`);
  for (const x of arr.slice(0, n)) {
    console.log(`  ${x.path}  ←  ${x.hits.map((h) => `${h.id}[${h.severity}]`).join(" + ")}`);
  }
  if (arr.length > n) console.log(`  …另有 ${arr.length - n} 个`);
};

// ── 3. 报告 ───────────────────────────────────────────────────────────
console.log(`=== 公开树判定（ref=${ref}）===`);
console.log(`  被跟踪总数        ${all.length}`);
console.log(`  白名单外（跳过）  ${outside.length}`);
console.log(`  命中 deny（硬）   ${deniedByRule.length}`);
console.log(`  白名单内          ${inScope.length}`);
console.log(`  内容判据挡下      ${blocked.length}`);
console.log(`  → 将公开          ${pub.length}`);
console.log(`  （其中仅“路径名”级告警 ${warned.length} 个，不挡）`);

show(blocked, "内容判据挡下的文件");
if (exempt.length) {
  console.log(`\n=== 已登记的例外（命中判据但放行，${exempt.length}）===`);
  for (const x of exempt) console.log(`  ${x.path}  ←  ${exemptWhy.get(x.path)}`);
}
if (args.includes("--verbose")) show(warned, "只是提到内部路径名的（warn，不挡）", 40);

if (mode === "--verify") {
  const pubRemote = git("ls-tree", "-r", "origin/main", "--name-only", "-z").split("\0").filter(Boolean);
  const A = new Set(pub);
  const B = new Set(pubRemote);
  const added = [...A].filter((p) => !B.has(p)).sort();
  const removed = [...B].filter((p) => !A.has(p)).sort();
  const kept = [...A].filter((p) => B.has(p)).length;
  console.log(`\n=== 与 origin/main（${pubRemote.length} 个文件）对比 ===`);
  console.log(`  保留 ${kept} · 将新增 ${added.length} · 将从公开库消失 ${removed.length}`);
  for (const p of added.slice(0, 20)) console.log(`  + ${p}`);
  if (added.length > 20) console.log(`  …另有 ${added.length - 20} 个新增`);
  for (const p of removed.slice(0, 20)) console.log(`  - ${p}`);
  if (removed.length > 20) console.log(`  …另有 ${removed.length - 20} 个将消失`);
  if (removed.length) {
    console.log("  ⚠️ 「将消失」= 清单判定它们不该公开。下次快照提交会真的删除，先确认再推。");
  }
}

// ── 4. --build：按清单真正铺出一棵公开树（只读仓库，只写目标目录）─────
if (mode === "--build") {
  const dest = rest[0];
  const buildRef = rest[1] ?? ref;
  if (!dest) {
    console.error("用法：node tools/public-tree.mjs --build <目标目录> [ref]");
    process.exit(2);
  }
  const tree = git("ls-tree", "-r", "-z", buildRef).split("\0").filter(Boolean);
  const shaOf = new Map();
  for (const line of tree) {
    const tab = line.indexOf("\t");
    const meta = line.slice(0, tab).split(/\s+/);
    shaOf.set(line.slice(tab + 1), meta[2]);
  }
  const want = pub.map((p) => ({ path: p, sha: shaOf.get(p) })).filter((e) => e.sha);
  if (want.length !== pub.length) {
    console.error(`内部不一致：判定 ${pub.length} 个，取到 blob ${want.length} 个`);
    process.exit(1);
  }
  // 一次 cat-file --batch 读全部 blob：比逐个 git show 快两个数量级
  const r = spawnSync(GIT, ["cat-file", "--batch"], {
    cwd: repo,
    input: want.map((e) => e.sha).join("\n") + "\n",
    maxBuffer: 1 << 30,
  });
  if (r.status !== 0) {
    console.error(r.stderr.toString());
    process.exit(1);
  }
  const buf = r.stdout;
  let off = 0;
  let n = 0;
  for (const e of want) {
    const nl = buf.indexOf(10, off);
    const size = Number(buf.subarray(off, nl).toString("utf8").split(" ")[2]);
    const body = buf.subarray(nl + 1, nl + 1 + size);
    off = nl + 1 + size + 1;
    const abs = path.join(dest, e.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    n++;
  }
  console.log(`\n=== 已物料化公开树 ===`);
  console.log(`  目标  ${dest}`);
  console.log(`  写入  ${n} 个文件（判定将公开 ${pub.length} 个）`);
  console.log(`  ★ 被挡下的 ${blocked.length} 个不在里面；这棵树可直接当一个提交的树用。`);
}

console.log("\nCOMPLETE");
