/** Shared final-target role guard. Leaf module: no partN imports, no writes, no side effects.
 * Init validation is not a substitute: manifests can also arrive via old versions or manual edits.
 */
import fs from "node:fs";
import path from "node:path";

const ROLE_FIELDS = { active: "activeRel", decisions: "decisionsRel", journal: "journalRel", goals: "goalsRel", lessons: "lessonsRel", principles: "principlesRel" };
const CARD_FIELDS = { decisions: "decisionsDir", goals: "goalsDir", lessons: "lessonsDir" };
function rolePathIdentity(base, relative) {
  let absolute = path.resolve(base, relative);
  let ancestor = absolute;
  const missing = [];
  // Resolve real ancestors even when the final file has not been created yet.
  for (;;) {
    try { absolute = path.join(fs.realpathSync(ancestor), ...missing.reverse()); break; }
    catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      missing.push(path.basename(ancestor)); ancestor = parent;
    }
  }
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function roleContains(directory, candidate) {
  const rel = path.relative(directory, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
/** Return undefined when safe, otherwise a structured refusal. Never authorizes principles writes. */
export function refuseMemoryRoleCollision(root, info, target) {
  if (!Object.hasOwn(ROLE_FIELDS, target)) return { ok: false, reason: `未知记忆角色：${target}`, roleCollision: true };
  const base = typeof info?.memoryBase === "string" && info.memoryBase ? info.memoryBase : root;
  const identities = [];
  for (const [kind, field] of Object.entries(ROLE_FIELDS)) {
    const rel = info?.[field];
    if (typeof rel === "string" && rel.trim()) identities.push({ kind, dir: false, rel, id: rolePathIdentity(base, rel) });
    const dirRel = info?.[CARD_FIELDS[kind]];
    if (typeof dirRel === "string" && dirRel.trim()) identities.push({ kind, dir: true, rel: dirRel, id: rolePathIdentity(base, dirRel) });
  }
  const conventional = path.join(base, "PRINCIPLES.md");
  if (fs.existsSync(conventional)) identities.push({ kind: "principles", dir: false, rel: "PRINCIPLES.md", id: rolePathIdentity(base, "PRINCIPLES.md") });
  const targetDir = identities.find((x) => x.kind === target && x.dir);
  let effective = targetDir ?? identities.find((x) => x.kind === target && !x.dir);
  // ledger_goals may create its first conventional singleton before registration.
  if (!effective && target === "goals") effective = { kind: target, dir: false, rel: "GOALS.md", id: rolePathIdentity(base, "GOALS.md") };
  if (!effective) return undefined;
  for (const peer of identities) {
    if (peer.kind === target) continue;
    const collides = effective.id === peer.id || (effective.dir && roleContains(effective.id, peer.id)) || (peer.dir && roleContains(peer.id, effective.id));
    if (collides) return {
      ok: false,
      roleCollision: true,
      target,
      conflictingRole: peer.kind,
      reason: `拒绝写入：${target}（${effective.rel}）与 ${peer.kind}（${peer.rel}）的实际路径重合或目录互相包含。请先修复清单角色配置；原则授权和流水只追加不能被其他角色绕过。`,
    };
  }
  return undefined;
}
