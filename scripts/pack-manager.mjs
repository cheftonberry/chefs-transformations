import "../libs/jszip.min.js";
import {validatePack} from "./animation-catalog.mjs";
const MODULE_ID = "chefs-transformations";
export const PACK_IMPORTS_ENABLED = true;
const STORAGE_ROOT = "chefs-transformations/animation-packs";
let busy = false;

async function ensureDirectory(path) {
  let current = "";
  const picker = foundry.applications.apps.FilePicker.implementation;
  for (const part of path.split("/")) {
    current = current ? `${current}/${part}` : part;
    try { await picker.createDirectory("data", current, {notify: false}); }
    catch (error) {
      // Only ignore an existing directory, not permission or server errors.
      try { await picker.browse("data", current); } catch { throw error; }
    }
  }
}

export async function importTransformationPack(file, {onProgress = () => {}} = {}) {
  if (!PACK_IMPORTS_ENABLED) throw new Error("Animation pack importing is currently unavailable.");
  if (!game.user.isGM) throw new Error("Only a GM can install transformation packs.");
  if (busy) throw new Error("Another pack operation is in progress.");
  busy = true;
  try {
    if (!file?.name?.toLowerCase().endsWith(".zip") || file.size > 512 * 1024 * 1024)
      throw new Error("Choose a transformation pack ZIP smaller than 512 MB.");
    onProgress("Reading and validating the ZIP…");
    const zip = await globalThis.JSZip.loadAsync(await file.arrayBuffer());
    const entries = Object.values(zip.files).filter(e => !e.dir && /(^|\/)transformation-pack\.json$/.test(e.name));
    if (entries.length !== 1) throw new Error("The ZIP must contain exactly one transformation-pack.json.");
    const entry = entries[0], prefix = entry.name.slice(0, -"transformation-pack.json".length);
    if (entry._data?.uncompressedSize > 1024 * 1024) throw new Error("Pack manifest is too large.");
    const manifest = validatePack(JSON.parse(await entry.async("string")));
    const installed = structuredClone(game.settings.get(MODULE_ID, "installedPacks") ?? {});
    const otherIds = new Set(Object.values(installed).filter(p => p.id !== manifest.id).flatMap(p => p.animations.map(a => a.id)));
    if (manifest.animations.some(a => otherIds.has(a.id))) throw new Error("An animation ID is already supplied by another pack.");
    const required = [...new Set(manifest.animations.flatMap(a => [a.introSrc, a.src]))];
    let total = 0;
    for (const relative of required) {
      const asset = zip.file(prefix + relative);
      if (!asset || asset.dir || (asset.unsafeOriginalName && asset.unsafeOriginalName !== asset.name)) throw new Error(`Missing or unsafe asset: ${relative}`);
      const size = asset._data?.uncompressedSize;
      if (!Number.isFinite(size) || size > 64 * 1024 * 1024) throw new Error(`Video is too large: ${relative}`);
      total += size;
    }
    if (total > 512 * 1024 * 1024) throw new Error("Expanded pack exceeds 512 MB.");
    // A unique upload directory leaves the previous install intact on failure.
    const target = `${STORAGE_ROOT}/${manifest.id}/${foundry.utils.randomID()}`;
    const uploaded = new Map();
    for (const [index, relative] of required.entries()) {
      onProgress(`Uploading videos… ${index}/${required.length}`);
      const bytes = await zip.file(prefix + relative).async("uint8array");
      if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) throw new Error(`Not a WebM video: ${relative}`);
      const parts = relative.split("/"), name = parts.pop(), directory = [target, ...parts].join("/");
      await ensureDirectory(directory);
      const result = await foundry.applications.apps.FilePicker.implementation.upload("data", directory, new File([bytes], name, {type: "video/webm"}), {}, {notify: false});
      if (!result?.path) throw new Error(`Upload failed: ${name}`);
      uploaded.set(relative, result.path);
    }
    for (const a of manifest.animations) { a.introSrc = uploaded.get(a.introSrc); a.src = uploaded.get(a.src); }
    installed[manifest.id] = {...manifest, installedAt: new Date().toISOString()};
    onProgress("Saving the animation catalog…");
    await game.settings.set(MODULE_ID, "installedPacks", installed);
    return manifest;
  } finally { busy = false; }
}

export async function removeTransformationPack(id) {
  if (!game.user.isGM) throw new Error("Only a GM can remove packs.");
  if (busy) throw new Error("Another pack operation is in progress.");
  busy = true;
  try {
    const installed = structuredClone(game.settings.get(MODULE_ID, "installedPacks") ?? {});
    delete installed[id];
    await game.settings.set(MODULE_ID, "installedPacks", installed);
  } finally { busy = false; }
}
const {ApplicationV2, HandlebarsApplicationMixin} = foundry.applications.api;

