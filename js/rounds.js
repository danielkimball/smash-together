// Stage authority is derived identically by every peer from native results.
// Keep it in synchronization metadata so a late join/reconnect inherits it.
export class Rounds {
  constructor() {
    this.restore();
  }
  restore(state = {}) {
    this.winnerId = typeof state.winnerId === "string" ? state.winnerId : "";
    this.resultsSeen = !!state.resultsSeen;
    this.scene = -1;
  }
  snapshot() {
    return { winnerId: this.winnerId, resultsSeen: this.resultsSeen };
  }
  observe(info, room) {
    this.scene = info.scene;
    if (info.scene === 22) this.resultsSeen = false;
    const results = info.results;
    if (info.scene !== 24 || !results || results.ticks < 2 || this.resultsSeen)
      return;
    this.resultsSeen = true;
    if (results.kind === 4) return; // No contest: retain the previous choice.
    const winners = results.players.filter((p) => p.present && p.place === 0);
    // In team games use the winning team's leading player, matching the
    // native winner ordering: points, KOs, then lowest controller port.
    if (results.teams)
      winners.sort(
        (a, b) => b.points - a.points || b.kos - a.kos || a.slot - b.slot,
      );
    this.winnerId =
      room.members.find((m) => m.slot === winners[0]?.slot)?.id || "";
  }
  chooser(room) {
    return (
      room?.members.find((p) => p.id === this.winnerId) ||
      room?.members.find((p) => p.id === room.hostId)
    );
  }
  filter(inputs, room) {
    if (this.scene !== 21) return inputs;
    const slot = this.chooser(room)?.slot;
    return inputs.map((input, i) =>
      i === slot ? input : { buttons: 0, x: 0, y: 0 },
    );
  }
}
