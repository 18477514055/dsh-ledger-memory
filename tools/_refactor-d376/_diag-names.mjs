import fs from "node:fs";

// 复刻 namesOf
function namesOf(spec) {
  if (!spec.startsWith("{")) return [spec.trim()];
  return spec
    .replace(/^\{|\}$/g, "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const as = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(x);
      return as ? as[1] : x;
    });
}

const line = fs.readFileSync("lib/part1.js", "utf8").split("\n")[7];
const m = /^import\s+(.+?)\s+from\s+"([^"]+)";?\s*$/.exec(line);
const names = namesOf(m[1]);
console.log("解析出的名字数:", names.length);
console.log("含 protocolGapOf:", names.includes("protocolGapOf"));
console.log("前 5 个:", names.slice(0, 5));
console.log("后 5 个:", names.slice(-5));
const idx = names.findIndex((n) => n.includes("protocolGapOf"));
console.log("protocolGapOf 附近:", idx >= 0 ? names.slice(Math.max(0, idx - 1), idx + 2) : "没找到");
