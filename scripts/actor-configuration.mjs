const MODULE_ID = "chefs-transformations";

export function actorPresetId(actor, actors, campaignPreset = "") {
  // A transformed actor retains the original's identity. Consult the original
  // first so editing its default also affects later chained transformations.
  const originalId = globalThis.game?.system?.id === "dnd5e" ? actor.getFlag("dnd5e", "originalActor") : null;
  const original = originalId ? actors?.get(originalId) : null;
  return (original ?? actor).getFlag(MODULE_ID, "defaultPreset") ?? campaignPreset;
}

export function registerActorConfiguration(open) {
  const insert = (entries, item) => {
    const ownership = entries.findIndex(entry => {
      const label = entry.label ?? entry.name;
      return label === "OWNERSHIP.Configure" || label === "PERMISSION.Configure"
        || label === "Configure Ownership"
        || label === game.i18n?.localize("OWNERSHIP.Configure");
    });
    entries.splice(ownership < 0 ? entries.length : ownership + 1, 0, item);
  };
  const resolve = entry => {
    const element = entry?.[0] ?? entry;
    const row = element?.closest?.("[data-entry-id], [data-document-id]") ?? element;
    return game.actors.get(row?.dataset?.entryId ?? row?.dataset?.documentId);
  };
  // V14 uses the document context API; V13 uses the directory entry API.
  Hooks.on("getActorContextOptions", (_app, entries) => {
    insert(entries, {
      label: "Configure Transformations", icon: "fa-solid fa-hurricane",
      visible: entry => { const actor = resolve(entry); return Boolean(game.user.isGM && actor && !actor.getFlag(MODULE_ID, "temporaryForm")); },
      onClick: (_event, entry) => { const actor = resolve(entry); if (game.user.isGM && actor && !actor.getFlag(MODULE_ID, "temporaryForm")) open(actor); }
    });
  });
  Hooks.on("getActorDirectoryEntryContext", (_html, entries) => {
    insert(entries, {
      name: "Configure Transformations", icon: '<i class="fa-solid fa-hurricane"></i>',
      condition: entry => { const actor = resolve(entry); return Boolean(game.user.isGM && actor && !actor.getFlag(MODULE_ID, "temporaryForm")); },
      callback: entry => { const actor = resolve(entry); if (game.user.isGM && actor && !actor.getFlag(MODULE_ID, "temporaryForm")) open(actor); }
    });
  });
}
