const MODULE_ID = "chefs-transformations";
const FOLDER_NAME = "Chef's Transformation Forms";

async function formFolder() {
  return game.folders.find(folder => folder.type === "Actor" && folder.name === FOLDER_NAME && !folder.folder)
    ?? Folder.create({name: FOLDER_NAME, type: "Actor", color: "#735c39"});
}

export async function createPf2eTemporaryActor(host, source, tokenDocument) {
  if (!game.user.isGM) throw new Error("A GM must create PF2e transformation actors.");
  const data = source.toObject();
  delete data._id;
  delete data._stats;
  data.folder = (await formFolder()).id;
  data.name = `${source.name} (${host.name} form)`;
  data.ownership = foundry.utils.deepClone(game.actors.get(tokenDocument.actorId)?.ownership ?? host.ownership);
  data.flags ??= {};
  data.flags[MODULE_ID] = {temporaryForm: {
    hostActorId: tokenDocument.actorId, tokenUuid: tokenDocument.uuid, sourceUuid: source.uuid
  }};
  const actor = await Actor.create(data, {renderSheet: false});
  if (!actor) throw new Error("Foundry could not create the temporary PF2e form actor.");
  return actor;
}

export async function cleanupPf2eTemporaryActor(actorId, tokenUuid) {
  if (!game.user.isGM) return false;
  const actor = game.actors.get(actorId);
  const temporary = actor?.getFlag(MODULE_ID, "temporaryForm");
  if (!temporary || temporary.tokenUuid !== tokenUuid) return false;
  if (game.scenes.some(scene => scene.tokens.some(token => token.actorId === actorId
    || token.getFlag?.(MODULE_ID, "manualTransformation")?.temporaryActorId === actorId))) return false;
  await actor.delete();
  return true;
}

export async function cleanupOrphanedPf2eTemporaryActors() {
  if (!game.user.isGM) return;
  for (const actor of [...game.actors]) {
    const temporary = actor.getFlag(MODULE_ID, "temporaryForm");
    if (temporary) await cleanupPf2eTemporaryActor(actor.id, temporary.tokenUuid);
  }
}
