const CHANNEL = "module.chefs-transformations";
const END_FADE_MS = 750;

// Each playback has its own Sound so stopping one actor never cuts off another.
export function createTransformationAudio(game) {
  const active = new Map();
  const receive = async message => {
    if (!message || typeof message.id !== "string") return;
    if (message.action === "stop") {
      const entry = active.get(message.id);
      if (!entry) return;
      active.delete(message.id);
      entry.stopped = true;
      await entry.sound.stop({fade: END_FADE_MS});
      return;
    }
    if (message.action !== "start" || typeof message.src !== "string" || active.has(message.id)) return;
    const sound = game.audio.create({src: message.src, singleton: false, context: game.audio.interface});
    const entry = {sound, stopped: false};
    active.set(message.id, entry);
    sound.addEventListener("end", () => active.delete(message.id), {once: true});
    try {
      await sound.load();
      if (!entry.stopped) await sound.play({volume: Math.max(0, Math.min(1, Number(message.volume) || 0)), loop: message.loop === true});
      if (entry.stopped) await sound.stop({fade: END_FADE_MS});
    } catch (error) {
      active.delete(message.id);
      console.warn("chefs-transformations | Transformation audio failed", error);
    }
  };
  const dispatch = message => {
    receive(message).catch(error => console.warn("chefs-transformations | Audio control failed", error));
    game.socket.emit(CHANNEL, message);
  };
  game.socket.on(CHANNEL, message => {
    receive(message).catch(error => console.warn("chefs-transformations | Audio control failed", error));
  });
  return {
    start(src, volume, {loop = false} = {}) {
      const id = crypto.randomUUID();
      dispatch({action: "start", id, src, volume, loop});
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        dispatch({action: "stop", id});
      };
    },
    stopAll() {
      for (const id of active.keys()) dispatch({action: "stop", id});
    }
  };
}
