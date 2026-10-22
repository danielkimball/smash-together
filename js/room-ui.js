import { RoomVoice } from "./voice.js";
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
export class RoomUI {
  constructor(net, open, toast) {
    this.net = net;
    this.voice = new RoomVoice(net);
    this.open = open;
    document.querySelectorAll("[data-room-panel]").forEach(
      (b) =>
        (b.onclick = () => {
          this.render();
          open("players-dialog");
        }),
    );
    document.querySelectorAll("[data-voice]").forEach(
      (b) =>
        (b.onclick = () => {
          this.renderVoice();
          open("voice-dialog");
        }),
    );
    $("sit-out").onclick = () =>
      net.send({ type: "availability", ready: !net.me.ready });
    $("rotation-mode").onchange = () =>
      net.send({ type: "manage", rotation: $("rotation-mode").value });
    $("lineup-apply").onclick = () => {
      const lineup = [
        ...document.querySelectorAll("[data-lineup]:checked"),
      ].map((n) => n.dataset.lineup);
      if (lineup.length > 4) return toast("Choose no more than four players.");
      net.send({ type: "manage", lineup });
    };
    $("teams-apply").onclick = () =>
      net.send({
        type: "manage",
        teamsEnabled: $("battle-mode").value === "teams",
        teams: Object.fromEntries(
          [...document.querySelectorAll("[data-team]")].map((n) => [
            n.dataset.team,
            Number(n.value),
          ]),
        ),
      });
    $("voice-join").onclick = () => this.voice.join();
    $("voice-leave").onclick = () => this.voice.stop();
    $("voice-mute").onclick = () => {
      this.voice.muted = !this.voice.muted;
      this.voice.settings();
    };
    $("voice-volume").oninput = (e) => {
      this.voice.volume = Number(e.target.value) / 100;
      this.voice.settings();
    };
    $("mute-spectators").onchange = (e) =>
      net.send({ type: "voice-moderate", spectators: e.target.checked });
    net.addEventListener("change", () => {
      this.render();
      this.renderVoice();
    });
    this.voice.addEventListener("change", () => this.renderVoice());
    setInterval(() => {
      for (const n of document.querySelectorAll("[data-speaking]"))
        n.classList.toggle(
          "speaking",
          (this.voice.speaking.get(n.dataset.speaking) || 0) >
            performance.now(),
        );
    }, 150);
  }
  render() {
    const n = this.net,
      r = n.room;
    document
      .querySelectorAll("[data-room-panel],[data-voice]")
      .forEach((b) => (b.hidden = !r));
    if (!r) return;
    $("sit-out").textContent = n.me?.ready
      ? "Sit out until I’m ready"
      : "Ready to play";
    $("queue-status").textContent =
      n.me?.slot >= 0
        ? `You are Player ${n.me.slot + 1}${n.isHost ? " · Room host" : ""}`
        : `${n.me?.ready ? "Spectating · Waiting to play" : "Spectating · Sitting out"}${n.isHost ? " · Room host" : ""}`;
    $("rotation-mode").disabled = !n.isHost;
    $("rotation-mode").value = r.rotation;
    $("lineup-apply").hidden = !n.isHost;
    $("teams-apply").hidden = !n.isHost || !r.selecting;
    $("battle-mode-label").hidden = !n.isHost || !r.selecting;
    $("lineup-help").textContent = r.selecting
      ? "Choose up to four ready players. Apply changes before starting."
      : "Changes apply at the next character-selection screen.";
    const key = JSON.stringify([
      r.hostId,
      r.selecting,
      r.rotation,
      r.teams,
      r.nextLineup,
      r.members.map((p) => [
        p.id,
        p.name,
        p.slot,
        p.ready,
        p.connected,
        p.queue,
        p.team,
      ]),
    ]);
    if (key === this.rosterKey) return;
    this.rosterKey = key;
    $("battle-mode").value = r.teams ? "teams" : "ffa";
    const ordered = [...r.members].sort(
      (a, b) =>
        (a.slot < 0 ? 10 : a.slot) - (b.slot < 0 ? 10 : b.slot) ||
        a.queue - b.queue,
    );
    $("room-members").replaceChildren(
      ...ordered.map((p) => {
        const row = el("div", undefined, "member-row");
        const info = el("div");
        info.append(
          el("strong", `${p.name}${p.id === r.hostId ? " · HOST" : ""}`),
          el(
            "small",
            !p.connected
              ? "Disconnected"
              : p.slot >= 0
                ? `Player ${p.slot + 1}${!p.ready ? " · Sitting out next" : ""}`
                : p.ready
                  ? "Waiting to play"
                  : "Sitting out",
          ),
        );
        row.append(info);
        if (n.isHost) {
          const label = el("label", "Next round "),
            check = el("input");
          check.type = "checkbox";
          check.dataset.lineup = p.id;
          check.checked = r.nextLineup.includes(p.id);
          check.disabled = !p.ready || !p.connected;
          label.append(check);
          row.append(label);
          if (r.selecting && p.slot >= 0) {
            const select = el("select");
            select.dataset.team = p.id;
            select.setAttribute("aria-label", `${p.name} team`);
            for (const [i, name] of ["Red", "Blue", "Green"].entries()) {
              const option = new Option(name, String(i));
              select.append(option);
            }
            select.value = String(p.team || 0);
            row.append(select);
          }
        }
        return row;
      }),
    );
    const queue = r.members
      .filter((p) => p.slot < 0 && p.ready && p.connected)
      .sort((a, b) => a.queue - b.queue);
    $("waiting-queue").replaceChildren(
      ...queue.map((p, i) => {
        const row = el("div", undefined, "queue-row");
        row.append(el("span", `${i + 1}. ${p.name}`));
        if (n.isHost && i) {
          const b = el("button", "Move up");
          b.onclick = () => {
            const ids = queue.map((p) => p.id);
            [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
            n.send({ type: "manage", queue: ids });
          };
          row.append(b);
        }
        return row;
      }),
    );
    $("next-round").textContent =
      "Next round: " +
      (r.nextLineup
        .map((id) => r.members.find((p) => p.id === id)?.name)
        .join(", ") || "Waiting for ready players");
    $("next-round-banner").hidden = !r.results;
    $("next-round-banner").textContent = $("next-round").textContent;
  }
  renderVoice() {
    const n = this.net,
      r = n.room,
      v = this.voice;
    $("voice-join").hidden = !!v.stream;
    $("voice-join").disabled = v.joining || !r;
    $("voice-join").textContent = v.joining
      ? "Waiting for microphone permission…"
      : "Join Voice";
    $("voice-leave").hidden = !v.stream;
    $("voice-mute").hidden = !v.stream;
    const forced = n.me?.muted || (r?.muteSpectators && n.me?.slot < 0);
    $("voice-mute").disabled = !!forced;
    $("voice-mute").textContent = forced
      ? "Muted by host"
      : v.muted
        ? "Unmute microphone"
        : "Mute microphone";
    $("voice-status").textContent =
      v.error ||
      (v.stream
        ? "Voice connected · Microphone " + (v.blocked ? "muted" : "on")
        : "Your microphone stays off until you choose Join Voice.");
    $("voice-host-options").hidden = !n.isHost;
    $("mute-spectators").checked = !!r?.muteSpectators;
    const signature = JSON.stringify([
      r?.members,
      r?.muteSpectators,
      !!v.stream,
    ]);
    if (signature === this.voiceKey) return;
    this.voiceKey = signature;
    $("voice-members").replaceChildren(
      ...(r?.members || []).map((p) => {
        const row = el("div", undefined, "member-row");
        row.dataset.speaking = p.id;
        row.append(
          el("strong", p.name),
          el(
            "small",
            p.muted || (r.muteSpectators && p.slot < 0)
              ? "Muted by host"
              : p.voice
                ? "In voice"
                : "Voice off",
          ),
        );
        if (p.id !== n.id) {
          const label = el("label", "Volume "),
            range = el("input");
          range.type = "range";
          range.min = 0;
          range.max = 100;
          range.value = (v.levels.get(p.id) ?? 1) * 100;
          range.setAttribute("aria-label", `${p.name} voice volume`);
          range.oninput = () => {
            v.levels.set(p.id, Number(range.value) / 100);
            v.settings();
          };
          label.append(range);
          row.append(label);
        }
        if (n.isHost) {
          const b = el(
            "button",
            p.muted ? "Allow microphone" : "Mute for everyone",
          );
          b.onclick = () =>
            n.send({ type: "voice-moderate", id: p.id, muted: !p.muted });
          row.append(b);
        }
        return row;
      }),
    );
  }
}
