import {
  HEADER_COLLAPSED_HEIGHT,
  MODULE_ID,
  MODULE_TITLE_KEY,
} from "../constants.js";
import { debug, error, isDebugEnabled, warn } from "../debug.js";
import { getPanelState, setPanelState } from "../settings.js";
import { sanitizePosition } from "./gm-panel-position.js";
import { getContentElement, getFrameElement, getHeaderElement } from "./gm-panel-app-dom.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const renderTemplate = foundry.applications.handlebars.renderTemplate;

export class SimoneGmPanelApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static get DEFAULT_OPTIONS() {
    return {
      id: MODULE_ID,
      classes: ["simone-gm-panel-app"],
      window: {
        frame: true,
        title: MODULE_TITLE_KEY,
        icon: "fa-solid fa-user-shield",
        minimizable: false,
        positioned: true,
        resizable: true,
        contentClasses: ["sgmp-window-content"],
      },
      position: sanitizePosition(getPanelState()),
    };
  }

  static PARTS = {
    navigation: {
      template: "modules/simone-gm-panel/templates/tab-navigation.hbs",
    },
    content: {
      template: "modules/simone-gm-panel/templates/feature-content.hbs",
      scrollable: [""],
    },
    footer: {
      template: "modules/simone-gm-panel/templates/feature-footer.hbs",
    },
  };

  #registry;
  #activeFeatureId = null;
  #collapsed = false;
  #activatedFeatureIds = new Set();
  #featureCleanups = new Map();
  #boundFeatureCleanup = null;
  #navigationCleanup = null;
  #headerCleanup = null;
  #persistStateDebounced = foundry.utils.debounce(() => void this.#persistState(), 250);

  constructor({ registry, ...options } = {}) {
    super(options);
    if (!registry) throw new Error("Simone GM Panel requires a feature registry");
    this.#registry = registry;
    const state = getPanelState();
    this.#activeFeatureId = state.activeFeatureId;
    this.#collapsed = state.collapsed === true;
  }

  get title() {
    return game.i18n.localize(MODULE_TITLE_KEY);
  }

  _getHeaderControls() {
    return super._getHeaderControls().filter((control) => !["close", "minimize"].includes(control.action));
  }

  async _prepareContext(options) {
    await this.#cleanupBoundFeature();
    this.#registry.freeze();
    this.#normalizeActiveFeature();
    await this.#activateFeatures();

    const context = await super._prepareContext(options);
    const features = this.#registry.getFeatures();
    const active = this.#registry.getFeature(this.#activeFeatureId);

    context.tabs = features.map((feature) => ({
      id: feature.id,
      label: feature.labelKey,
      icon: feature.icon,
      active: feature.id === this.#activeFeatureId,
    }));
    context.activeFeatureId = this.#activeFeatureId;
    context.hasFeatures = features.length > 0;
    context.emptyState = game.i18n.localize("SIMONE_GM_PANEL.EmptyState");
    context.featureHtml = "";
    context.footerHtml = "";

    if (active) {
      const featureContext = await active.prepareContext(this.#createHostContext());
      const normalizedContext = featureContext && typeof featureContext === "object"
        ? { ...featureContext }
        : {};
      normalizedContext.tab = {
        id: active.id,
        group: "primary",
        active: true,
        cssClass: "active",
        label: active.labelKey,
      };
      context.featureHtml = await renderTemplate(active.template, normalizedContext);
      if (active.footerTemplate) {
        context.footerHtml = await renderTemplate(active.footerTemplate, normalizedContext);
      }
    }

    context.isCollapsed = this.#collapsed;
    return context;
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#detachCoreListeners();
    this.#attachCoreListeners();
    this.#applyCollapsedState();

    const active = this.#registry.getFeature(this.#activeFeatureId);
    if (active && this.element instanceof HTMLElement) {
      const cleanup = await active.bind(this.element, this.#createHostServices(active.id));
      if (typeof cleanup === "function") this.#boundFeatureCleanup = cleanup;
    }

    this.bringToFront();
    debug("Panel rendered", { activeFeatureId: this.#activeFeatureId, collapsed: this.#collapsed });
  }

  async _onClose(options) {
    await this.#cleanupBoundFeature();
    this.#detachCoreListeners();

    const features = this.#registry.getFeatures().slice().reverse();
    for (const feature of features) {
      if (!this.#activatedFeatureIds.has(feature.id)) continue;
      try {
        await feature.deactivate();
      } catch (cause) {
        error(`Feature deactivate failed: ${feature.id}`, cause);
      }
      await this.#runFeatureCleanups(feature.id);
    }
    this.#activatedFeatureIds.clear();

    await this.#persistState();
    return super._onClose(options);
  }

  setPosition(position) {
    const next = super.setPosition(position);
    this.#persistStateDebounced();
    return next;
  }

  async selectFeature(featureId) {
    const normalized = typeof featureId === "string" ? featureId.trim() : "";
    if (!normalized || !this.#registry.getFeature(normalized)) {
      throw new Error(`Unknown GM Panel feature: ${String(featureId)}`);
    }
    if (normalized === this.#activeFeatureId) return this;
    this.#activeFeatureId = normalized;
    await this.#persistState();
    await this.render({ force: true });
    return this;
  }

  async toggleCollapsed() {
    this.#collapsed = !this.#collapsed;
    this.#applyCollapsedState();
    await this.#persistState();
  }

  #normalizeActiveFeature() {
    const features = this.#registry.getFeatures();
    if (this.#activeFeatureId && features.some((feature) => feature.id === this.#activeFeatureId)) return;
    this.#activeFeatureId = features[0]?.id ?? null;
  }

  async #activateFeatures() {
    for (const feature of this.#registry.getFeatures()) {
      if (this.#activatedFeatureIds.has(feature.id)) continue;
      await feature.activate(this.#createHostServices(feature.id));
      this.#activatedFeatureIds.add(feature.id);
    }
  }

  #createHostContext() {
    return {
      isGM: game.user?.isGM === true,
      activeFeatureId: this.#activeFeatureId,
      i18n: {
        localize: (key) => game.i18n.localize(key),
        format: (key, data) => game.i18n.format(key, data),
      },
      logger: this.#loggerFacade(),
    };
  }

  #createHostServices(featureId) {
    const services = {
      requestRender: () => this.render({ force: true }),
      registerCleanup: (cleanup) => {
        if (typeof cleanup !== "function") return;
        const list = this.#featureCleanups.get(featureId) ?? [];
        list.push(cleanup);
        this.#featureCleanups.set(featureId, list);
      },
      isGM: game.user?.isGM === true,
      i18n: this.#createHostContext().i18n,
      logger: this.#loggerFacade(),
    };
    Object.defineProperty(services, "activeFeatureId", {
      enumerable: true,
      get: () => this.#activeFeatureId,
    });
    return Object.freeze(services);
  }

  #loggerFacade() {
    return Object.freeze({ debug, warn, error, isDebugEnabled });
  }

  #attachCoreListeners() {
    const element = this.element;
    if (!(element instanceof HTMLElement)) return;

    const onNavigationClick = (event) => {
      const target = event.target instanceof Element ? event.target.closest("[data-feature-id]") : null;
      if (!(target instanceof HTMLElement)) return;
      event.preventDefault();
      void this.selectFeature(target.dataset.featureId);
    };
    element.addEventListener("click", onNavigationClick);
    this.#navigationCleanup = () => element.removeEventListener("click", onNavigationClick);

    const header = getHeaderElement(this);
    if (header instanceof HTMLElement) {
      header.title = game.i18n.localize("SIMONE_GM_PANEL.Header.CollapseHint");
      const onHeaderDoubleClick = (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.closest("button, a, input, select, textarea, [data-action]")) return;
        void this.toggleCollapsed();
      };
      header.addEventListener("dblclick", onHeaderDoubleClick);
      this.#headerCleanup = () => header.removeEventListener("dblclick", onHeaderDoubleClick);
    }
  }

  #detachCoreListeners() {
    this.#navigationCleanup?.();
    this.#headerCleanup?.();
    this.#navigationCleanup = null;
    this.#headerCleanup = null;
  }

  async #cleanupBoundFeature() {
    const cleanup = this.#boundFeatureCleanup;
    this.#boundFeatureCleanup = null;
    if (typeof cleanup === "function") await cleanup();
  }

  async #runFeatureCleanups(featureId) {
    const cleanups = this.#featureCleanups.get(featureId) ?? [];
    this.#featureCleanups.delete(featureId);
    for (const cleanup of cleanups.reverse()) await cleanup();
  }

  #applyCollapsedState() {
    const frame = getFrameElement(this);
    const content = getContentElement(this);
    if (!(frame instanceof HTMLElement) || !(content instanceof HTMLElement)) return;

    frame.classList.toggle("sgmp-collapsed", this.#collapsed);
    content.hidden = this.#collapsed;
    if (this.#collapsed) {
      const current = this.getPosition() ?? getPanelState();
      super.setPosition({
        left: current.left,
        top: current.top,
        width: current.width,
        height: HEADER_COLLAPSED_HEIGHT,
      });
      return;
    }

    super.setPosition(sanitizePosition(getPanelState()));
  }

  getPosition() {
    const frame = getFrameElement(this);
    if (!(frame instanceof HTMLElement)) return null;
    const rect = frame.getBoundingClientRect();
    return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  }

  async #persistState() {
    const position = this.getPosition();
    if (!position) return;
    const previous = getPanelState();
    await setPanelState({
      top: position.top,
      left: position.left,
      width: position.width,
      height: this.#collapsed ? previous.height : position.height,
      collapsed: this.#collapsed,
      activeFeatureId: this.#activeFeatureId,
    });
  }
}
