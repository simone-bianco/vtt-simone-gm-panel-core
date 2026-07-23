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

function key(moduleId, setting) { return `${moduleId}.${setting}`; }
function clone(value) { return value === undefined ? undefined : structuredClone(value); }

function createUser({ initial = {}, failOnce = null, isGM = true } = {}) {
  const flags = new Map(Object.entries(initial).map(([name, value]) => [name, clone(value)]));
  const reads = [];
  const writes = [];
  let failure = failOnce;
  return {
    isGM,
    flags,
    reads,
    writes,
    getFlag(moduleId, flag) {
      const full = key(moduleId, flag);
      reads.push(full);
      return clone(flags.get(full));
    },
    async setFlag(moduleId, flag, value) {
      const full = key(moduleId, flag);
      writes.push({ key: full, value: clone(value) });
      if (failure === full) {
        failure = null;
        throw new Error(`injected setFlag failure: ${full}`);
      }
      flags.set(full, clone(value));
      return clone(value);
    },
  };
}

function createSettings({ client = {}, world = {}, runtime = {}, failOnce = null } = {}) {
  const clientStore = new Map(Object.entries(client).map(([name, value]) => [name, clone(value)]));
  const worldStore = new Map(Object.entries(world).map(([name, value]) => [name, clone(value)]));
  const runtimeStore = new Map(Object.entries(runtime).map(([name, value]) => [name, clone(value)]));
  const reads = [];
  const writes = [];
  let failure = failOnce;

  function scopeFor(full) {
    if (/disableCriticals|migrationClientVersion/.test(full)) return "client";
    return "world";
  }

  const api = {
    storage: new Map([
      ["client", {
        getItem(full) {
          reads.push({ scope: "client", key: full });
          return clientStore.has(full) ? JSON.stringify(clientStore.get(full)) : null;
        },
      }],
      ["world", {
        getSetting(full) {
          reads.push({ scope: "world", key: full });
          return worldStore.has(full) ? { value: clone(worldStore.get(full)) } : undefined;
        },
      }],
    ]),
    register() {},
    get(moduleId, setting) {
      const full = key(moduleId, setting);
      if (runtimeStore.has(full)) return clone(runtimeStore.get(full));
      if (clientStore.has(full)) return clone(clientStore.get(full));
      if (worldStore.has(full)) return clone(worldStore.get(full));
      return 0;
    },
    async set(moduleId, setting, value) {
      const full = key(moduleId, setting);
      writes.push({ key: full, value: clone(value) });
      if (failure === full) {
        failure = null;
        throw new Error(`injected settings failure: ${full}`);
      }
      runtimeStore.set(full, clone(value));
      const target = scopeFor(full) === "client" ? clientStore : worldStore;
      target.set(full, clone(value));
      return clone(value);
    },
  };

  return { api, clientStore, worldStore, runtimeStore, reads, writes };
}

async function loadCoreSettings(game) {
  return loadVmModule(resolve(coreRoot, "scripts/settings.js"), {
    globals: { game },
    stubs: {
      [resolve(modulesDir, "simone-homebrew/scripts/core/settings-base.js")]: "export const registerSetting=()=>{};",
    },
  });
}

async function loadLuckSettings(game) {
  return loadVmModule(resolve(luckRoot, "scripts/settings.js"), { globals: { game } });
}

async function loadSoundsSettings(game) {
  return loadVmModule(resolve(soundsRoot, "scripts/settings.js"), {
    globals: { game, foundry: { utils: { randomID: () => "qa-id" } } },
  });
}

