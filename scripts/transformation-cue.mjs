// Use the media clock, not time elapsed since creating the <video>. Loading
// and buffering must not move the transformation to a different video frame.
export function createTransformationCue(video, seconds, { now = () => performance.now(),
  request = requestAnimationFrame, cancel = cancelAnimationFrame } = {}) {
  let frame, finished = false, resolve;
  const started = now();
  const target = Math.max(0, Number(seconds) || 0);
  const ready = new Promise(r => { resolve = r; });
  const release = () => {
    if ( finished ) return;
    finished = true;
    cancel(frame);
    resolve();
  };
  const tick = () => {
    if ( finished ) return;
    const unavailable = !video?.isConnected || video.error || video.ended;
    // A missing or stalled video must never block the actor indefinitely.
    const timeout = now() - started > target * 1000 + 15000;
    if ( unavailable || timeout || video.currentTime >= target ) {
      // Never pause playback while waiting for the document/renderer. A pause
      // here freezes the flare at precisely the busiest point of the effect.
      release();
      return;
    }
    frame = request(tick);
  };
  tick();
  return { ready, release };
}
