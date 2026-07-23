import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const qaDir = dirname(fileURLToPath(import.meta.url));
const modulesDir = resolve(qaDir, "..", "..");
const projectRoot = resolve(modulesDir, "..", "..", "..");
const packages = {
  core: resolve(modulesDir, "simone-gm-panel"),
  luck: resolve(modulesDir, "simone-gm-panel-luck"),
  sounds: resolve(modulesDir, "simone-gm-panel-sounds"),
};

async function readJson(path) {
  const raw = await readFile(path);
  assert.equal(raw.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false, `${path} must not contain UTF-8 BOM`);
  return JSON.parse(raw.toString("utf8"));
}

async function walk(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else output.push(path);
  }
  return output;
}

function flattenKeys(value, prefix = "", result = new Set()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (prefix) result.add(prefix);
    return result;
  }
  for (const [key, child] of Object.entries(value)) {
    flattenKeys(child, prefix ? `${prefix}.${key}` : key, result);
  }
  return result;
}

function dependencyIds(manifest) {
  return (manifest.relationships?.requires ?? []).map((entry) => entry.id);
}

async function assertDeclaredPathsExist(root, manifest) {
  const declared = [
    ...(manifest.esmodules ?? []),
    ...(manifest.scripts ?? []),
    ...(manifest.styles ?? []),
    ...(manifest.languages ?? []).map((entry) => entry.path),
  ];
  for (const item of declared) {
    const info = await stat(resolve(root, item));
    assert.equal(info.isFile(), true, `${manifest.id} declared path missing: ${item}`);
  }
}

async function validateRelativeImports(root) {
  const files = (await walk(root)).filter((path) => [".js", ".mjs"].includes(extname(path)) && !path.includes(`${sep}qa${sep}`));
  let count = 0;
  for (const path of files) {
    const source = await readFile(path, "utf8");
    const pattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      count += 1;
      const resolved = resolve(dirname(path), specifier);
      const info = await stat(resolved);
      assert.equal(info.isFile(), true, `missing import ${specifier} from ${relative(projectRoot, path)}`);
      const rel = relative(root, resolved);
      const escapesPackage = rel.startsWith("..") || resolve(root, rel) !== resolved;
      if (escapesPackage) {
        const targetModule = relative(modulesDir, resolved).split(sep)[0];
        const approvedCoreDependency = basename(root) === "simone-gm-panel" && targetModule === "simone-homebrew";
        assert.equal(approvedCoreDependency, true, `cross-package private import from ${relative(projectRoot, path)} to ${specifier}`);
      }
    }
  }
  assert.ok(count > 0, `${root} must contain relative imports to validate`);
  return { files: files.length, imports: count };
}

async function validateModuleAssetReferences(root, moduleId) {
  const files = (await walk(root)).filter((path) => [".js", ".hbs", ".css"].includes(extname(path)) && !path.includes(`${sep}qa${sep}`));
  let references = 0;
  const prefix = `modules/${moduleId}/`;
  for (const path of files) {
    const source = await readFile(path, "utf8");
    const pattern = /modules\/([a-z0-9-]+)\/([A-Za-z0-9_./-]+)/g;
    for (const match of source.matchAll(pattern)) {
      references += 1;
      assert.equal(match[1], moduleId, `${relative(projectRoot, path)} references asset owned by ${match[1]}`);
      const target = resolve(root, match[2]);
      const info = await stat(target);
      assert.equal(info.isFile(), true, `missing module asset ${match[0]} from ${relative(projectRoot, path)}`);
    }
  }
  assert.ok(references > 0, `${moduleId} must expose at least one package-owned module asset`);
}

async function validateI18n(root) {
  const en = await readJson(resolve(root, "languages/en.json"));
  const it = await readJson(resolve(root, "languages/it.json"));
  const enKeys = flattenKeys(en);
  const itKeys = flattenKeys(it);
  assert.deepEqual([...enKeys].sort(), [...itKeys].sort(), `${relative(projectRoot, root)} EN/IT key structure differs`);

  const files = (await walk(root)).filter((path) => [".js", ".hbs"].includes(extname(path)) && !path.includes(`${sep}qa${sep}`));
  const missing = new Set();
  let lookups = 0;
  for (const path of files) {
    const source = await readFile(path, "utf8");
    for (const match of source.matchAll(/SIMONE_GM_PANEL(?:\.[A-Za-z0-9_]+)+/g)) {
      const key = match[0];
      const next = source[match.index + key.length];
      if (next === "$" || next === ".") continue;
      lookups += 1;
      if (!enKeys.has(key)) missing.add(`${relative(projectRoot, path)} -> ${key}`);
    }
  }
  assert.deepEqual([...missing], [], `missing i18n lookups:\n${[...missing].join("\n")}`);
  assert.ok(lookups > 0, `${relative(projectRoot, root)} must contain i18n lookups`);
}