test("core migration is destination-first, marker-last and retryable", async () => {
  const legacyKey = key("simone-gm-panel", "panelState");
  const destinationKey = key("simone-gm-panel", "corePanelState");
  const markerKey = key("simone-gm-panel", "coreStateMigrationVersion");

  const user = createUser({ initial: { [legacyKey]: { top: 11, activeTab: "dice", soundboardItems: [{ uuid: "legacy" }] } } });
  const { namespace } = await loadCoreSettings({ user });
  await namespace.migrateCoreState();
  assert.equal(user.flags.get(destinationKey).top, 11);
  assert.equal(user.flags.get(destinationKey).activeFeatureId, "luck");
  assert.equal("soundboardItems" in user.flags.get(destinationKey), false);
  assert.equal(user.flags.get(markerKey), 2);
  assert.deepEqual(user.flags.get(legacyKey), { top: 11, activeTab: "dice", soundboardItems: [{ uuid: "legacy" }] });
  assert.ok(user.writes.findIndex((entry) => entry.key === destinationKey) < user.writes.findIndex((entry) => entry.key === markerKey));

  const existing = { top: 99, left: 98, width: 500, height: 400, collapsed: true, activeFeatureId: "soundboards" };
  const preexistingUser = createUser({ initial: { [legacyKey]: { top: 1 }, [destinationKey]: existing } });
  const preexistingModule = await loadCoreSettings({ user: preexistingUser });
  await preexistingModule.namespace.migrateCoreState();
  assert.deepEqual(preexistingUser.flags.get(destinationKey), existing);
  assert.equal(preexistingUser.writes.some((entry) => entry.key === destinationKey), false);

  const markedUser = createUser({ initial: { [markerKey]: 1, [destinationKey]: existing, [legacyKey]: { top: 1 } } });
  const markedModule = await loadCoreSettings({ user: markedUser });
  await markedModule.namespace.migrateCoreState();
  assert.deepEqual(markedUser.flags.get(destinationKey), existing);
  assert.deepEqual(markedUser.writes, [{ key: markerKey, value: 2 }]);
  assert.equal(markedUser.reads.includes(legacyKey), false, "v1-to-v2 migration must not reread legacy");

  const retryUser = createUser({ initial: { [legacyKey]: { top: 44 } }, failOnce: destinationKey });
  const retryModule = await loadCoreSettings({ user: retryUser });
  await assert.rejects(retryModule.namespace.migrateCoreState(), /injected setFlag failure/);
  assert.equal(retryUser.flags.has(markerKey), false);
  await retryModule.namespace.migrateCoreState();
  assert.equal(retryUser.flags.get(destinationKey).top, 44);
  assert.equal(retryUser.flags.get(markerKey), 2);

  const diceDestination = { ...existing, activeFeatureId: "dice" };
  const v1User = createUser({ initial: { [markerKey]: 1, [destinationKey]: diceDestination } });
  const v1Module = await loadCoreSettings({ user: v1User });
  await v1Module.namespace.migrateCoreState();
  assert.equal(v1User.flags.get(destinationKey).activeFeatureId, "luck");
  assert.equal(v1User.flags.get(markerKey), 2);

  const v2RetryUser = createUser({
    initial: { [markerKey]: 1, [destinationKey]: diceDestination },
    failOnce: destinationKey,
  });
  const v2RetryModule = await loadCoreSettings({ user: v2RetryUser });
  await assert.rejects(v2RetryModule.namespace.migrateCoreState(), /injected setFlag failure/);
  assert.equal(v2RetryUser.flags.get(markerKey), 1, "v2 marker must remain at v1 when dice-to-luck write fails");
  assert.equal(v2RetryUser.flags.get(destinationKey).activeFeatureId, "dice");
  await v2RetryModule.namespace.migrateCoreState();
  assert.equal(v2RetryUser.flags.get(destinationKey).activeFeatureId, "luck");
  assert.equal(v2RetryUser.flags.get(markerKey), 2);
});

