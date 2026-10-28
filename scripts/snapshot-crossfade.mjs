const running = new Map();

export function snapshotResolution(mesh, bounds, renderer) {
  // Local bounds are in source-art pixels (often 4K), not displayed pixels.
  // Keep enough detail for the current zoom, with a bounded temporary texture.
  const m = mesh.worldTransform ?? mesh.transform.localTransform;
  const scale = Math.max(Math.hypot(m.a, m.b || 0), Math.hypot(m.c || 0, m.d));
  const desired = (Number.isFinite(scale) && scale > 0 ? scale : 1) * (renderer.resolution || 1);
  return Math.min(desired, 2048 / Math.max(bounds.width, bounds.height));
}

// Capture the already-rendered mesh, including its ring and texture fit.
// The snapshot uses the same parent and local transform, not token grid bounds.
function snapshot(mesh, renderer) {
  if ( !mesh?.parent || mesh.destroyed ) return null;
  const bounds = mesh.getLocalBounds().clone();
  if ( !(bounds.width > 0 && bounds.height > 0) ) return null;
  mesh.transform.updateLocalTransform();
  const matrix = mesh.transform.localTransform.clone();
  const transform = mesh.transform;
  // generateTexture renders in LOCAL coordinates. Live token meshes carry
  // screen-space culling/filter bounds and cached vertices from the main pass.
  // None of those can be reused when rendering into a small offscreen texture.
  const state = {
    visible: mesh.visible, renderable: mesh.renderable,
    cullable: mesh.cullable, filterArea: mesh.filterArea
  };
  let texture;
  try {
    mesh.visible = mesh.renderable = true;
    mesh.cullable = false;
    mesh.filterArea = null;
    mesh._transformID = -1;
    texture = renderer.generateTexture(mesh, {
      region: bounds, resolution: snapshotResolution(mesh, bounds, renderer)
    });
  } finally {
    mesh.transform = transform;
    Object.assign(mesh, state);
    // The next main-canvas pass must rebuild world-space vertices too.
    mesh._transformID = -1;
  }
  // Pixel extraction forces a synchronous GPU readback. Reserve it for an
  // explicitly enabled diagnostic, never the normal transition path.
  if ( globalThis.CONFIG?.debug?.ctfxSnapshots && renderer.extract?.pixels ) {
    const pixels = renderer.extract.pixels(texture);
    let hasAlpha = false;
    for ( let i = 3; i < pixels.length; i += 4 ) {
      if ( pixels[i] ) { hasAlpha = true; break; }
    }
    if ( !hasAlpha ) {
      texture.destroy(true);
      throw new Error("Token snapshot is empty; leaving the live token visible");
    }
  }
  const container = new PIXI.Container();
  const image = new PIXI.Sprite(texture);
  image.position.set(bounds.x, bounds.y);
  container.addChild(image);
  container.transform.setFromMatrix(matrix);
  container.eventMode = "none";
  for ( const key of ["elevation", "sortLayer", "sort", "zIndex"] ) {
    if ( mesh[key] !== undefined ) container[key] = mesh[key];
  }
  mesh.parent.addChild(container);
  return {
    container,
    destroy() {
      container.parent?.removeChild(container);
      container.destroy({ children: true });
      texture.destroy(true);
    }
  };
}

export function cancelTokenCrossfades() {
  for ( const cancel of [...running.values()] ) cancel();
}

function refreshDestinationSize(token) {
  // draw() rebuilds the mesh, but clearing a pending redraw can also clear
  // the size update from the actor/token swap. Apply it before the incoming
  // snapshot is taken so the new form has the right footprint immediately.
  token.renderFlags?.set({ refreshSize: true, refreshPosition: true, refreshMesh: true });
  token.applyRenderFlags();
}

