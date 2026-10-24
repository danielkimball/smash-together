export class AudioSettings {
  constructor(engine, voice) {
    this.engine = engine;
    this.voice = voice;
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem("smash.audio.v1")) || {};
    } catch {}
    const volume = (value, fallback) =>
      Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
    this.game = volume(saved.game, 0.55);
    voice.volume = volume(saved.voice, 1);
    this.autoLower = saved.autoLower !== false;
    engine.setVolume(this.game);
    voice.addEventListener("activity", () => this.tick());
    voice.addEventListener("change", () => this.tick());
  }
  save() {
    localStorage.setItem(
      "smash.audio.v1",
      JSON.stringify({
        game: this.game,
        voice: this.voice.volume,
        autoLower: this.autoLower,
      }),
    );
  }
  setGame(value) {
    this.game = Math.max(0, Math.min(1, value));
    this.engine.setVolume(this.game);
    this.save();
  }
  setVoice(value) {
    this.voice.volume = Math.max(0, Math.min(1, value));
    this.voice.settings();
    this.save();
  }
  tick(now = performance.now()) {
    const lower =
      this.autoLower &&
      this.voice.isListening &&
      this.voice.volume > 0 &&
      now < this.voice.activityUntil;
    if (lower !== this.lowered) {
      this.lowered = lower;
      this.engine.setVoiceGain(lower ? 0.28 : 1);
    }
    return lower;
  }
}
