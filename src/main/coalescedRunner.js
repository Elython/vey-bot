function createCoalescedRunner(task, options = {}) {
  if (typeof task !== 'function') throw new TypeError('A coalesced task function is required');
  const minIntervalMs = Math.max(0, Math.trunc(Number(options.minIntervalMs) || 0));
  const wait = options.wait || (delay => new Promise(resolve => setTimeout(resolve, delay)));
  const now = options.now || (() => Date.now());
  let disposed = false;
  let requested = false;
  let running = null;
  let lastStartedAt = 0;

  const drain = async () => {
    while (!disposed && requested) {
      requested = false;
      const delay = Math.max(0, minIntervalMs - (now() - lastStartedAt));
      if (delay > 0) await wait(delay);
      if (disposed) break;
      lastStartedAt = now();
      await task();
    }
  };

  const ensureRunning = () => {
    if (running || disposed) return running;
    running = drain().finally(() => {
      running = null;
      // A request can arrive as the previous drain settles. Preserve that one
      // trailing refresh instead of leaving it queued without an owner.
      if (!disposed && requested) ensureRunning();
    });
    return running;
  };

  return {
    request() {
      if (disposed) return Promise.resolve(false);
      requested = true;
      return ensureRunning();
    },
    dispose() {
      disposed = true;
      requested = false;
    },
    get running() { return Boolean(running); },
  };
}

module.exports = { createCoalescedRunner };
