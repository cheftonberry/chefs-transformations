import {readTransformationPresets, escapePresetText} from "./preset-configuration.mjs";

const MODULE_ID = "chefs-transformations";

export function canManageTransformations(actor, user = game.user) {
  if (!["dnd5e", "pf2e"].includes(game.system.id)) return false;
  if (!actor) return false;
  if (!user.isGM && actor.getFlag(MODULE_ID, "transformationsGmOnly") !== false) return false;
  return user.isGM || actor.testUserPermission(user, "OWNER");
}

export function canUseTransformations(actor, user = game.user) {
  return canManageTransformations(actor, user) && readTransformationPresets(actor).length > 0;
}

export function transformationHostActor(token) {
  const state = token?.document?.getFlag(MODULE_ID, "manualTransformation");
  if (state?.temporaryActorId && state.original?.actorId)
    return game.actors.get(state.original.actorId) ?? token.actor;
  return token?.actor;
}

export function registerTransformationHud(activate, revert) {
  Hooks.on("renderTokenHUD", (hud, html) => {
    const token = hud.object;
    const actor = transformationHostActor(token);
    const current = token?.document?.getFlag(MODULE_ID, "manualTransformation")
      || (game.system.id === "dnd5e" && actor?.isPolymorphed);
    if (!canUseTransformations(actor) && !(current && canManageTransformations(actor))) return;
    const button = $(`<div class="control-icon ctfx-hud-button" title="Transformations" role="button" tabindex="0" aria-label="Transformations"><i class="fa-solid fa-hurricane"></i></div>`);
    const open = event => {
      event.preventDefault(); event.stopPropagation();
      openTransformationList(token, activate, revert);
    };
    button.on("click", open);
    button.on("keydown", event => { if (["Enter", " "].includes(event.key)) open(event); });
    const root = $(html);
    const right = root.find(".col.right");
    if (right.length) right.append(button);
    else root.append(button);
  });
}

function openTransformationList(token, activate, revert) {
  const actor = transformationHostActor(token);
  const current = token.document.getFlag(MODULE_ID, "manualTransformation") || (game.system.id === "dnd5e" && actor?.isPolymorphed);
  if (!canUseTransformations(actor) && !(current && canManageTransformations(actor))) return;
  const entries = readTransformationPresets(actor);
  const content = `<div class="ctfx-hud-list">
    ${current ? `<button type="button" data-ctfx-revert="true"><i class="fa-solid fa-rotate-left"></i> Revert to original form</button>` : ""}
    ${entries.map(entry => `<button type="button" data-ctfx-preset="${escapePresetText(entry.id)}" ${current ? "disabled" : ""}><i class="fa-solid fa-hurricane"></i> ${escapePresetText(entry.name)}</button>`).join("")}
  </div>`;
  const dialog = new foundry.applications.api.DialogV2({
    window: {title: `Transformations: ${actor.name}`},
    classes: ["ctfx-configuration"], position: {width: 380}, content,
    buttons: [{action: "close", label: "Close", type: "button"}]
  });
  dialog.addEventListener("render", () => {
    dialog.element.querySelector('[data-ctfx-revert]')?.addEventListener("click", async () => {
      dialog.close();
      try { await revert(token); } catch (error) { ui.notifications.error(error.message); console.error(error); }
    });
    for (const button of dialog.element.querySelectorAll("[data-ctfx-preset]")) {
      button.addEventListener("click", async () => {
        const entry = entries.find(item => item.id === button.dataset.ctfxPreset);
        if (!entry || !canUseTransformations(transformationHostActor(token))) return;
        dialog.close();
        try { await activate(token, entry); } catch (error) { ui.notifications.error(error.message); console.error(error); }
      });
    }
  });
  dialog.render({force: true});
}
