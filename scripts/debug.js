import { createLogger } from "../../simone-homebrew/scripts/core/logger.js";
import { MODULE_ID, SETTINGS } from "./constants.js";

const logger = createLogger(MODULE_ID);

export function isDebugEnabled() {
  try {
    return game.settings.get(MODULE_ID, SETTINGS.DEBUG) === true;
  } catch {
    return false;
  }
}

export function debug(message, payload) {
  if (!isDebugEnabled()) return;
  if (payload === undefined) {
    logger.log(`[DEBUG] ${message}`);
    return;
  }

  logger.log(`[DEBUG] ${message}`, payload);
}

export function warn(message, payload) {
  if (payload === undefined) {
    logger.warn(message);
    return;
  }

  logger.warn(message, payload);
}

export function error(message, payload) {
  if (payload === undefined) {
    logger.error(message);
    return;
  }

  logger.error(message, payload);
}
