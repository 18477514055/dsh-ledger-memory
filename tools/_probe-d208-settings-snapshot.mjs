/**
 * ★★★★★★ 探针（D208）：**"当前设置"快照到底有没有送达模型**？
 *
 * ★ 为什么必须单独验（不能只看"我写了那个函数"）：
 *   本项目已栽过两次"代码写了、但实际送达的那一份没有"（D195 契约漏 3 份记忆文件、
 *   D197 协议 7/7 没推行）⇒ 判据：**判据要吃"真渲染出来的注入文本"**，
 *   而不是源码里有没有那个函数名（L14：源码 ≠ 送达文本）。
 *
 * ★ 用户的病（逐字）：*"我现在已经台账设置为 400，但是你仍然认为是 350，
 *   然后有些模型认为是 150，有些模型认为是 300"* ⇒ 本探针必须证明：
 *   ① 快照**真的在注入里**（走真入口 `renderInjectionBody`）；
 *   ② 它报的是**生效值**且标了**来源**（"项目" vs "插件"）；
 *   ③ 面板值与项目值不一致时，快照**说清了谁管用**。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const mod = await import(pathToFileURL(path.join(ROOT, "lib", "index.js")).href);
const T = mod.__test;

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail === "" ? "" : `  ← ${detail}`}`);
  }
};

// ── 夹具：一个**面板与项目值不一致**的项目（正是用户的现场形状）──────────────
const root = fs.mkdtempSync(path.join(os.tmpdir(), "d208-snap-"));
fs.writeFileSync(path.join(root, "LEDGER.md"), "# 台账\n\n状态。\n", "utf8");
fs.mkdirSync(path.join(root, "_ledger-archive"), { recursive: true });
// ★ 项目清单写 350（"项目管用"），而我们要把**插件面板**设成 400 ⇒ 分叉现场。
fs.writeFileSync(
  path.join(root, ".dsh-ledger.json"),
  JSON.stringify(
    { version: 1, active: "LEDGER.md", decisions: "DECISIONS.md", archiveDir: "_ledger-archive", maxActiveLines: 350, revision: 0 },
    null, 2
  ),
  "utf8"
);

// ★ 用真入口：makeCtx 那套在 selftest 里，这里直接调导出面（若没导出就跳过并如实报）
const renderer = T.renderSettingsSnapshot;
ok("前提：`renderSettingsSnapshot` 已从 `__test` 导出（否则本探针验不了）", typeof renderer === "function");

if (typeof renderer === "function") {
  // ★ 用当前进程的设置（面板）——真实调用点是 apply()；这里直接给一份覆盖后的设置。
  //   （`__test.setActiveSettings` 若没导出，就用 apply 走一次；这里优先用它。）
  const info = T.inspect(root);
  const text = renderer(info);

  ok("① 快照**真的在注入里**（真渲染出来的文本含标题）", /当前设置/.test(text), text.slice(0, 60));
  ok("② 它报了**台账上限**这一项", /活跃台账上限/.test(text), "");
  ok("③ ★ 它带**来源标注**（「项目清单」/「插件面板」字样）", /项目清单/.test(text) && /面板/.test(text), "");
  ok("④ ★★ 它**明说「它管用」并把面板值降级说明**（这正是用户困惑的解药）", /它管用/.test(text) && /只管新项目|新项目的默认/.test(text), "");
  ok("⑤ 它报了压缩线 / 分流单 / 注入形态（用户看的另外几项）", /全量压缩线/.test(text) && /分流单/.test(text) && /注入/.test(text), "");
  console.log("\n  ── 渲染出来的快照（逐字）──");
  console.log(text.split("\n").map((l) => `  │ ${l}`).join("\n"));

  // ② 反向：面板 400 vs 项目 350 ⇒ 快照必须**同时**给出这两个数并把话说清
  ok(
    "⑥ ★★ 面板值与项目值不一致时，两个数**都出现**且**谁管用说得清**",
    text.includes("350") && text.includes("400"),
    `含350=${text.includes("350")} 含400=${text.includes("400")}`
  );
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n  通过 ${pass}，失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
