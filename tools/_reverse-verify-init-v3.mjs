/**
 * ★★★ 反向验证「默认生第三代」：把默认值摘掉，看探针是否真的能看见红。
 * ★ 规矩（本项目最贵的一条）：反向验证必须摘到"能看见红"为止。
 * ★ 绝不改生产目录：在一次性副本里做。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "lib", "part4.js");
const original = fs.readFileSync(SRC, "utf8");

const cases = [
  {
    name: "默认三代（wantV3ByDefault）",
    from: `      const wantV3ByDefault = explicitMemoryRoot === "" && layoutArg !== "flat" && isBrandNew;`,
    to: `      const wantV3ByDefault = false; /* REVERSED */`,
    expect: "默认建成第 3 代",
  },
  {
    name: "不偷升既有项目（isBrandNew 判据）",
    from: `      const isBrandNew = manifestBefore === undefined || Object.keys(manifestBefore ?? {}).length === 0;`,
    to: `      const isBrandNew = true; /* REVERSED: 一律当新项目 */`,
    expect: "不许**把既有 V2 偷偷升成 V3",
  },
  {
    name: "flat 退回",
    from: `      const wantV3ByDefault = explicitMemoryRoot === "" && layoutArg !== "flat" && isBrandNew;`,
    to: `      const wantV3ByDefault = explicitMemoryRoot === "" && isBrandNew; /* REVERSED: 忽略 flat */`,
    expect: "flat ⇒ 不建 memoryRoot",
  },
  {
    name: "自动补齐卡片三目录",
    from: `      const dflt = (v, name) => (v !== "" ? v : wantsV3Now && isBrandNew ? name : v);`,
    to: `      const dflt = (v, name) => v; /* REVERSED: 不补默认 */`,
    expect: "卡片三目录已登记",
  },
];

const runProbe = (tmpRoot) => {
  const dst = path.join(tmpRoot, "tools", "probe.mjs");
  fs.copyFileSync(path.join(ROOT, "tools", "_probe-init-default-v3.mjs"), dst);
  try {
    return execFileSync(process.execPath, [dst], { encoding: "utf8", timeout: 180000 });
  } catch (e) {
    return (e.stdout ?? "") + (e.stderr ?? "");
  }
};

console.log("═══ 反向验证：摘掉默认三代，对应断言必须变红 ═══\n");
let okN = 0, bad = 0;

for (const c of cases) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rev-init-"));
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(tmp, "package.json"));
  fs.mkdirSync(path.join(tmp, "lib"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tools"), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, "lib"))) {
    if (f.endsWith(".js")) fs.copyFileSync(path.join(ROOT, "lib", f), path.join(tmp, "lib", f));
  }
  const target = path.join(tmp, "lib", "part4.js");
  let src = fs.readFileSync(target, "utf8");
  if (!src.includes(c.from)) {
    console.log(`  ✗ ${c.name}：副本里找不到要摘的片段（尺子失效）`);
    bad += 1;
    continue;
  }
  src = src.replace(c.from, c.to);
  fs.writeFileSync(target, src, "utf8");

  const out = runProbe(tmp);
  const lines = out.split(/\r?\n/).filter((l) => l.includes(c.expect));
  // ★★★ 尺子修正（我第一版写错）：探针的结论行**带前导空格**（"  FAIL ..."），
  //   而 `startsWith("FAIL")` 匹配不到 ⇒ 明明红了却判成"仍然绿"。
  //   ★ 这正是本项目那句老话：**判据的输入必须是"被测对象自己产生的那部分"，
  //     而且要按它**真实的形状**去读** —— 不能按我以为的形状（无缩进）。
  const hasFail = lines.some((l) => l.trim().startsWith("FAIL"));
  const m = /(\d+) PASS \/ (\d+) FAIL/.exec(out);

  if (hasFail) {
    console.log(`  ✓ ${c.name} → 变红（正确）  [${m ? m[1] + "P/" + m[2] + "F" : "?"}]`);
    okN += 1;
  } else {
    console.log(`  ✗ ${c.name} → 摘掉后**仍然绿**（断言太弱，必须查清！）  [${m ? m[1] + "P/" + m[2] + "F" : "?"}]`);
    for (const l of lines.slice(0, 3)) console.log(`       ${l.slice(0, 120)}`);
    bad += 1;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

const after = fs.readFileSync(SRC, "utf8");
console.log(`\n  生产 part4.js 未被改动: ${after === original}`);
console.log(`\n═══ ${okN} 条能看见红 / ${bad} 条摘了不红 ═══`);
process.exit(bad === 0 && after === original ? 0 : 1);
