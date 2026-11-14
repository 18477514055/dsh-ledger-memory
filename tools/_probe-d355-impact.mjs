// _probe-d355-impact.mjs —— 指纹整合对系统的**全部影响**评估
// ★ 用户要求：先研究影响，没负面影响才整合。
// ★ 必须量清的六类影响：
//   I1. **注入体积**（frontmatter 会不会进每回合注入 ⇒ 上下文税）
//   I2. 分块/解析是否被破坏（splitBlocks / 卡片 / TOC）
//   I3. 体积增长（磁盘 + git diff）
//   I4. 写路径次数（每次写入多算多少次哈希）
//   I5. 与已有机制的冲突（seal 与 block hash、与 revision、与 ledger_write 的 changedBy）
//   I6. 扫盲性能（真实 memoryRoot 上量）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { splitBlocks } from "../lib/part1.js";
import { listCards, entryTocOf } from "../lib/card-ops.js";

const MEM = "D:\\Deepseek工作区\\20-DSH插件\\04-其余插件\\10.项目台账\\10.项目台账-ledger-memory";
const TOK = 1.72;
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };
const eq = (n, a, b) => ok(n, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);

// ── 模拟三载体写入（与 D354 原型一致）──
const FM = "dsh-fp-front";
const LK = "dsh-fp-link";
function pay(id, seal) { return `v=1 kind=${id.kind} project=${id.project} key=${id.key} check=${id.check} seal=${seal}`; }

function writeTriple(text, id, seal) {
  const p = pay(id, seal);
  let s = text ?? "";
  s = s.replace(/^---\n[\s\S]*?\n---\n/, "");
  s = s.replace(new RegExp(`^\\[${LK}\\]:.*$\\n?`, "gm"), "");
  s = s.replace(/<!--dsh-id:[0-9a-f]{16}:[A-Za-z0-9_.-]+-->/g, "");
  s = s.replace(/<!--\s*dsh-ledger-fp:[\s\S]*?-->\n?/g, "");
  const lines = s.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === "") continue;
    lines[i] = lines[i].replace(/\s+$/, "") + ` <!--dsh-id:${id.project}:${id.key}-->`;
    break;
  }
  s = lines.join("\n");
  return `---\n${FM}: ${p}\n---\n${s.replace(/\s+$/, "")}\n\n[${LK}]: dsh-ledger-fp ${p}\n`;
}

const PROJ = "0123456789abcdef";
const check = (kind, key) => crypto.createHash("sha256").update(`1|${kind}|${PROJ}|${key}`).digest("hex").slice(0, 8);
const sealOf = (body) => crypto.createHash("sha256").update(body, "utf8").digest("hex").slice(0, 8);