test("Luck migration separates client/world authority, preserves destinations and retries", async () => {
  const legacyDisable = key("simone-gm-panel", "disableCriticals");
  const legacyControl = key("simone-gm-panel", "diceControl");
  const previousDisable = key("simone-gm-panel-dice", "disableCriticals");
  const previousControl = key("simone-gm-panel-dice", "diceControl");
  const newDisable = key("simone-gm-panel-luck", "disableCriticals");
  const newControl = key("simone-gm-panel-luck", "luckControl");
  const clientMarker = key("simone-gm-panel-luck", "migrationClientVersion");
  const worldMarker = key("simone-gm-panel-luck", "migrationWorldVersion");

  const storage = createSettings({
    client: { [legacyDisable]: true },
    world: { [legacyControl]: { allies: { attackLuck: 7 }, enemies: { damageLuck: -4 } } },
  });
  const game = { user: { isGM: true }, settings: storage.api };
  const { namespace } = await loadLuckSettings(game);
  await namespace.migrateLuckSettings();
  assert.equal(storage.clientStore.get(newDisable), true);
  assert.equal(storage.worldStore.get(newControl).allies.attackLuck, 7);
  assert.equal(storage.worldStore.get(newControl).enemies.damageLuck, -4);
  assert.equal(storage.runtimeStore.get(clientMarker), 1);
  assert.equal(storage.runtimeStore.get(worldMarker), 1);
  assert.equal(storage.clientStore.get(legacyDisable), true);
  assert.deepEqual(storage.worldStore.get(legacyControl), { allies: { attackLuck: 7 }, enemies: { damageLuck: -4 } });
  assert.ok(storage.writes.findIndex((entry) => entry.key === newControl) < storage.writes.findIndex((entry) => entry.key === worldMarker));

  const previousState = { allies: { attackLuck: 9 }, enemies: { abilityLuck: -3 } };
  const priorityStorage = createSettings({
    client: { [legacyDisable]: false, [previousDisable]: true },
    world: { [legacyControl]: { allies: { attackLuck: 1 } }, [previousControl]: previousState },
  });
  const priorityModule = await loadLuckSettings({ user: { isGM: true }, settings: priorityStorage.api });
  await priorityModule.namespace.migrateLuckSettings();
  assert.equal(priorityStorage.clientStore.get(newDisable), true);
  assert.equal(priorityStorage.worldStore.get(newControl).allies.attackLuck, 9);
  assert.equal(priorityStorage.worldStore.get(newControl).enemies.abilityLuck, -3);

  const clientRetryStorage = createSettings({ client: { [previousDisable]: true }, failOnce: newDisable });
  const clientRetryModule = await loadLuckSettings({ user: { isGM: false }, settings: clientRetryStorage.api });
  await assert.rejects(clientRetryModule.namespace.migrateLuckSettings(), /injected settings failure/);
  assert.equal(clientRetryStorage.runtimeStore.has(clientMarker), false, "client marker must not be written after destination failure");
  await clientRetryModule.namespace.migrateLuckSettings();
  assert.equal(clientRetryStorage.clientStore.get(newDisable), true);
  assert.equal(clientRetryStorage.runtimeStore.get(clientMarker), 1);

  const destination = { allies: { d20OutcomeMode: "alwaysCritical", attackLuck: 2, damageLuck: 3, abilityLuck: 4 }, enemies: { d20OutcomeMode: "normal", attackLuck: 0, damageLuck: 0, abilityLuck: 0 } };
  const existingStorage = createSettings({
    client: { [newDisable]: false, [legacyDisable]: true },
    world: { [newControl]: destination, [legacyControl]: { allies: { attackLuck: 10 } } },
  });
  const existingModule = await loadLuckSettings({ user: { isGM: true }, settings: existingStorage.api });
  await existingModule.namespace.migrateLuckSettings();
  assert.equal(existingStorage.clientStore.get(newDisable), false);
  assert.deepEqual(existingStorage.worldStore.get(newControl), destination);
  assert.equal(existingStorage.writes.some((entry) => entry.key === newDisable || entry.key === newControl), false);

  const playerStorage = createSettings({ client: { [legacyDisable]: true }, world: { [legacyControl]: destination } });
  const playerModule = await loadLuckSettings({ user: { isGM: false }, settings: playerStorage.api });
  await playerModule.namespace.migrateLuckSettings();
  assert.equal(playerStorage.clientStore.get(newDisable), true);
  assert.equal(playerStorage.writes.some((entry) => entry.key === newControl || entry.key === worldMarker), false);

  const retryStorage = createSettings({ world: { [legacyControl]: destination }, failOnce: newControl });
  const retryModule = await loadLuckSettings({ user: { isGM: true }, settings: retryStorage.api });
  await assert.rejects(retryModule.namespace.migrateLuckSettings(), /injected settings failure/);
  assert.equal(retryStorage.runtimeStore.has(worldMarker), false);
  await retryModule.namespace.migrateLuckSettings();
  assert.deepEqual(retryStorage.worldStore.get(newControl), destination);
  assert.equal(retryStorage.runtimeStore.get(worldMarker), 1);
});