async function releaseContent(root, prefix = "") {
  const files = new Map();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if ([".git", "dist", "node_modules"].includes(entry.name)) continue;
    const absolute = join(root, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [path, content] of await releaseContent(absolute, relativePath)) files.set(path, content);
    } else {
      files.set(relativePath, await readFile(absolute));
    }
  }
  return files;
}

test("three manifests define the approved acyclic package graph", async () => {
  const core = await readJson(resolve(packages.core, "module.json"));
  const luck = await readJson(resolve(packages.luck, "module.json"));
  const sounds = await readJson(resolve(packages.sounds, "module.json"));

  assert.equal(core.id, "simone-gm-panel");
  assert.equal(luck.id, "simone-gm-panel-luck");
  assert.equal(sounds.id, "simone-gm-panel-sounds");
  assert.deepEqual(dependencyIds(core), ["simone-homebrew"]);
  assert.deepEqual(dependencyIds(luck), ["simone-gm-panel"]);
  assert.deepEqual(dependencyIds(sounds), ["simone-gm-panel"]);
  const homebrewDependency = core.relationships.requires.find((entry) => entry.id === "simone-homebrew");
  assert.equal(
    homebrewDependency?.manifest,
    "https://github.com/simone-bianco/simone-homebrew-utils/releases/latest/download/module.json",
  );
  assert.equal(homebrewDependency?.compatibility?.minimum, "1.0.0");
  assert.equal(homebrewDependency?.compatibility?.verified, "1.0.0");
  assert.deepEqual((luck.relationships?.systems ?? []).map((entry) => entry.id), ["dnd5e"]);
  assert.equal((core.relationships?.systems ?? []).length, 0);
  assert.equal((sounds.relationships?.systems ?? []).length, 0);

  for (const [name, root] of Object.entries(packages)) {
    const manifest = { core, luck, sounds }[name];
    assert.equal(manifest.compatibility?.minimum, "14");
    assert.equal(manifest.compatibility?.verified, "14");
    assert.equal(manifest.socket, undefined, `${manifest.id} must not enable sockets`);
    await assertDeclaredPathsExist(root, manifest);
  }
});

test("imports, owned assets and i18n are complete in every package", async (t) => {
  for (const [name, root] of Object.entries(packages)) {
    await t.test(name, async () => {
      const manifest = await readJson(resolve(root, "module.json"));
      await validateRelativeImports(root);
      await validateModuleAssetReferences(root, manifest.id);
      await validateI18n(root);
    });
  }
});

test("core contains no live Dice or Sounds implementation assets", async () => {
  const files = (await walk(packages.core)).map((path) => relative(packages.core, path).replaceAll("\\", "/"));
  const forbidden = files.filter((path) => !path.startsWith("qa/") && /(?:dice|soundboard|audio|group|playlist|token)/i.test(path));
  assert.deepEqual(forbidden, []);

  const productionSources = (await walk(packages.core)).filter((path) => extname(path) === ".js" && !path.includes(`${sep}qa${sep}`));
  for (const path of productionSources) {
    const source = await readFile(path, "utf8");
    assert.equal(source.includes("simone-gm-panel-luck"), false, `${relative(projectRoot, path)} imports/references Luck package`);
    assert.equal(source.includes("simone-gm-panel-sounds"), false, `${relative(projectRoot, path)} imports/references Sounds package`);
  }
});