export class TransformationPackManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "chefs-transformations-pack-manager",
    classes: ["chefs-transformations-pack-manager-window"],
    window: {
      title: "Chef's Transformations — Transformation Pack Manager",
      icon: "fa-solid fa-hurricane",
      contentClasses: ["standard-form"]
    },
    position: {width: 620},
    actions: {
      import: TransformationPackManager._onImport,
      remove: TransformationPackManager._onRemove
    }
  };

  static PARTS = {
    manager: {
      template: `modules/${MODULE_ID}/templates/pack-manager.hbs`,
      root: true
    }
  };

  async _prepareContext(_options) {
    const titles = {"patreon-paid": "Patreon Sous Chef Pack", "patreon-free": "Patreon Free Pack"};
    const packs = Object.values(game.settings.get(MODULE_ID, "installedPacks") ?? {})
      .map(pack => ({...pack, title: titles[pack.id] ?? pack.title}));
    return {packs, isGM: game.user.isGM};
  }

  _fitToContent() {
    requestAnimationFrame(() => this.setPosition({height: "auto"}));
  }

  static async _onImport(_event, target) {
      const root = this.element;
      const input = root.querySelector('input[name="transformationPack"]');
      if ( !input?.files?.[0] ) return ui.notifications.warn("Choose a transformation pack ZIP first.");
      const controls = root.querySelectorAll("button, input");
      const button = target;
      const status = root.querySelector("[data-import-status]");
      const setProgress = message => {
        status.hidden = false;
        status.querySelector("span").textContent = message;
        this._fitToContent();
      };
      controls.forEach(control => control.disabled = true);
      button.setAttribute("aria-busy", "true");
      button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing…';
      setProgress("Starting import…");
      try {
        const manifest = await importTransformationPack(input.files[0], {onProgress: setProgress});
        setProgress(`${manifest.title} ${manifest.version} installed successfully.`);
        const installedLabel = foundry.utils.escapeHTML(`${manifest.title} ${manifest.version}`);
        const reload = await foundry.applications.api.DialogV2.confirm({
          window: {title: "Transformation Pack Installed"},
          content: `<p><strong>${installedLabel}</strong> was installed successfully.</p><p>Reload Foundry now to make its transformations available?</p>`,
          yes: {label: "Yes, Reload Foundry", icon: "fa-solid fa-arrows-rotate"},
          no: {label: "No, Reload Later", icon: "fa-solid fa-clock"},
          defaultYes: true
        });
        if ( reload ) window.location.reload();
        else this.render();
      } catch (error) {
        console.error(`${MODULE_ID} | Transformation pack import failed`, error);
        setProgress(`Import failed: ${error.message}`);
        ui.notifications.error(error.message);
      } finally {
        controls.forEach(control => control.disabled = false);
        button.removeAttribute("aria-busy");
        button.innerHTML = '<i class="fa-solid fa-file-import"></i> Import Transformation Pack';
      }
  }

  static async _onRemove(_event, target) {
      if ( this._removalPending ) return;
      this._removalPending = true;
      const root = this.element;
      const id = target.dataset.packId;
      const controls = root.querySelectorAll("button, input");
      const button = target;
      const originalButton = button.innerHTML;
      const status = root.querySelector("[data-removal-status]");
      controls.forEach(control => control.disabled = true);
      button.setAttribute("aria-busy", "true");
      button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      try {
        const confirmed = await foundry.applications.api.DialogV2.confirm({window: {title: "Remove Transformation Pack"}, content: `<p>Remove <strong>${id}</strong> from Chef's Transformations?</p>`});
        if ( !confirmed ) return;
        status.hidden = false;
        status.querySelector("span").textContent = `Removing ${id} from the transformation catalog…`;
        this._fitToContent();
        await removeTransformationPack(id);
        const removedLabel = foundry.utils.escapeHTML(id);
        const reload = await foundry.applications.api.DialogV2.confirm({
          window: {title: "Transformation Pack Removed"},
          content: `<p><strong>${removedLabel}</strong> was removed from the transformation library.</p><p>Reload Foundry now to remove its transformations from active tokens?</p><p class="hint">The stored asset files were retained so the pack can be safely re-imported.</p>`,
          yes: {label: "Yes, Reload Foundry", icon: "fa-solid fa-arrows-rotate"},
          no: {label: "No, Reload Later", icon: "fa-solid fa-clock"},
          defaultYes: true
        });
        if ( reload ) window.location.reload();
        else this.render();
      } catch (error) {
        console.error(`${MODULE_ID} | Transformation pack removal failed`, error);
        status.hidden = false;
        status.querySelector("span").textContent = `Removal failed: ${error.message}`;
        this._fitToContent();
        ui.notifications.error(error.message);
      } finally {
        this._removalPending = false;
        controls.forEach(control => control.disabled = false);
        button.removeAttribute("aria-busy");
        button.innerHTML = originalButton;
      }
  }
}

export function registerPackSettings() {
  game.settings.register(MODULE_ID, "installedPacks", {scope: "world", config: false, type: Object, default: {}});
  if (!PACK_IMPORTS_ENABLED) return;
  game.settings.registerMenu(MODULE_ID, "transformationPackManager", {
    name: "Transformation Pack Manager", label: "Manage Transformation Packs", hint: "Install or update transformation packs downloaded from Patreon.",
    icon: "fa-solid fa-hurricane", type: TransformationPackManager, restricted: true
  });
}
