// D217 · 在活桌面端的 app.asar 里找 **0.2.0-rc.2 的那个 dsh 内核**（bin.js）
// 目的：用它跑一次性 profile，这样 dshOperations 的证据才与我们声明的键 0.2.0-rc.2 匹配。
// 用法：node tools/_probe-d217-find-kernel.mjs
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
  // ★ 本项目记过的坑：JSON 长度在偏移 12，不在 8
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const tree = JSON.parse(jsonBuf.toString("utf8"));

  const hits = [];
  const walk = (node, p) => {
    for (const [name, v] of Object.entries(node.files ?? {})) {
      const full = `${p}/${name}`;
      if (v.files) walk(v, full);
      else if (/(^|\/)dsh(\/|$)/.test(full) && /bin\.js$/.test(full)) hits.push(full);
      else if (/@deepseek-ai[\/\\]dsh[\/\\]package\.json$/.test(full)) hits.push(full);
    }
  };
  walk(tree, "");

  console.log("═══ app.asar 里与 dsh 内核相关的条目 ═══");
  if (hits.length === 0) console.log("  （没有直接命中，列出顶层结构供判断）");
  for (const h of hits.slice(0, 40)) console.log("  " + h);

  if (hits.length === 0) {
    console.log("\n═══ 顶层 ═══");
    for (const k of Object.keys(tree.files ?? {}).slice(0, 30)) console.log("  " + k);
    const nm = tree.files?.node_modules?.files;
    if (nm) {
      console.log("\n═══ node_modules 顶层（前 40）═══");
      for (const k of Object.keys(nm).slice(0, 40)) console.log("  " + k);
      const ds = nm["@deepseek-ai"]?.files;
      if (ds) {
        console.log("\n═══ @deepseek-ai 下（前 60）═══");
        for (const k of Object.keys(ds).slice(0, 60)) console.log("  " + k);
      }
    }
  }

  // 若找到内核 package.json，读它的版本（需要按 asar 偏移读文件内容）
  const pkgEntry = hits.find((h) => h.endsWith("package.json"));
  if (pkgEntry) {
    // 重新定位该条目拿 offset/size
    const parts = pkgEntry.split("/").filter(Boolean);
    let node = tree;
    for (const part of parts) node = node.files?.[part];
    if (node?.offset !== undefined) {
      const off = 16 + jsonLen + Number(node.offset);
      const buf = Buffer.alloc(Number(node.size));
      fs.readSync(fd, buf, 0, buf.length, off);
      const j = JSON.parse(buf.toString("utf8"));
      console.log(`\n★ 找到内核：${pkgEntry}`);
      console.log(`   name    : ${j.name}`);
      console.log(`   version : ${j.version}`);
      console.log(`   bin     : ${JSON.stringify(j.bin)}`);
    }
  }
} finally {
  fs.closeSync(fd);
}