export async function crossfadeToken(token, { duration = 600, applyUpdate, onReady } = {}) {
  if ( typeof applyUpdate !== "function" ) throw new TypeError("A token destination update is required");
  running.get(token)?.();
  const renderer = canvas.app?.renderer;
  let outgoing, incoming, capturing = false, cancelled = false, cleaned = false;
  let frame, finish;
  let updatePromise;
  // Commit exactly once, including when snapshot capture fails first.
  const commit = () => updatePromise ??= Promise.resolve().then(applyUpdate);
  const hiddenMeshes = new Map();
  const hideLiveMesh = () => {
    if ( capturing || cleaned ) return;
    const mesh = token.mesh;
    if ( mesh && !mesh.destroyed ) {
      if ( !hiddenMeshes.has(mesh) ) hiddenMeshes.set(mesh, mesh.renderable);
      mesh.renderable = false;
    }
    const visible = !token.destroyed && token.isVisible !== false;
    if ( outgoing ) outgoing.container.visible = visible;
    if ( incoming ) incoming.container.visible = visible;
  };
  const cleanup = () => {
    if ( cleaned ) return;
    cleaned = true;
    renderer?.off("prerender", hideLiveMesh);
    if ( frame !== undefined ) cancelAnimationFrame(frame);
    for ( const [mesh, renderable] of hiddenMeshes ) {
      if ( !mesh.destroyed ) mesh.renderable = renderable;
    }
    outgoing?.destroy();
    incoming?.destroy();
    if ( running.get(token) === cancel ) running.delete(token);
  };
  const cancel = () => { cancelled = true; cleanup(); finish?.(); };
  running.set(token, cancel);
  try {
    if ( renderer && token.isVisible !== false && token.mesh?.renderable ) outgoing = snapshot(token.mesh, renderer);
    // Keep the outgoing image on screen while the live token loads/redraws.
    // The native update runs instantly underneath this cover. Its destination
    // state must be committed before drawing/capturing the incoming token.
    if ( outgoing ) {
      renderer.on("prerender", hideLiveMesh);
      hideLiveMesh();
    }
    token.stopAnimation({ reset: false });
    await commit();
    if ( cancelled || token.destroyed ) return;
    // Foundry animates width/height through its movement context, separately
    // from the texture transition intercepted above. End that context at the
    // updated document state; otherwise the old footprint can linger until
    // the next manual token move.
    token.stopAnimation({ reset: true });
    // Fulfil the pending redraw ourselves and await it. Otherwise applying
    // its leftover redraw flag starts another asynchronous clear/load cycle
    // just as the incoming image is captured.
    token.renderFlags?.clear();
    await token.draw();
    if ( cancelled || token.destroyed ) return;
    refreshDestinationSize(token);
    if ( !outgoing ) return;
    const mesh = token.mesh;
    if ( !mesh || mesh.destroyed ) return;
    // Capture at the destination's actual dimensions; the render guard is
    // briefly suspended synchronously, so no browser frame can expose it.
    capturing = true;
    if ( !hiddenMeshes.has(mesh) ) hiddenMeshes.set(mesh, mesh.renderable);
    mesh.renderable = hiddenMeshes.get(mesh);
    try { incoming = snapshot(mesh, renderer); }
    finally { capturing = false; hideLiveMesh(); }
    if ( !incoming ) return;
    incoming.container.alpha = 0;
    onReady?.();
    const started = performance.now();
    await new Promise(resolve => {
      finish = resolve;
      const tick = () => {
        if ( cancelled || token.destroyed || !canvas.ready ) { resolve(); return; }
        const t = Math.min(1, Math.max(0, (performance.now() - started) / Math.max(1, duration)));
        outgoing.container.alpha = 1 - t;
        incoming.container.alpha = t;
        if ( t === 1 ) resolve();
        else frame = requestAnimationFrame(tick);
      };
      tick();
    });
  } catch (error) {
    // An unsupported snapshot renderer must not leave an invisible token.
    console.error("chefs-transformations | Snapshot crossfade failed", error);
    if ( !cancelled && !token.destroyed ) {
      await commit();
      token.stopAnimation({ reset: true });
      await token.draw();
      refreshDestinationSize(token);
    }
  } finally { onReady?.(); cleanup(); }
}
