import { FEATURE_API_VERSION } from "./constants.js";

const REQUIRED_FUNCTIONS = ["prepareContext", "activate", "deactivate", "bind"];

export class FeatureRegistry {
  #features = new Map();
  #frozen = false;

  registerFeature(descriptor) {
    if (this.#frozen) {
      throw new Error("GM Panel feature registration is frozen; reload Foundry after changing active feature modules");
    }
    const normalized = validateDescriptor(descriptor);
    if (this.#features.has(normalized.id)) {
      throw new Error(`GM Panel feature already registered: ${normalized.id}`);
    }
    this.#features.set(normalized.id, normalized);
    return normalized;
  }

  unregisterFeature(featureId) {
    if (this.#frozen) {
      throw new Error("GM Panel features cannot be hot-unloaded; reload Foundry after changing active modules");
    }
    return this.#features.delete(featureId);
  }

  freeze() {
    this.#frozen = true;
  }

  getFeature(featureId) {
    return this.#features.get(featureId) ?? null;
  }

  getFeatures() {
    return [...this.#features.values()].sort((left, right) =>
      left.order - right.order || left.id.localeCompare(right.id));
  }
}

function validateDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new TypeError("GM Panel feature descriptor must be an object");
  }
  if (descriptor.apiVersion !== FEATURE_API_VERSION) {
    throw new Error(`Unsupported GM Panel feature apiVersion: ${String(descriptor.apiVersion)}`);
  }

  const id = typeof descriptor.id === "string" ? descriptor.id.trim() : "";
  const labelKey = typeof descriptor.labelKey === "string" ? descriptor.labelKey.trim() : "";
  const icon = typeof descriptor.icon === "string" ? descriptor.icon.trim() : "";
  const template = typeof descriptor.template === "string" ? descriptor.template.trim() : "";
  if (!id || !labelKey || !icon || !template) {
    throw new Error("GM Panel feature descriptor requires id, labelKey, icon and template");
  }
  for (const name of REQUIRED_FUNCTIONS) {
    if (typeof descriptor[name] !== "function") {
      throw new Error(`GM Panel feature ${id} is missing ${name}()`);
    }
  }

  return Object.freeze({
    apiVersion: FEATURE_API_VERSION,
    id,
    labelKey,
    icon,
    order: Number.isFinite(Number(descriptor.order)) ? Number(descriptor.order) : 0,
    template,
    footerTemplate: typeof descriptor.footerTemplate === "string" && descriptor.footerTemplate.trim()
      ? descriptor.footerTemplate.trim()
      : null,
    prepareContext: descriptor.prepareContext,
    activate: descriptor.activate,
    deactivate: descriptor.deactivate,
    bind: descriptor.bind,
  });
}
