import { registerSetting } from "../../simone-homebrew/scripts/core/settings-base.js";
import {
  CORE_PANEL_STATE_FLAG,
  CORE_STATE_MIGRATION_FLAG,
  CORE_STATE_MIGRATION_VERSION,
  DEFAULT_PANEL_STATE,
  LEGACY_PANEL_STATE_FLAG,
  MODULE_ID,
  SETTINGS,
} from "./constants.js";

export function registerSettings() {
  registerSetting(MODULE_ID, SETTINGS.DEBUG, {
    name: "SIMONE_GM_PANEL.Settings.Debug.Name",
    hint: "SIMONE_GM_PANEL.Settings.Debug.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });
}

export async function migrateCoreState() {
  const user = game.user;
  if (!user) return;

  const marker = user.getFlag(MODULE_ID, CORE_STATE_MIGRATION_FLAG);
  if (Number(marker) >= CORE_STATE_MIGRATION_VERSION) return;

  const destination = user.getFlag(MODULE_ID, CORE_PANEL_STATE_FLAG);
  if (destination === undefined) {
    const legacy = user.getFlag(MODULE_ID, LEGACY_PANEL_STATE_FLAG);
    const migrated = normalizePanelState({
      ...(legacy && typeof legacy === "object" ? legacy : {}),
      activeFeatureId: migrateFeatureId(legacy?.activeFeatureId ?? legacy?.activeTab ?? null),
    });
    await user.setFlag(MODULE_ID, CORE_PANEL_STATE_FLAG, migrated);
  } else if (Number(marker) < 2 && destination?.activeFeatureId === "dice") {
    await user.setFlag(MODULE_ID, CORE_PANEL_STATE_FLAG, normalizePanelState({
      ...destination,
      activeFeatureId: "luck",
    }));
  }

  await user.setFlag(MODULE_ID, CORE_STATE_MIGRATION_FLAG, CORE_STATE_MIGRATION_VERSION);
}

export function getPanelState() {
  const raw = game.user?.getFlag(MODULE_ID, CORE_PANEL_STATE_FLAG);
  return normalizePanelState(raw);
}

export async function setPanelState(nextState) {
  const normalized = normalizePanelState(nextState);
  return game.user?.setFlag(MODULE_ID, CORE_PANEL_STATE_FLAG, normalized);
}

export function normalizePanelState(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    top: finiteNumber(value.top, DEFAULT_PANEL_STATE.top),
    left: finiteNumber(value.left, DEFAULT_PANEL_STATE.left),
    width: finiteNumber(value.width, DEFAULT_PANEL_STATE.width),
    height: finiteNumber(value.height, DEFAULT_PANEL_STATE.height),
    collapsed: value.collapsed === true,
    activeFeatureId: typeof value.activeFeatureId === "string" && value.activeFeatureId.trim()
      ? value.activeFeatureId.trim()
      : null,
  };
}

function finiteNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}


function migrateFeatureId(value) {
  return value === "dice" ? "luck" : value;
}