test("Sounds migration owns user/world data, preserves legacy and uses marker-last retry", async () => {
  const legacyPanel = key("simone-gm-panel", "panelState");
  const legacyPlaylist = key("simone-gm-panel", "currentPlaylist");
  const legacyInstances = key("simone-gm-panel", "activeInstances");
  const newState = key("simone-gm-panel-sounds", "soundboardState");
  const newPlaylist = key("simone-gm-panel-sounds", "currentPlaylist");
  const newInstances = key("simone-gm-panel-sounds", "activeInstances");
  const userMarker = key("simone-gm-panel-sounds", "migrationUserVersion");
  const legacyRadius = key("simone-gm-panel", "positionalRadius");
  const legacyVolume = key("simone-gm-panel", "positionalVolume");
  const newRadius = key("simone-gm-panel-sounds", "positionalRadius");
  const newVolume = key("simone-gm-panel-sounds", "positionalVolume");
  const worldMarker = key("simone-gm-panel-sounds", "migrationWorldVersion");

  const legacyState = { soundboardItems: [{ uuid: "Playlist.a.Sound.b", loop: true }] };
  const user = createUser({ initial: {
    [legacyPanel]: legacyState,
    [legacyPlaylist]: { id: "playlist" },
    [legacyInstances]: [{ type: "sound", soundUuid: "x" }],
  } });
  const storage = createSettings({ world: { [legacyRadius]: 77, [legacyVolume]: 0.25 } });
  const { namespace } = await loadSoundsSettings({ user, settings: storage.api });
  await namespace.migrateSoundsData();
  assert.equal(user.flags.get(newState).items[0].uuid, "Playlist.a.Sound.b");
  assert.deepEqual(user.flags.get(newPlaylist), { id: "playlist" });
  assert.deepEqual(user.flags.get(newInstances), [{ type: "sound", soundUuid: "x" }]);
  assert.equal(user.flags.get(userMarker), 1);
  assert.equal(storage.worldStore.get(newRadius), 77);
  assert.equal(storage.worldStore.get(newVolume), 0.25);
  assert.equal(storage.runtimeStore.get(worldMarker), 1);
  assert.deepEqual(user.flags.get(legacyPanel), legacyState);
  assert.deepEqual(user.flags.get(legacyPlaylist), { id: "playlist" });
  assert.ok(user.writes.findIndex((entry) => entry.key === newInstances) < user.writes.findIndex((entry) => entry.key === userMarker));
  assert.ok(storage.writes.findIndex((entry) => entry.key === newVolume) < storage.writes.findIndex((entry) => entry.key === worldMarker));

  const preservedState = { items: [{ id: "kept", uuid: "kept" }], groups: [], layout: [{ type: "item", id: "kept" }] };
  const existingUser = createUser({ initial: {
    [legacyPanel]: legacyState,
    [newState]: preservedState,
    [newPlaylist]: { id: "new" },
    [newInstances]: [{ id: 1 }],
  } });
  const existingStorage = createSettings({ world: { [newRadius]: 12, [legacyRadius]: 99 } });
  const existingModule = await loadSoundsSettings({ user: existingUser, settings: existingStorage.api });
  await existingModule.namespace.migrateSoundsData();
  assert.deepEqual(existingUser.flags.get(newState), preservedState);
  assert.deepEqual(existingUser.flags.get(newPlaylist), { id: "new" });
  assert.deepEqual(existingUser.flags.get(newInstances), [{ id: 1 }]);
  assert.equal(existingStorage.worldStore.get(newRadius), 12);

  const playerUser = createUser({ initial: { [legacyPanel]: legacyState }, isGM: false });
  const playerStorage = createSettings({ world: { [legacyRadius]: 99 } });
  const playerModule = await loadSoundsSettings({ user: playerUser, settings: playerStorage.api });
  await playerModule.namespace.migrateSoundsData();
  assert.equal(playerUser.flags.get(newState).items.length, 1);
  assert.equal(playerStorage.writes.some((entry) => entry.key === newRadius || entry.key === worldMarker), false);

  const retryUser = createUser({ initial: { [legacyPanel]: legacyState }, failOnce: newState });
  const retryStorage = createSettings();
  const retryModule = await loadSoundsSettings({ user: retryUser, settings: retryStorage.api });
  await assert.rejects(retryModule.namespace.migrateSoundsData(), /injected setFlag failure/);
  assert.equal(retryUser.flags.has(userMarker), false);
  await retryModule.namespace.migrateSoundsData();
  assert.equal(retryUser.flags.get(newState).items.length, 1);
  assert.equal(retryUser.flags.get(userMarker), 1);
});

