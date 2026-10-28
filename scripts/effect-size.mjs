export const EFFECT_RESIZE_MS = 600;

// Read prepared document scales: D&D applies dynamic-token size adjustments
// here even when the grid footprint stays unchanged. Never use screen bounds,
// which already include camera zoom.
export function tokenEffectSize(token) {
  const dimensions = token.document?.getSize?.();
  const texture = token.document?.texture;
  const scale = value => Number.isFinite(value) ? Math.abs(value) : 1;
  const width = dimensions?.width ?? token.w;
  const height = dimensions?.height ?? token.h;
  return Math.max(width * scale(texture?.scaleX), height * scale(texture?.scaleY));
}

export function createEffectSize(size, now) {
  return { from: size, to: size, startedAt: now };
}

function sample(state, now) {
  const t = Math.min(1, Math.max(0, (now - state.startedAt) / EFFECT_RESIZE_MS));
  const eased = t * t * (3 - 2 * t);
  return state.from + (state.to - state.from) * eased;
}

// Sizes are canvas-world pixels. Applying camera zoom afterward ensures a
// camera change never starts or delays a token-size transition.
export function updateEffectSize(state, target, now) {
  const current = sample(state, now);
  if ( Number.isFinite(target) && target > 0 && target !== state.to ) {
    state.from = current;
    state.to = target;
    state.startedAt = now;
    return current;
  }
  return current;
}
