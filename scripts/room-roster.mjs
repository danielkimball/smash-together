export const active = (room) =>
  [...room.members.values()].filter((p) => p.slot >= 0);
export const waiting = (room) =>
  [...room.members.values()]
    .filter((p) => p.slot < 0 && p.ready && p.socket)
    .sort((a, b) => a.queue - b.queue);
export function nextHost(room) {
  const rank = (p) =>
    Math.min(
      ...[...room.members.values()]
        .filter((m) => (m.ownerId || m.id) === p.id && m.slot >= 0)
        .map((m) => m.slot),
      10,
    );
  return [...room.members.values()]
    .filter((p) => p.socket && !p.ownerId)
    .sort((a, b) => rank(a) - rank(b) || a.joined - b.joined)[0];
}
export function enqueue(room, member) {
  member.slot = -1;
  member.queue = ++room.queueCounter;
}
export function lineup(room) {
  const players = active(room).filter((p) => p.socket && p.ready);
  const queue = waiting(room);
  if (room.override) {
    return room.override
      .map((id) => room.members.get(id))
      .filter((p) => p?.socket && p.ready)
      .slice(0, 4);
  }
  if (!room.results || room.rotation === "manual")
    return [...players, ...queue].slice(0, 4);
  const scores = new Map(room.results.players.map((p) => [p.id, p]));
  const rank = (a, b) =>
    (scores.get(a.id)?.place ?? 99) - (scores.get(b.id)?.place ?? 99) ||
    (scores.get(b.id)?.points ?? 0) - (scores.get(a.id)?.points ?? 0) ||
    (scores.get(b.id)?.kos ?? 0) - (scores.get(a.id)?.kos ?? 0) ||
    a.slot - b.slot;
  players.sort(rank);
  const winnerStaying = players.some((p) => scores.get(p.id)?.place === 0);
  const replace = Math.min(
    Math.max(0, players.length + queue.length - 4),
    room.results.teams
      ? 2
      : Math.max(0, players.length - (winnerStaying ? 1 : 0)),
  );
  return [
    ...players.slice(0, players.length - replace),
    ...queue.slice(0, 4 - (players.length - replace)),
  ].slice(0, 4);
}
export function applyLineup(room, chosen = lineup(room)) {
  const before = active(room);
  const ids = new Set(chosen.map((p) => p.id));
  // Higher-KO losing teammate follows the odd spectator in seven-person rooms.
  const scores = new Map((room.results?.players || []).map((p) => [p.id, p]));
  const outgoing = before.filter((p) => !ids.has(p.id));
  outgoing.sort(
    (a, b) =>
      (scores.get(b.id)?.kos ?? 0) - (scores.get(a.id)?.kos ?? 0) ||
      a.slot - b.slot,
  );
  for (const p of outgoing) enqueue(room, p);
  const occupied = new Set(
    chosen.filter((p) => p.slot >= 0).map((p) => p.slot),
  );
  for (const p of chosen)
    if (p.slot < 0) {
      p.slot = [0, 1, 2, 3].find((slot) => !occupied.has(slot));
      occupied.add(p.slot);
    }
  if (room.results?.teams) {
    // Keep the winning team intact; pair the incoming waiting players.
    const winner = room.results.players.find((p) => p.place === 0);
    const team = winner?.team ?? 0;
    for (const p of chosen)
      p.team = scores.get(p.id)?.place === 0 ? team : team === 0 ? 1 : 0;
  }
  room.override = null;
  room.results = null;
  return chosen;
}
