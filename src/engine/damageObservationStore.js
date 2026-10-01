const fs = require('fs');
const path = require('path');
const { hashCanonical } = require('./loadoutCatalog');
const { NORMAL_ATTACKS } = require('./attackPlanner');
const { getDataDir } = require('../main/dataPaths');

const DAMAGE_OBSERVATION_SCHEMA_VERSION = 1;
const DEFAULT_PATH = path.join(getDataDir(), 'damage_observations.json');
const MULTIPLIER_BY_SKILL_ID = new Map(NORMAL_ATTACKS.map(attack => [attack.id, attack.multiplier]));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyStore() {
  return { schemaVersion: DAMAGE_OBSERVATION_SCHEMA_VERSION, records: {} };
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function gameNumberOrNull(value) {
  if (typeof value === 'string') return numberOrNull(value.replace(/,/g, ''));
  return numberOrNull(value);
}

function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function accountKey(accountName) {
  return hashCanonical({ accountName: String(accountName || '') });
}

function createCombatContext({ accountName, target, player, loadoutHash }) {
  const stableStats = target?.monsterStats || target?.stats;
  const identityPayload = {
    schemaVersion: DAMAGE_OBSERVATION_SCHEMA_VERSION,
    accountKey: accountKey(accountName),
    attackFamily: 'normal',
    monster: {
      areaKey: String(target?.areaKey || ''),
      monsterKey: String(target?.monsterKey || ''),
    },
    player: {
      level: numberOrNull(player?.level),
      attack: numberOrNull(player?.attack),
      defense: numberOrNull(player?.defense),
    },
    loadoutHash: String(loadoutHash || ''),
  };
  if (stableStats && typeof stableStats === 'object' && !Array.isArray(stableStats)) {
    identityPayload.monster.stats = clone(stableStats);
  }
  if (!identityPayload.monster.areaKey || !identityPayload.monster.monsterKey || !identityPayload.loadoutHash) return null;
  const payload = clone(identityPayload);
  payload.monster.name = String(target?.name || '');
  payload.monster.areaName = String(target?.areaName || target?.instanceName || '');
  return { hash: hashCanonical(identityPayload), payload };
}

function classifyAttackResult(result, skill) {
  const damage = numberOrNull(result?.damage);
  const skillId = numberOrNull(skill?.id);
  const multiplier = MULTIPLIER_BY_SKILL_ID.get(skillId);
  if (result?.success !== true || damage === null || damage <= 0 || !multiplier) return null;

  const logs = Array.isArray(result.logs) ? result.logs : [];
  const matchingLog = logs.find(log => gameNumberOrNull(
    log?.DAMAGE
      ?? log?.damage
      ?? log?.DAMAGE_TO_MONSTERS
      ?? log?.damage_to_monsters
  ) === damage) || null;
  const extraInfo = String(matchingLog?.EXTRA_INFO ?? matchingLog?.extra_info ?? '').trim();
  const criticalMatch = extraInfo.match(/critical hit\s*\(x([\d.]+)\s*damage\)/i);
  // The verified game log labels every critical. A matching damage entry without
  // that marker is therefore a usable non-critical observation, even when the
  // server adds another non-critical note instead of the literal "NONE".
  const critical = matchingLog ? Boolean(criticalMatch) : null;
  return {
    damage,
    multiplier,
    baseDamage: damage / multiplier,
    critical,
    criticalMultiplier: criticalMatch ? numberOrNull(criticalMatch[1]) : null,
    extraInfo: extraInfo.slice(0, 200),
  };
}

class DamageObservationStore {
  constructor(filePath = DEFAULT_PATH, options = {}) {
    this.filePath = filePath;
    this.now = options.now || (() => Date.now());
    this.maxRecords = Number.isInteger(options.maxRecords) ? Math.max(1, options.maxRecords) : 500;
    this.maxSamplesPerClass = Number.isInteger(options.maxSamplesPerClass)
      ? Math.max(1, options.maxSamplesPerClass)
      : 50;
    this.data = this._read();
  }

  createContext(input) {
    return createCombatContext(input);
  }

  recordAttack({ context, result, skill, playerHpBefore = null }) {
    if (!context?.hash || !context.payload) return { recorded: false, reason: 'Combat context is unavailable' };
    const classified = classifyAttackResult(result, skill);
    if (!classified) return { recorded: false, reason: 'Attack result is not a verified normal-damage sample' };

    const observedAt = new Date(this.now()).toISOString();
    const hpAfter = numberOrNull(result?.retaliation?.user_hp_after);
    const hpBefore = numberOrNull(playerHpBefore);
    const sample = {
      observedAt,
      damage: classified.damage,
      multiplier: classified.multiplier,
      baseDamage: classified.baseDamage,
      hpLost: hpBefore !== null && hpAfter !== null ? Math.max(0, hpBefore - hpAfter) : null,
      criticalMultiplier: classified.criticalMultiplier,
      extraInfo: classified.extraInfo,
    };
    const record = this.data.records[context.hash] || {
      context: clone(context.payload),
      createdAt: observedAt,
      updatedAt: observedAt,
      nonCritical: [],
      critical: [],
      unclassified: [],
    };
    const bucket = classified.critical === true
      ? 'critical'
      : (classified.critical === false ? 'nonCritical' : 'unclassified');
    record[bucket].push(sample);
    record[bucket] = record[bucket].slice(-this.maxSamplesPerClass);
    record.updatedAt = observedAt;
    this.data.records[context.hash] = record;
    this._trimRecords();
    this._write();
    return {
      recorded: true,
      classification: classified.critical === true ? 'critical' : (classified.critical === false ? 'non-critical' : 'unclassified'),
      estimate: this.getEstimate(context.hash),
    };
  }

  getEstimate(contextOrHash) {
    const hash = typeof contextOrHash === 'string' ? contextOrHash : contextOrHash?.hash;
    const record = this.data.records[String(hash || '')];
    const samples = (record?.nonCritical || []).map(sample => Number(sample.baseDamage)).filter(value => Number.isFinite(value) && value > 0);
    if (samples.length === 0) return null;
    const ordered = [...samples].sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    const median = ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
    return {
      contextHash: hash,
      conservativeBaseDamage: Math.floor(ordered[0]),
      medianBaseDamage: Math.floor(median),
      sampleCount: ordered.length,
      confidence: ordered.length >= 5 ? 'high' : (ordered.length >= 2 ? 'medium' : 'low'),
      updatedAt: record.updatedAt,
    };
  }

  getPlanningEstimate(contextOrHash) {
    const verified = this.getEstimate(contextOrHash);
    if (verified) return verified;
    const hash = typeof contextOrHash === 'string' ? contextOrHash : contextOrHash?.hash;
    const record = this.data.records[String(hash || '')];
    const adjusted = (record?.critical || [])
      .map(sample => {
        const damage = positiveFinite(sample.baseDamage);
        const criticalMultiplier = positiveFinite(sample.criticalMultiplier);
        return damage && criticalMultiplier ? damage / criticalMultiplier : null;
      })
      .filter(value => value !== null);
    if (adjusted.length === 0) return null;
    const ordered = adjusted.sort((left, right) => left - right);
    const middle = Math.floor(ordered.length / 2);
    const median = ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
    return {
      contextHash: hash,
      conservativeBaseDamage: Math.floor(ordered[0]),
      medianBaseDamage: Math.floor(median),
      sampleCount: ordered.length,
      confidence: 'provisional',
      source: 'critical-adjusted',
      updatedAt: record.updatedAt,
    };
  }

  getSummary({ accountName: name = null, loadoutHash = null } = {}) {
    const expectedAccountKey = name ? accountKey(name) : null;
    const records = Object.entries(this.data.records)
      .filter(([, record]) => !expectedAccountKey || record.context?.accountKey === expectedAccountKey)
      .filter(([, record]) => !loadoutHash || record.context?.loadoutHash === loadoutHash)
      .map(([hash, record]) => ({
        hash,
        monster: clone(record.context?.monster || {}),
        loadoutHash: record.context?.loadoutHash || '',
        updatedAt: record.updatedAt,
        nonCriticalSamples: record.nonCritical?.length || 0,
        criticalSamples: record.critical?.length || 0,
        unclassifiedSamples: record.unclassified?.length || 0,
        estimate: this.getEstimate(hash),
      }))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    return {
      recordCount: records.length,
      nonCriticalSamples: records.reduce((total, record) => total + record.nonCriticalSamples, 0),
      criticalSamples: records.reduce((total, record) => total + record.criticalSamples, 0),
      unclassifiedSamples: records.reduce((total, record) => total + record.unclassifiedSamples, 0),
      latest: records[0] || null,
    };
  }

  purgeAccount(accountName) {
    if (!accountName) return 0;
    const expectedAccountKey = accountKey(accountName);
    let removed = 0;
    for (const [hash, record] of Object.entries(this.data.records)) {
      if (record.context?.accountKey !== expectedAccountKey) continue;
      delete this.data.records[hash];
      removed += 1;
    }
    if (removed > 0) this._write();
    return removed;
  }

  exportAccount(accountName) {
    const expectedAccountKey = accountKey(accountName);
    return Object.fromEntries(Object.entries(this.data.records)
      .filter(([, record]) => record.context?.accountKey === expectedAccountKey)
      .map(([key, record]) => [key, clone(record)]));
  }

  replaceAccount(accountName, records = {}) {
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid damage-observation backup');
    this.purgeAccount(accountName);
    const expectedAccountKey = accountKey(accountName);
    for (const [key, record] of Object.entries(records)) {
      if (record?.context?.accountKey === expectedAccountKey) this.data.records[key] = clone(record);
    }
    this._trimRecords();
    this._write();
  }

  _read() {
    try {
      if (!fs.existsSync(this.filePath)) return emptyStore();
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed?.schemaVersion !== DAMAGE_OBSERVATION_SCHEMA_VERSION || !parsed.records || typeof parsed.records !== 'object') {
        return emptyStore();
      }
      return parsed;
    } catch {
      return emptyStore();
    }
  }

  _trimRecords() {
    const records = Object.entries(this.data.records);
    if (records.length <= this.maxRecords) return;
    records.sort((left, right) => String(right[1].updatedAt).localeCompare(String(left[1].updatedAt)));
    this.data.records = Object.fromEntries(records.slice(0, this.maxRecords));
  }

  _write() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }
}

module.exports = {
  DAMAGE_OBSERVATION_SCHEMA_VERSION,
  DamageObservationStore,
  createCombatContext,
  classifyAttackResult,
};
