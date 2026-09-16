const fs = require('fs');
const path = require('path');
const { hashCanonical } = require('./loadoutCatalog');
const { getDataDir } = require('../main/paths');

const XP_MODEL_SCHEMA_VERSION = 1;
const DEFAULT_PATH = path.join(getDataDir(), 'xp_observations.json');

function emptyStore() {
  return { schemaVersion: XP_MODEL_SCHEMA_VERSION, records: {} };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function parseXpProgress(state = {}) {
  let current = finiteNumber(state.expCurrent);
  let required = finiteNumber(state.expRequired);
  if (current === null || required === null) {
    const match = String(state.exp || '').match(/([\d,]+)\s*\/\s*([\d,]+)/);
    if (match) {
      current = finiteNumber(match[1]);
      required = finiteNumber(match[2]);
    }
  }
  if (current === null || required === null || required <= 0) {
    return { recognized: false, current: null, required: null, needed: null };
  }
  return {
    recognized: true,
    current: Math.max(0, current),
    required: Math.max(1, required),
    needed: Math.max(0, required - current),
  };
}

function xpForNextLevel(level) {
  const currentLevel = Math.max(0, Math.trunc(Number(level) || 0));
  return Math.floor((25 * ((currentLevel + 1) ** 2)) / 4) + 100;
}

function xpForRange(startLevel, endLevel) {
  const start = Math.max(0, Math.trunc(Number(startLevel) || 0));
  const end = Math.max(start, Math.trunc(Number(endLevel) || start));
  let total = 0;
  for (let level = start; level < end; level += 1) total += xpForNextLevel(level);
  return total;
}

function accountLevelKey(accountName, level) {
  return hashCanonical({ accountName: String(accountName || ''), level: Math.max(0, Math.trunc(Number(level) || 0)) });
}

class XpModel {
  constructor(filePath = DEFAULT_PATH, options = {}) {
    this.filePath = filePath;
    this.now = options.now || (() => Date.now());
    this.maxSamples = Math.max(1, Math.trunc(Number(options.maxSamples) || 20));
    this.data = this._read();
  }

  observeAttack({ accountName, level, xpDelta, staminaCost }) {
    const delta = finiteNumber(xpDelta);
    const cost = finiteNumber(staminaCost);
    const normalizedLevel = Math.max(0, Math.trunc(Number(level) || 0));
    if (!accountName || delta === null || delta <= 0 || cost === null || cost <= 0) {
      return { recorded: false, reason: 'A positive attack XP delta and actual Stamina cost are required' };
    }
    const key = accountLevelKey(accountName, normalizedLevel);
    const record = this.data.records[key] || {
      accountKey: hashCanonical({ accountName: String(accountName) }),
      level: normalizedLevel,
      samples: [],
      updatedAt: null,
    };
    record.samples.push({ xpDelta: delta, staminaCost: cost, xpPerStamina: delta / cost });
    record.samples = record.samples.slice(-this.maxSamples);
    record.updatedAt = new Date(this.now()).toISOString();
    this.data.records[key] = record;
    this._write();
    return { recorded: true, estimate: this.getRate(accountName, normalizedLevel) };
  }

  getRate(accountName, level) {
    if (!accountName) return null;
    const record = this.data.records[accountLevelKey(accountName, level)];
    const samples = (record?.samples || [])
      .map(sample => finiteNumber(sample.xpPerStamina))
      .filter(value => value !== null && value > 0)
      .sort((left, right) => left - right);
    if (samples.length === 0) return null;
    const middle = Math.floor(samples.length / 2);
    const median = samples.length % 2 === 0
      ? (samples[middle - 1] + samples[middle]) / 2
      : samples[middle];
    return {
      level: Math.max(0, Math.trunc(Number(level) || 0)),
      xpPerStamina: median,
      sampleCount: samples.length,
      updatedAt: record.updatedAt,
    };
  }

  planImminentLevel({ accountName, state = {}, allowedStaminaCosts = [], chaptersAvailable = 0 }) {
    const progress = parseXpProgress(state);
    const rate = this.getRate(accountName, state.level);
    if (!progress.recognized || !rate || progress.needed <= 0) {
      return { recognized: false, progress, rate };
    }
    const stamina = Math.max(0, Math.trunc(Number(state.stamina) || 0));
    const maxStamina = Math.max(stamina, Math.trunc(Number(state.maxStamina) || stamina));
    const chapterLimit = Math.min(
      Math.max(0, Math.trunc(Number(chaptersAvailable) || 0)),
      Math.floor(Math.max(0, maxStamina - stamina) / 2),
    );
    const costs = [...new Set(allowedStaminaCosts
      .map(value => Math.max(0, Math.trunc(Number(value) || 0)))
      .filter(value => value > 0))]
      .sort((left, right) => left - right);
    const candidates = [];
    for (let chapters = 0; chapters <= chapterLimit; chapters += 1) {
      const available = stamina + (chapters * 2);
      for (const staminaCost of costs) {
        if (staminaCost > available) continue;
        const predictedXp = rate.xpPerStamina * staminaCost;
        if (predictedXp < progress.needed) continue;
        candidates.push({
          chapters,
          staminaAfterChapters: available,
          staminaCost,
          predictedXp: Math.floor(predictedXp),
          staminaWaste: available - staminaCost,
        });
      }
    }
    candidates.sort((left, right) =>
      left.staminaWaste - right.staminaWaste ||
      left.chapters - right.chapters ||
      left.staminaCost - right.staminaCost
    );
    return {
      recognized: true,
      progress,
      rate,
      plan: candidates[0] || null,
    };
  }

  _read() {
    try {
      if (!fs.existsSync(this.filePath)) return emptyStore();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed?.schemaVersion !== XP_MODEL_SCHEMA_VERSION || !parsed.records || typeof parsed.records !== 'object') {
        return emptyStore();
      }
      return parsed;
    } catch {
      return emptyStore();
    }
  }

  _write() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }
}

module.exports = {
  XP_MODEL_SCHEMA_VERSION,
  XpModel,
  parseXpProgress,
  xpForNextLevel,
  xpForRange,
  accountLevelKey,
};
