/** Core DOM helpers for the GM Panel ApplicationV2 shell. */

export function getFrameElement(app) {
  const element = app.element;
  if (!(element instanceof HTMLElement)) return null;
  const frame = element.closest(".application");
  return frame instanceof HTMLElement ? frame : null;
}

export function getHeaderElement(app) {
  const frame = getFrameElement(app);
  if (!(frame instanceof HTMLElement)) return null;
  const header = frame.querySelector(".window-header");
  return header instanceof HTMLElement ? header : null;
}

export function getContentElement(app) {
  const frame = getFrameElement(app);
  if (!(frame instanceof HTMLElement)) return null;
  const content = frame.querySelector(".window-content");
  return content instanceof HTMLElement ? content : null;
}
