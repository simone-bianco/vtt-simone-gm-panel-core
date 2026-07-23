import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadVmModule } from "./helpers/vm-loader.mjs";

const qaDir = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(qaDir, "..");
const modulesDir = resolve(coreRoot, "..");
const luckRoot = resolve(modulesDir, "simone-gm-panel-luck");
const soundsRoot = resolve(modulesDir, "simone-gm-panel-sounds");

const noOpDescriptorFunctions = {
  prepareContext() { return {}; },
  async activate() {},
  async deactivate() {},
  bind() { return () => {}; },
};

async function loadRegistry() {
  return loadVmModule(resolve(coreRoot, "scripts/feature-registry.js"));
}

async function loadActualLuckFeature(observations = {}) {
  const cleanups = observations.cleanups ?? [];
  return loadVmModule(resolve(luckRoot, "scripts/luck-feature.js"), {
    globals: {
      game: { i18n: { localize: (key) => key } },
      __configureLogger: (logger) => { observations.logger = logger; },
      __initialize: async () => { observations.initializeCalls = (observations.initializeCalls ?? 0) + 1; },
      __getState: () => ({ allies: {}, enemies: {} }),
      __attachLuck: (_element, addCleanup) => {
        addCleanup(() => cleanups.push("first"));
        addCleanup(() => cleanups.push("second"));
      },
      __buildViewModel: (state) => state,
    },
    stubs: {
      [resolve(luckRoot, "scripts/debug.js")]: "export const configureLogger = (logger) => globalThis.__configureLogger(logger);",
      [resolve(luckRoot, "scripts/initialization.js")]: "export const initializeLuckFeature = () => globalThis.__initialize();",
      [resolve(luckRoot, "scripts/settings.js")]: "export const getLuckControlState = () => globalThis.__getState();",
      [resolve(luckRoot, "scripts/ui/luck-listeners.js")]: "export const attachLuckControlListeners = (element, addCleanup) => globalThis.__attachLuck(element, addCleanup);",
      [resolve(luckRoot, "scripts/ui/gm-panel-luck-view-model.js")]: "export const buildLuckControlViewModel = (state, options) => globalThis.__buildViewModel(state, options);",
    },
  });
}

