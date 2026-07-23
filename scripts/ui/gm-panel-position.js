import {
  DEFAULT_PANEL_STATE,
  HEADER_COLLAPSED_HEIGHT,
} from "../constants.js";

/**
 * Clamp a numeric value between min and max, falling back to a default if invalid.
 */
export function clampNumber(value, fallback, min, max) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(Math.max(numericValue, min), max);
}

/**
 * Sanitize panel position/size against viewport bounds.
 * Ensures the panel is fully visible and within reasonable size limits.
 */
export function sanitizePosition(state) {
  const viewportWidth = globalThis.innerWidth || 1920;
  const viewportHeight = globalThis.innerHeight || 1080;

  const width = clampNumber(state?.width, DEFAULT_PANEL_STATE.width, 320, Math.max(320, viewportWidth - 24));
  const height = clampNumber(state?.height, DEFAULT_PANEL_STATE.height, 220, Math.max(220, viewportHeight - 24));
  const maxLeft = Math.max(12, viewportWidth - width - 12);
  const maxTop = Math.max(12, viewportHeight - HEADER_COLLAPSED_HEIGHT - 12);

  return {
    left: clampNumber(state?.left, DEFAULT_PANEL_STATE.left, 12, maxLeft),
    top: clampNumber(state?.top, DEFAULT_PANEL_STATE.top, 12, maxTop),
    width,
    height,
  };
}
