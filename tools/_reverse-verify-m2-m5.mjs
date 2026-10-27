/**
 * ★★★ 反向验证：把四条修复逐一「摘掉」，确认探针真能看见红。
 *
 * ★ 规矩（本项目最贵的一条纪律）：
 *   **反向验证必须摘到"能看见红"为止** —— 摘一处不红，要么断言太弱、要么修复冗余，
 *   两种都要查清。
 * ★ 绝不改生产目录：每次都在**一次性副本**里做（D 那条事故的教训）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "lib", "part3.js");
const original = fs.readFileSync(SRC, "utf8");

const cases = [
  {
    name: "M2a owed 出口",
    file: "gates.js",
    from: `  if (x.phase === "owed") {
    if (x.gapsOk === true) return { act: "compact", why: "owed-done" };
    return { act: "wait", why: "awaiting-owed" };
  }`,
    to: `  if (x.phase === "owed") return { act: "wait", why: "awaiting-owed" };`,
    expect: "owed + completed obligations must advance",
  },
  {
    name: "M3 总开关",
    from: `    if (s.autoCompact === false) return { act: "none", why: "auto-off" };`,
    to: `    /* REMOVED FOR REVERSE TEST */`,
    expect: "automatic master switch respected",
  },
  {
    name: "M1 失败可见",
    from: `        const reasonTxt = String(out?.reason ?? "unknown").slice(0, 300);`,
    to: `        const reasonTxt = ""; /* REMOVED FOR REVERSE TEST */`,
    expect: "failure reason must be observable",
  },
  {
    name: "M5 合同文案",
    from: `        (currentSettings().midTurnCompact === true
          ? "★★ **压缩不需要你动手**：水位一旦越过全量线，插件会在**本回合内**\\n" +
            "做一次**高保真全量压缩**（先抓逐字胶囊、压完连台账一起重注），\\n" +
            "**压完你不用重新开工，直接接着做手上的事** —— 不需要等回合结束，也不需要用户再发一句话。\\n"
          : "★★ **压缩不需要你动手**：水位一旦越过全量线，插件会在**本回合结束之后**\\n" +
            "做一次**高保真全量压缩**（先抓逐字胶囊、压完连台账一起重注）。\\n") +`,
    to: `        ("★★ **压缩不需要你动手**：水位一旦越过全量线，插件会在**本回合结束之后**\\n" +
          "做一次**高保真全量压缩**（先抓逐字胶囊、压完连台账一起重注）。\\n") +`,
    expect: "mid-turn mode must not instruct",
  },
];

const runProbe = (tmpRoot) => {
  const probe = path.join(ROOT, "tools", "diagnose-compaction-integration.mjs");
  // ★ 探针内部是 `path.resolve(dirname(自身), '..')` 当 ROOT，再去 ROOT/lib。
  //   ⇒ 必须把它放在 `<tmpRoot>/tools/` 里，才能解析到 `<tmpRoot>/lib`。
  const dst = path.join(tmpRoot, "tools", "probe.mjs");
  fs.copyFileSync(probe, dst);
  try {
    return execFileSync(process.execPath, [dst], {
      encoding: "utf8",
      timeout: 120000,
    });
  } catch (e) {
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
};

console.log("═══ 反向验证：每条修复摘掉后，对应断言必须变红 ═══\n");
let ok = 0, bad = 0;

for (const c of cases) {
  // 1) 建一次性副本
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rev-"));
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(tmp, "package.json"));
  fs.mkdirSync(path.join(tmp, "lib"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tools"), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, "lib"))) {
    if (f.endsWith(".js")) fs.copyFileSync(path.join(ROOT, "lib", f), path.join(tmp, "lib", f));
  }
  // 2) 摘掉那一处
  const target = path.join(tmp, "lib", c.file ?? "part3.js");
  let src = fs.readFileSync(target, "utf8");
  if (!src.includes(c.from)) {
    console.log(`  ✗ ${c.name}：在副本里找不到要摘的片段（尺子失效）`);
    bad += 1;
    continue;
  }
  src = src.replace(c.from, c.to);
  fs.writeFileSync(target, src, "utf8");

  // 3) 跑探针，看那条断言红不红
  const out = runProbe(tmp);
  const lines = out.split(/\r?\n/).filter((l) => l.includes(c.expect));
  const hasFail = lines.some((l) => l.startsWith("FAIL"));
  const summary = (out.match(/SUMMARY PASS \d+ FAIL \d+/) ?? ["(无 SUMMARY) — 探针没跑起来，属夹具故障"])[0];

  if (hasFail) {
    console.log(`  ✓ ${c.name} → 摘掉后变红（正确）  [${summary}]`);
    ok += 1;
  } else {
    console.log(`  ✗ ${c.name} → 摘掉后**仍然绿**（断言太弱或修复冗余，必须查清！）  [${summary}]`);
    for (const l of lines.slice(0, 3)) console.log(`       ${l.slice(0, 140)}`);
    bad += 1;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ★ 自证：确认被测的 part3.js 没被污染（生产文件 hash 不变）
const after = fs.readFileSync(SRC, "utf8");
console.log(`\n  生产 part3.js 未被改动: ${after === original}`);

console.log(`\n═══ 结果：${ok} 条能看见红 / ${bad} 条摘了不红 ═══`);
process.exit(bad === 0 && after === original ? 0 : 1);
