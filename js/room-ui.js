import { RoomVoice } from "./voice.js";
import { AudioSettings } from "./audio-settings.js";
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};
export class RoomUI {
  constructor(net, engine, open, toast) {
    this.net = net;
    this.voice = new RoomVoice(net);
    this.audio = new AudioSettings(engine, this.voice);
    this.open = open;
    this.toast = toast;
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
          this.voice.listen();
          open("voice-dialog");
        }),
    );
    $("rotation-mode").onchange = () =>
      net.send({ type: "manage", rotation: $("rotation-mode").value });
    $("voice-join").onclick = () => this.voice.join();
    $("voice-enable").onclick = () => this.voice.listen();
    $("voice-listen").onclick = () => {
      const unmute = this.voice.deafened || this.voice.volume === 0;
      if (unmute && this.voice.volume === 0) this.audio.setVoice(1);
      this.voice.muteAll(!unmute);
    };
    $("voice-mute").onclick = () => {
      this.voice.muted = !this.voice.muted;
      this.voice.settings();
    };
    $("voice-volume").oninput = (e) => {
      this.audio.setVoice(Number(e.target.value) / 100);
      this.renderVoice();
    };
    $("volume").oninput = (e) => {
      this.audio.setGame(Number(e.target.value) / 100);
      this.renderVoice();
    };
    $("voice-duck").onchange = (e) => {
      this.audio.autoLower = e.target.checked;
      this.audio.save();
      this.audio.tick();
      this.renderVoice();
    };
    $("mute-spectators").onchange = (e) =>
      net.send({ type: "voice-moderate", spectators: e.target.checked });
    net.addEventListener("change", () => {
      this.render();
      this.renderVoice();
    });
    this.voice.addEventListener("change", () => this.renderVoice());
    setInterval(() => {
      const lowered = this.audio.tick();
      $("game-volume-status").textContent = lowered
        ? "Lowered while someone speaks"
        : "Your chosen game volume";
      const talking = [...this.voice.speaking].some(
        ([, until]) => until > performance.now(),
      );
      document.querySelectorAll("[data-voice]").forEach((button) => {
        button.classList.toggle("speaking", talking);
        button.textContent = this.net.room
          ? this.voice.deafened || !this.voice.volume
            ? "Audio · Voice muted"
            : !this.voice.isListening
              ? "Audio · Enable sound"
              : talking
                ? "Audio · Talking"
                : "Audio & Voice"
          : "Audio & Voice";
      });
      for (const n of document.querySelectorAll("[data-speaking]"))
        n.classList.toggle(
          "speaking",
          (this.voice.speaking.get(n.dataset.speaking) || 0) >
            performance.now(),
        );
    }, 150);
    this.renderVoice();
  }
  render() {
    const n = this.net,
      r = n.room;
    document
      .querySelectorAll("[data-room-panel]")
      .forEach((b) => (b.hidden = !r));
    if (!r) return;
    document
      .querySelectorAll("[data-voice]")
      .forEach((b) => (b.hidden = false));
    $("queue-status").textContent =
      n.me?.slot >= 0
        ? `You are Player ${n.me.slot + 1}${n.isHost ? " · Server host" : ""}`
        : `${n.me?.ready ? "Waiting to play" : "Sitting out"}${n.isHost ? " · Server host" : ""}`;
    $("rotation-mode").disabled = !n.isHost;
    $("rotation-mode").value = r.rotation;
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
        p.muted,
      ]),
    ]);
    if (key === this.rosterKey) return;
    this.rosterKey = key;
    const ordered = r.members
      .filter((p) => p.connected)
      .sort(
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
        row.dataset.member = p.id;
        row.append(info, this.playerActions(p));
        const owned = (p.ownerId || p.id) === n.id;
        const availability = el(
          "button",
          p.ready ? "Sit out next round" : "Ready to play",
          "member-availability",
        );
        availability.disabled = !n.isHost && !owned;
        availability.setAttribute(
          "aria-label",
          `${p.ready ? "Sit out" : "Ready"}: ${p.name}`,
        );
        availability.onclick = () =>
          n.send({ type: "availability", id: p.id, ready: !p.ready });
        row.append(availability);
        if (n.isHost) {
          const label = el("label", "Next round "),
            check = el("input");
          check.type = "checkbox";
          check.dataset.lineup = p.id;
          check.checked = r.nextLineup.includes(p.id);
          check.disabled = !p.ready;
          check.setAttribute("aria-label", `${p.name} next round`);
          check.onchange = () => {
            const lineup = [
              ...$("room-members").querySelectorAll("[data-lineup]:checked"),
            ].map((n) => n.dataset.lineup);
            if (lineup.length > 4) {
              check.checked = false;
              return this.toast(
                "Choose up to four players for the next round.",
              );
            }
            n.send({ type: "manage", lineup });
          };
          label.append(check);
          row.append(label);
          if (p.id !== r.hostId) {
            const family = r.members.filter((m) => m.ownerId === p.id);
            const kick = el(
              "button",
              owned ? "Remove" : family.length > 1 ? "Kick device" : "Kick",
              "member-kick",
            );
            kick.title =
              family.length > 1
                ? `Remove ${family.map((m) => m.name).join(" and ")} from this server`
                : `${owned ? "Remove" : "Kick"} ${p.name}`;
            kick.setAttribute("aria-label", kick.title);
            kick.onclick = () =>
              owned
                ? this.removeLocal?.(p)
                : n.send({ type: "kick", id: p.id });
            row.append(kick);
          }
        } else if (owned && p.id !== n.id) {
          const remove = el("button", "Remove", "member-kick");
          remove.onclick = () => this.removeLocal?.(p);
          row.append(remove);
        }
        if (n.isHost && !owned) {
          const owner = r.members.find((m) => m.id === (p.ownerId || p.id));
          const mute = el(
            "button",
            owner?.muted ? "Allow mic" : "Mute for everyone",
            "member-host-mute",
          );
          mute.onclick = () =>
            n.send({
              type: "voice-moderate",
              id: owner.id,
              muted: !owner.muted,
            });
          row.append(mute);
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
  playerActions(player) {
    const actions = el("span", undefined, "player-actions");
    const owner = player.ownerId || player.id;
    const mic = el("button", undefined, "player-mic");
    mic.type = "button";
    mic.dataset.playerMic = owner;
    mic.dataset.playerName = player.name;
    mic.dataset.speaking = owner;
    mic.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3M9 21h6"/><path class="mic-slash" d="M3 3l18 18"/></svg>';
    mic.onclick = () => {
      if (owner === this.net.id) {
        if (!this.voice.stream) this.voice.join();
        else if (!this.voice.forced) {
          this.voice.muted = !this.voice.muted;
          this.voice.settings();
        }
      } else
        this.voice.setLevel(
          owner,
          (this.voice.levels.get(owner) ?? 1) > 0 ? 0 : 1,
        );
      this.renderVoice();
    };
    this.updateMic(mic);
    actions.append(mic);
    if (owner === this.net.id) {
      const edit = el("button", "✎", "player-edit");
      edit.type = "button";
      edit.title = `Change ${player.name}'s name`;
      edit.setAttribute("aria-label", edit.title);
      edit.onclick = () => this.renamePlayer?.(player);
      actions.append(edit);
    }
    return actions;
  }
  updateMic(button) {
    const id = button.dataset.playerMic,
      v = this.voice;
    const own = id === this.net.id;
    const muted = own ? !v.stream || v.blocked : (v.levels.get(id) ?? 1) <= 0;
    const member = this.net.room?.members.find((p) => p.id === id);
    const label = own
      ? !v.stream
        ? "Turn microphone on"
        : v.forced
          ? "Muted by host"
          : v.muted
            ? "Unmute microphone"
            : "Mute microphone"
      : `${muted ? "Unmute" : "Mute"} ${button.dataset.playerName} for me`;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.setAttribute("aria-pressed", String(muted));
    button.classList.toggle(
      "muted",
      muted || !!member?.muted || !member?.voice,
    );
    button.disabled = own && !!v.forced;
  }
  renderVoice() {
    document
      .querySelectorAll("[data-player-mic]")
      .forEach((button) => this.updateMic(button));
    const n = this.net,
      r = n.room,
      v = this.voice;
    $("voice-join").hidden = !!v.stream;
    $("voice-join").disabled = v.joining || !r;
    $("voice-join").textContent = v.joining
      ? "Waiting for microphone permission…"
      : "Turn microphone on";
    $("voice-mute").hidden = !v.stream;
    const forced = v.forced;
    $("voice-mute").disabled = !!forced;
    $("voice-mute").textContent = forced
      ? "Muted by host"
      : v.muted
        ? "Microphone muted · Unmute"
        : "Microphone on · Mute";
    $("voice-mute").setAttribute("aria-pressed", String(!v.blocked));
    $("voice-enable").hidden =
      !r || !!v.audioError || !v.ctx || v.ctx.state === "running";
    $("voice-listen").disabled = !r;
    $("voice-listen").textContent =
      v.deafened || !v.volume ? "Unmute all voices" : "Mute all voices";
    $("voice-listen").setAttribute(
      "aria-pressed",
      String(v.deafened || !v.volume),
    );
    $("voice-status").textContent =
      v.audioError ||
      v.error ||
      (!r
        ? "Join a room to hear and talk with friends."
        : `${v.deafened ? "You muted voice playback" : !v.volume ? "Voice volume is at 0%" : v.isListening ? "Listening to the room" : "Enable sound to hear the room"} · ${v.stream ? (v.blocked ? "Microphone muted" : "Microphone on") : "Microphone off"}.`);
    if (r && v.ctx?.state === "suspended" && this.soundPrompt !== r.id) {
      this.soundPrompt = r.id;
      this.toast(
        "Click Audio → Enable sound to hear the room. Your microphone stays off.",
      );
    }
    $("volume").value = Math.round(this.audio.game * 100);
    $("game-volume-value").value = `${Math.round(this.audio.game * 100)}%`;
    $("voice-volume").value = Math.round(v.volume * 100);
    $("voice-volume-value").value = `${Math.round(v.volume * 100)}%`;
    $("voice-duck").checked = this.audio.autoLower;
    $("voice-host-options").hidden = !n.isHost;
    $("mute-spectators").checked = !!r?.muteSpectators;
    for (const button of document.querySelectorAll("[data-voice-mute]")) {
      const muted = (v.levels.get(button.dataset.voiceMute) ?? 1) <= 0;
      button.textContent = muted ? "Unmute for me" : "Mute for me";
      button.setAttribute("aria-pressed", String(muted));
    }
    for (const range of document.querySelectorAll("[data-voice-level]"))
      range.value = (v.levels.get(range.dataset.voiceLevel) ?? 1) * 100;
    const signature = JSON.stringify([
      r?.members,
      r?.muteSpectators,
      !!v.stream,
    ]);
    if (signature === this.voiceKey) return;
    this.voiceKey = signature;
    $("voice-members").replaceChildren(
      ...(n.devices || [])
        .filter((p) => p.connected)
        .map((p) => {
          const row = el("div", undefined, "member-row");
          row.dataset.speaking = p.id;
          row.append(
            el(
              "strong",
              r.members
                .filter((m) => (m.ownerId || m.id) === p.id && m.connected)
                .map((m) => m.name)
                .join(" + "),
            ),
            el(
              "small",
              p.muted ||
                (r.muteSpectators &&
                  !r.members.some(
                    (m) => (m.ownerId || m.id) === p.id && m.slot >= 0,
                  ))
                ? "Muted by host"
                : p.voice
                  ? "Microphone on"
                  : p.listening
                    ? "Listening · Mic off"
                    : "Voice playback off",
            ),
          );
          if (p.id !== n.id) {
            const label = el("label", "Volume "),
              range = el("input");
            range.type = "range";
            range.min = 0;
            range.max = 100;
            range.value = (v.levels.get(p.id) ?? 1) * 100;
            range.dataset.voiceLevel = p.id;
            range.setAttribute("aria-label", `${p.name} voice volume`);
            range.oninput = () => {
              v.setLevel(p.id, Number(range.value) / 100);
            };
            label.append(range);
            row.append(label);
            const mute = el(
              "button",
              (v.levels.get(p.id) ?? 1) > 0 ? "Mute for me" : "Unmute for me",
            );
            mute.dataset.voiceMute = p.id;
            mute.setAttribute(
              "aria-pressed",
              String((v.levels.get(p.id) ?? 1) === 0),
            );
            mute.onclick = () =>
              v.setLevel(p.id, (v.levels.get(p.id) ?? 1) > 0 ? 0 : 1);
            row.append(mute);
          }
          if (n.isHost) {
            const b = el(
              "button",
              p.muted ? "Host: allow mic" : "Host: mute mic",
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
