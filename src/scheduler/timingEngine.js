/**
 * Anti-Detection Timing Engine
 * Implements randomized delay distributions, Gaussian jitter, and micro-delays
 * to emulate human interaction patterns and avoid rigid intervals.
 */

class TimingEngine {
  /**
   * @param {Object} options
   * @param {number} options.minDelay - Minimum delay in ms (default: 450)
   * @param {number} options.maxDelay - Maximum delay in ms (default: 950)
   * @param {number} options.jitterRatio - Jitter factor (0 to 1, default: 0.25)
   */
  constructor(options = {}) {
    this.minDelay = options.minDelay ?? 450;
    this.maxDelay = options.maxDelay ?? 950;
    this.jitterRatio = options.jitterRatio ?? 0.25;
    this.pendingSleeps = new Set();
    this.lastActionAt = 0;
    this.actionGate = Promise.resolve();
  }

  /**
   * Updates timing configuration dynamically
   * @param {Object} newConfig
   */
  updateConfig({ minDelay, maxDelay, jitterRatio }) {
    if (minDelay !== undefined) this.minDelay = Math.max(100, Number(minDelay));
    if (maxDelay !== undefined) this.maxDelay = Math.max(this.minDelay + 50, Number(maxDelay));
    if (jitterRatio !== undefined) this.jitterRatio = Math.max(0.05, Math.min(0.5, Number(jitterRatio)));
  }

  /**
   * Generates a standard normal random variable using Box-Muller transform
   * @returns {number} Mean 0, Variance 1
   */
  _randomGaussian() {
    let u1 = 0;
    let u2 = 0;
    while (u1 === 0) u1 = Math.random();
    while (u2 === 0) u2 = Math.random();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  }

  /**
   * Calculates a randomized delay using a Gaussian distribution centered between min and max
   * @param {number} [customMin]
   * @param {number} [customMax]
   * @returns {number} Delay in milliseconds
   */
  getRandomDelay(customMin, customMax) {
    const min = customMin ?? this.minDelay;
    const max = customMax ?? this.maxDelay;
    const mean = (min + max) / 2;
    const stdDev = ((max - min) / 4) * (1 + (Math.random() - 0.5) * this.jitterRatio);

    const sample = mean + this._randomGaussian() * stdDev;
    // Clip between min and max
    const clamped = Math.min(Math.max(sample, min), max);
    return Math.round(clamped);
  }

  /**
   * Generates a micro delay (e.g. for mouse down -> mouse up or typing cadence)
   * @param {number} [min=40]
   * @param {number} [max=130]
   * @returns {number} Delay in ms
   */
  getMicroDelay(min = 40, max = 130) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Generates randomized pixel coordinate offset within target element bounding box
   * @param {number} width
   * @param {number} height
   * @param {number} [marginRatio=0.2] - Safe margin from border
   * @returns {{x: number, y: number}}
   */
  getRandomClickOffset(width, height, marginRatio = 0.2) {
    const marginX = width * marginRatio;
    const marginY = height * marginRatio;
    const innerW = width - (marginX * 2);
    const innerH = height - (marginY * 2);

    // Human click distribution is slightly biased towards center
    const rx = (this._randomGaussian() * 0.2 + 0.5);
    const ry = (this._randomGaussian() * 0.2 + 0.5);

    const clampedRx = Math.min(Math.max(rx, 0.05), 0.95);
    const clampedRy = Math.min(Math.max(ry, 0.05), 0.95);

    return {
      x: Math.round(marginX + (innerW * clampedRx)),
      y: Math.round(marginY + (innerH * clampedRy)),
    };
  }

  /**
   * Sleep helper returning a Promise with randomized duration
   * @param {number} [min]
   * @param {number} [max]
   * @returns {Promise<number>} Resolved with actual elapsed sleep time
   */
  async sleepRandom(min, max, signal = null) {
    const delay = this.getRandomDelay(min, max);
    await this._sleep(delay, signal);
    return delay;
  }

  /**
   * Sleep micro delay helper
   * @param {number} [min]
   * @param {number} [max]
   * @returns {Promise<number>}
   */
  async sleepMicro(min = 40, max = 120, signal = null) {
    const delay = this.getMicroDelay(min, max);
    await this._sleep(delay, signal);
    return delay;
  }

  /**
   * Global pacing gate used by every mutating game action. Strategy decides
   * what happens; this method only decides when the next request may start.
   */
  async waitForAction(signal = null, options = {}) {
    let release;
    const previous = this.actionGate;
    this.actionGate = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const configuredFloor = Number(options.minimumIntervalMs);
      const minimumIntervalMs = Number.isFinite(configuredFloor) && configuredFloor > 0
        ? configuredFloor
        : 0;
      const customMin = Number(options.minDelayMs);
      const customMax = Number(options.maxDelayMs);
      const hasCustomRange = Number.isFinite(customMin) && Number.isFinite(customMax)
        && customMin >= 0 && customMax >= customMin;
      const interval = Math.max(
        hasCustomRange ? this.getRandomDelay(customMin, customMax) : this.getRandomDelay(),
        minimumIntervalMs
      );
      const remaining = Math.max(0, this.lastActionAt + interval - Date.now());
      if (remaining > 0) await this._sleep(remaining, signal);
      this.lastActionAt = Date.now();
      return remaining;
    } finally {
      release();
    }
  }

  async _sleep(delay, signal = null) {
    if (signal?.aborted) {
      throw this._abortError();
    }

    await new Promise((resolve, reject) => {
      const entry = { timer: null, reject, signal, onAbort: null };
      const cleanup = () => {
        this.pendingSleeps.delete(entry);
        if (entry.signal && entry.onAbort) {
          entry.signal.removeEventListener('abort', entry.onAbort);
        }
      };

      entry.timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delay);

      entry.onAbort = () => {
        clearTimeout(entry.timer);
        cleanup();
        reject(this._abortError());
      };

      this.pendingSleeps.add(entry);
      if (signal) signal.addEventListener('abort', entry.onAbort, { once: true });
    });
  }

  cancelAll() {
    for (const entry of [...this.pendingSleeps]) {
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      this.pendingSleeps.delete(entry);
      entry.reject(this._abortError());
    }
  }

  _abortError() {
    const error = new Error('Operation cancelled');
    error.name = 'AbortError';
    return error;
  }
}

module.exports = { TimingEngine };
