const DEFAULT_DIRECTORY_TTL_MS = 60_000;
const DEFAULT_UNAVAILABLE_TTL_MS = 5 * 60_000;
const GAME_ORIGIN = 'https://demonicscans.org';

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function gateRouteFromUrl(value) {
  try {
    const url = new URL(String(value || ''), `${GAME_ORIGIN}/gates.php`);
    if (url.origin !== GAME_ORIGIN || url.pathname !== '/active_wave.php') return null;
    const gateId = Number(url.searchParams.get('gate'));
    const wave = Number(url.searchParams.get('wave'));
    if (!Number.isInteger(gateId) || gateId < 1 || !Number.isInteger(wave) || wave < 1) return null;
    // Deliberately ignore unrelated query fields such as cookie_test=1.
    return { gateId, wave };
  } catch {
    return null;
  }
}

function unavailableWaveError(error) {
  return error?.code === 'AREA_UNAVAILABLE'
    || (error?.code === 'WAVE_FETCH_FAILED' && Number(error?.status) === 503)
    || /(?:wave|area).*HTTP\s+503|HTTP\s+503.*(?:wave|area)/i.test(String(error?.message || ''));
}

function routeForArea(area) {
  if (!area || area.type !== 'gate') return null;
  const gateId = Number(area.gateId);
  const wave = Number(area.wave);
  if (!Number.isInteger(gateId) || gateId < 1 || !Number.isInteger(wave) || wave < 1) return null;
  return { gateId, wave };
}

function unknownAreaState(source = 'probe') {
  return {
    state: 'unknown',
    available: true,
    verified: false,
    reason: null,
    observedAt: null,
    retryAt: null,
    source,
  };
}

class AreaAccessService {
  constructor(gameAPI, {
    now = () => Date.now(),
    directoryTtlMs = DEFAULT_DIRECTORY_TTL_MS,
    unavailableTtlMs = DEFAULT_UNAVAILABLE_TTL_MS,
  } = {}) {
    if (!gameAPI || typeof gameAPI.getGates !== 'function') {
      throw new TypeError('AreaAccessService requires the authenticated Gate reader');
    }
    this.gameAPI = gameAPI;
    this.now = now;
    this.directoryTtlMs = Math.max(1_000, Number(directoryTtlMs) || DEFAULT_DIRECTORY_TTL_MS);
    this.unavailableTtlMs = Math.max(1_000, Number(unavailableTtlMs) || DEFAULT_UNAVAILABLE_TTL_MS);
    this.gateDirectory = null;
    this.gateDirectoryPromise = null;
    this.areaStates = new Map();
  }

  async refreshGateDirectory({ force = false } = {}) {
    const now = Number(this.now());
    if (!force && this.gateDirectory && now - this.gateDirectory.observedAt < this.directoryTtlMs) {
      return clone(this.gateDirectory);
    }
    if (this.gateDirectoryPromise) return clone(await this.gateDirectoryPromise);
    const read = (async () => {
      const gates = await this.gameAPI.getGates();
      const routes = [];
      const maxWaveByGate = {};
      for (const gate of Array.isArray(gates) ? gates : []) {
        const route = gateRouteFromUrl(gate?.url);
        if (!route) continue;
        routes.push({ ...route, active: gate?.active === true, name: String(gate?.name || '') });
        maxWaveByGate[String(route.gateId)] = Math.max(
          Number(maxWaveByGate[String(route.gateId)]) || 0,
          route.wave,
        );
      }
      this.gateDirectory = {
        recognized: routes.length > 0,
        observedAt: Number(this.now()),
        routes,
        maxWaveByGate,
      };
      return this.gateDirectory;
    })();
    this.gateDirectoryPromise = read;
    try {
      return clone(await read);
    } finally {
      if (this.gateDirectoryPromise === read) this.gateDirectoryPromise = null;
    }
  }

  async checkArea(area, { force = false } = {}) {
    if (!area || !['gate', 'event'].includes(area.type)) {
      return unknownAreaState('not_gate_like');
    }
    const now = Number(this.now());
    const remembered = this.areaStates.get(area.key);
    if (!force && remembered?.available === true && remembered?.verified === true) {
      return clone(remembered);
    }
    if (!force && remembered?.available === false && Number(remembered.retryAt) > now) {
      return clone(remembered);
    }
    // `/gates.php` is navigation, not an authorization contract. Accounts may
    // receive an exact active_wave href which still returns the verified access
    // denial/503 when opened. Only the exact Wave response may mark the area
    // available or unavailable.
    if (remembered?.available === false && Number(remembered.retryAt) <= now) this.areaStates.delete(area.key);
    return unknownAreaState('probe');
  }

  markAvailable(area) {
    if (!area?.key) return unknownAreaState('wave');
    const state = {
      state: 'available',
      available: true,
      verified: true,
      reason: null,
      observedAt: Number(this.now()),
      retryAt: null,
      source: 'wave',
      route: routeForArea(area),
    };
    this.areaStates.set(area.key, state);
    return clone(state);
  }

  markUnavailable(area, error = null) {
    const state = {
      state: 'unavailable',
      available: false,
      verified: true,
      reason: `${area?.label || 'Area'} is not currently available to this account`,
      observedAt: Number(this.now()),
      retryAt: Number(this.now()) + this.unavailableTtlMs,
      source: Number(error?.status) === 503 ? 'wave_http_503' : 'wave_access_denied',
    };
    if (area?.key) this.areaStates.set(area.key, state);
    return clone(state);
  }

  getAreaState(areaKey) {
    const state = this.areaStates.get(String(areaKey || ''));
    return state ? clone(state) : null;
  }

  async getPlayerResourceRoute() {
    const verified = [...this.areaStates.values()]
      .filter(state => state?.available === true && state?.verified === true && state?.route)
      .sort((left, right) => Number(right.observedAt || 0) - Number(left.observedAt || 0));
    if (verified[0]?.route) return clone(verified[0].route);
    return null;
  }

  invalidate() {
    this.gateDirectory = null;
    this.areaStates.clear();
  }
}

module.exports = {
  AreaAccessService,
  DEFAULT_DIRECTORY_TTL_MS,
  DEFAULT_UNAVAILABLE_TTL_MS,
  gateRouteFromUrl,
  routeForArea,
  unknownAreaState,
  unavailableWaveError,
};
