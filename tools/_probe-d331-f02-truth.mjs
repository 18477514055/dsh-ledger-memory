/**
 * _probe-d331-f02-truth.mjs —— 查清 F-02 那一条：打补丁后 `extRootAbs(null,"")` 到底返回什么
 *
 * ★ 起因：`_probe-d331-012-repro.mjs` 打补丁后仍报 F-02① 为 `""`。
 *   但源码已改成 `return undefined` ⇒ **冲突**。按纪律第 7 条：
 *   **结论与自己已手工验证过的事实冲突时，先怀疑尺子。**
 *
 * ★ 我的怀疑：`resolveInfo(null, "")` 可能**返回 ok:true**（把 `null` 当成"没给 info，
 *   用 fallbackRoot 当根"），于是 `extRootAbs` 根本走不到那个 `return undefined` 分支，
 *   而是继续往下走 `memoryBaseOf` —— 那里可能把空根算成了 `""`。
 *   ⇒ 那就说明：**病灶被修掉了一半**（r.ok!==true 那条分支修了），
 *     **另一半（base 为空）还在**，或者**两条都修了但我的输入没走到**。
 *
 * 本探针把每个中间量都打印出来，不再猜。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

const P8 = await import(pathToFileURL(path.resolve("lib/part8.js")).href);

console.log("part8 导出的相关函数：");
for (const n of ["extRootAbs", "extRegistryAbs", "extDirAbs", "readRegistry", "writeRegistry", "resolveInfo"]) {
  console.log(`  ${n}: ${typeof P8[n]}`);
}

const CASES = [
  { label: "null, \"\"", info: null, fb: "" },
  { label: "null, undefined", info: null, fb: undefined },
  { label: "undefined, \"\"", info: undefined, fb: "" },
  { label: "{}, \"\"", info: {}, fb: "" },
  { label: "{manifest:{}}, \"\"", info: { manifest: {} }, fb: "" },
];

console.log("\n═══ extRootAbs / extRegistryAbs 各输入 ═══");
for (const c of CASES) {
  let root, reg, ri;
  try { root = P8.extRootAbs(c.info, c.fb); } catch (e) { root = `THREW:${e.message}`; }
  try { reg = P8.extRegistryAbs(c.info, c.fb); } catch (e) { reg = `THREW:${e.message}`; }
  try {
    ri = typeof P8.resolveInfo === "function" ? P8.resolveInfo(c.info, c.fb) : "（未导出）";
  } catch (e) { ri = `THREW:${e.message}`; }
  console.log(`  ${c.label}`);
  console.log(`      resolveInfo → ${ri === "（未导出）" ? ri : JSON.stringify(ri).slice(0, 220)}`);
  console.log(`      extRootAbs  → ${JSON.stringify(root)}`);
  console.log(`      extRegistryAbs → ${JSON.stringify(reg)}`);
}

console.log("\n═══ 判据：两种「危险值」都不许出现 ═══");
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log(`  PASS  ${name}${extra ? `  —— ${extra}` : ""}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${extra ? `  —— ${extra}` : ""}`); }
}
for (const c of CASES) {
  let root, reg;
  try { root = P8.extRootAbs(c.info, c.fb); } catch { root = undefined; }
  try { reg = P8.extRegistryAbs(c.info, c.fb); } catch { reg = undefined; }
  ok(
    `危险值检查 [${c.label}]：extRootAbs 不许是 ""（会被 path.join 吞成 cwd 相对）`,
    root !== "",
    JSON.stringify(root)
  );
  ok(
    `危险值检查 [${c.label}]：extRegistryAbs 不许是裸 "registry.json"`,
    reg !== "registry.json",
    JSON.stringify(reg)
  );
}

console.log(`\n合计：PASS ${pass} · FAIL ${fail}`);
console.log("PROBE-COMPLETE");
