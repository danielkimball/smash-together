// Only the opening has audio. The title is a separate, silent fire loop;
// live menus and gameplay always come from the verified browser-local ROM.
export class Attract {
  constructor({ start, hasDialog }) {
    this.start = start;
    this.hasDialog = hasDialog;
    this.phase = "opening";
    this.active = true;
    this.sound = true;
    this.audioBlocked = false;
    this.lastPress = -Infinity;
    this.held = false;
    this.videos = Object.fromEntries(
      ["opening", "title"].map((name) => [
        name,
        document.getElementById("attract-" + name),
      ]),
    );
    this.button = document.getElementById("power-on");
    this.soundButton = document.getElementById("attract-sound");
    this.hint = document.getElementById("attract-hint");
    for (const [name, video] of Object.entries(this.videos)) {
      video.dataset.source = video.getAttribute("src");
      video.volume = 0.55;
      video.loop = name === "title";
      video.addEventListener("ended", () => {
        if (this.active && name === "opening") this.show("title");
      });
      video.addEventListener("error", () => {
        if (this.active && this.phase === name)
          document.getElementById("attract-fallback").hidden = false;
      });
    }
    this.soundButton.onclick = () => {
      this.audioBlocked = false;
      this.setSound(!this.sound);
      if (this.active) this.play();
    };
    this.button.onclick = () => this.press("pointer");
    document.addEventListener("keydown", (event) => {
      if (
        !this.active ||
        this.hasDialog() ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        [
          "Tab",
          "Escape",
          "Shift",
          "Control",
          "Alt",
          "Meta",
          "CapsLock",
        ].includes(event.key)
      )
        return;
      if (
        event.target.closest("input,select,textarea,button,a,summary") &&
        !this.button.contains(event.target)
      )
        return;
      event.preventDefault();
      this.press("keyboard");
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.pause();
      else if (this.active) this.play();
    });
    this.setSound(true);
    this.play();
  }
  updateHint() {
    this.hint.textContent =
      this.phase === "title"
        ? "PRESS ANY BUTTON TO START"
        : this.audioBlocked
          ? "PLAY INTRO WITH SOUND"
          : "PRESS ANY BUTTON TO SKIP";
    this.button.setAttribute("aria-label", this.hint.textContent);
    this.soundButton.hidden = !this.active || this.phase !== "opening";
  }
  setSound(enabled) {
    this.sound = enabled;
    this.videos.opening.muted = !enabled;
    this.videos.title.muted = true;
    this.soundButton.textContent = enabled ? "Sound on" : "Sound off";
    this.soundButton.setAttribute("aria-pressed", String(enabled));
    this.soundButton.setAttribute(
      "aria-label",
      `Turn opening sound ${enabled ? "off" : "on"}`,
    );
    this.updateHint();
  }
  pause() {
    for (const video of Object.values(this.videos)) video.pause();
  }
  play() {
    const video = this.videos[this.phase];
    video.play().catch((error) => {
      if (
        error.name !== "NotAllowedError" ||
        !this.active ||
        video !== this.videos[this.phase]
      )
        return;
      this.audioBlocked = this.phase === "opening";
      this.setSound(false);
      video.play().catch(() => {});
    });
  }
  setActive(active) {
    this.active = active;
    this.updateHint();
    if (active) {
      const video = this.videos[this.phase];
      if (!video.getAttribute("src")) video.src = video.dataset.source;
      if (!document.hidden) this.play();
    } else {
      this.pause();
      for (const video of Object.values(this.videos)) {
        video.removeAttribute("src");
        video.load();
      }
    }
  }
  show(phase) {
    if (!this.videos[phase]) return;
    this.pause();
    this.phase = phase;
    document.body.dataset.attract = phase;
    document.getElementById("attract-fallback").hidden =
      !this.videos[phase].error;
    for (const [name, video] of Object.entries(this.videos))
      video.hidden = name !== phase;
    const video = this.videos[phase];
    if (!video.getAttribute("src")) video.src = video.dataset.source;
    video.currentTime = 0;
    this.updateHint();
    if (this.active && !document.hidden) this.play();
  }
  holdTitle() {
    if (this.phase !== "title") this.show("title");
    if (this.active) this.play();
  }
  press(source = "pointer") {
    if (
      !this.active ||
      this.hasDialog() ||
      performance.now() - this.lastPress < 350
    )
      return;
    this.lastPress = performance.now();
    if (
      this.phase === "opening" &&
      this.audioBlocked &&
      source !== "controller"
    ) {
      this.audioBlocked = false;
      this.setSound(true);
      this.videos.opening.currentTime = 0;
      this.play();
      return;
    }
    if (this.phase !== "title") this.show("title");
    else this.start();
  }
  tick(pad) {
    const pressed = !!pad?.buttons.some((button) => button.pressed);
    if (pressed && !this.held && this.active && !this.hasDialog())
      this.press("controller");
    this.held = pressed;
  }
}
