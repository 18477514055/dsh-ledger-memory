// D338 探针 v2 —— 修两处我自己的尺子错：
//   #56 调用 renderCardIndex 前没读签名（真签名是 `(root, dirRel, opts)`，我按 (cards) 调 ⇒ 取到 -1，误判）
//   #57 F-03② 只用「赋值清空」的形态写判据，而实现用的是 `state.triageOwedAt?.delete?.(key)` ⇒ 空转通过
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const libUrl = (n) => pathToFileURL(path.join(root, "lib", n)).href;

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail = "") {
  if (cond) { pass++; results.push(["PASS", name, detail]); }
  else { fail++; results.push(["FAIL", name, detail]); }
}
const tmpdir = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `d338-${t}-`));

// ══ F-01
{
  const { readManifestDetailed } = await import(libUrl("v3-conformance.js"));
  const d1 = tmpdir("f01a");
  const r1 = readManifestDetailed(d1, ".dsh-ledger.json");
  ok("F-01 对照｜清单真的不存在 ⇒ broken:false（允许猜）",
    r1 && r1.broken === false && r1.manifest === undefined, JSON.stringify(r1));

  const d2 = tmpdir("f01b");
  fs.mkdirSync(path.join(d2, ".dsh-ledger.json"));
  const r2 = readManifestDetailed(d2, ".dsh-ledger.json");
  ok("F-01 主体｜物理存在但读不出 ⇒ 必须 broken:true", r2 && r2.broken === true, JSON.stringify(r2));
}

// ══ F-04（大括号配平切块，不加固定长度 —— 尺子错 #53）
{
  const src = fs.readFileSync(path.join(root, "lib/part2.js"), "utf8");
  const anchor = "for (const c of HANDOFF_DIR_CANDIDATES) {";
  const i = src.indexOf(anchor);
  ok("F-04 前提｜能找到探测段", i >= 0, `index=${i}`);
  if (i >= 0) {
    let depth = 0, end = -1, started = false;
    for (let k = i; k < src.length; k++) {
      const ch = src[k];
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") { depth--; if (started && depth === 0) { end = k; break; } }
    }
    const block = src.slice(i, end + 1);
    ok("F-04 主体｜候选目录探测段必须调用 isUnderReal",
      block.includes("isUnderReal"), `blockLen=${block.length}`);
  }
}

// ══ F-05（★ 尺子错 #58：修好之后那行**合法地消失**了，不能拿「旧字面量还在不在」当判据）
//   正确判据：白名单判定必须建立在**归一化后**的比较上（normPath / toLowerCase / resolve）。
{
  const src = fs.readFileSync(path.join(root, "lib/settings-http.js"), "utf8");
  const i = src.indexOf('const root = typeof body?.root === "string"');
  ok("F-05 前提｜能找到扩展保存路由的 root 解析点", i >= 0, `index=${i}`);
  if (i >= 0) {
    const win = src.slice(i, i + 1200);
    const hasNorm = /normPath|toLowerCase|normalize\(/.test(win);
    const hasBare = /!\s*allowed\.roots\.includes\(\s*root\s*\)/.test(win);
    ok("F-05 主体｜白名单判定必须归一化后比较（且不再有裸 includes）",
      hasNorm && !hasBare, `hasNorm=${hasNorm} hasBare=${hasBare}`);
  }
}

// ══ F-06
{
  const src = fs.readFileSync(path.join(root, "lib/manifest-mirror.js"), "utf8");
  const m = src.match(/const tmp = `\$\{abs\}\.tmp-[^`]*`/);
  ok("F-06 前提｜能找到临时文件名拼装", !!m, m ? m[0] : "没找到");
  ok("F-06 主体｜临时名必须含随机/唯一段",
    !!m && /random|uuid|randBytes|Math\.random|nonce/i.test(m[0]), m ? m[0] : "");
}

// ══ F-07（★ 先读签名再调用：renderCardIndex(root, dirRel, opts)）
{
  const { renderCardIndex } = await import(libUrl("card-ops.js"));
  const d = tmpdir("f07");
  const cardDir = "decisions";
  fs.mkdirSync(path.join(d, cardDir), { recursive: true });
  // 三张卡：内容量与结构完全一致 ⇒ 融合分必然相同 ⇒ 只看同分排序
  for (const k of ["D1", "D2", "D10"]) {
    fs.writeFileSync(path.join(d, cardDir, `${k}.md`),
      `## ${k} · 同一分\r\n\r\n- 日期：2026-10-27\r\n- 正文：占位\r\n`, "utf8");
  }
  const r = renderCardIndex(d, cardDir, {});
  const md = String(r?.markdown ?? "");
  const idx = ["D1", "D2", "D10"].map((k) => md.indexOf("`" + k + "`"));
  const natural = idx[0] >= 0 && idx[0] < idx[1] && idx[1] < idx[2];
  ok("F-07 主体｜同分时须自然数字序（D1 < D2 < D10）", natural,
    `indexOf=${JSON.stringify(idx)} rows=${r?.count}`);
}

