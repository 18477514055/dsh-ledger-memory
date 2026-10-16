// D221 · 在活桌面端 app.asar 里**列出**内核侧与 web / server / http 相关的包（不解全树）
// 目的：找到宿主 `webServer` 服务的实现，查它有没有「请求授权」契约。
// 用法：node tools/_probe-d221-asar-list.mjs [关键字正则]
import fs from "node:fs";
import path from "node:path";

// ★ 隐私（D221）：**绝不把真实用户名写进 tools/**（它是 PUBLIC 的）。
//   路径用环境变量拼：%LOCALAPPDATA%\\Programs\\DeepSeek Harness\\resources\\app.asar
//   ★ 回读：本机解析结果就是活桌面端那个 asar（与硬编码时同一个文件）。
const ASAR = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "DeepSeek Harness", "resources", "app.asar");
const KW = process.argv[2] ? new RegExp(process.argv[2], "i") : /web|server|http|auth|session/i;

const fd = fs.openSync(ASAR, "r");
try {
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  const tree = JSON.parse(jsonBuf.toString("utf8"));

  // ① @deepseek-ai 下的包名
  const ds = tree.files?.dsh?.files?.node_modules?.files?.["@deepseek-ai"]?.files;
  if (ds) {
    const names = Object.keys(ds).filter((n) => KW.test(n));
    console.log(`═══ @deepseek-ai 下匹配 ${KW} 的包（共 ${Object.keys(ds).length} 个包）═══`);
    for (const n of names) console.log("  " + n);
  } else {
    console.log("⚠️ 没找到 /dsh/node_modules/@deepseek-ai");
  }

  // ② 内核自己的 src 树里匹配的文件路径
  const dshRoot = tree.files?.dsh?.files;
  const hits = [];
  const walk = (node, p, depth) => {
    if (depth > 8) return;
    for (const [name, v] of Object.entries(node.files ?? {})) {
      const full = p + "/" + name;
      if (v.files) walk(v, full, depth + 1);
      else if (KW.test(full) && !/node_modules/.test(full)) hits.push(full);
    }
  };
  if (dshRoot) walk(tree.files.dsh, "dsh", 0);
  console.log(`\n═══ /dsh 下非 node_modules 且匹配 ${KW} 的文件（前 60）═══`);
  for (const h of hits.slice(0, 60)) console.log("  " + h);
} finally {
  fs.closeSync(fd);
}
