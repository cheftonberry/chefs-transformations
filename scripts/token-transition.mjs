function read(object, path) {
  if ( Object.hasOwn(object, path) ) return object[path];
  return path.split(".").reduce((value, key) => value?.[key], object);
}

export function configureTokenTransition(document, changes, options) {
  const appearanceChanged = read(changes, "actorId") !== undefined
    || read(changes, "texture.src") !== undefined
    || read(changes, "ring.subject.texture") !== undefined;
  if ( !appearanceChanged ) return false;
  // Route this update to our snapshot fade. Finish movement/size changes
  // immediately while the old image covers the live mesh during its redraw.
  options.animate = true;
  options.animation = {
    ...options.animation, transition: "fade", duration: 600,
    ctfxCrossfade: true, movementSpeed: Number.MAX_VALUE
  };
  return true;
}