// ══ F-08
{
  const src = fs.readFileSync(path.join(root, "lib/base.js"), "utf8");
  const m = src.match(/fs\.rmSync\(fromAbs,\s*\{[^}]*\}\)/);
  ok("F-08 前提｜能找到删源调用", !!m, m ? m[0] : "没找到");
  ok("F-08 主体｜删源目录必须带 force:true", !!m && /force\s*:\s*true/.test(m[0]), m ? m[0] : "");
}

// ══ F-02
{
  const targets = [
    ["lib/workspace-tools.js", [143, 267, 307]],
    ["lib/part4.js", [2851, 3248, 3249]],
    ["lib/part5.js", [544]],
    ["lib/part2-tools.js", [386]],
  ];
  let hits = 0; const detail = [];
  for (const [rel, lines] of targets) {
    const L = fs.readFileSync(path.join(root, rel), "utf8").split(/\r?\n/);
    for (const n of lines) {
      if (/throw fail\(/.test((L[n - 1] || "").trim())) { hits++; detail.push(`${rel}:${n}`); }
    }
  }
  ok("F-02 主体｜点名的边界处不再有未捕获 throw fail（0 处）",
    hits === 0, hits ? `残留 ${hits}：${detail.join(", ")}` : "0 处");
}

// ══ F-03（★ 欠账清除有两种形态：赋值 **和** `.delete?.()` —— 只认一种会空转通过）
{
  const src = fs.readFileSync(path.join(root, "lib/part5.js"), "utf8");
  const i = src.indexOf("export function defineTriageTool");
  ok("F-03 前提｜能找到 defineTriageTool", i >= 0, `index=${i}`);
  if (i >= 0) {
    const rest = src.slice(i + 10);
    const j = rest.indexOf("\nexport function");
    const body = j > 0 ? src.slice(i, i + 10 + j) : src.slice(i);
    ok("F-03 主体①｜triage 有顶层 refuseIfMemoryRootUnsafe 门禁",
      body.includes("refuseIfMemoryRootUnsafe"), `bodyLen=${body.length}`);

    const kStash = body.indexOf("persistStash(");
    // 两种清除形态都算：赋值清空 / Map.delete
    const clears = [];
    const reA = /state\.triageOwedAt\s*=\s*(?:undefined|null|0|""|'')/g;
    let mm;
    while ((mm = reA.exec(body))) clears.push(mm.index);
    const reD = /state\.triageOwedAt\?*\.?delete\?*\.?\(/g;
    while ((mm = reD.exec(body))) clears.push(mm.index);
    ok("F-03 前提②｜能找到 persistStash 调用", kStash >= 0, `persistStash@${kStash}`);
    ok("F-03 前提③｜能找到清欠账的位置（两种形态）", clears.length > 0, `clears=${JSON.stringify(clears)}`);
    const earliest = clears.length ? Math.min(...clears) : -1;
    ok("F-03 主体②｜清欠账必须在 persistStash **之后**（不许提前清）",
      kStash >= 0 && earliest > kStash, `clear@${earliest} stash@${kStash}`);
  }
}

console.log("──────── D338 复核（v2）────────");
for (const [st, name, detail] of results) {
  console.log(`  ${st === "PASS" ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
console.log(`──────── 合计：PASS ${pass} · FAIL ${fail} ────────`);
console.log("PROBE-COMPLETE");
process.exit(fail === 0 ? 0 : 1);