test("Luck rename identity and publication-source metadata are complete", async () => {
  const manifests = {
    core: await readJson(resolve(packages.core, "module.json")),
    luck: await readJson(resolve(packages.luck, "module.json")),
    sounds: await readJson(resolve(packages.sounds, "module.json")),
  };
  const repositories = {
    core: "https://github.com/simone-bianco/vtt-simone-gm-panel-core",
    luck: "https://github.com/simone-bianco/vtt-simone-gm-panel-luck",
    sounds: "https://github.com/simone-bianco/vtt-simone-gm-panel-audio",
  };

  for (const [name, root] of Object.entries(packages)) {
    const manifest = manifests[name];
    const repository = repositories[name];
    for (const document of ["README.md", "CHANGELOG.md", "LICENSE"]) {
      const documentPath = resolve(root, document);
      assert.equal((await stat(documentPath)).isFile(), true, `${manifest.id} missing ${document}`);
      assert.ok((await readFile(documentPath, "utf8")).trim().length > 0, `${manifest.id} ${document} is empty`);
    }
    assert.equal(manifest.url, repository);
    assert.equal(manifest.manifest, `${repository}/releases/latest/download/module.json`);
    assert.equal(manifest.readme, `${repository.replace("github.com", "raw.githubusercontent.com")}/main/README.md`);
    assert.equal(manifest.changelog, `${repository.replace("github.com", "raw.githubusercontent.com")}/main/CHANGELOG.md`);
    assert.equal(manifest.license, `${repository.replace("github.com", "raw.githubusercontent.com")}/main/LICENSE`);
    assert.equal(manifest.bugs, `${repository}/issues`);
    assert.match(manifest.download, new RegExp(`^${repository.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}/releases/download/v1\\.0\\.0/`));
  }

  const coreManifest = manifests.core.manifest;
  for (const feature of [manifests.luck, manifests.sounds]) {
    const dependency = feature.relationships.requires.find((entry) => entry.id === "simone-gm-panel");
    assert.equal(dependency?.manifest, coreManifest, `${feature.id} must declare the core manifest URL`);
    assert.equal(dependency?.compatibility?.minimum, "1.0.0");
    assert.equal(dependency?.compatibility?.verified, "1.0.0");
  }

  await assert.rejects(
    stat(resolve(modulesDir, "simone-gm-panel-dice")),
    (error) => error?.code === "ENOENT",
    "old live simone-gm-panel-dice package must be absent",
  );

  const luckFiles = (await walk(packages.luck)).map((path) => relative(packages.luck, path).replaceAll("\\", "/"));
  for (const required of [
    "scripts/luck-feature.js",
    "scripts/luck/gm-panel-luck-automation.js",
    "scripts/luck/gm-panel-luck-dice.js",
    "scripts/ui/luck-listeners.js",
    "scripts/ui/gm-panel-luck-view-model.js",
    "styles/module-luck.css",
    "templates/luck-tab.hbs",
  ]) assert.ok(luckFiles.includes(required), `renamed Luck asset missing: ${required}`);
  const forbiddenOldFiles = new Set([
    "scripts/dice-feature.js",
    "scripts/dice/gm-panel-dice-automation.js",
    "scripts/dice/gm-panel-karma-dice.js",
    "scripts/ui/dice-listeners.js",
    "scripts/ui/gm-panel-dice-view-model.js",
    "styles/module-dice.css",
    "templates/dice-tab.hbs",
  ]);
  assert.deepEqual(luckFiles.filter((path) => forbiddenOldFiles.has(path)), []);

  const oldIdOccurrences = [];
  for (const path of (await walk(packages.luck)).filter((entry) => extname(entry) === ".js")) {
    const source = await readFile(path, "utf8");
    if (source.includes("simone-gm-panel-dice")) oldIdOccurrences.push(relative(packages.luck, path).replaceAll("\\", "/"));
  }
  assert.deepEqual(oldIdOccurrences, ["scripts/constants.js"], "old package ID is allowed only as the migration source constant");
});

test("publication repositories exactly mirror approved package sources", async () => {
  const devRoot = resolve(projectRoot, "dev");
  const repositories = {
    core: resolve(devRoot, "vtt-simone-gm-panel-core"),
    luck: resolve(devRoot, "vtt-simone-gm-panel-luck"),
    sounds: resolve(devRoot, "vtt-simone-gm-panel-audio"),
  };

  for (const [name, sourceRoot] of Object.entries(packages)) {
    const source = await releaseContent(sourceRoot);
    const destination = await releaseContent(repositories[name]);
    assert.deepEqual([...destination.keys()].sort(), [...source.keys()].sort(), `${name} publication file list differs`);
    for (const [path, content] of source) {
      assert.equal(destination.get(path)?.equals(content), true, `${name} publication content differs: ${path}`);
    }
  }
});
