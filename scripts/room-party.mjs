import { randomBytes } from "node:crypto";

export const ownerOf = (member) => member.ownerId || member.id;
export const party = (room, id) =>
  [...room.members.values()].filter((p) => ownerOf(p) === id);
export const connections = (room) =>
  [...room.members.values()].filter((p) => !p.ownerId);

export function validateLocals(locals) {
  if (
    !Array.isArray(locals) ||
    locals.length > 3 ||
    locals.some(
      (p) =>
        !p ||
        typeof p.key !== "string" ||
        !/^[a-zA-Z0-9_-]{1,40}$/.test(p.key) ||
        p.key === "primary",
    ) ||
    new Set(locals.map((p) => p.key)).size !== locals.length
  )
    throw Error(
      "Choose up to four players on this device, each with a different controller.",
    );
  return locals;
}

export function reconcileParty(room, owner, locals, clean) {
  validateLocals(locals);
  const existing = party(room, owner.id).filter((p) => p.ownerId);
  if (room.members.size - existing.length + locals.length > room.capacity)
    throw Error(
      "There is not enough room for everyone on this device. Rooms hold eight people, with four fighting at once.",
    );
  const removed = existing.filter(
    (p) => !locals.some((l) => l.key === p.localKey),
  );
  for (const p of removed) {
    room.members.delete(p.id);
    room.override = room.override?.filter((id) => id !== p.id);
  }
  const added = [];
  for (const [index, local] of locals.entries()) {
    let member = existing.find((p) => p.localKey === local.key);
    if (!member) {
      const used = new Set([...room.members.values()].map((p) => p.slot));
      member = {
        id: randomBytes(8).toString("hex"),
        ownerId: owner.id,
        localKey: local.key,
        ready: true,
        team: 0,
        joined: ++room.queueCounter,
        queue: room.queueCounter,
        slot: room.selecting
          ? ([0, 1, 2, 3].find((i) => !used.has(i)) ?? -1)
          : -1,
      };
      room.members.set(member.id, member);
      added.push(member);
    }
    member.localIndex = index + 1;
    member.name = clean(local.name, `Player ${index + 2}`, 30);
    member.controller = clean(local.controller, "Controller", 80);
    member.socket = owner.socket;
  }
  return { added, removed };
}
