import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { loadVmModule } from "./helpers/vm-loader.mjs";

const qaDir = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(qaDir, "..");
const modulesDir = resolve(coreRoot, "..");
const luckRoot = resolve(modulesDir, "simone-gm-panel-luck");

function readGuard(environment) {
  return vm.runInContext('globalThis[Symbol.for("simone-gm-panel-luck.wrapper.v1")]', environment.context);
}

function writeGuard(environment, value) {
  environment.sandbox.__qaGuard = value;
  vm.runInContext('globalThis[Symbol.for("simone-gm-panel-luck.wrapper.v1")] = globalThis.__qaGuard', environment.context);
  delete environment.sandbox.__qaGuard;
}

function createHooks({ failAt = null } = {}) {
  const callbacks = new Map();
  const registrations = [];
  const removals = [];
  let nextId = 0;
  return {
    callbacks,
    registrations,
    removals,
    api: {
      on(name, callback) {
        if (failAt !== null && registrations.length === failAt) throw new Error(`injected hook failure: ${name}`);
        const id = ++nextId;
        registrations.push({ name, callback, id });
        callbacks.set(name, callback);
        return id;
      },
      off(name, id) {
        removals.push({ name, id });
      },
    },
  };
}

function createDiceTerm(previousRoll) {
  return class DiceTerm {
    constructor({ faces = 20, options = {} } = {}) {
      this.faces = faces;
      this.options = options;
      this.results = [];
    }
    async roll(options) {
      return previousRoll.call(this, options);
    }
  };
}

async function loadAutomation({ systemId = "dnd5e", state, hooks = createHooks(), previousRoll } = {}) {
  const calls = { previous: 0, warnings: [], debug: [] };
  const baseRoll = previousRoll ?? async function baseRoll(options) {
    calls.previous += 1;
    const result = { result: 13, active: true, delegatedOptions: options };
    this.results.push(result);
    return result;
  };
  const DiceTerm = createDiceTerm(baseRoll);
  const defaultState = state ?? {
    allies: { d20OutcomeMode: "disableCritical", attackLuck: 7, damageLuck: -4, abilityLuck: 5 },
    enemies: { d20OutcomeMode: "normal", attackLuck: 0, damageLuck: 0, abilityLuck: 0 },
  };

  const loaded = await loadVmModule(resolve(luckRoot, "scripts/luck/gm-panel-luck-automation.js"), {
    globals: {
      game: { system: { id: systemId } },
      Hooks: hooks.api,
      CONFIG: {
        Dice: { termTypes: { DiceTerm }, randomUniform: () => 0.75 },
        DND5E: { healingTypes: { healing: {}, temp: {} } },
      },
      canvas: { tokens: { placeables: [] } },
      __state: defaultState,
      __warn: (...args) => calls.warnings.push(args),
      __debug: (...args) => calls.debug.push(args),
    },
    stubs: {
      [resolve(luckRoot, "scripts/settings.js")]: "export const getLuckControlState=()=>globalThis.__state;",
      [resolve(luckRoot, "scripts/debug.js")]: "export const debug=(...x)=>globalThis.__debug(...x); export const warn=(...x)=>globalThis.__warn(...x); export const isDebugEnabled=()=>false;",
    },
  });
  return { ...loaded, hooks, calls, DiceTerm, baseRoll };
}

function allyConfig(extra = {}) {
  return {
    subject: { actor: { token: { document: { disposition: 1 } } } },
    ...extra,
  };
}

