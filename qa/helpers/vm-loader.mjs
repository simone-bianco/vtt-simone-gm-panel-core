import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

/**
 * Load real project ES modules in an isolated VM without requiring package.json type=module.
 * Relative imports resolve to real files unless explicitly replaced with a stub source.
 */
export async function loadVmModule(entryPath, { globals = {}, stubs = {} } = {}) {
  if (typeof vm.SourceTextModule !== "function") {
    throw new Error("vm.SourceTextModule unavailable; run Node with --experimental-vm-modules");
  }

  const sandbox = {
    console,
    structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    ...globals,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const absoluteStubs = new Map();
  const specifierStubs = new Map();
  for (const [key, source] of Object.entries(stubs)) {
    if (isAbsolute(key)) absoluteStubs.set(resolve(key), source);
    else specifierStubs.set(key, source);
  }

  const cache = new Map();

  async function load(identifier, sourceOverride = undefined) {
    if (cache.has(identifier)) return cache.get(identifier);

    let source = sourceOverride;
    let moduleIdentifier = identifier;
    if (source === undefined) {
      source = absoluteStubs.get(identifier);
      if (source === undefined) source = await readFile(identifier, "utf8");
      moduleIdentifier = pathToFileURL(identifier).href;
    }

    const module = new vm.SourceTextModule(source, {
      context,
      identifier: moduleIdentifier,
      initializeImportMeta(meta) {
        meta.url = moduleIdentifier;
      },
    });
    cache.set(identifier, module);

    await module.link(async (specifier, referencingModule) => {
      if (specifierStubs.has(specifier)) {
        const stubId = `stub:${specifier}`;
        return load(stubId, specifierStubs.get(specifier));
      }
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        throw new Error(`Unstubbed bare import ${specifier} from ${referencingModule.identifier}`);
      }
      const resolvedPath = resolve(fileURLToPath(new URL(specifier, referencingModule.identifier)));
      return load(resolvedPath);
    });

    return module;
  }

  const absoluteEntry = resolve(entryPath);
  const root = await load(absoluteEntry);
  await root.evaluate();
  return { namespace: root.namespace, context, sandbox, module: root };
}

export function moduleStubPath(path) {
  return resolve(path);
}
