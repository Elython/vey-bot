const { buildLoadoutSnapshot } = require('./loadoutCatalog');

const LOADOUT_CONTEXTS = new Set(['attack', 'pvp_attack', 'defense']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class LoadoutService {
  constructor(gameAPI, accountName = null, options = {}) {
    this.gameAPI = gameAPI;
    this.accountName = accountName;
    this.cacheMaxAgeMs = Number.isFinite(options.cacheMaxAgeMs) ? Math.max(0, options.cacheMaxAgeMs) : 30000;
    this.now = options.now || (() => Date.now());
    this.latest = new Map();
    this.snapshots = new Map();
    this.inFlight = new Map();
  }

  setGameAPI(gameAPI, accountName = this.accountName) {
    this.gameAPI = gameAPI;
    this.accountName = accountName;
    this.latest.clear();
    this.snapshots.clear();
    this.inFlight.clear();
  }

  async getActiveLoadout({ gearContext = 'attack', petContext = 'attack', force = false } = {}) {
    if (!LOADOUT_CONTEXTS.has(gearContext) || !LOADOUT_CONTEXTS.has(petContext)) {
      throw new Error('Unknown loadout context');
    }
    if (!this.gameAPI) throw new Error('Game session not active');
    const cacheKey = `${gearContext}:${petContext}`;
    const cached = this.latest.get(cacheKey);
    if (!force && cached && this.now() - cached.readAt <= this.cacheMaxAgeMs) return clone(cached.snapshot);
    if (this.inFlight.has(cacheKey)) return clone(await this.inFlight.get(cacheKey));

    const request = this._readLoadout(gearContext, petContext);
    this.inFlight.set(cacheKey, request);
    try {
      return clone(await request);
    } finally {
      if (this.inFlight.get(cacheKey) === request) this.inFlight.delete(cacheKey);
    }
  }

  getSnapshot(hash) {
    const snapshot = this.snapshots.get(String(hash || ''));
    return snapshot ? clone(snapshot) : null;
  }

  invalidateActive() {
    this.latest.clear();
    this.inFlight.clear();
  }

  async isSavedSetActive({ kind, setNumber, context = 'attack' } = {}) {
    const [saved, active] = await Promise.all([
      this.getSavedSet({ kind, setNumber, context }),
      this.getActiveLoadout({ force: true }),
    ]);
    const activeItems = kind === 'gear' ? active.gear.equipped : active.pets.equipped;
    const signature = items => (Array.isArray(items) ? items : [])
      .map(item => ({
        name: String(item.name || '').trim().toLowerCase(),
        attack: Number(item.attack) || 0,
        defense: Number(item.defense) || 0,
        ability: String(item.ability || item.effect || '').trim(),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return JSON.stringify(signature(saved.items)) === JSON.stringify(signature(activeItems));
  }

  async getSavedSet({ kind, setNumber, context = 'attack' } = {}) {
    if (!LOADOUT_CONTEXTS.has(context)) throw new Error('Unknown loadout context');
    if (!['gear', 'pets'].includes(kind)) throw new Error('Unknown loadout kind');
    if (!this.gameAPI) throw new Error('Game session not active');
    const parsed = kind === 'gear'
      ? await this.gameAPI.getGearInventory(context, setNumber)
      : await this.gameAPI.getPetInventory(context, setNumber);
    return clone({
      kind,
      context,
      quickSetNumber: parsed.quickSetNumber,
      items: parsed.equipped,
      totals: parsed.equipped.reduce((totals, item) => ({
        attack: totals.attack + (Number(item.attack) || 0),
        defense: totals.defense + (Number(item.defense) || 0),
      }), { attack: 0, defense: 0 }),
      warnings: parsed.warnings,
    });
  }

  async _readLoadout(gearContext, petContext) {
    const [gear, pets] = await Promise.all([
      this.gameAPI.getGearInventory(gearContext),
      this.gameAPI.getPetInventory(petContext),
    ]);
    const observedAt = new Date(this.now()).toISOString();
    const snapshot = buildLoadoutSnapshot({ gear, pets, accountName: this.accountName, observedAt });
    const cacheKey = `${gearContext}:${petContext}`;
    this.latest.set(cacheKey, { readAt: this.now(), snapshot });
    this.snapshots.set(snapshot.hash.value, snapshot);
    while (this.snapshots.size > 50) this.snapshots.delete(this.snapshots.keys().next().value);
    return snapshot;
  }
}

module.exports = { LoadoutService, LOADOUT_CONTEXTS };