test("core-only init/ready does not install a Luck DiceTerm wrapper or dnd5e hooks", async () => {
  const callbacks = new Map();
  const registeredHooks = [];
  const originalRoll = async function originalRoll() { return { result: 9 }; };
  const DiceTerm = createDiceTerm(originalRoll);
  const moduleRecord = {};
  const core = await loadVmModule(resolve(coreRoot, "scripts/main.js"), {
    globals: {
      CONFIG: { Dice: { termTypes: { DiceTerm } } },
      Hooks: {
        once(name, callback) { callbacks.set(name, callback); },
        on(name, callback) { registeredHooks.push({ name, callback }); return registeredHooks.length; },
      },
      game: {
        user: { isGM: false },
        modules: new Map([["simone-gm-panel", moduleRecord]]),
      },
      __migrate: async () => {},
    },
    stubs: {
      [resolve(coreRoot, "scripts/feature-registry.js")]: "export class FeatureRegistry { registerFeature(){} unregisterFeature(){} }",
      [resolve(coreRoot, "scripts/debug.js")]: "export const error=()=>{}; export const warn=()=>{};",
      [resolve(coreRoot, "scripts/settings.js")]: "export const registerSettings=()=>{}; export const migrateCoreState=()=>globalThis.__migrate();",
      [resolve(coreRoot, "scripts/ui/gm-panel-app.js")]: "export class SimoneGmPanelApp { constructor(){} }",
    },
  });
  assert.equal(typeof core.namespace.ensurePanel, "function");
  const before = DiceTerm.prototype.roll;
  callbacks.get("init")();
  await callbacks.get("ready")();
  assert.equal(DiceTerm.prototype.roll, before);
  assert.equal(registeredHooks.some(({ name }) => name.startsWith("dnd5e.")), false);
});

test("unsupported systems do not install wrapper or hooks", async () => {
  const env = await loadAutomation({ systemId: "pf2e" });
  const before = env.DiceTerm.prototype.roll;
  assert.equal(env.namespace.registerLuckAutomation(), false);
  assert.equal(env.DiceTerm.prototype.roll, before);
  assert.equal(env.hooks.registrations.length, 0);
  assert.equal(readGuard(env), undefined);
});

test("Luck wrapper installs once, delegates cooperatively and supports forced/biased terms", async () => {
  let externalCalls = 0;
  const externalWrapper = async function externalWrapper(options) {
    externalCalls += 1;
    const result = { result: 17, active: true, externalOptions: options };
    this.results.push(result);
    return result;
  };
  const env = await loadAutomation({ previousRoll: externalWrapper });
  const previous = env.DiceTerm.prototype.roll;

  assert.equal(env.namespace.registerLuckAutomation({ implementationVersion: "1.0.0" }), true);
  const wrapped = env.DiceTerm.prototype.roll;
  assert.notEqual(wrapped, previous);
  assert.equal(env.hooks.registrations.length, 6);
  assert.deepEqual(env.hooks.registrations.map(({ name }) => name), [
    "dnd5e.postAttackRollConfiguration",
    "dnd5e.preRollDamage",
    "dnd5e.preRollDamageV2",
    "dnd5e.postDamageRollConfiguration",
    "dnd5e.postAbilityCheckRollConfiguration",
    "dnd5e.postSavingThrowRollConfiguration",
  ]);

  assert.equal(env.namespace.registerLuckAutomation({ implementationVersion: "1.0.1" }), true);
  assert.equal(env.DiceTerm.prototype.roll, wrapped);
  assert.equal(env.hooks.registrations.length, 6, "second registration must not duplicate hooks");

  const unmarked = new env.DiceTerm();
  const delegated = await unmarked.roll({ fastForward: true });
  assert.equal(delegated.result, 17);
  assert.equal(delegated.externalOptions.fastForward, true);
  assert.equal(externalCalls, 1, "unmarked roll must delegate exactly once");

  const forced = new env.DiceTerm({ options: { _simoneGmPanelForcedFace: 20 } });
  const forcedResult = await forced.roll({});
  assert.equal(forcedResult.result, 20);
  assert.equal(forcedResult.active, true);
  assert.equal(forced.results.length, 1);
  assert.equal(externalCalls, 1, "forced roll must not delegate");

  const biased = new env.DiceTerm({ faces: 20, options: { _simoneGmPanelLuck: 10 } });
  const biasedResult = await biased.roll({});
  assert.ok(Number.isInteger(biasedResult.result));
  assert.ok(biasedResult.result >= 1 && biasedResult.result <= 20);
  assert.equal(externalCalls, 1, "biased roll must not delegate when a face is generated");

  const guard = readGuard(env);
  assert.equal(guard.owner, "simone-gm-panel-luck");
  assert.equal(guard.apiVersion, 1);
  assert.equal(guard.implementationVersion, "1.0.0");
  assert.equal(guard.wrappedFunction, wrapped);
  assert.equal(guard.previousFunction, previous);
  assert.equal(Object.isFrozen(guard), true);
});

