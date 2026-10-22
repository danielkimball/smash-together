// Footage of the native opening lets new visitors see it before selecting a
// cartridge. Gameplay always boots from their verified, browser-local ROM.
export class Attract {
  constructor({ start, hasDialog }) {
    this.start = start;
    this.hasDialog = hasDialog;
    this.phase = "opening";
    this.active = true;
    this.sound = false;
    this.lastPress = -Infinity;
    this.held = false;
    this.videos = Object.fromEntries(
      ["opening", "title", "how-to-play"].map((name) => [
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
      video.addEventListener("ended", () => {
        if (!this.active || name !== this.phase) return;
        this.show(
          name === "title" && !this.hasDialog() ? "how-to-play" : "title",
        );
      });
      video.addEventListener("error", () => {
        if (this.phase === name)
          document.getElementById("attract-fallback").hidden = false;
      });
      video.addEventListener("timeupdate", () => {
        if (
          name === "title" &&
          this.hasDialog() &&
          video.currentTime > video.duration - 0.25
        )
          video.currentTime = 4;
      });
    }
    this.soundButton.onclick = () => {
      this.setSound(!this.sound);
      if (this.active) this.play();
    };
    this.button.onclick = () => this.press();
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
      this.press();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) this.pause();
      else if (this.active) this.play();
    });
    new MutationObserver(() => {
      this.videos.title.loop = this.hasDialog();
    }).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["open"],
    });
  }
  setSound(enabled) {
    this.sound = enabled;
    for (const video of Object.values(this.videos)) video.muted = !enabled;
    this.soundButton.textContent = enabled ? "Sound on" : "Sound off";
    this.soundButton.setAttribute("aria-pressed", String(enabled));
    this.soundButton.setAttribute(
      "aria-label",
      `Turn opening sound ${enabled ? "off" : "on"}`,
    );
  }
  pause() {
    for (const video of Object.values(this.videos)) video.pause();
  }
  play() {
    const video = this.videos[this.phase];
    video.play().catch((error) => {
      // A gamepad press is not a browser audio-unlock gesture. Keep the
      // opening moving silently until a click/key can enable its sound.
      if (
        error.name !== "NotAllowedError" ||
        !this.active ||
        video !== this.videos[this.phase]
      )
        return;
      this.setSound(false);
      video.play().catch(() => {});
    });
  }
  setActive(active) {
    this.active = active;
    this.soundButton.hidden = !active;
    if (active) {
      const video = this.videos[this.phase];
      if (!video.getAttribute("src")) video.src = video.dataset.source;
      if (!document.hidden) this.play();
    } else {
      // Stop decoders AND media downloads before netplay starts.
      this.pause();
      for (const video of Object.values(this.videos)) {
        video.removeAttribute("src");
        video.load();
      }
    }
  }
  show(phase) {
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
    video.loop = phase === "title" && this.hasDialog();
    this.button.setAttribute(
      "aria-label",
      phase === "title"
        ? "Press Start — open your cartridge"
        : "Skip opening to title screen",
    );
    this.hint.textContent =
      phase === "title" ? "PRESS ANY BUTTON TO START" : "PRESS ANY BUTTON";
    if (this.active && !document.hidden) this.play();
  }
  holdTitle() {
    if (this.phase !== "title") this.show("title");
    const video = this.videos.title;
    // Skip the native logo entrance so the ROM modal sits over the fire.
    if (video.readyState && video.currentTime < 4) video.currentTime = 4;
    video.loop = true;
  }
  press() {
    if (
      !this.active ||
      this.hasDialog() ||
      performance.now() - this.lastPress < 350
    )
      return;
    this.lastPress = performance.now();
    this.setSound(true);
    if (this.phase !== "title") this.show("title");
    else this.start();
  }
  tick(pad) {
    const pressed = !!pad?.buttons.some((button) => button.pressed);
    if (pressed && !this.held && this.active && !this.hasDialog()) this.press();
    this.held = pressed;
  }
}
