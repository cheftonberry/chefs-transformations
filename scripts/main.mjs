import { createTransformationAudio } from "./transformation-audio.mjs";
import { actorPresetId, registerActorConfiguration } from "./actor-configuration.mjs";
import {readTransformationPresets, renderTransformationPresetPage} from "./preset-configuration.mjs";
import {canManageTransformations, canUseTransformations, registerTransformationHud, transformationHostActor} from "./preset-hud.mjs";
import {createPf2eTemporaryActor, cleanupPf2eTemporaryActor, cleanupOrphanedPf2eTemporaryActors} from "./pf2e-temp-form.mjs";
import { BUILTIN_PRESETS } from "./builtin-presets.mjs";
import {registerPackSettings} from "./pack-manager.mjs";
import {getAnimationCatalog} from "./animation-catalog.mjs";
import { configureTokenTransition } from "./token-transition.mjs";
import { createEffectSize, updateEffectSize, tokenEffectSize } from "./effect-size.mjs";
import { crossfadeToken, cancelTokenCrossfades } from "./snapshot-crossfade.mjs";
import { createTransformationCue } from "./transformation-cue.mjs";

const MODULE_ID = "chefs-transformations";
const DEFAULT_EFFECT = BUILTIN_PRESETS[0];
const SUPPORTED_SYSTEMS = new Set(["dnd5e", "pf2e"]);

const transformingSelections = new Map();
const crossfadeTokens = new Set();
const activeEffects = new Map();
const audioWithoutEffect = new Map();
const transformationCues = new Map();
let effectLayer = null;
let transformationAudio;
const EFFECT_FADE_MS = 750;
const PATCHED = Symbol.for(`${MODULE_ID}.patched`);

Hooks.once("init", () => {
  if (!SUPPORTED_SYSTEMS.has(game.system.id)) return;
  if (game.system.id === "pf2e") CONFIG.queries[`${MODULE_ID}.temporaryForm`] = handlePf2eTemporaryFormQuery;
  // Sidebar context options are built before ready, during the first render.
  registerActorConfiguration(openActorConfiguration);
  registerPackSettings();
  game.settings.register(MODULE_ID, "campaignPreset", {
    scope: "world",
    config: false,
    type: String,
    default: ""
  });
  game.settings.register(MODULE_ID, "campaignAudioDb", {scope: "world", config: false, type: Number, default: 0});
  game.settings.register(MODULE_ID, "campaignAudio", {scope: "world", config: false, type: String, default: ""});
  game.settings.register(MODULE_ID, "campaignSustainAura", {
    scope: "world",
    config: false,
    type: Boolean,
    default: true
  });
});

Hooks.once("ready", async () => {
  if (!SUPPORTED_SYSTEMS.has(game.system.id)) return;
  if (game.system.id === "pf2e" && game.user.isGM)
    cleanupOrphanedPf2eTemporaryActors().catch(error => console.error(`${MODULE_ID} | Temporary form cleanup failed`, error));

  transformationAudio = createTransformationAudio(game);
  registerTransformationHud(activateTransformationPreset, revertTransformationPreset);
  registerManualTransformationHooks();
  patchTokenCrossfade();
  if (game.system.id === "dnd5e") {
    patchTransformationMethods();
  }
});