test("incompatible guard and partial Hook failure leave DiceTerm unmodified", async () => {
  const incompatible = await loadAutomation();
  const before = incompatible.DiceTerm.prototype.roll;
  writeGuard(incompatible, Object.freeze({ owner: "other", apiVersion: 99 }));
  assert.throws(() => incompatible.namespace.registerLuckAutomation(), /Incompatible/);
  assert.equal(incompatible.DiceTerm.prototype.roll, before);
  assert.equal(incompatible.hooks.registrations.length, 0);

  const hooks = createHooks({ failAt: 2 });
  const partial = await loadAutomation({ hooks });
  const partialBefore = partial.DiceTerm.prototype.roll;
  assert.throws(() => partial.namespace.registerLuckAutomation(), /injected hook failure/);
  assert.equal(partial.DiceTerm.prototype.roll, partialBefore);
  assert.equal(readGuard(partial), undefined);
  assert.deepEqual(hooks.removals, [
    { name: "dnd5e.postAttackRollConfiguration", id: 1 },
    { name: "dnd5e.preRollDamage", id: 2 },
  ]);
});

test("dnd5e attack, ability, save and damage hooks apply policy while healing is untouched", async () => {
  const env = await loadAutomation();
  env.namespace.registerLuckAutomation();

  const attackRoll = { options: {}, d20: { options: {} } };
  env.hooks.callbacks.get("dnd5e.postAttackRollConfiguration")([attackRoll], allyConfig());
  assert.equal(attackRoll.options.criticalSuccess, 21);
  assert.equal(attackRoll.d20.options.criticalSuccess, 21);
  assert.equal(attackRoll.d20.options._simoneGmPanelLuck, 7);

  const abilityRoll = { options: {}, d20: { options: {} } };
  env.hooks.callbacks.get("dnd5e.postAbilityCheckRollConfiguration")([abilityRoll], allyConfig());
  assert.equal(abilityRoll.options.criticalSuccess, 21);
  assert.equal(abilityRoll.d20.options._simoneGmPanelLuck, 5);

  const saveRoll = { options: {}, d20: { options: {} } };
  env.hooks.callbacks.get("dnd5e.postSavingThrowRollConfiguration")([saveRoll], allyConfig());
  assert.equal(saveRoll.options.criticalSuccess, 21);
  assert.equal(saveRoll.d20.options._simoneGmPanelLuck, 5);

  const preDamage = allyConfig({ isCritical: true, rolls: [{ options: { isCritical: true } }] });
  env.hooks.callbacks.get("dnd5e.preRollDamage")(preDamage);
  assert.equal(preDamage.isCritical, false);
  assert.equal(preDamage.rolls[0].options.isCritical, false);
  const snapshot = structuredClone(preDamage);
  env.hooks.callbacks.get("dnd5e.preRollDamageV2")(preDamage);
  assert.deepEqual(preDamage, snapshot, "pre-damage policy must be idempotent across paired hooks");

  const damageTerms = [{ faces: 6, options: {} }, { faces: 8, options: {} }, { faces: 1, options: {} }];
  const damageRoll = { dice: damageTerms };
  env.hooks.callbacks.get("dnd5e.postDamageRollConfiguration")([damageRoll], allyConfig());
  assert.equal(damageTerms[0].options._simoneGmPanelLuck, -4);
  assert.equal(damageTerms[1].options._simoneGmPanelLuck, -4);
  assert.equal(damageTerms[2].options._simoneGmPanelLuck, undefined);

  const healingTerm = { faces: 8, options: {} };
  env.hooks.callbacks.get("dnd5e.postDamageRollConfiguration")(
    [{ dice: [healingTerm] }],
    allyConfig({ rollType: "healing" }),
  );
  assert.equal(healingTerm.options._simoneGmPanelLuck, undefined);
});
