import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadVmModule } from "./helpers/vm-loader.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function fixture() {
  const scene = { id: "one", tokens: new Map() };
  const token = (id, parent = scene) => {
    const document = { id, uuid: `Scene.${parent.id}.Token.${id}`, parent, name: `Token ${id}`, texture: { src: `${id}.webp` } };
    document.object = { center: { x: 100, y: 200 } };
    parent.tokens.set(id, document);
    return { document, actor: { name: "Shared Actor", img: "actor.webp" } };
  };
  const a = token("a"), b = token("b");
  const other = token("a", { id: "other", tokens: new Map() });
  const hooks = new Map(), timers = new Map(), renders = [], warnings = [], pans = [], errors = [];
  let next = 0;
  const canvas = { ready: true, scene, tokens: { controlled: [a, b, a, other] }, animatePan: async (position) => pans.push(position) };
  const { namespace } = await loadVmModule(resolve(root, "scripts/ui/gm-panel-selected-tokens.js"), {
    globals: {
      canvas,
      game: { i18n: { localize: (key) => key } },
      ui: { notifications: { warn: (message) => warnings.push(message) } },
      foundry: { utils: { fromUuid: async (uuid) => [a, b, other].find((t) => t.document.uuid === uuid)?.document } },
      Hooks: {
        on: (name, fn) => { const id = ++next; hooks.set(id, { name, fn }); return id; },
        off: (_name, id) => hooks.delete(id),
      },
      setTimeout: (fn) => { const id = ++next; timers.set(id, fn); return id; },
      clearTimeout: (id) => timers.delete(id),
      __error: (...args) => errors.push(args),
    },
    stubs: { [resolve(root, "scripts/debug.js")]: "export const error=(...args)=>globalThis.__error(...args);" },
  });
  const app = { rendered: true, render: async (options) => renders.push(options) };
  const controller = new namespace.GmPanelSelectedTokens(app);
  const fire = (name, ...args) => { for (const hook of hooks.values()) if (hook.name === name) hook.fn(...args); };
  const flush = async () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } await new Promise(setImmediate); };
  return { controller, app, canvas, a, b, other, hooks, timers, renders, warnings, pans, errors, fire, flush };
}

test("core selection is live, scene-local, deduplicated and excludes deleted tokens without persisting state", async () => {
  const { controller, canvas, a, b } = await fixture();
  assert.deepEqual(Array.from(controller.collect(), (t) => t.uuid), [a.document.uuid, b.document.uuid]);
  assert.equal(controller.collect()[0].name, "Token a");
  b.document.texture.src = "";
  canvas.tokens.controlled = [b];
  assert.equal(controller.collect()[0].img, "actor.webp");
  canvas.scene.tokens.delete(b.document.id);
  assert.equal(controller.collect().length, 0);
  canvas.ready = false;
  canvas.tokens.controlled = [a];
  assert.equal(controller.collect().length, 0);
});

test("selection hooks coalesce into a footer-only render, clear on teardown and clean up on close/reopen", async () => {
  const { controller, fire, flush, hooks, timers, renders, a, app } = await fixture();
  controller.activate();
  const count = hooks.size;
  controller.activate();
  assert.equal(hooks.size, count);
  fire("controlToken", a, true);
  fire("controlToken", a, false);
  assert.equal(timers.size, 1);
  await flush();
  assert.deepEqual(Array.from(renders[0].parts), ["selectedTokens"]);
  fire("canvasTearDown");
  assert.equal(controller.collect().length, 0, "teardown can fire while canvas.ready is still true");
  await flush();
  fire("canvasReady");
  assert.equal(controller.collect().length, 2);
  await flush();
  fire("updateToken", a.document);
  controller.deactivate();
  assert.equal(hooks.size, 0);
  assert.equal(timers.size, 0);
  controller.activate();
  assert.equal(hooks.size, count);
  app.rendered = false;
  fire("controlToken", a, true);
  assert.equal(timers.size, 0);
  controller.deactivate();
});

test("core chip click pans once after repeated binding and ignores missing or other-scene targets", async () => {
  const { controller, pans, warnings, a, other } = await fixture();
  const listeners = new Set();
  const button = { dataset: { tokenUuid: a.document.uuid } };
  const root = {
    addEventListener: (_name, fn) => listeners.add(fn),
    removeEventListener: (_name, fn) => listeners.delete(fn),
    contains: (element) => element === button,
  };
  controller.activate();
  controller.bind(root);
  controller.bind(root);
  assert.equal(listeners.size, 1);
  for (const fn of listeners) fn({ target: { closest: () => button }, preventDefault() {} });
  await new Promise(setImmediate);
  assert.equal(pans.length, 1);
  assert.deepEqual({ ...pans[0] }, { x: 100, y: 200, duration: 350 });
  await controller.panToToken(other.document.uuid);
  await controller.panToToken("missing");
  assert.equal(pans.length, 1);
  assert.equal(warnings.length, 2);
  controller.deactivate();
  assert.equal(listeners.size, 0);
  await controller.panToToken(a.document.uuid);
  assert.equal(pans.length, 1);
});

test("core footer template renders token chips and escapes names even without a feature footer", async () => {
  const require = createRequire(resolve(root, "../../../../foundryvtt/package.json"));
  const handlebars = require("handlebars").create();
  const translations = JSON.parse(await readFile(resolve(root, "languages/en.json"), "utf8")).SIMONE_GM_PANEL;
  handlebars.registerHelper("localize", (key, options) => key.split(".").slice(1).reduce((value, part) => value[part], translations)
    .replace("{name}", options.hash.name ?? ""));
  const template = handlebars.compile(await readFile(resolve(root, "templates/selected-tokens-footer.hbs"), "utf8"));
  const html = template({ selectedTokens: [{ uuid: "Scene.one.Token.a", name: '<script>bad()</script>', img: "a.webp" }] });
  assert.equal((html.match(/class="sgmp-token-chip"/g) ?? []).length, 1);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("Focus on &lt;script&gt;"));
  assert.ok(template({ selectedTokens: [] }).includes("No tokens selected"));
});
