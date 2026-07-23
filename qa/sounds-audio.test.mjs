import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadVmModule } from "./helpers/vm-loader.mjs";

const qaDir = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(qaDir, "..");
const modulesDir = resolve(coreRoot, "..");
const soundsRoot = resolve(modulesDir, "simone-gm-panel-sounds");
const MODULE_ID = "simone-gm-panel-sounds";

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitUntil(predicate, message, iterations = 200) {
  for (let index = 0; index < iterations; index += 1) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.fail(message);
}

class SoundCollection {
  #documents = new Map();
  get(id) { return this.#documents.get(id); }
  set(doc) { this.#documents.set(doc.id, doc); return doc; }
  delete(id) { this.#documents.delete(id); }
  filter(callback) { return [...this.#documents.values()].filter(callback); }
  values() { return [...this.#documents.values()]; }
  get size() { return this.#documents.size; }
}

function createAmbientDocument({ id, flags, collection, deleteBehavior, updateBehavior } = {}) {
  const calls = { delete: 0, update: 0 };
  const document = {
    id,
    path: "audio.ogg",
    repeat: false,
    flags: structuredClone(flags ?? {}),
    calls,
    getFlag(moduleId, key) { return this.flags?.[moduleId]?.[key]; },
    async delete() {
      calls.delete += 1;
      await deleteBehavior?.(this);
      collection?.delete(this.id);
      return this;
    },
    async update(change) {
      calls.update += 1;
      await updateBehavior?.(change, this);
      Object.assign(this, change);
      return this;
    },
  };
  collection?.set(document);
  return document;
}

function ownedGroupFlags(instanceId = 1) {
  return {
    [MODULE_ID]: {
      instanceType: "soundboard-group-positional",
      groupId: "group-1",
      groupSessionId: instanceId,
      tokenUuid: "Token.token-1",
      soundUuid: "Playlist.p.Sound.s",
    },
  };
}

function ownedPositionalFlags({ soundUuid = "Playlist.p.Sound.s", tokenUuid = "Token.token-1" } = {}) {
  return { [MODULE_ID]: { instanceType: "soundboard-positional", soundUuid, tokenUuid } };
}

async function createGroupHarness({ createDocument } = {}) {
  const collection = new SoundCollection();
  const timers = new Map();
  let timerId = 0;
  let createCalls = 0;
  const warnings = [];
  const token = { uuid: "Token.token-1", name: "QA Token", elevation: 0, document: true };
  const state = {
    items: [{ id: "item-1", uuid: "Playlist.p.Sound.s", positional: {} }],
    groups: [{
      id: "group-1",
      itemIds: ["item-1"],
      mode: "sequential",
      avoidImmediateRepeat: true,
      repeat: true,
      offsetMin: 1000,
      offsetMax: 1000,
      perTokenDesync: false,
      volumeMode: "item",
      positional: {},
    }],
    layout: [],
  };
  const app = {
    selectedTokens: [token],
    renderCalls: 0,
    async resolvePlaylistSoundByUuid(uuid) {
      return uuid === "Playlist.p.Sound.s" ? { uuid, path: "audio.ogg", name: "QA Sound", volume: 0.5 } : null;
    },
    render() { this.renderCalls += 1; },
  };
  const scene = {
    sounds: collection,
    async createEmbeddedDocuments(documentName, data) {
      assert.equal(documentName, "AmbientSound");
      createCalls += 1;
      if (createDocument) return createDocument({ data, collection, createCalls });
      return [createAmbientDocument({ id: `ambient-${createCalls}`, flags: data[0].flags, collection })];
    },
  };

  class FakeSound {
    constructor() { this.duration = 0.01; this.playing = false; }
    async load() { return this; }
    destroy() {}
    stop() { this.playing = false; }
    async playAtPosition() { this.playing = true; }
  }

  const loaded = await loadVmModule(resolve(soundsRoot, "scripts/ui/gm-panel-group-audio-controller.js"), {
    globals: {
      game: {
        audio: { environment: {} },
        i18n: { localize: (key) => key },
      },
      canvas: { ready: true, scene },
      foundry: {
        utils: { fromUuid: async (uuid) => uuid === token.uuid ? token : null },
        audio: {
          Sound: FakeSound,
          AudioHelper: { play: async () => ({ playing: true, stop() { this.playing = false; } }) },
        },
      },
      setTimeout(callback, delay) {
        const id = ++timerId;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
      __state: state,
      __warn: (...args) => warnings.push(args),
    },
    stubs: {
      [resolve(soundsRoot, "scripts/debug.js")]: "export const debug=()=>{}; export const warn=(...x)=>globalThis.__warn(...x);",
      [resolve(soundsRoot, "scripts/settings.js")]: "export const getSoundboardState=()=>globalThis.__state;",
      [resolve(soundsRoot, "scripts/ui/gm-panel-audio-token-utils.js")]: "export const getTokenDocumentCenter=()=>({x:100,y:200});",
      [resolve(soundsRoot, "scripts/ui/gm-panel-group-scheduler.js")]: "export const chooseNextGroupItem=(instance)=>instance.resolvedItems[0]??null; export const computeGroupDelay=()=>1000;",
    },
  });

  const controller = new loaded.namespace.GmPanelGroupAudioController(app, {
    getPositionalDefaults: () => ({ radius: 60, volume: 0.5, walls: true, easing: true, elevation: 0 }),
  });
  return {
    ...loaded,
    app,
    collection,
    controller,
    scene,
    state,
    timers,
    token,
    warnings,
    get createCalls() { return createCalls; },
  };
}

test("group stop waits for AmbientSound creation and delete before dropping tracking", async () => {
  const createGate = deferred();
  const deleteGate = deferred();
  let createdDoc;
  const harness = await createGroupHarness({
    async createDocument({ data, collection }) {
      await createGate.promise;
      createdDoc = createAmbientDocument({
        id: "ambient-gated",
        flags: data[0].flags,
        collection,
        deleteBehavior: async () => deleteGate.promise,
      });
      return [createdDoc];
    },
  });

  await harness.controller.playGroup("group-1");
  await waitUntil(() => harness.createCalls === 1, "AmbientSound creation did not start");
  let settled = false;
  const stopPromise = harness.controller.stopGroup("group-1").finally(() => { settled = true; });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(settled, false, "stop must wait for in-flight create");
  assert.equal(harness.controller.getGroupInstanceCount("group-1"), 1);

  createGate.resolve();
  await waitUntil(() => createdDoc?.calls.delete === 1, "owned AmbientSound delete did not start");
  assert.equal(settled, false, "stop must wait for delete completion");
  assert.equal(harness.controller.getGroupInstanceCount("group-1"), 1, "tracking must remain until cleanup succeeds");

  deleteGate.resolve();
  await stopPromise;
  assert.equal(harness.controller.getGroupInstanceCount("group-1"), 0);
  assert.equal(harness.collection.get("ambient-gated"), undefined);
});

test("delete failure propagates, preserves tracking, and a retry succeeds", async () => {
  let failDelete = true;
  let doc;
  const harness = await createGroupHarness({
    async createDocument({ data, collection }) {
      doc = createAmbientDocument({
        id: "ambient-retry",
        flags: data[0].flags,
        collection,
        deleteBehavior: async () => {
          if (failDelete) throw new Error("injected delete failure");
        },
      });
      return [doc];
    },
  });

  await harness.controller.playGroup("group-1");
  await waitUntil(() => harness.collection.get("ambient-retry") !== undefined, "AmbientSound was not created");
  await assert.rejects(
    harness.controller.stopGroup("group-1"),
    (error) => error?.name === "AggregateError"
      && /Failed to stop group audio sessions/.test(error.message)
      && Array.from(error.errors ?? []).some((cause) => /injected delete failure/.test(cause.message)),
  );
  assert.equal(harness.controller.getGroupInstanceCount("group-1"), 1, "failed delete must retain instance tracking");
  assert.equal(harness.collection.get("ambient-retry"), doc);
  assert.equal(doc.calls.delete, 1);

  failDelete = false;
  await harness.controller.stopGroup("group-1");
  assert.equal(doc.calls.delete, 2);
  assert.equal(harness.controller.getGroupInstanceCount("group-1"), 0);
  assert.equal(harness.collection.get("ambient-retry"), undefined);
});

test("replacement waits for prior owned document cleanup before creating the next session", async () => {
  const firstDeleteGate = deferred();
  const docs = [];
  const harness = await createGroupHarness({
    async createDocument({ data, collection, createCalls }) {
      const doc = createAmbientDocument({
        id: `ambient-replace-${createCalls}`,
        flags: data[0].flags,
        collection,
        deleteBehavior: createCalls === 1 ? async () => firstDeleteGate.promise : undefined,
      });
      docs.push(doc);
      return [doc];
    },
  });

  await harness.controller.playGroup("group-1");
  await waitUntil(() => harness.createCalls === 1 && docs[0], "first session was not created");
  const replacePromise = harness.controller.playGroup("group-1");
  await waitUntil(() => docs[0].calls.delete === 1, "replacement did not begin cleanup");
  assert.equal(harness.createCalls, 1, "replacement must not create before old delete succeeds");

  firstDeleteGate.resolve();
  await replacePromise;
  await waitUntil(() => harness.createCalls === 2, "replacement session was not created after cleanup");
  assert.equal(harness.controller.getGroupInstanceCount("group-1"), 1);
  await harness.controller.stopGroup("group-1");
});

test("pause waits for cleanup, resolves the playback timer, and retains a paused session", async () => {
  const deleteGate = deferred();
  let doc;
  const harness = await createGroupHarness({
    async createDocument({ data, collection }) {
      doc = createAmbientDocument({
        id: "ambient-pause",
        flags: data[0].flags,
        collection,
        deleteBehavior: async () => deleteGate.promise,
      });
      return [doc];
    },
  });

  await harness.controller.playGroup("group-1");
  await waitUntil(() => harness.timers.size === 1, "duration timer was not scheduled");
  const [session] = await harness.controller.getGroupSessionViewModels("group-1");
  let settled = false;
  const pausePromise = harness.controller.pauseGroupSession(session.id).finally(() => { settled = true; });
  await waitUntil(() => doc.calls.delete === 1, "pause did not begin owned AmbientSound delete");
  assert.equal(settled, false);
  assert.equal(harness.timers.size, 0, "pause must cancel and resolve the duration timer");

  deleteGate.resolve();
  await pausePromise;
  assert.equal(harness.controller.getGroupInstanceCount("group-1"), 1);
  const [paused] = await harness.controller.getGroupSessionViewModels("group-1");
  assert.equal(paused.paused, true);
  assert.equal(paused.status, "paused");
  await harness.controller.stopGroup("group-1");
});

test("foreign AmbientSound documents are never deleted by group cleanup", async () => {
  let doc;
  const harness = await createGroupHarness({
    async createDocument({ data, collection }) {
      doc = createAmbientDocument({ id: "ambient-foreignized", flags: data[0].flags, collection });
      return [doc];
    },
  });
  await harness.controller.playGroup("group-1");
  await waitUntil(() => harness.collection.get("ambient-foreignized") !== undefined, "document not created");
  doc.flags = { "another-module": { instanceType: "soundboard-group-positional" } };
  await harness.controller.stopGroup("group-1");
  assert.equal(doc.calls.delete, 0);
  assert.equal(harness.collection.get("ambient-foreignized"), doc, "foreign document must remain on scene");
  assert.equal(harness.controller.getGroupInstanceCount("group-1"), 0);
});

test("positional helpers dedupe/delete only documents with exact feature ownership", async () => {
  const collection = new SoundCollection();
  const canvas = { ready: true, scene: {
    sounds: collection,
    async createEmbeddedDocuments(_name, data) {
      return [createAmbientDocument({ id: "created-owned", flags: data[0].flags, collection })];
    },
  } };
  const token = { uuid: "Token.token-1", elevation: 0 };
  const loaded = await loadVmModule(resolve(soundsRoot, "scripts/ui/gm-panel-ambient-audio.js"), {
    globals: {
      canvas,
      foundry: { utils: { fromUuid: async () => token } },
    },
    stubs: {
      [resolve(soundsRoot, "scripts/debug.js")]: "export const debug=()=>{}; export const warn=()=>{};",
      [resolve(soundsRoot, "scripts/ui/gm-panel-audio-token-utils.js")]: "export const getTokenDocumentCenter=()=>({x:10,y:20});",
    },
  });

  const owned1 = createAmbientDocument({ id: "owned-1", flags: ownedPositionalFlags(), collection });
  const owned2 = createAmbientDocument({ id: "owned-2", flags: ownedPositionalFlags(), collection });
  const foreign = createAmbientDocument({ id: "foreign", flags: { "other-module": { instanceType: "soundboard-positional", soundUuid: "Playlist.p.Sound.s", tokenUuid: "Token.token-1" } }, collection });
  const ambientInstances = [{ ambientSoundId: "owned-1" }];
  const kept = await loaded.namespace.dedupeFlaggedDocs({
    soundUuid: "Playlist.p.Sound.s",
    tokenUuid: "Token.token-1",
    ambientInstances,
    findAmbientInstance: () => null,
    removeAmbientInstanceByDocId: () => {},
  });
  assert.equal(kept.id, "owned-1");
  assert.equal(owned1.calls.delete, 0);
  assert.equal(owned2.calls.delete, 1);
  assert.equal(foreign.calls.delete, 0);

  const tracked = [{ id: 10, ambientSoundId: "foreign", soundUuid: "Playlist.p.Sound.s", tokenUuid: "Token.token-1" }];
  let removed = 0;
  assert.equal(await loaded.namespace.stopAmbientInstance(10, {
    ambientInstances: tracked,
    removeAmbientInstance: () => { removed += 1; },
    persist: () => {},
  }), true);
  assert.equal(foreign.calls.delete, 0);
  assert.equal(removed, 1, "foreign document may be untracked but never deleted");

  let foreignUpdates = 0;
  foreign.update = async () => { foreignUpdates += 1; };
  const created = await loaded.namespace.createAmbientSoundsForTokens({
    soundPath: "new.ogg",
    soundUuid: "Playlist.new.Sound.x",
    tokenUuids: ["Token.token-1"],
    loop: false,
    positional: { elevation: 0, radius: 60, volume: 0.5, walls: true, easing: true },
    getPositionalSettings: () => ({}),
    dedupeFlagged: async () => foreign,
    adoptAmbient: () => {},
    forceRefresh: () => {},
  });
  assert.equal(foreignUpdates, 0, "foreign document must not be updated/adopted");
  assert.equal(created[0].id, "created-owned");
});

test("token delete hook removes only owned positional AmbientSound documents", async () => {
  const collection = new SoundCollection();
  const owned = createAmbientDocument({ id: "owned-token", flags: ownedPositionalFlags(), collection });
  const otherToken = createAmbientDocument({ id: "owned-other-token", flags: ownedPositionalFlags({ tokenUuid: "Token.other" }), collection });
  const group = createAmbientDocument({ id: "owned-group", flags: ownedGroupFlags(), collection });
  const foreign = createAmbientDocument({ id: "foreign-token", flags: { "other-module": { instanceType: "soundboard-positional", tokenUuid: "Token.token-1" } }, collection });
  const persists = [];
  const removed = [];

  const loaded = await loadVmModule(resolve(soundsRoot, "scripts/ui/gm-panel-audio-token-hooks.js"), {
    globals: {
      canvas: { scene: { sounds: collection } },
      game: { userId: "user-1" },
    },
    stubs: {
      [resolve(soundsRoot, "scripts/settings.js")]: "export const getSoundboardItems=()=>[];",
      [resolve(soundsRoot, "scripts/ui/gm-panel-audio-token-utils.js")]: "export const getTokenUpdateCenter=()=>({x:0,y:0,elevation:0});",
    },
  });

  await loaded.namespace.handleAudioTokenDelete(
    { uuid: "Token.token-1" },
    {},
    "user-1",
    {
      ambientInstances: [{ id: 1, tokenUuid: "Token.token-1" }],
      removeAmbientInstance: (id) => removed.push(id),
      persist: () => persists.push(true),
    },
  );

  assert.equal(owned.calls.delete, 1);
  assert.equal(otherToken.calls.delete, 0);
  assert.equal(group.calls.delete, 0);
  assert.equal(foreign.calls.delete, 0);
  assert.deepEqual(removed, [1]);
  assert.equal(persists.length, 1);
});