test("AmbientSound legacy adoption enforces authority, ambiguity stop, recheck and marker-last", async () => {
  const marker = key("simone-gm-panel-sounds", "ambientOwnershipMigrationVersion");
  const makeDocument = ({ id, legacy, feature, onUpdate } = {}) => ({
    id,
    flags: {
      ...(legacy === undefined ? {} : { "simone-gm-panel": legacy }),
      ...(feature === undefined ? {} : { "simone-gm-panel-sounds": feature }),
    },
    async update(change) { onUpdate?.(change, this); this.flags["simone-gm-panel-sounds"] = clone(change["flags.simone-gm-panel-sounds"]); },
  });

  async function loadAdoption({ isGM = true, docs = [], migration = 0, failMarker = false } = {}) {
    const writes = [];
    const settings = {
      get: () => migration,
      async set(moduleId, setting, value) {
        writes.push({ key: key(moduleId, setting), value });
        if (failMarker) throw new Error("marker failure");
      },
    };
    const game = { user: { isGM }, settings, scenes: [{ id: "scene", sounds: docs }] };
    const loaded = await loadVmModule(resolve(soundsRoot, "scripts/ambient-migration.js"), {
      globals: { game },
      stubs: { [resolve(soundsRoot, "scripts/debug.js")]: "export const debug=()=>{};" },
    });
    return { ...loaded, writes };
  }

  const playerDoc = makeDocument({ id: "p", legacy: { instanceType: "soundboard-positional", soundUuid: "s", tokenUuid: "t" } });
  const player = await loadAdoption({ isGM: false, docs: [playerDoc] });
  await player.namespace.adoptLegacyAmbientSoundFlags();
  assert.equal(playerDoc.flags["simone-gm-panel-sounds"], undefined);
  assert.deepEqual(player.writes, []);

  let ambiguousUpdates = 0;
  const ambiguousDoc = makeDocument({ id: "a", legacy: { instanceType: "soundboard-group-positional", groupId: "g" }, onUpdate: () => { ambiguousUpdates += 1; } });
  const ambiguous = await loadAdoption({ docs: [ambiguousDoc] });
  await assert.rejects(ambiguous.namespace.adoptLegacyAmbientSoundFlags(), /Ambiguous legacy/);
  assert.equal(ambiguousUpdates, 0);
  assert.deepEqual(ambiguous.writes, []);

  let updateCalls = 0;
  const validLegacy = { instanceType: "soundboard-group-positional", groupId: "g", groupSessionId: 1, tokenUuid: "t", soundUuid: "s" };
  const validDoc = makeDocument({ id: "v", legacy: validLegacy, onUpdate: () => { updateCalls += 1; } });
  const valid = await loadAdoption({ docs: [validDoc] });
  await valid.namespace.adoptLegacyAmbientSoundFlags();
  assert.equal(updateCalls, 1);
  assert.deepEqual(validDoc.flags["simone-gm-panel-sounds"], validLegacy);
  assert.deepEqual(valid.writes, [{ key: marker, value: 1 }]);

  let reads = 0;
  const changingFlags = {};
  Object.defineProperty(changingFlags, "simone-gm-panel", {
    configurable: true,
    get() {
      reads += 1;
      return reads === 1 ? validLegacy : { instanceType: "soundboard-group-positional", groupId: "g" };
    },
  });
  const changingDoc = { id: "c", flags: changingFlags, async update() { throw new Error("must not update"); } };
  const changing = await loadAdoption({ docs: [changingDoc] });
  await assert.rejects(changing.namespace.adoptLegacyAmbientSoundFlags(), /ownership changed/);
  assert.deepEqual(changing.writes, []);
});

