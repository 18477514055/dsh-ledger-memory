/**
 * 探针：我们**能不能**给插件声明 `Config`（官方设置面板据此渲染表单）。
 *
 * ★ 两个必须先测的未知数（不测就写代码 = 猜）：
 *   ① 插件目录是 Junction 目标，Node 会解析**真实路径** ⇒ 从 `lib/` 往上找
 *      `node_modules` 找不到 profile 里的 `@deepseek-ai/*`。
 *      官方 `dshmarket` 用了 `@deepseek-ai/schemastery`，我们能不能也用？
 *   ② 若不能 import，内核要的 `Config` 到底**是什么形状**（它只调哪些方法）？
 *      —— 只要能满足那个形状，就不必 import。
 *
 * 用法：node tools/_probe-config-schema.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";

const PLUGIN_DIR = path.resolve(import.meta.dirname, "..");
const PROFILE_DIR = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "profiles", process.env.DSH_PROFILE ?? "desktop");

console.log("═══ ① 从插件真实路径能否解析 @deepseek-ai/schemastery ═══");
{
  const req = createRequire(path.join(PLUGIN_DIR, "lib", "index.js"));
  for (const spec of [
    "@deepseek-ai/schemastery",
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-settings",
  ]) {
    try {
      const p = req.resolve(spec);
      console.log(`  ✅ ${spec}\n     → ${p}`);
    } catch (e) {
      console.log(`  ❌ ${spec}  → ${e.code ?? e.message}`);
    }
  }
  console.log("  （require.resolve 用的正是 Node 真实的 node_modules 查找链）");
}

console.log("\n═══ ② 从 profile 解析（对照：内核自己看到的） ═══");
{
  const req = createRequire(path.join(PROFILE_DIR, "package.json"));
  for (const spec of ["@deepseek-ai/schemastery", "@deepseek-ai/cordis"]) {
    try {
      const p = req.resolve(spec);
      console.log(`  ✅ ${spec}\n     → ${p}`);
    } catch (e) {
      console.log(`  ❌ ${spec}  → ${e.code ?? e.message}`);
    }
  }
}

console.log("\n═══ ③ 内核到底怎么用 Config（它调哪些方法） ═══");
{
  // 从 profile 那边取 schemastery 来实测它的形状（只读、只用来观察）。
  const req = createRequire(path.join(PROFILE_DIR, "package.json"));
  let Schema;
  try {
    Schema = req("@deepseek-ai/schemastery");
  } catch (e) {
    console.log(`  取不到 schemastery：${e.message}`);
  }
  if (Schema !== undefined) {
    console.log(`  导出键：${Object.keys(Schema).join(", ")}`);
    const z = Schema.default ?? Schema;
    const s = z.object({
      autoCompact: z.boolean().default(true),
      turnEndOffer: z.boolean().default(false),
      maxActiveLines: z.number().default(300),
    });
    console.log(`  z.object(...) 的类型：${typeof s}`);
    console.log(`  有的方法/属性：${Object.getOwnPropertyNames(Object.getPrototypeOf(s)).join(", ")}`);
    console.log(`  自己身上的键：${Object.getOwnPropertyNames(s).join(", ")}`);
    // `resolveConfig` 会调 `simplify`；`Config` 常被当函数调用来校验。
    console.log(`  可调用吗：${typeof s === "function" ? "是（typeof === 'function'）" : "否"}`);
    try {
      console.log(`  simplify() → ${JSON.stringify(s.simplify?.({}))}`);
    } catch (e) {
      console.log(`  simplify 出错：${e.message}`);
    }
    try {
      const out = typeof s === "function" ? s({}) : undefined;
      console.log(`  当函数调（空对象）→ ${JSON.stringify(out)}`);
    } catch (e) {
      console.log(`  当函数调出错：${e.message}`);
    }
  }
}
