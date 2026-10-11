import { error } from "../debug.js";

export class GmPanelSelectedTokens {
  #app;
  #hooks = [];
  #timer = null;
  #cleanup = null;
  #tearingDown = false;

  constructor(app) { this.#app = app; }

  collect() {
    if (this.#tearingDown || !globalThis.canvas?.ready || !canvas.scene) return [];
    const seen = new Set();
    return (canvas.tokens?.controlled ?? []).flatMap((token) => {
      const document = token.document;
      if (!document?.uuid || document.parent?.id !== canvas.scene.id
        || !canvas.scene.tokens.has(document.id) || seen.has(document.uuid)) return [];
      seen.add(document.uuid);
      return [{
        uuid: document.uuid, name: document.name ?? token.actor?.name ?? "",
        img: document.texture?.src || token.actor?.img || "icons/svg/mystery-man.svg",
      }];
    });
  }

  activate() {
    if (this.#hooks.length) return;
    this.#tearingDown = false;
    const on = (name, fn) => this.#hooks.push([name, Hooks.on(name, fn)]);
    on("controlToken", () => this.#scheduleRefresh());
    on("canvasTearDown", () => { this.#tearingDown = true; this.#scheduleRefresh(); });
    on("canvasReady", () => { this.#tearingDown = false; this.#scheduleRefresh(); });
    for (const name of ["updateToken", "deleteToken"]) {
      on(name, (token) => {
        if (token.parent?.id === canvas.scene?.id) this.#scheduleRefresh();
      });
    }
  }

  bind(element) {
    this.#cleanup?.();
    const click = (event) => {
      const button = event.target.closest('[data-action="pan-to-token"]');
      if (!button || !element.contains(button)) return;
      event.preventDefault();
      void this.panToToken(button.dataset.tokenUuid);
    };
    element.addEventListener("click", click);
    this.#cleanup = () => element.removeEventListener("click", click);
  }

  deactivate() {
    for (const [name, id] of this.#hooks.splice(0)) Hooks.off(name, id);
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#cleanup?.();
    this.#cleanup = null;
  }

  async panToToken(uuid) {
    if (!this.#hooks.length || !canvas.ready || !this.#app.rendered || typeof uuid !== "string" || !uuid.trim()) return;
    try {
      const token = await foundry.utils.fromUuid(uuid.trim());
      if (!this.#hooks.length || !canvas.ready) return;
      if (token?.parent?.id !== canvas.scene?.id || !token.object) {
        ui.notifications?.warn(game.i18n.localize("SIMONE_GM_PANEL.Notifications.TokenNotFound"));
        return;
      }
      await canvas.animatePan({ ...token.object.center, duration: 350 });
    } catch (cause) {
      error("Failed to pan to token", { uuid, error: cause });
    }
  }

  #scheduleRefresh() {
    if (!this.#app.rendered || this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (!this.#hooks.length || !this.#app.rendered) return;
      void this.#app.render({ parts: ["selectedTokens"] })
        .catch((cause) => error("Failed to refresh selected tokens", cause));
    }, 0);
  }
}