test("Luck and Sounds initialization are single-flight across concurrent callers", async () => {
  function gate() {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    return { promise, release };
  }

  const luckGate = gate();
  const luckCounts = { migrate: 0, automation: 0 };
  const luck = await loadVmModule(resolve(luckRoot, "scripts/initialization.js"), {
    globals: {
      game: { system: { id: "dnd5e" }, modules: new Map([["simone-gm-panel-luck", { version: "1.0.0" }]]) },
      __migrate: async () => { luckCounts.migrate += 1; await luckGate.promise; },
      __automation: () => { luckCounts.automation += 1; },
    },
    stubs: {
      [resolve(luckRoot, "scripts/debug.js")]: "export const warn=()=>{};",
      [resolve(luckRoot, "scripts/settings.js")]: "export const migrateLuckSettings=()=>globalThis.__migrate();",
      [resolve(luckRoot, "scripts/luck/gm-panel-luck-automation.js")]: "export const registerLuckAutomation=(x)=>globalThis.__automation(x);",
    },
  });
  const luckFirst = luck.namespace.initializeLuckFeature();
  const luckSecond = luck.namespace.initializeLuckFeature();
  assert.equal(luckFirst, luckSecond);
  assert.equal(luckCounts.migrate, 1);
  luckGate.release();
  await luckFirst;
  assert.equal(luckCounts.automation, 1);

  const soundsGate = gate();
  const soundsCounts = { migrate: 0, adopt: 0 };
  const sounds = await loadVmModule(resolve(soundsRoot, "scripts/initialization.js"), {
    globals: {
      __migrate: async () => { soundsCounts.migrate += 1; await soundsGate.promise; },
      __adopt: async () => { soundsCounts.adopt += 1; },
    },
    stubs: {
      [resolve(soundsRoot, "scripts/settings.js")]: "export const migrateSoundsData=()=>globalThis.__migrate();",
      [resolve(soundsRoot, "scripts/ambient-migration.js")]: "export const adoptLegacyAmbientSoundFlags=()=>globalThis.__adopt();",
    },
  });
  const soundsFirst = sounds.namespace.initializeSoundsFeature();
  const soundsSecond = sounds.namespace.initializeSoundsFeature();
  assert.equal(soundsFirst, soundsSecond);
  assert.equal(soundsCounts.migrate, 1);
  soundsGate.release();
  await soundsFirst;
  assert.equal(soundsCounts.adopt, 1);
});
