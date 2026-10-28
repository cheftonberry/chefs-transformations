import {BUILTIN_PRESETS} from "./builtin-presets.mjs";

export function getAnimationCatalog(packs = game.settings.get("chefs-transformations", "installedPacks") ?? {}) {
  const catalog = Object.fromEntries(BUILTIN_PRESETS.map(effect => [effect.id, {...effect}]));
  for (const pack of Object.values(packs)) for (const effect of pack.animations ?? []) {
    if (!catalog[effect.id]) catalog[effect.id] = {...effect};
  }
  return catalog;
}

export function validatePack(source) {
  if (source?.format !== "chefs-transformations-pack" || source.schemaVersion !== 1)
    throw new Error("This is not a supported Chef's Transformations pack.");
  const id = value => {
    if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value)) throw new Error("Invalid pack or animation ID.");
    return value;
  };
  const text = value => {
    if (typeof value !== "string" || !value.trim() || value.length > 160) throw new Error("Missing or invalid pack name/version.");
    return value.trim();
  };
  const path = value => {
    if (typeof value !== "string" || !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.webm$/.test(value))
      throw new Error("Pack videos must use safe relative .webm paths.");
    return value;
  };
  const number = (value, fallback, min, max) => {
    const n = value ?? fallback;
    if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) throw new Error("Invalid animation timing or display setting.");
    return n;
  };
  if (!Array.isArray(source.animations) || !source.animations.length || source.animations.length > 50)
    throw new Error("A pack must contain 1–50 animations.");
  const ids = new Set(BUILTIN_PRESETS.map(p => p.id));
  const animations = source.animations.map(p => {
    const effectId = id(p.id);
    if (ids.has(effectId)) throw new Error(`Duplicate or stock animation ID: ${effectId}`);
    ids.add(effectId);
    return {id: effectId, name: text(p.name), introSrc: path(p.introSrc), src: path(p.src),
      loopStart: number(p.loopStart, 0, 0, 3.99), transformAt: number(p.transformAt, 5 + 16 / 30, 0, 8),
      scale: number(p.scale, 2.1, .1, 10), opacity: number(p.opacity, 1, 0, 1), sustainAura: p.sustainAura !== false};
  });
  return {format: source.format, schemaVersion: 1, id: id(source.id), title: text(source.title), version: text(source.version), animations};
}