async function loadActualSoundsFeature(observations = {}) {
  class FakeElement {
    querySelector() { return null; }
    closest() { return null; }
  }
  class FakeInput extends FakeElement {}
  const timers = new Map();
  let timerId = 0;
  const addListener = (name) => (_element, _callbacks, addCleanup) => addCleanup(() => observations.cleanupOrder.push(name));
  const stubClass = (name) => `export class ${name} {\n  constructor(){ globalThis.__events.push(\"${name}:construct\"); }\n  activate(){ globalThis.__events.push(\"${name}:activate\"); }\n  deactivate(){ globalThis.__events.push(\"${name}:deactivate\"); }\n  async stopAllAudio(){ globalThis.__events.push(\"${name}:stopAllAudio\"); }\n  async stopAllGroupsAndWait(){ globalThis.__events.push(\"${name}:stopAllGroupsAndWait\"); }\n  async flushAutosave(){ globalThis.__events.push(\"${name}:flushAutosave\"); }\n  get selectedTokens(){ return []; }\n  get currentPlaylistKey(){ return \"x\"; }\n  get currentPlaylistName(){ return null; }\n  getRecentPlaylistEntries(){ return []; }\n  getGroupInstanceCount(){ return 0; }\n}`;

  observations.events ??= [];
  observations.cleanupOrder ??= [];
  observations.canvasDestroyCalls ??= 0;

  return loadVmModule(resolve(soundsRoot, "scripts/sounds-feature.js"), {
    globals: {
      game: { ready: false, i18n: { localize: (key) => key } },
      foundry: { applications: { api: { DialogV2: { confirm: async () => false } } } },
      HTMLElement: FakeElement,
      HTMLInputElement: FakeInput,
      document: { activeElement: null },
      setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
      __timers: timers,
      __events: observations.events,
      __initialize: async () => { observations.initializeCalls = (observations.initializeCalls ?? 0) + 1; },
      __configureLogger: () => {},
      __debug: () => {},
      __error: () => {},
      __getState: () => ({ items: [], groups: [], layout: [] }),
      __setState: async () => {},
      __listenerSearch: addListener("search"),
      __listenerDropzone: addListener("dropzone"),
      __listenerPan: addListener("pan"),
      __listenerActions: addListener("actions"),
      __listenerExpand: addListener("expand"),
      __listenerDrag: addListener("drag"),
      __attachCanvas: () => ({ destroy: () => { observations.canvasDestroyCalls += 1; } }),
    },
    stubs: {
      [resolve(soundsRoot, "scripts/debug.js")]: "export const configureLogger=(x)=>globalThis.__configureLogger(x); export const debug=(...x)=>globalThis.__debug(...x); export const error=(...x)=>globalThis.__error(...x);",
      [resolve(soundsRoot, "scripts/settings.js")]: "export const getPositionalEasing=()=>true; export const getPositionalElevation=()=>0; export const getPositionalRadius=()=>60; export const getPositionalVolume=()=>0.5; export const getPositionalWalls=()=>true; export const getSoundboardState=()=>globalThis.__getState(); export const setSoundboardState=(x)=>globalThis.__setState(x);",
      [resolve(soundsRoot, "scripts/initialization.js")]: "export const initializeSoundsFeature=()=>globalThis.__initialize();",
      [resolve(soundsRoot, "scripts/sounds-listeners.js")]: "export const attachDropzoneListeners=(...x)=>globalThis.__listenerDropzone(...x); export const attachSearchListener=(...x)=>globalThis.__listenerSearch(...x); export const attachTokenPanListener=(...x)=>globalThis.__listenerPan(...x);",
      [resolve(soundsRoot, "scripts/ui/gm-panel-app-callbacks.js")]: "export const buildSoundboardCallbacks=()=>({});",
      [resolve(soundsRoot, "scripts/ui/gm-panel-app-map-drop.js")]: "export const handleGroupMapDrop=()=>{}; export const handleItemMapDrop=()=>{};",
      [resolve(soundsRoot, "scripts/ui/gm-panel-audio-controller.js")]: stubClass("GmPanelAudioController"),
      [resolve(soundsRoot, "scripts/ui/gm-panel-soundboard-actions.js")]: "export const attachSoundboardActionListeners=(...x)=>globalThis.__listenerActions(...x);",
      [resolve(soundsRoot, "scripts/ui/gm-panel-soundboard-drag.js")]: "export const attachDragRowListeners=(...x)=>globalThis.__listenerDrag(...x); export const attachRowExpandListeners=(...x)=>globalThis.__listenerExpand(...x);",
      [resolve(soundsRoot, "scripts/ui/gm-panel-group-audio-controller.js")]: stubClass("GmPanelGroupAudioController"),
      [resolve(soundsRoot, "scripts/ui/gm-panel-map-drop.js")]: "export const attachCanvasDropListener=(...x)=>globalThis.__attachCanvas(...x);",
      [resolve(soundsRoot, "scripts/ui/gm-panel-soundboard-store.js")]: stubClass("GmPanelSoundboardStore"),
      [resolve(soundsRoot, "scripts/ui/gm-panel-token-controller.js")]: stubClass("GmPanelTokenController"),
    },
  });
}

function descriptor(overrides = {}) {
  return {
    apiVersion: 1,
    id: "feature",
    labelKey: "Label",
    icon: "icon",
    order: 0,
    template: "template.hbs",
    ...noOpDescriptorFunctions,
    ...overrides,
  };
}

test("registry validates descriptors, ordering, duplicates and freeze", async () => {
  const { namespace } = await loadRegistry();
  const registry = new namespace.FeatureRegistry();

  assert.throws(() => registry.registerFeature(null), /must be an object/);
  assert.throws(() => registry.registerFeature(descriptor({ apiVersion: 2 })), /apiVersion/);
  assert.throws(() => registry.registerFeature(descriptor({ bind: undefined })), /missing bind/);

  registry.registerFeature(descriptor({ id: "zeta", order: 10 }));
  registry.registerFeature(descriptor({ id: "alpha", order: 10 }));
  registry.registerFeature(descriptor({ id: "first", order: -1 }));
  assert.deepEqual(Array.from(registry.getFeatures(), (item) => item.id), ["first", "alpha", "zeta"]);
  assert.throws(() => registry.registerFeature(descriptor({ id: "zeta" })), /already registered/);
  assert.equal(registry.unregisterFeature("alpha"), true);
  registry.freeze();
  assert.throws(() => registry.registerFeature(descriptor({ id: "late" })), /frozen/);
  assert.throws(() => registry.unregisterFeature("zeta"), /hot-unloaded/);
});

