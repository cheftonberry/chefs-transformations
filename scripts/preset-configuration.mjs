import {getAnimationCatalog} from "./animation-catalog.mjs";
const MODULE_ID = "chefs-transformations";

export function readTransformationPresets(actor) {
  const entries = actor?.getFlag(MODULE_ID, "transformationPresets");
  return Array.isArray(entries) ? entries.filter(entry => entry?.id && entry?.actorUuid) : [];
}

export function escapePresetText(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[char]);
}

async function configureNativeDndPreset(host, source) {
  const api = globalThis.dnd5e ?? game.dnd5e;
  const dialog = api?.applications?.actor?.TransformDialog;
  if (!dialog?.promptSettings) throw new Error("D&D5e's transformation settings dialog is unavailable.");
  const Setting = api?.dataModels?.settings?.TransformationSetting;
  const systemDefaults = game.settings.get("dnd5e", "transformationSettings");
  const settings = Setting ? new Setting(systemDefaults?.toObject?.() ?? systemDefaults ?? {}) : undefined;
  // Foundry concatenates array options, so passing one button to promptSettings
  // leaves D&D5e's built-in Transform button visible beside Save Preset.
  class PresetTransformDialog extends dialog {
    _initializeApplicationOptions(options) {
      const configured = super._initializeApplicationOptions(options);
      configured.buttons = options.buttons.map(button => ({...button}));
      return configured;
    }
  }
  const chosen = await PresetTransformDialog.promptSettings(host, source, {
    transform: {settings},
    window: {title: "Configure Transformation Preset"},
    buttons: [{action: "submit", icon: "fa-solid fa-check", label: "Save Preset", type: "submit", default: true}]
  });
  return chosen?.toObject() ?? null;
}

async function configurePf2ePreset(host, source) {
  const state = {artwork: true, size: true, tokenName: true, vision: true, lighting: true};
  let saved = false;
  const content = `<div class="ctfx-pf2e-form">
    <div class="ctfx-pf2e-heading"><strong>${escapePresetText(host.name)} → ${escapePresetText(source.name)}</strong><p>The transformed token uses a temporary copy of ${escapePresetText(source.name)}'s complete actor sheet, including attacks, abilities, AC, saves, items, and spells. Reverting restores ${escapePresetText(host.name)}'s sheet.</p></div>
    <fieldset class="ctfx-pf2e-token-options"><legend>Token appearance</legend>
      <label><input type="checkbox" data-transfer="artwork" checked><span>Use target token artwork</span></label>
      <label><input type="checkbox" data-transfer="size" checked><span>Use target token dimensions</span></label>
      <label><input type="checkbox" data-transfer="tokenName" checked><span>Use target token name</span></label>
      <label><input type="checkbox" data-transfer="vision" checked><span>Use target vision and detection</span></label>
      <label><input type="checkbox" data-transfer="lighting" checked><span>Use target token light</span></label>
    </fieldset>
  </div>`;
  const dialog = new foundry.applications.api.DialogV2({
    window: {title: "Configure PF2e Transformation"}, classes: ["ctfx-configuration"],
    position: {width: 540}, content,
    buttons: [
      {action: "save", label: "Save Preset", icon: "fa-solid fa-check", default: true,
        callback: () => { saved = true; }},
      {action: "cancel", label: "Cancel", type: "button"}
    ]
  });
  dialog.addEventListener("render", () => {
    for (const input of dialog.element.querySelectorAll("[data-transfer]"))
      input.addEventListener("change", () => { state[input.dataset.transfer] = input.checked; });
  });
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(saved ? state : null), {once: true});
    dialog.render({force: true});
  });
}

export async function configureTransformationTarget(host, source) {
  if (game.system.id === "dnd5e") return configureNativeDndPreset(host, source);
  if (game.system.id === "pf2e") return configurePf2ePreset(host, source);
  throw new Error("Transformation presets are supported only in D&D5e and PF2e.");
}

export function renderTransformationPresetPage(panel, context, state, render) {
  const animations = getAnimationCatalog();
  const currentAnimationId = state.selected === "__campaign__"
    ? game.settings.get(MODULE_ID, "campaignPreset") ?? "" : state.selected;
  const captureAnimation = () => ({
    animationPresetId: currentAnimationId,
    sustainAura: state.sustainAura,
    audioSrc: state.audioSrc,
    audioDb: state.audioDb
  });
  panel.innerHTML = `<div class="ctfx-preset-page">
    <div class="ctfx-preset-body">
      <label class="ctfx-preset-switch"><input type="checkbox" data-ctfx="gm-only" ${state.transformationsGmOnly ? "checked" : ""}><span><strong>Transformations GM only?</strong><small>When unchecked, owners can use the token's Transformations button.</small></span></label>
      <div class="ctfx-drop-actor" data-ctfx="drop-actor" tabindex="0"><i class="fa-solid fa-user-plus" aria-hidden="true"></i><strong>Drag an actor here</strong><small>Choose a form from the Actors directory to configure and save it.</small></div>
      <div class="ctfx-preset-list">${state.transformationPresets.length ? state.transformationPresets.map(entry => `
        <div class="ctfx-preset-entry" data-preset-id="${escapePresetText(entry.id)}">
          <div class="ctfx-preset-entry-header">
            <span><strong>${escapePresetText(entry.name)}</strong></span>
            <button type="button" data-ctfx="remove-preset" aria-label="Remove ${escapePresetText(entry.name)}"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="ctfx-preset-details"><span>Animation: ${escapePresetText(animations[entry.animationPresetId ?? currentAnimationId]?.name ?? "None")}</span><span>Sustain Aura: ${(entry.sustainAura ?? state.sustainAura) ? "On" : "Off"}</span><span>Audio: ${escapePresetText((entry.audioSrc ?? state.audioSrc) ? (entry.audioSrc ?? state.audioSrc).split("/").pop() : "None")}</span></div>
        </div>`).join("") : `<p class="ctfx-no-presets">No transformation presets saved yet.</p>`}</div>
    </div>
  </div>`;
  panel.querySelector('[data-ctfx="gm-only"]').addEventListener("change", event => {
    state.transformationsGmOnly = event.target.checked;
  });
  const addActor = async event => {
    event.preventDefault();
    if (!game.user.isGM) return;
    let data;
    try { data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event); } catch { return; }
    if (data?.type !== "Actor") return;
    const source = (data.uuid ? await fromUuid(data.uuid).catch(() => null) : null) ?? game.actors.get(data.id);
    if (!source || source.uuid === context.actor.uuid) return;
    if (source.getFlag(MODULE_ID, "temporaryForm")) {
      ui.notifications.warn("Temporary transformation actors cannot be saved as presets.");
      return;
    }
    try {
      const settings = await configureTransformationTarget(context.actor, source);
      if (!settings) return;
      state.transformationPresets.push({
        id: foundry.utils.randomID(), actorUuid: source.uuid,
        name: source.name, settings,
        ...captureAnimation()
      });
      render();
    } catch (error) { ui.notifications.error(error.message); console.error(error); }
  };
  const drop = panel.querySelector('[data-ctfx="drop-actor"]');
  drop.addEventListener("dragover", event => event.preventDefault());
  drop.addEventListener("drop", addActor);
  for (const button of panel.querySelectorAll('[data-ctfx="remove-preset"]')) {
    button.addEventListener("click", () => {
      const id = button.closest("[data-preset-id]").dataset.presetId;
      state.transformationPresets = state.transformationPresets.filter(entry => entry.id !== id);
      render();
    });
  }
}
