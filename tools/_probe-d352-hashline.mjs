// _probe-d352-hashline.mjs —— 专门验证用户最后强调的那条边界：
//   "我不是指一定要把指纹变成哈希，因为那样的话，文字一变，哈希就会变"
// ★ 要证明的是：**内容随便改，身份不变**。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  newProjectId, applyFingerprint, parseFingerprint, verifySeal,
  identityCheck, scanBlind,
} from "../lib/fingerprint.js";

let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${e === undefined ? "" : "  ← " + e}`); } };
const eq = (n, a, b) => ok(n, a === b, `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`);

const PROJ = newProjectId();

// ══════════════════════════════════════════════════════════
console.log("=== 1. ★★★ 核心：正文改 3 次，身份必须一模一样 ===");
{
  const versions = [
    "## D195 · 某决定\n初版理由\n",
    "## D195 · 某决定\n理由被重写了，内容完全不同，长度也变了变变变变变\n",
    "## D195 · 某决定\n",
    "", // 甚至被清空
  ];
  const ids = [];
  const seals = [];
  for (const v of versions) {
    const t = applyFingerprint(v, { kind: "decisions", project: PROJ, key: "D195" }).text;
    const p = parseFingerprint(t);
    ids.push(`${p.fp.v}|${p.fp.kind}|${p.fp.project}|${p.fp.key}`);
    seals.push(p.fp.seal);
    eq(`  v${ids.length} 自证位通过`, p.checkOk, true);
  }
  const uniqId = new Set(ids);
  eq("★★★ 4 个版本的「身份四元组」完全一致", uniqId.size, 1);
  const uniqSeal = new Set(seals);
  eq("★★ seal 各不相同（内容确实变了）", uniqSeal.size, 4);
  console.log(`     身份: ${[...uniqId][0]}`);
  console.log(`     seal: ${seals.join(" / ")}`);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 2. 身份 check 只取决于四元组，与内容无关 ===");
{
  const a = identityCheck(1, "decisions", PROJ, "D195");
  const b = identityCheck(1, "decisions", PROJ, "D195");
  eq("同参数 ⇒ 同值", a, b);
  const c = identityCheck(1, "decisions", PROJ, "D196");
  ok("换 key ⇒ 换值", a !== c);
  const d = identityCheck(2, "decisions", PROJ, "D195");
  ok("换 v ⇒ 换值", a !== d);
  const e = identityCheck(1, "lessons", PROJ, "D195");
  ok("换 kind ⇒ 换值", a !== e);
  const f = identityCheck(1, "decisions", newProjectId(), "D195");
  ok("换 project ⇒ 换值", a !== f);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 3. 反向：正文被外部改了 ⇒ seal 必须报「内容变了」，但身份仍认得出 ===");
{
  const t1 = applyFingerprint("原始内容\n", { kind: "active", project: PROJ, key: "-" }).text;
  const modified = t1.replace("原始内容", "被人偷偷改过");
  const p = parseFingerprint(modified);
  eq("身份仍认得出", p.ok, true);
  eq("身份自证位仍通过（因为身份没变）", p.checkOk, true);
  const v = verifySeal(modified, p);
  eq("★ 但内容校验报不符", v.ok, false);
  ok("★ 并说明是内容被改过", String(v.reason).includes("内容"), v.reason);
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 4. 一个真文件：反复改正文 5 次，盲扫永远认得出 ===");
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fp-hash-"));
  const abs = path.join(tmp, "whatever-name");
  const texts = [
    "# 第一版\nA\n",
    "# 第二版\nA\nB\nC\n",
    "# 第三版\n完全不同的一段话完全不同的一段话完全不同的一段话\n",
    "#\n",
    "",
    "# 最后\n",
  ];
  let allFound = true;
  for (let i = 0; i < texts.length; i += 1) {
    const t = applyFingerprint(texts[i], { kind: "active", project: PROJ, key: "-" }).text;
    fs.writeFileSync(abs, t, "utf8");
    const scan = scanBlind(tmp, { project: PROJ });
    const n = (scan.byKind.get("active") ?? []).length;
    if (n !== 1) { allFound = false; console.log(`    第 ${i + 1} 次（长度 ${texts[i].length}）没认出来`); }
  }
  eq("★★★ 6 个不同内容的版本，每次都认得出", allFound, true);

  // 即使文件名叫完全无关的东西也一样
  fs.renameSync(abs, path.join(tmp, "x"));
  const s2 = scanBlind(tmp, { project: PROJ });
  eq("★★ 改成单字符名字后仍认得出", (s2.byKind.get("active") ?? []).length, 1);

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════
console.log("\n=== 5. 对照：如果身份含内容哈希会怎样（演示为什么不能那么做）===");
{
  const body1 = "## D195\n理由A\n";
  const body2 = "## D195\n理由B\n";
  // 假设身份 = 内容哈希
  const fakeId1 = identityCheck(1, "decisions", PROJ, body1);
  const fakeId2 = identityCheck(1, "decisions", PROJ, body2);
  ok("★ 若身份含内容，改一个字身份就变了（所以要禁止）", fakeId1 !== fakeId2);
  // 我们的真实身份
  const real1 = identityCheck(1, "decisions", PROJ, "D195");
  const real2 = identityCheck(1, "decisions", PROJ, "D195");
  eq("★ 我们的真实身份不含内容 ⇒ 两个版本一致", real1, real2);
}

console.log(`\n=== 结果：${pass} PASS / ${fail} FAIL ===`);
if (fail !== 0) process.exitCode = 1;
console.log("PROBE-COMPLETE");