Hooks.on("dnd5e.transformActor", (host, source, data) => {
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.transformationsGmOnly`, host.getFlag(MODULE_ID, "transformationsGmOnly") !== false);
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.transformationPresets`, readTransformationPresets(host));
  const selection = transformingSelections.get(host.uuid);
  if ( !transformingSelections.has(host.uuid) ) return;
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.preset`, selection?.presetId ?? "");
  if ( selection ) foundry.utils.setProperty(data, `flags.${MODULE_ID}.activeSustainAura`, selection.sustainAura);
});

// Mark transformation token updates so every connected client uses the same
// snapshot crossfade without exposing the live mesh during its resize.
Hooks.on("preUpdateToken", (document, changes, options) => {
  if ( !crossfadeTokens.has(document.uuid) ) return;
  configureTokenTransition(document, changes, options);
});

Hooks.on("deleteToken", document => {
  if (game.system.id !== "pf2e" || !game.user.isGM) return;
  const actorId = document.getFlag(MODULE_ID, "manualTransformation")?.temporaryActorId;
  if (actorId) setTimeout(() => cleanupPf2eTemporaryActor(actorId, document.uuid)
    .catch(error => console.error(`${MODULE_ID} | Temporary form cleanup failed`, error)), 0);
});

function patchTokenCrossfade() {
  const proto = CONFIG.Token.objectClass?.prototype;
  const patched = Symbol.for(`${MODULE_ID}.crossfade`);
  if ( !proto?.animate || proto[patched] ) return;
  const animate = proto.animate;
  proto.animate = async function(to, options = {}) {
    if ( !options.ctfxCrossfade ) return animate.call(this, to, options);
    if ( this.destroyed ) return;
    const { ctfxCrossfade, ...updateOptions } = options;
    return crossfadeToken(this, {
      duration: options.duration ?? 600,
      // Foundry commits texture paths into its private animation state at the
      // end of animate(). Redrawing alone does not apply the destination.
      applyUpdate: () => animate.call(this, to, { ...updateOptions, duration: 0, chain: false })
    });
  };
  Object.defineProperty(proto, patched, { value: true });
}

Hooks.on("canvasReady", () => {
  if (!SUPPORTED_SYSTEMS.has(game.system.id)) return;
  const presets = getAnimationCatalog();
  for ( const token of canvas.tokens?.placeables ?? [] ) {
    const presetId = token.actor?.getFlag(MODULE_ID, "preset");
    if ( token.actor?.isPolymorphed && presets[presetId] ) {
      const sustainAura = token.actor.getFlag(MODULE_ID, "activeSustainAura")
        ?? token.actor.getFlag(MODULE_ID, "sustainAura") ?? (presets[presetId].sustainAura !== false);
      if ( sustainAura ) attachEffect(token, { ...presets[presetId], sustainAura }, { resumeLoop: true });
    }
  }
});

function isActorTransformed(actor, token) {
  return Boolean(token?.document?.getFlag(MODULE_ID, "manualTransformation") || actor?.isPolymorphed);
}

function animationForTarget(actor, requestedId) {
  const presets = getAnimationCatalog();
  const fallbackId = actorPresetId(actor, game.actors, game.settings.get(MODULE_ID, "campaignPreset"));
  const id = requestedId === "" ? "" : (requestedId && presets[requestedId] ? requestedId : fallbackId);
  return {id, preset: presets[id]};
}

function effectSettingsForTarget(actor, saved = {}) {
  const {id, preset} = animationForTarget(actor, saved.animationPresetId);
  const originalId = game.system.id === "dnd5e" ? actor.getFlag("dnd5e", "originalActor") : null;
  const settingsActor = (originalId && game.actors.get(originalId)) || actor;
  const override = settingsActor.getFlag(MODULE_ID, "defaultPreset");
  return {
    id, preset,
    sustainAura: saved.sustainAura ?? settingsActor.getFlag(MODULE_ID, "sustainAura")
      ?? (override == null ? game.settings.get(MODULE_ID, "campaignSustainAura") : preset?.sustainAura !== false),
    audioSrc: saved.audioSrc ?? settingsActor.getFlag(MODULE_ID, "audioSrc")
      ?? (override == null ? game.settings.get(MODULE_ID, "campaignAudio") : ""),
    audioDb: saved.audioDb ?? settingsActor.getFlag(MODULE_ID, "audioDb")
      ?? (override == null ? game.settings.get(MODULE_ID, "campaignAudioDb") : 0)
  };
}

const manualVisuals = new Map();
function syncManualTransformation(token, {resume = false} = {}) {
  if (!token?.document || !canvas.ready) return;
  const key = token.document.uuid;
  const state = token.document.getFlag(MODULE_ID, "manualTransformation");
  const previous = manualVisuals.get(key);
  if (previous?.id === state?.id) return;
  if (previous) {
    previous.stopAudio();
    manualVisuals.delete(key);
    fadeEffect(key);
  }
  if (!state) return;
  const actor = token.actor;
  const {preset, sustainAura, audioSrc, audioDb} = effectSettingsForTarget(actor, state);
  if (resume && !sustainAura) return;
  if (preset) attachEffect(token, {...preset, sustainAura}, {resumeLoop: resume});
  let stopAudio = () => {};
  const authority = game.users.activeGM ?? game.users.find(user => user.active && actor.testUserPermission(user, "OWNER"));
  if (!resume && audioSrc && authority?.id === game.user.id) {
    stopAudio = transformationAudio.start(audioSrc, audioVolume(audioDb), {loop: sustainAura});
    if (!preset && !sustainAura) setTimeout(stopAudio, 12000);
  }
  manualVisuals.set(key, {id: state.id, stopAudio});
  const effect = activeEffects.get(key);
  if (effect) {
    effect.stopAudio = stopAudio;
    const animation = effect.introVideo ?? effect.video;
    if (!sustainAura) animation.addEventListener("ended", stopAudio, {once: true});
    animation.addEventListener("error", stopAudio, {once: true});
  }
}

function registerManualTransformationHooks() {
  Hooks.on("updateToken", document => syncManualTransformation(document.object));
  Hooks.on("canvasReady", () => {
    manualVisuals.clear();
    for (const token of canvas.tokens?.placeables ?? []) syncManualTransformation(token, {resume: true});
  });
  if (canvas.ready) for (const token of canvas.tokens?.placeables ?? []) syncManualTransformation(token, {resume: true});
}

async function handlePf2eTemporaryFormQuery({sceneId, tokenId, action, presetId, actorId}, {user}) {
  if (game.system.id !== "pf2e" || !game.user.isGM) throw new Error("A PF2e GM must prepare the transformation form.");
  const document = game.scenes.get(sceneId)?.tokens.get(tokenId);
  if (!document) throw new Error("The transformation token is unavailable.");
  const state = document.getFlag(MODULE_ID, "manualTransformation");
  const host = game.actors.get(state?.original?.actorId ?? document.actorId);
  if (!host) throw new Error("The original actor is unavailable.");
  if (action === "create") {
    if (!canUseTransformations(host, user)) throw new Error("You cannot use this character's transformations.");
    if (state) throw new Error("Revert this form before choosing another.");
    const entry = readTransformationPresets(host).find(saved => saved.id === presetId);
    if (!entry) throw new Error("This transformation preset is no longer saved.");
    const source = await fromUuid(entry.actorUuid);
    if (!source || source.documentName !== "Actor") throw new Error("The preset's target actor is unavailable.");
    const temporary = await createPf2eTemporaryActor(host, source, document);
    return {actorId: temporary.id, sourceName: source.name, token: temporary.prototypeToken.toObject()};
  }
  if (action === "cleanup") {
    const allowed = user.isGM || (host.getFlag(MODULE_ID, "transformationsGmOnly") === false
      && host.testUserPermission(user, "OWNER"));
    if (!allowed) throw new Error("You cannot clean up this character's transformation.");
    const temporary = game.actors.get(actorId)?.getFlag(MODULE_ID, "temporaryForm");
    if (temporary?.hostActorId !== host.id || temporary?.tokenUuid !== document.uuid)
      throw new Error("The temporary transformation actor does not match this token.");
    return {cleaned: await cleanupPf2eTemporaryActor(actorId, document.uuid)};
  }
  throw new Error("Unknown transformation action.");
}

async function requestPf2eTemporaryForm(document, action, {presetId, actorId} = {}) {
  const payload = {sceneId: document.parent?.id, tokenId: document.id, action, presetId, actorId};
  if (game.user.isGM) return handlePf2eTemporaryFormQuery(payload, {user: game.user});
  const gm = game.users.activeGM;
  if (!gm) throw new Error("A GM must be online to prepare PF2e transformation forms.");
  const result = await gm.query(`${MODULE_ID}.temporaryForm`, payload, {timeout: 30000});
  if (action === "create") {
    for (let attempt = 0; attempt < 50 && !game.actors.get(result.actorId); attempt++)
      await new Promise(resolve => setTimeout(resolve, 100));
    if (!game.actors.get(result.actorId)) {
      try { await gm.query(`${MODULE_ID}.temporaryForm`, {...payload, action: "cleanup", actorId: result.actorId}); }
      catch (error) { console.warn(`${MODULE_ID} | Temporary form cleanup deferred`, error); }
      throw new Error("The temporary PF2e form did not reach this client.");
    }
  }
  return result;
}

async function releasePf2eTemporaryForm(document, actorId) {
  if (!actorId) return;
  try { await requestPf2eTemporaryForm(document, "cleanup", {actorId}); }
  catch (error) { console.warn(`${MODULE_ID} | Temporary form cleanup deferred`, error); }
}

async function activateTransformationPreset(token, entry) {
  if (!SUPPORTED_SYSTEMS.has(game.system.id)) throw new Error("Transformation presets are supported only in D&D5e and PF2e.");
  if (!canUseTransformations(token.actor)) throw new Error("You cannot use this character's transformations.");
  if (!readTransformationPresets(token.actor).some(saved => saved.id === entry.id)) throw new Error("This transformation preset is no longer saved.");
  if (game.system.id === "dnd5e") {
    const source = await fromUuid(entry.actorUuid);
    if (!source || source.documentName !== "Actor") throw new Error("The preset's source actor is unavailable.");
    const Setting = (globalThis.dnd5e ?? game.dnd5e)?.dataModels?.settings?.TransformationSetting;
    if (!Setting) throw new Error("D&D5e transformation settings are unavailable.");
    await token.actor.transformInto(source, new Setting(entry.settings), {ctfxPresetSettings: entry});
    return;
  }
  const document = token.document;
  if (document.getFlag(MODULE_ID, "manualTransformation")) throw new Error("Revert this form before choosing another.");
  const settings = entry.settings ?? {};
  const {id: animationPresetId, preset: animation, sustainAura, audioSrc, audioDb} = effectSettingsForTarget(token.actor, entry);
  const originalToken = document.toObject();
  const temporary = await requestPf2eTemporaryForm(document, "create", {presetId: entry.id});
  const targetToken = temporary.token;
  const state = {
    id: foundry.utils.randomID(), presetId: entry.id, animationPresetId,
    temporaryActorId: temporary.actorId,
    sustainAura, audioSrc, audioDb,
    original: {
      actorId: document.actorId, actorLink: document.actorLink,
      texture: document.texture.src, width: document.width, height: document.height,
      name: originalToken.name, sight: originalToken.sight,
      detectionModes: originalToken.detectionModes, light: originalToken.light,
      bar1: originalToken.bar1, bar2: originalToken.bar2
    }
  };
  let cue;
  try {
    if (settings.artwork !== false && !targetToken?.texture?.src)
      throw new Error("The target actor has no token artwork.");
    await document.setFlag(MODULE_ID, "manualTransformation", state);
    const effect = activeEffects.get(document.uuid);
    cue = animation ? createTransformationCue(effect?.introVideo ?? effect?.video, animation.transformAt) : null;
    if (cue) await cue.ready;
    const changes = {actorId: temporary.actorId, actorLink: state.original.actorLink};
    if (settings.artwork !== false) changes["texture.src"] = targetToken.texture.src;
    if (settings.size !== false) {
      changes.width = targetToken.width;
      changes.height = targetToken.height;
    }
    if (settings.tokenName !== false) changes.name = targetToken.name || temporary.sourceName;
    if (settings.vision !== false) {
      changes.sight = foundry.utils.deepClone(targetToken.sight);
      changes.detectionModes = foundry.utils.deepClone(targetToken.detectionModes);
    }
    if (settings.lighting !== false) changes.light = foundry.utils.deepClone(targetToken.light);
    changes.bar1 = foundry.utils.deepClone(targetToken.bar1);
    changes.bar2 = foundry.utils.deepClone(targetToken.bar2);
    crossfadeTokens.add(document.uuid);
    try { await document.update(changes); } finally { crossfadeTokens.delete(document.uuid); }
  } catch (error) {
    try {
      await document.update({
        actorId: state.original.actorId, actorLink: state.original.actorLink,
        "texture.src": state.original.texture, width: state.original.width, height: state.original.height,
        name: state.original.name, sight: state.original.sight,
        detectionModes: state.original.detectionModes, light: state.original.light,
        bar1: state.original.bar1, bar2: state.original.bar2
      });
    } catch (rollbackError) { console.error(`${MODULE_ID} | Token rollback failed`, rollbackError); }
    if (document.actorId === state.original.actorId) {
      try { await document.unsetFlag(MODULE_ID, "manualTransformation"); }
      catch (rollbackError) { console.error(`${MODULE_ID} | Transformation flag rollback failed`, rollbackError); }
      await releasePf2eTemporaryForm(document, temporary.actorId);
    }
    throw error;
  } finally { cue?.release(); }
}

async function revertTransformationPreset(token) {
  if (!SUPPORTED_SYSTEMS.has(game.system.id)) throw new Error("Transformation presets are supported only in D&D5e and PF2e.");
  if (!canManageTransformations(transformationHostActor(token))) throw new Error("You cannot revert this character's transformation.");
  if (game.system.id === "dnd5e") {
    if (!token.actor.isPolymorphed) return;
    await token.actor.revertOriginalForm();
    return;
  }
  const document = token.document;
  const state = document.getFlag(MODULE_ID, "manualTransformation");
  if (!state) return;
  const original = state.original ?? {};
  const changes = {width: original.width, height: original.height};
  if (original.texture) changes["texture.src"] = original.texture;
  if (state.temporaryActorId) {
    changes.actorId = original.actorId;
    changes.actorLink = original.actorLink;
    changes.bar1 = original.bar1;
    changes.bar2 = original.bar2;
  }
  if (state.temporaryActorId) {
    changes.name = original.name;
    changes.sight = original.sight;
    changes.detectionModes = original.detectionModes;
    changes.light = original.light;
  }
  crossfadeTokens.add(document.uuid);
  try {
    await document.update(changes);
    await document.unsetFlag(MODULE_ID, "manualTransformation");
  } finally { crossfadeTokens.delete(document.uuid); }
  if (state.temporaryActorId) await releasePf2eTemporaryForm(document, state.temporaryActorId);
}

function openActorConfiguration(actor) {
  if (!SUPPORTED_SYSTEMS.has(game.system.id)) return;
  const originalId = game.system?.id === "dnd5e" ? actor?.getFlag("dnd5e", "originalActor") : null;
  actor = (originalId && game.actors.get(originalId)) || actor;
  if (!game.user.isGM || !actor) return;
  const selected = actor.getFlag(MODULE_ID, "defaultPreset") ?? "__campaign__";
  const campaign = game.settings.get(MODULE_ID, "campaignPreset") ?? "";
  const presets = getAnimationCatalog();
  const initialPreset = presets[selected === "__campaign__" ? campaign : selected];
  const state = {
    page: "animation",
    transformationsGmOnly: actor.getFlag(MODULE_ID, "transformationsGmOnly") !== false,
    transformationPresets: structuredClone(readTransformationPresets(actor)),
    selected,
    audioDb: normalizeAudioDb(actor.getFlag(MODULE_ID, "audioDb") ?? (selected === "__campaign__" ? game.settings.get(MODULE_ID, "campaignAudioDb") : 0)),
    audioSrc: actor.getFlag(MODULE_ID, "audioSrc") ?? (selected === "__campaign__" ? game.settings.get(MODULE_ID, "campaignAudio") ?? "" : ""),
    sustainAura: actor.getFlag(MODULE_ID, "sustainAura")
      ?? (selected === "__campaign__"
        ? game.settings.get(MODULE_ID, "campaignSustainAura")
        : initialPreset?.sustainAura !== false)
  };
  const context = { actor };
  const dialog = new foundry.applications.api.DialogV2({
    window: { title: `Configure Transformations: ${actor.name}` },
    classes: ["ctfx-configuration"],
    position: { width: 600 },
    content: '<div class="ctfx-panel"></div>',
    buttons: [{ action: "save", label: "Save", icon: "fa-solid fa-check", default: true,
      callback: async () => {
        if (!game.user.isGM) return;
        await rememberSelection(context, state.selected);
        if (state.selected === "__campaign__" && state.audioDb === normalizeAudioDb(game.settings.get(MODULE_ID, "campaignAudioDb"))) {
          await actor.unsetFlag(MODULE_ID, "audioDb");
        } else await actor.setFlag(MODULE_ID, "audioDb", state.audioDb);
        if (state.selected === "__campaign__" && state.audioSrc === (game.settings.get(MODULE_ID, "campaignAudio") ?? "")) {
          await actor.unsetFlag(MODULE_ID, "audioSrc");
        } else await actor.setFlag(MODULE_ID, "audioSrc", state.audioSrc);
        if (state.selected === "__campaign__"
          && state.sustainAura === game.settings.get(MODULE_ID, "campaignSustainAura")) {
          await actor.unsetFlag(MODULE_ID, "sustainAura");
        } else await actor.setFlag(MODULE_ID, "sustainAura", state.sustainAura);
        await actor.setFlag(MODULE_ID, "transformationsGmOnly", state.transformationsGmOnly);
        await actor.setFlag(MODULE_ID, "transformationPresets", state.transformationPresets);
        ui.notifications.info(`Transformation animation saved for ${actor.name}.`);
      }
    }, { action: "campaign", label: "Set as Campaign Default", icon: "fa-solid fa-globe",
      type: "button", callback: async () => {
        if (!game.user.isGM) return;
        const presetId = state.selected === "__campaign__"
          ? game.settings.get(MODULE_ID, "campaignPreset") : state.selected;
        await game.settings.set(MODULE_ID, "campaignPreset", presetId ?? "");
        await game.settings.set(MODULE_ID, "campaignSustainAura", state.sustainAura);
        await game.settings.set(MODULE_ID, "campaignAudio", state.audioSrc);
        await game.settings.set(MODULE_ID, "campaignAudioDb", state.audioDb);
        await actor.unsetFlag(MODULE_ID, "audioDb");
        await actor.unsetFlag(MODULE_ID, "audioSrc");
        await actor.unsetFlag(MODULE_ID, "defaultPreset");
        await actor.unsetFlag(MODULE_ID, "sustainAura");
        state.selected = "__campaign__";
        ui.notifications.info("Campaign transformation default updated.");
        renderPanel(dialog.element.querySelector(".ctfx-panel"), context, state);
      }
    }, { action: "cancel", label: "Cancel", icon: "fa-solid fa-xmark", type: "button" }]
  });
  dialog.addEventListener("render", () => {
    renderPanel(dialog.element.querySelector(".ctfx-panel"), context, state);
  });
  dialog.addEventListener("close", () => context.stopPreview?.());
  dialog.render({ force: true });
}

function renderPanel(panel, app, state) {
  app.stopPreview?.();
  const navigation = `<nav class="ctfx-pages" aria-label="Transformation configuration pages">
    <button type="button" data-ctfx-page="animation" ${state.page === "animation" ? 'aria-current="page"' : ""}>Animation</button>
    <button type="button" data-ctfx-page="presets" ${state.page === "presets" ? 'aria-current="page"' : ""}>Transformation Presets</button>
    ${Object.keys(game.settings.get(MODULE_ID, "installedPacks") ?? {}).length === 0 ? '<a class="ctfx-more-animations" href="https://www.patreon.com/ChefsCauldron/posts/module-master-166505944" target="_blank" rel="noopener noreferrer">Get more animations here</a>' : ""}
  </nav>`;
  const setPage = () => {
    panel.insertAdjacentHTML("afterbegin", navigation);
    for (const button of panel.querySelectorAll("[data-ctfx-page]")) {
      button.addEventListener("click", () => { state.page = button.dataset.ctfxPage; renderPanel(panel, app, state); });
    }
    const campaignButton = panel.closest(".ctfx-configuration")?.querySelector('[data-action="campaign"]');
    if (campaignButton) campaignButton.hidden = state.page !== "animation";
  };
  if (state.page === "presets") {
    renderTransformationPresetPage(panel, app, state, () => renderPanel(panel, app, state));
    setPage();
    return;
  }
  const presets = getAnimationCatalog();
  const choices = value => [`<option value="" ${value === "" ? "selected" : ""}>None</option>`, ...Object.values(presets).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })).map(p =>
    `<option value="${escapeHtml(p.id)}" ${p.id === value ? "selected" : ""}>${escapeHtml(p.name)}</option>`
  )].join("");
  if (state.selected !== "__campaign__" && state.selected && !presets[state.selected]) state.selected = "";
  const campaignId = game.settings.get(MODULE_ID, "campaignPreset") ?? "";
  const effectiveId = state.selected === "__campaign__" ? campaignId : state.selected;
  const selected = presets[effectiveId] ?? DEFAULT_EFFECT;

  panel.innerHTML = `
    <div class="ctfx-editor">
      <div class="ctfx-preview-column">
        <div class="ctfx-preview">${effectiveId && presets[effectiveId] ? `<video aria-label="Animation preview" src="${escapeHtml(selected.introSrc || selected.src)}" playsinline></video><div class="ctfx-media-controls"><input data-preview="seek" type="range" min="0" max="1" step="0.01" value="0" aria-label="Preview position"><div><button type="button" data-preview="play" aria-label="Play preview"><i class="fa-solid fa-play"></i></button></div></div>` : `<div class="ctfx-empty"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>No animation selected</span></div>`}</div>
        <div class="ctfx-campaign-note"><span>Campaign default</span><strong>${escapeHtml(presets[campaignId]?.name ?? "None")}</strong><small>Sustain Aura ${game.settings.get(MODULE_ID, "campaignSustainAura") ? "on" : "off"}</small></div>
      </div>
      <div class="ctfx-controls-column">
        <div class="ctfx-fields">
          <label class="ctfx-animation">Animation<select data-ctfx="preset"><option value="__campaign__" ${state.selected === "__campaign__" ? "selected" : ""}>Use campaign default</option>${choices(state.selected)}</select></label>
          <label class="ctfx-toggle"><input data-ctfx="sustainAura" type="checkbox" ${state.sustainAura ? "checked" : ""}><span><strong>Sustain Aura</strong><small>Keep the aura playing during the transformation.</small></span></label>
        </div>
        <div class="ctfx-audio-section">
          <div class="ctfx-audio">
            <div class="ctfx-audio-title"><strong>Transformation audio</strong><button class="ctfx-clear-audio" data-ctfx="clear-audio" type="button" aria-label="Remove transformation audio" ${state.audioSrc ? "" : "hidden"}><i class="fa-solid fa-xmark" aria-hidden="true"></i> Remove</button></div>
            <small>The transformation lasts 12 seconds unless sustain aura is checked.</small>
            <file-picker data-ctfx="audio" type="audio" value="${escapeHtml(state.audioSrc)}" placeholder="No audio" aria-label="Transformation audio file"></file-picker>
          </div>
          <div class="ctfx-audio-panel" data-audio="panel" ${state.audioSrc ? "" : "hidden"}>
            <div class="ctfx-audio-heading"><span>Audio level</span><output data-audio="gain">${state.audioDb} dB</output></div>
            <input data-audio="level" type="range" min="-60" max="0" step="1" value="${state.audioDb}" aria-label="Transformation audio level in decibels">
            <div class="ctfx-meter-row"><meter data-audio="meter" min="-60" max="0" low="-18" high="-3" optimum="-12" value="-60" aria-label="Audio output peak level"></meter><output data-audio="output">−∞ dBFS</output></div>
            <small>Output during preview · 0 dB keeps the file's original volume.</small>
          </div>
        </div>
      </div>
    </div>`;
  setPage();

  const audioPicker = panel.querySelector('[data-ctfx="audio"]');
  const clearAudio = panel.querySelector('[data-ctfx="clear-audio"]');
  const preview = panel.querySelector("video");
  const previewAudio = document.createElement("audio");
  previewAudio.crossOrigin = "anonymous";
  previewAudio.preload = "metadata";
  const audioPanel = panel.querySelector('[data-audio="panel"]');
  const level = panel.querySelector('[data-audio="level"]');
  const gainLabel = panel.querySelector('[data-audio="gain"]');
  const meter = panel.querySelector('[data-audio="meter"]');
  const output = panel.querySelector('[data-audio="output"]');
  let previewSrc = "", audioContext, gain, analyser, samples, meterFrame;
  let disposed = false;
  const resetMeter = () => { meter.value = -60; output.textContent = "−∞ dBFS"; };
  const stopMeter = () => { cancelAnimationFrame(meterFrame); resetMeter(); };
  const drawMeter = () => {
    if (disposed || previewAudio.paused || previewAudio.ended) { stopMeter(); return; }
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    meter.value = Math.max(-60, Math.min(0, db));
    output.textContent = db > -60 ? `${db.toFixed(1)} dBFS` : "−∞ dBFS";
    meterFrame = requestAnimationFrame(drawMeter);
  };
  const applyLevel = () => {
    const volume = audioVolume(state.audioDb);
    if (gain) { gain.gain.value = volume; previewAudio.volume = 1; }
    else previewAudio.volume = volume;
    gainLabel.textContent = `${state.audioDb} dB`;
  };
  const startAudio = () => {
    if (disposed) return;
    if (!audioContext) {
      try {
        audioContext = new AudioContext();
        gain = audioContext.createGain();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        samples = new Float32Array(analyser.fftSize);
        audioContext.createMediaElementSource(previewAudio).connect(gain);
        gain.connect(analyser);
        analyser.connect(audioContext.destination);
      } catch (error) {
        console.warn(`${MODULE_ID} | Audio meter unavailable`, error);
      }
    }
    applyLevel();
    audioContext?.resume().catch(() => {});
    previewAudio.play().then(() => {
      if (!disposed && analyser) { cancelAnimationFrame(meterFrame); drawMeter(); }
    }).catch(() => {});
  };
  const syncAudio = () => {
    if (disposed || !preview || !previewSrc) return;
    if (Number.isFinite(previewAudio.duration) && preview.currentTime >= previewAudio.duration) {
      previewAudio.pause(); stopMeter(); return;
    }
    if (Math.abs(previewAudio.currentTime - preview.currentTime) > 0.15) previewAudio.currentTime = preview.currentTime;
    if (preview.paused || preview.ended || preview.seeking) { previewAudio.pause(); stopMeter(); }
    else startAudio();
  };
  const setPreviewAudio = () => {
    audioPanel.hidden = !state.audioSrc;
    clearAudio.hidden = !state.audioSrc;
    if (previewSrc === state.audioSrc) return;
    previewAudio.pause(); stopMeter();
    previewSrc = state.audioSrc;
    if (previewSrc) previewAudio.src = previewSrc;
    else previewAudio.removeAttribute("src");
    previewAudio.load();
    syncAudio();
  };
  level.addEventListener("input", () => {
    state.audioDb = normalizeAudioDb(level.value);
    applyLevel();
  });
  for (const event of ["play", "playing", "pause", "ended", "seeking", "seeked"]) preview?.addEventListener(event, syncAudio);
  preview?.addEventListener("waiting", () => { previewAudio.pause(); stopMeter(); });
  previewAudio.addEventListener("loadedmetadata", syncAudio);
  previewAudio.addEventListener("ended", stopMeter);
  previewAudio.addEventListener("error", () => { stopMeter(); output.textContent = "Audio unavailable"; });
  app.stopPreview = () => {
    disposed = true;
    preview?.pause(); previewAudio.pause(); stopMeter();
    previewAudio.removeAttribute("src"); previewAudio.load();
    audioContext?.close().catch(() => {});
  };
  if (preview) {
    preview.muted = true;
    const play = panel.querySelector('[data-preview="play"]');
    const seek = panel.querySelector('[data-preview="seek"]');
    const refreshControls = () => {
      play.setAttribute("aria-label", preview.paused ? "Play preview" : "Pause preview");
      play.firstElementChild.className = `fa-solid fa-${preview.paused ? "play" : "pause"}`;
      seek.disabled = !Number.isFinite(preview.duration);
      seek.max = Number.isFinite(preview.duration) ? preview.duration : 1;
      seek.value = preview.currentTime;
    };
    play.addEventListener("click", () => {
      if (preview.paused) preview.play().catch(() => {});
      else preview.pause();
    });
    seek.addEventListener("input", () => { preview.currentTime = Number(seek.value); syncAudio(); });
    for (const event of ["play", "pause", "ended", "timeupdate", "loadedmetadata"]) preview.addEventListener(event, refreshControls);
    refreshControls();
  }
  applyLevel();
  setPreviewAudio();
  const readAudio = () => {
    state.audioSrc = String(audioPicker.value ?? "").trim();
    setPreviewAudio();
  };
  audioPicker.addEventListener("change", readAudio);
  audioPicker.addEventListener("input", readAudio);
  clearAudio.addEventListener("click", () => {
    audioPicker.value = "";
    state.audioSrc = "";
    setPreviewAudio();
  });
  const select = panel.querySelector('[data-ctfx="preset"]');
  select.addEventListener("change", async () => {
    state.selected = select.value;
    if (state.selected === "__campaign__") {
      state.sustainAura = game.settings.get(MODULE_ID, "campaignSustainAura");
      state.audioSrc = game.settings.get(MODULE_ID, "campaignAudio") ?? "";
      state.audioDb = normalizeAudioDb(game.settings.get(MODULE_ID, "campaignAudioDb"));
    }
    renderPanel(panel, app, state);
  });
  panel.querySelector('[data-ctfx="sustainAura"]').addEventListener("change", event => {
    state.sustainAura = event.target.checked;
  });
}

function normalizeAudioDb(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(-60, Math.min(0, number)) : 0;
}

function audioVolume(db) { return Math.pow(10, normalizeAudioDb(db) / 20); }

async function rememberSelection(app, id) {
  if (!game.user.isGM) return;
  if (id === "__campaign__") return app.actor.unsetFlag(MODULE_ID, "defaultPreset");
  await app.actor.setFlag(MODULE_ID, "defaultPreset", id);
}


function patchTransformationMethods() {
  const proto = CONFIG.Actor.documentClass?.prototype;
  if ( !proto?.transformInto || proto[PATCHED] ) return;
  const transformInto = proto.transformInto;
  const revertOriginalForm = proto.revertOriginalForm;

  proto.transformInto = async function(source, settings, options) {
    const {ctfxPresetSettings, ...nativeOptions} = options ?? {};
    const {id: presetId, preset, sustainAura, audioSrc, audioDb} = effectSettingsForTarget(this, ctfxPresetSettings);
    transformingSelections.set(this.uuid, preset ? { presetId, sustainAura } : null);
    const tokens = this.isToken ? [this.token?.object] : this.getActiveTokens?.() ?? [];
    if ( preset ) for ( const token of tokens.filter(Boolean) ) attachEffect(token, { ...preset, sustainAura });
    let stopAudio = () => {};
    if (audioSrc) {
      try {
        transformationAudio ??= createTransformationAudio(game);
        stopAudio = transformationAudio.start(audioSrc, audioVolume(audioDb), {loop: sustainAura});
      } catch (error) { console.warn(`${MODULE_ID} | Transformation audio failed`, error); }
    }
    let audioBoundToAnimation = false;
    for (const token of tokens.filter(Boolean)) {
      const effect = activeEffects.get(token.document.uuid);
      const animation = effect?.introVideo ?? effect?.video;
      if (!animation) continue;
      audioBoundToAnimation = true;
      effect.stopAudio = stopAudio;
      if (!sustainAura) animation.addEventListener("ended", stopAudio, {once: true});
      animation.addEventListener("error", stopAudio, {once: true});
    }
    const cues = [];
    if ( preset ) {
      // Warm the same texture cache used by Token.draw during the buildup.
      const paths = [source.prototypeToken?.texture?.src, source.prototypeToken?.ring?.subject?.texture];
      for ( const path of new Set(paths.filter(Boolean)) ) {
        foundry.canvas.loadTexture(path).catch(error => console.warn(`${MODULE_ID} | Texture preload failed`, error));
      }
      for ( const token of tokens.filter(Boolean) ) {
        const effect = activeEffects.get(token.document.uuid);
        const cue = createTransformationCue(effect?.introVideo ?? effect?.video, preset.transformAt);
        transformationCues.set(token.document.uuid, cue);
        cues.push(cue);
      }
    }
    try {
      await Promise.all(cues.map(cue => cue.ready));
      if ( preset ) for ( const token of tokens.filter(Boolean) ) crossfadeTokens.add(token.document.uuid);
      const result = await transformInto.call(this, source, settings, nativeOptions);
      if (result == null) stopAudio();
      else if (!audioBoundToAnimation) {
        if (sustainAura && tokens.some(Boolean)) {
          for (const token of tokens.filter(Boolean)) {
            const key = token.document.uuid;
            audioWithoutEffect.get(key)?.();
            audioWithoutEffect.set(key, stopAudio);
          }
        } else if (!sustainAura) setTimeout(stopAudio, 12000);
        else stopAudio();
      }
      if ( preset && result == null ) for ( const token of tokens.filter(Boolean) ) removeEffect(token.document.uuid);
      return result;
    } catch (error) {
      stopAudio();
      for ( const token of tokens.filter(Boolean) ) removeEffect(token.document.uuid);
      throw error;
    } finally {
      for ( const cue of cues ) cue.release();
      for ( const token of tokens.filter(Boolean) ) transformationCues.delete(token.document.uuid);
      for ( const token of tokens.filter(Boolean) ) crossfadeTokens.delete(token.document.uuid);
      transformingSelections.delete(this.uuid);
    }
  };

  if ( revertOriginalForm ) proto.revertOriginalForm = async function(options) {
    const tokens = this.isToken ? [this.token?.object] : this.getActiveTokens?.() ?? [];
    const hasEffect = Boolean(this.getFlag(MODULE_ID, "preset"))
      || tokens.some(token => token && activeEffects.has(token.document.uuid));
    for ( const token of tokens.filter(Boolean) ) {
      fadeEffect(token.document.uuid);
      audioWithoutEffect.get(token.document.uuid)?.();
      audioWithoutEffect.delete(token.document.uuid);
    }
    if ( hasEffect ) for ( const token of tokens.filter(Boolean) ) crossfadeTokens.add(token.document.uuid);
    try {
      return await revertOriginalForm.call(this, options);
    } finally {
      if ( hasEffect ) for ( const token of tokens.filter(Boolean) ) crossfadeTokens.delete(token.document.uuid);
    }
  };
  Object.defineProperty(proto, PATCHED, { value: true });
}

function createEffectVideo() {
  if ( !effectLayer?.isConnected ) {
    effectLayer = document.createElement("div");
    effectLayer.id = "ctfx-effect-layer";
    effectLayer.setAttribute("aria-hidden", "true");
    // Runtime positioning must not depend on a newly registered stylesheet.
    // Clip oversized auras so camera zoom cannot enlarge the document or HUD.
    effectLayer.style.cssText = "position:fixed;inset:0;width:100%;height:100%;overflow:hidden;pointer-events:none;z-index:50;contain:strict;margin:0;padding:0;border:0;";
    document.body.append(effectLayer);
  }
  const video = document.createElement("video");
  video.className = "ctfx-token-effect";
  video.style.cssText = "position:absolute;display:block;width:0;height:0;max-width:none;max-height:none;margin:0;padding:0;border:0;object-fit:contain;pointer-events:none;transform:translate(-50%,-50%);mix-blend-mode:screen;";
  effectLayer.append(video);
  return video;
}

function attachEffect(token, preset, { resumeLoop = false } = {}) {
  const key = token.document.uuid;
  removeEffect(key);
  const video = createEffectVideo();
  video.src = preset.src;
  const loopStart = Number(preset.loopStart) || 0;
  const sustainAura = preset.sustainAura !== false;
  video.loop = sustainAura && loopStart <= 0;
  video.muted = true;
  video.autoplay = !preset.introSrc || resumeLoop;
  video.playsInline = true;
  video.style.opacity = String(preset.introSrc && !resumeLoop ? 0 : preset.opacity ?? 1);
  const playPoweredLoop = () => {
    if ( !sustainAura && !preset.introSrc ) video.loop = false;
    if ( loopStart > 0 ) {
      if ( video.readyState >= HTMLMediaElement.HAVE_METADATA ) video.currentTime = loopStart;
      else video.addEventListener("loadedmetadata", () => { video.currentTime = loopStart; video.play().catch(() => {}); }, { once: true });
    }
    video.play().catch(() => {});
  };
  if ( !preset.introSrc || resumeLoop ) playPoweredLoop();
  if ( loopStart > 0 && sustainAura ) video.addEventListener("ended", playPoweredLoop);
  if ( !sustainAura && !preset.introSrc ) video.addEventListener("ended", () => removeEffect(key), { once: true });

  let introVideo = null;
  if ( preset.introSrc && !resumeLoop ) {
    introVideo = createEffectVideo();
    introVideo.className = "ctfx-token-effect ctfx-token-intro";
    introVideo.src = preset.introSrc;
    introVideo.muted = true;
    introVideo.autoplay = true;
    introVideo.playsInline = true;
    introVideo.style.opacity = String(preset.opacity ?? 1);
    const beginLoop = () => {
      if ( !introVideo || activeEffects.get(key)?.fadingAt !== undefined ) return;
      introVideo.remove();
      introVideo = null;
      const current = activeEffects.get(key);
      if (current) current.introVideo = null;
      if ( !sustainAura ) {
        removeEffect(key);
        return;
      }
      video.style.opacity = String(preset.opacity ?? 1);
      playPoweredLoop();
    };
    introVideo.addEventListener("ended", beginLoop, { once: true });
    introVideo.addEventListener("error", beginLoop, { once: true });
    introVideo.play().catch(beginLoop);
  }

  const createdAt = performance.now();
  const effect = {
    video, introVideo, token, preset, frame: null, createdAt,
    size: createEffectSize(tokenEffectSize(token), createdAt)
  };
  const update = () => {
    // Actor changes may replace the placeable while retaining the token ID.
    token = canvas.tokens?.get?.(token.document.id) ?? token;
    effect.token = token;
    const transformationPending = performance.now() - effect.createdAt < (Math.max(0, Number(preset.transformAt) || 0) * 1000 + 5000);
    if ( !video.isConnected || !canvas?.ready || token.destroyed ) {
      removeEffect(key);
      return;
    }
    if (!transformationPending && !isActorTransformed(token.document?.actor, token)) fadeEffect(key);
    let opacityFactor = 1;
    if (effect.fadingAt !== undefined) {
      opacityFactor = Math.max(0, 1 - (performance.now() - effect.fadingAt) / EFFECT_FADE_MS);
    } else if (!sustainAura) {
      const animation = introVideo ?? video;
      if (Number.isFinite(animation.duration) && animation.duration > 0) {
        const remaining = Math.max(0, animation.duration - animation.currentTime);
        opacityFactor = Math.min(1, remaining * 1000 / EFFECT_FADE_MS);
        if (opacityFactor < 1) effect.stopAudio?.();
      }
    }
    const opacity = (preset.opacity ?? 1) * opacityFactor;
    video.style.opacity = String(introVideo ? 0 : opacity);
    if (introVideo) introVideo.style.opacity = String(opacity);
    const point = canvas.stage.worldTransform.apply(token.center);
    const zoom = canvas.stage.scale.x;
    const worldSize = updateEffectSize(effect.size, tokenEffectSize(token), performance.now());
    const size = worldSize * zoom * (Number(preset.scale) || 1);
    video.style.width = `${size}px`;
    video.style.height = `${size}px`;
    video.style.left = `${point.x}px`;
    video.style.top = `${point.y}px`;
    if ( introVideo ) {
      introVideo.style.width = `${size}px`;
      introVideo.style.height = `${size}px`;
      introVideo.style.left = `${point.x}px`;
      introVideo.style.top = `${point.y}px`;
    }
    effect.frame = requestAnimationFrame(update);
  };
  activeEffects.set(key, effect);
  effect.frame = requestAnimationFrame(update);
}

function fadeEffect(key) {
  const effect = activeEffects.get(key);
  if (!effect || effect.fadingAt !== undefined) return;
  effect.fadingAt = performance.now();
  effect.stopAudio?.();
  effect.fadeTimer = setTimeout(() => {
    if (activeEffects.get(key) === effect) removeEffect(key);
  }, EFFECT_FADE_MS);
}

function removeEffect(key) {
  transformationCues.get(key)?.release();
  const effect = activeEffects.get(key);
  if ( !effect ) return;
  effect.stopAudio?.();
  clearTimeout(effect.fadeTimer);
  cancelAnimationFrame(effect.frame);
  effect.video.remove();
  effect.introVideo?.remove();
  activeEffects.delete(key);
  if ( !activeEffects.size ) {
    effectLayer?.remove();
    effectLayer = null;
  }
}

function asElement(value) {
  if ( value instanceof HTMLElement ) return value;
  if ( value?.[0] instanceof HTMLElement ) return value[0];
  return null;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[c]);
}

Hooks.on("canvasTearDown", () => {
  transformationAudio?.stopAll();
  audioWithoutEffect.clear();
  manualVisuals.clear();
  cancelTokenCrossfades();
  for ( const key of [...activeEffects.keys()] ) removeEffect(key);
});