test("actual package descriptors satisfy all four installation combinations", async () => {
  const { namespace: registryNs } = await loadRegistry();
  const { namespace: luckNs } = await loadActualLuckFeature();
  const { namespace: soundsNs } = await loadActualSoundsFeature();
  const luck = luckNs.luckFeature.descriptor();
  const sounds = soundsNs.soundsFeature.descriptor();

  assert.equal(luck.id, "luck");
  assert.equal(luck.order, 10);
  assert.equal(sounds.id, "soundboards");
  assert.equal(sounds.order, 20);

  for (const scenario of [
    { name: "core-only", features: [], expected: [] },
    { name: "core+luck", features: [luck], expected: ["luck"] },
    { name: "core+sounds", features: [sounds], expected: ["soundboards"] },
    { name: "core+luck+sounds", features: [sounds, luck], expected: ["luck", "soundboards"] },
  ]) {
    const registry = new registryNs.FeatureRegistry();
    for (const feature of scenario.features) registry.registerFeature(feature);
    assert.deepEqual(Array.from(registry.getFeatures(), (item) => item.id), scenario.expected, scenario.name);
  }
});

test("core app renders empty state and cleans bind/deactivate lifecycle deterministically", async () => {
  class FakeElement {
    constructor() { this.listeners = new Map(); this.hidden = false; this.classList = { toggle() {} }; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
    closest() { return null; }
    getBoundingClientRect() { return { top: 10, left: 20, width: 400, height: 300 }; }
  }
  const rootElement = new FakeElement();
  const headerElement = new FakeElement();
  const contentElement = new FakeElement();
  const frameElement = new FakeElement();
  const persisted = [];

  class ApplicationV2 {
    constructor() { this.element = rootElement; this.rendered = true; this.position = {}; }
    async _prepareContext() { return {}; }
    async _onRender() {}
    async _onClose() { return "closed"; }
    _getHeaderControls() { return [{ action: "close" }, { action: "other" }]; }
    bringToFront() {}
    async render() { this.renderCalls = (this.renderCalls ?? 0) + 1; return this; }
    setPosition(position) { this.position = position; return position; }
    getPosition() { return this.position; }
  }

  const settingsStub = resolve(coreRoot, "scripts/settings.js");
  const { namespace: appNs } = await loadVmModule(resolve(coreRoot, "scripts/ui/gm-panel-app.js"), {
    globals: {
      game: { user: { isGM: true }, i18n: { localize: (key) => key, format: (key) => key } },
      foundry: {
        applications: {
          api: { ApplicationV2, HandlebarsApplicationMixin: (Base) => class extends Base {} },
          handlebars: { renderTemplate: async (template) => `<${template}>` },
        },
        utils: { debounce: (fn) => fn },
      },
      HTMLElement: FakeElement,
      Element: FakeElement,
      __getState: () => ({ top: 10, left: 20, width: 400, height: 300, collapsed: false, activeFeatureId: null }),
      __setState: async (state) => { persisted.push(state); },
      __root: rootElement,
      __header: headerElement,
      __content: contentElement,
      __frame: frameElement,
    },
    stubs: {
      [resolve(coreRoot, "scripts/debug.js")]: "export const debug=()=>{}; export const warn=()=>{}; export const error=()=>{}; export const isDebugEnabled=()=>false;",
      [settingsStub]: "export const getPanelState=()=>globalThis.__getState(); export const setPanelState=(x)=>globalThis.__setState(x);",
      [resolve(coreRoot, "scripts/ui/gm-panel-position.js")]: "export const sanitizePosition=(x)=>x;",
      [resolve(coreRoot, "scripts/ui/gm-panel-app-dom.js")]: "export const getContentElement=()=>globalThis.__content; export const getFrameElement=()=>globalThis.__frame; export const getHeaderElement=()=>globalThis.__header;",
    },
  });
  const { namespace: registryNs } = await loadRegistry();

  const emptyRegistry = new registryNs.FeatureRegistry();
  const emptyApp = new appNs.SimoneGmPanelApp({ registry: emptyRegistry });
  const emptyContext = await emptyApp._prepareContext({});
  assert.equal(emptyContext.hasFeatures, false);
  assert.equal(emptyContext.activeFeatureId, null);
  assert.equal(emptyContext.featureHtml, "");

  const events = [];
  let bindGeneration = 0;
  const registry = new registryNs.FeatureRegistry();
  const makeFeature = (id, order) => descriptor({
    id,
    order,
    template: `${id}.hbs`,
    async activate(services) { events.push(`activate:${id}`); services.registerCleanup(() => events.push(`registered-cleanup:${id}`)); },
    async deactivate() { events.push(`deactivate:${id}`); },
    async prepareContext() { events.push(`context:${id}`); return { id }; },
    async bind() {
      const generation = ++bindGeneration;
      events.push(`bind:${id}:${generation}`);
      return async () => events.push(`bound-cleanup:${id}:${generation}`);
    },
  });
  registry.registerFeature(makeFeature("soundboards", 20));
  registry.registerFeature(makeFeature("luck", 10));
  const app = new appNs.SimoneGmPanelApp({ registry });

  const firstContext = await app._prepareContext({});
  assert.deepEqual(Array.from(firstContext.tabs, (tab) => tab.id), ["luck", "soundboards"]);
  assert.equal(firstContext.activeFeatureId, "luck");
  await app._onRender(firstContext, {});
  await app._prepareContext({});
  assert.ok(events.indexOf("bound-cleanup:luck:1") < events.lastIndexOf("context:luck"), "bound cleanup must happen before rerender context");
  await app._onRender(firstContext, {});
  await app._onClose({});

  assert.equal(events.filter((item) => item === "activate:luck").length, 1);
  assert.equal(events.filter((item) => item === "activate:soundboards").length, 1);
  assert.ok(events.indexOf("deactivate:soundboards") < events.indexOf("deactivate:luck"), "deactivate must be reverse order");
  assert.ok(events.includes("registered-cleanup:luck"));
  assert.ok(events.includes("registered-cleanup:soundboards"));
  assert.ok(persisted.length >= 1);
});

test("actual Luck and Sounds bind cleanups and Sounds restore timer are owned by features", async () => {
  const luckObs = { cleanups: [] };
  const { namespace: luckNs } = await loadActualLuckFeature(luckObs);
  const luckDescriptor = luckNs.luckFeature.descriptor();
  const luckCleanup = luckDescriptor.bind({}, { logger: {} });
  luckCleanup();
  assert.deepEqual(luckObs.cleanups, ["second", "first"]);

  const soundsObs = {};
  const { namespace: soundsNs, sandbox } = await loadActualSoundsFeature(soundsObs);
  const soundsDescriptor = soundsNs.soundsFeature.descriptor();
  await soundsDescriptor.activate({ logger: {}, requestRender() {} });
  assert.equal(soundsObs.initializeCalls, 1);
  assert.equal(sandbox.__timers.size, 1, "restore timer must be retained while active");
  const element = new sandbox.HTMLElement();
  const cleanup = soundsDescriptor.bind(element, { logger: {}, requestRender() {} });
  cleanup();
  assert.deepEqual(soundsObs.cleanupOrder, ["pan", "drag", "search", "dropzone", "expand", "actions"]);
  assert.equal(soundsObs.canvasDestroyCalls, 1);
  await soundsDescriptor.deactivate();
  assert.equal(sandbox.__timers.size, 0, "restore timer must be cancelled on deactivate");
  assert.ok(soundsObs.events.includes("GmPanelGroupAudioController:stopAllGroupsAndWait"));
  assert.ok(soundsObs.events.includes("GmPanelAudioController:stopAllAudio"));
});
