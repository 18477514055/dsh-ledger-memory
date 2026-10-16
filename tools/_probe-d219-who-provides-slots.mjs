// D219 附2 · 找出**谁提供 `slots` 服务**，以及 client 插件的 `inject` 到底按什么解析。
//
// 背景：我的上一个判据把「bundle return 的 inject」直接当成 cordis 服务名去比对，
// 报了「slots 不存在」。★ 但**我们的插件此刻正在运行**（它就挂在这个界面上）⇒
// 按纪律 7：**结论与已手工验证的事实冲突时，先怀疑尺子**。
// ⇒ 本探针把"inject 是怎么被解析的"查清，而不是继续相信那个判据。
import fs from "node:fs";
import path from "node:path";

// ★ 隐私（D221）：**绝不把真实用户名写进 tools/**（它是 PUBLIC 的）。
//   路径按环境变量拼 ⇒ 任何人的机器上都能解析，且源码里没有本机专有信息。
const ASAR = path.join(
  process.env.LOCALAPPDATA ?? "",
  "Programs", "DeepSeek Harness", "resources", "app.asar"
);

const fd = fs.openSync(ASAR, "r");
try {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jb = Buffer.alloc(jsonLen);
  fs.readSync(fd, jb, 0, jsonLen, 16);
  const tree = JSON.parse(jb.toString("utf8"));

  const files = [];
  (function walk(n, p) {
    for (const [k, v] of Object.entries(n.files ?? {})) {
      const f = `${p}/${k}`;
      if (v.files) walk(v, f);
      else files.push({ f, v });
    }
  })(tree, "dsh");

  // ① 谁 provide "slots"（各种写法）
  console.log('═══ ① 谁 provide("slots") ═══');
  const prov = [];
  // ② client 插件 manifest 里的 inject 是怎么被消费的（找内核读 inject 的地方）
  console.log("\n═══ ② 内核里处理 `inject` 的位置 ═══");
  const injectConsumers = [];

  const read = (v) => {
    if (v.offset === undefined) return null;
    const off = 16 + jsonLen + Number(v.offset);
    const buf = Buffer.alloc(Number(v.size));
    fs.readSync(fd, buf, 0, buf.length, off);
    return buf.toString("utf8");
  };

  for (const { f, v } of files) {
    if (!/\.(?:js|mjs|cjs)$/.test(f)) continue;
    const t = read(v);
    if (t === null) continue;
    // provide('slots') / provide("slots")
    if (/provide\s*\(\s*['"]slots['"]/.test(t)) prov.push(f);
    // 内核消费 inject 的地方（客户端模块加载器）
    if (/inject/.test(t) && /(pending|did not activate|waiting for service)/.test(t)) {
      injectConsumers.push(f);
    }
  }
  console.log(prov.length === 0 ? "  （没有 provide('slots') 的字面量）" : prov.map((x) => "  " + x).join("\n"));
  console.log("\n  ── 可能处理 inject 的文件 ──");
  injectConsumers.slice(0, 10).forEach((x) => console.log("  " + x));

  // ③ 逐字看内核怎么判断 pending / waiting for service（这是判据的**真源**）
  console.log("\n═══ ③ 内核报出 `waiting for service: X` 的那段源码 ═══");
  const target = files.find(({ f }) => /dsh-client-modules/.test(f) && /lib\/index\.js$/.test(f));
  if (target) {
    const t = read(target.v);
    const lines = t.split("\n");
    console.log(`  文件：${target.f}（${lines.length} 行）`);
    lines.forEach((l, i) => {
      if (/waiting for service|did not activate|pending/.test(l)) {
        const a = Math.max(0, i - 6);
        const b = Math.min(lines.length, i + 4);
        console.log(`\n  ── 命中 L${i + 1} 的上下文 ──`);
        for (let k = a; k < b; k++) console.log(`   L${k + 1}: ${lines[k].slice(0, 160)}`);
      }
    });
  } else {
    console.log("  （没找到 dsh-client-modules）");
  }
} finally {
  fs.closeSync(fd);
}
