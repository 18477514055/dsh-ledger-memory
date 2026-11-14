import fs from "node:fs";

// 看 part1.js 与 part3-settings.js 的互相引用
for (const f of ["lib/part1.js", "lib/part3-settings.js", "lib/part1-store.js", "lib/part3.js"]) {
  const t = fs.readFileSync(f, "utf8");
  const lines = t.split("\n");
  console.log("=== " + f);
  lines.forEach((l, i) => {
    if (/from "\.\/(part1|part3|part3-settings|part1-store)\.js"/.test(l)) {
      console.log(`  ${i + 1}: ${l.slice(0, 120)}`);
    }
  });
}

console.log("\n=== currentSettings 定义在哪 ===");
for (const f of fs.readdirSync("lib").filter((x) => x.endsWith(".js"))) {
  const t = fs.readFileSync("lib/" + f, "utf8");
  if (/^export function currentSettings\(/m.test(t)) console.log("  " + f);
}
