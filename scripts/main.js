import {
  API_NAMESPACE,
  FEATURE_API_VERSION,
  MODULE_ID,
} from "./constants.js";
import { FeatureRegistry } from "./feature-registry.js";
import { error, warn } from "./debug.js";
import { migrateCoreState, registerSettings } from "./settings.js";
import { SimoneGmPanelApp } from "./ui/gm-panel-app.js";

const registry = new FeatureRegistry();
let panelApp = null;

Hooks.once("init", () => {
  registerSettings();

  const api = Object.freeze({
    apiVersion: FEATURE_API_VERSION,
    registerFeature: (descriptor) => registry.registerFeature(descriptor),
    unregisterFeature: (featureId) => registry.unregisterFeature(featureId),
    refresh: (options = {}) => refresh(options),
    ensurePanel,
    openPanel,
    refreshPanel,
  });

  game[API_NAMESPACE] = {
    ...(game[API_NAMESPACE] ?? {}),
    api,
    app: null,
  };

  const module = game.modules.get(MODULE_ID);
  if (module) module.api = api;
});

Hooks.once("ready", async () => {
  try {
    await migrateCoreState();
    if (game.user?.isGM) await openPanel();
  } catch (cause) {
    error("Failed to initialize GM Panel core", cause);
  }
});

Hooks.on("canvasReady", () => {
  if (!game.user?.isGM || !panelApp?.rendered) return;
  panelApp.bringToFront();
});

export function ensurePanel() {
  if (!game.user?.isGM) {
    warn("GM Panel requested by a non-GM client");
    return null;
  }

  if (!panelApp) {
    panelApp = new SimoneGmPanelApp({ registry });
    game[API_NAMESPACE].app = panelApp;
  }
  return panelApp;
}

export async function openPanel() {
  const app = ensurePanel();
  if (!app) return null;
  if (app.rendered) {
    app.bringToFront();
    return app;
  }
  await app.render({ force: true });
  return app;
}

export async function refreshPanel() {
  const app = ensurePanel();
  if (!app) return null;
  await app.render({ force: true });
  return app;
}

async function refresh({ featureId } = {}) {
  const app = ensurePanel();
  if (!app) return null;
  if (featureId !== undefined) return app.selectFeature(featureId);
  return refreshPanel();
}