// ══════════════════════════════════════════════════════════
console.log("=== I1. ★★★★★ 注入体积：frontmatter 会不会进每回合注入 ===");
{
  const ledgerRaw = fs.readFileSync(path.join(MEM, "LEDGER.md"), "utf8");
  const before = ledgerRaw.length;
  const after = writeTriple(ledgerRaw, { kind: "active", project: PROJ, key: "-", check: check("active", "-") }, "deadbeef");
  const delta = after.length - before;

  console.log(`  LEDGER.md: ${before} → ${after} 字符（+${delta}）`);
  console.log(`  折算 token: +${(delta / TOK).toFixed(0)} tok`);

  // ★ 关键：注入是每回合重发，而且是**整份**都进吗？
  const b1 = splitBlocks(ledgerRaw);
  const b2 = splitBlocks(after);
  console.log(`  分块数: ${b1.length} → ${b2.length}`);
  eq("分块数不变", b1.length, b2.length);

  // ★★ frontmatter 会不会**自成一块**？那是复用 D352 抓过的同一个病
  const fmBlock = b2.find((b) => b.text.includes(FM));
  ok("★ frontmatter 没有自成一块", fmBlock === undefined, fmBlock ? `成了第 ${b2.indexOf(fmBlock)} 块` : "");
  // 它并进了第一块
  const first = b2[0];
  ok("★ frontmatter 并进第一块", first.text.includes(FM) || first.text.includes("dsh-ledger-fp"));
  console.log(`  第一块内容前 90: ${JSON.stringify(first.text.slice(0, 90))}`);

  // ★★★ 真正要量的：**每回合注入会不会因此变长**
  // 注入正文 = 各块 text 拼起来（块级注入会按需给）
  const injBefore = b1.reduce((a, b) => a + b.text.length, 0);
  const injAfter = b2.reduce((a, b) => a + b.text.length, 0);
  console.log(`  ★ 注入正文总字符: ${injBefore} → ${injAfter}（+${injAfter - injBefore}，≈ +${((injAfter - injBefore) / TOK).toFixed(0)} tok）`);

  // 但 D342 已测：满配注入只有 52,552 字符 —— 这个增量占比？
  const perTurn = 52552;
  const pct = ((injAfter - injBefore) / perTurn) * 100;
  console.log(`  ★ 相对满配注入(52,552 字符) 占 ${pct.toFixed(3)}%`);
  ok("★ 增量 < 满配注入的 0.5%", pct < 0.5, `${pct.toFixed(3)}%`);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== I1b. 更严的检查：三载体里哪一处会进注入 ===");
{
  const ledgerRaw = fs.readFileSync(path.join(MEM, "LEDGER.md"), "utf8");
  const after = writeTriple(ledgerRaw, { kind: "active", project: PROJ, key: "-", check: check("active", "-") }, "deadbeef");
  const b = splitBlocks(after);
  const all = b.map((x) => x.text).join("\n");
  console.log(`  frontmatter 出现在注入正文里吗？ ${all.includes(FM) ? "✅ 会" : "❌ 不会"}`);
  console.log(`  链接定义出现在注入正文里吗？ ${all.includes(`[${LK}]`) ? "✅ 会" : "❌ 不会"}`);
  console.log(`  行内标记出现在注入正文里吗？ ${all.includes("<!--dsh-id:") ? "✅ 会" : "❌ 不会"}`);
  // ★ 结论：三处**都会进**注入 —— 这就是代价
  const fmLen = `---\n${FM}: ${pay({ kind: "active", project: PROJ, key: "-", check: check("active", "-") }, "deadbeef")}\n---\n`.length;
  const lkLen = `\n\n[${LK}]: dsh-ledger-fp ${pay({ kind: "active", project: PROJ, key: "-", check: check("active", "-") }, "deadbeef")}\n`.length;
  const inLen = ` <!--dsh-id:${PROJ}:- -->`.length;
  console.log(`  三者加起来 = ${fmLen + lkLen + inLen} 字符 ≈ ${((fmLen + lkLen + inLen) / TOK).toFixed(0)} tok/次注入`);
  console.log(`  ★ 每回合因此多付 ≈ ${((fmLen + lkLen + inLen) / TOK).toFixed(0)} tok（但只在 LEDGER 这一份上）`);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== I2. 解析是否被破坏（真卡样本）===");
{
  const decDir = path.join(MEM, "decisions");
  const cards = fs.readdirSync(decDir).filter((f) => /^D\d+\.md$/.test(f)).slice(0, 6);
  let tocSame = 0, splitSame = 0;
  for (const f of cards) {
    const raw = fs.readFileSync(path.join(decDir, f), "utf8");
    const key = f.replace(/\.md$/, "");
    const after = writeTriple(raw, { kind: "decisions", project: PROJ, key, check: check("decisions", key) }, sealOf(raw));

    // TOC 条目数
    const t1 = entryTocOf(raw, 200);
    const t2 = entryTocOf(after, 200);
    const n1 = Array.isArray(t1) ? t1.length : -1;
    const n2 = Array.isArray(t2) ? t2.length : -1;
    if (n1 === n2) tocSame += 1; else console.log(`    ⚠ ${f} TOC ${n1}→${n2}`);

    // 分块（卡片也可能被 splitBlocks 处理）
    const s1 = splitBlocks(raw).length;
    const s2 = splitBlocks(after).length;
    if (s1 === s2) splitSame += 1; else console.log(`    ⚠ ${f} 块数 ${s1}→${s2}`);
  }
  eq(`${cards.length} 张卡 TOC 不变`, tocSame, cards.length);
  eq(`${cards.length} 张卡块数不变`, splitSame, cards.length);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== I2b. ★★★ frontmatter 会不会被现有卡片解析当成「标题」===");
{
  // 危险点：`---` 在某些解析里是分隔线/标题
  const sample = "---\ndsh-fp-front: v=1\n---\n# D195 · 标题\n\n正文\n";
  const blocks = splitBlocks(sample);
  console.log(`  块数 = ${blocks.length}`);
  blocks.forEach((b, i) => console.log(`    [${i}] heading=${JSON.stringify(b.heading)} | 前 40: ${JSON.stringify(b.text.slice(0, 40))}`));
  eq("★ frontmatter 没有变成标题块", blocks.filter((b) => b.heading?.includes("dsh-fp-front")).length, 0);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== I3. 体积增长（真实 331 张卡）===");
{
  const decDir = path.join(MEM, "decisions");
  const files = fs.readdirSync(decDir).filter((f) => f.endsWith(".md"));
  let before = 0, after = 0;
  for (const f of files) {
    const raw = fs.readFileSync(path.join(decDir, f), "utf8");
    const key = f.replace(/\.md$/, "");
    before += Buffer.byteLength(raw, "utf8");
    after += Buffer.byteLength(writeTriple(raw, { kind: "decisions", project: PROJ, key, check: check("decisions", key) }, "deadbeef"), "utf8");
  }
  const delta = after - before;
  console.log(`  decisions/: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB（+${(delta / 1024).toFixed(1)} KB）`);
  console.log(`  平均每份 +${(delta / files.length).toFixed(0)} 字节`);
  ok("每份增量 < 300 字节", delta / files.length < 300, `${(delta / files.length).toFixed(0)}`);
  // 全库估算
  const total = 990;
  console.log(`  ★ 全库 ${total} 份估算：+${((delta / files.length) * total / 1024).toFixed(0)} KB`);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== I4. 写路径成本（哈希计算次数）===");
{
  const body = "x".repeat(50000); // 50KB 的台账
  const N = 200;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) sealOf(body);
  const t1 = process.hrtime.bigint();
  const perMs = Number(t1 - t0) / 1e6 / N;
  console.log(`  50KB 正文算一次 seal: ${perMs.toFixed(3)} ms`);
  ok("单次 seal < 5ms", perMs < 5, `${perMs.toFixed(3)}ms`);
  console.log(`  ⇒ 一次 ledger_write 多算 1 次 seal + 1 次 check（check 只算 60 字节，可忽略）`);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== I5. ★★★★ 与已有机制的冲突（最危险的一类）===");
{
  // ① 与 block hash：seal 每写必变，但 block hash 应该只随**内容**变
  const raw = "# 标题\n\n正文\n";
  const a1 = writeTriple(raw, { kind: "active", project: PROJ, key: "-", check: check("active", "-") }, "aaaa1111");
  const a2 = writeTriple(raw, { kind: "active", project: PROJ, key: "-", check: check("active", "-") }, "bbbb2222"); // seal 变了
  const h1 = splitBlocks(a1).map((b) => b.hash).join(",");
  const h2 = splitBlocks(a2).map((b) => b.hash).join(",");
  eq("★★ seal 变 ⇒ block hash 也变（因为 frontmatter 在第一块里）", h1 === h2, false);
  console.log("      ⇒ 这是**真冲突**：seal 每次写都变 ⇒ 第一块 hash 每次都变 ⇒ 块级注入省字失效");
  console.log("      ⇒ 修法：splitBlocks 也要跳过 frontmatter 与链接定义（不只是跳过注释）");
}

// ══════════════════════════════════════════════════════════
console.log("\n=== I6. 盲扫性能（真实 memoryRoot）===");
{
  const t0 = process.hrtime.bigint();
  // 直接数文件，模拟盲扫的 IO 压力
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) n += 1;
    }
  };
  walk(MEM, 0);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  console.log(`  遍历 ${n} 个文件耗时 ${ms.toFixed(0)} ms（只 stat，不读内容）`);
  console.log(`  ★ 盲扫还要读每个文件头 4KB ⇒ 估算 ×3~5 = ${(ms * 4).toFixed(0)} ms`);
  ok("全量盲扫 < 5 秒", ms * 4 < 5000, `${(ms * 4).toFixed(0)}ms`);
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
