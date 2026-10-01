const {
  ReadPriority,
  createCollectorRequest,
  createReadRequest,
  createWorldPatch,
} = require('./contracts');
const { isFreshEnough } = require('./freshnessPolicy');
const { assertAccountKey, assertAccountScope, buildResourceKey } = require('./identity');

const PRIORITY_RANK = Object.freeze({
  [ReadPriority.MUTATION_REVALIDATION]: 0,
  [ReadPriority.COMBAT]: 1,
  [ReadPriority.ACTIVE_MODULE]: 2,
  [ReadPriority.VISIBLE_UI]: 3,
  [ReadPriority.BACKGROUND]: 4,
});

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

class ReadCoordinatorError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = code === 'READ_ABORTED' ? 'AbortError' : 'ReadCoordinatorError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function abortError(message = 'Read operation cancelled') {
  return new ReadCoordinatorError('READ_ABORTED', message);
}

function emptyDiagnostics() {
  return {
    requestsRequested: 0,
    collectorStarts: 0,
    collectorCompletions: 0,
    collectorFailures: 0,
    cacheHits: 0,
    cacheMisses: 0,
    coalescedWaiters: 0,
    queuePromotions: 0,
    cancellations: 0,
    stalePatchesDropped: 0,
    totalDurationMs: 0,
    latestDurationMs: 0,
    byDomain: {},
  };
}

function domainDiagnostics(diagnostics, domain) {
  diagnostics.byDomain[domain] ||= {
    requested: 0,
    starts: 0,
    completions: 0,
    failures: 0,
    cacheHits: 0,
    cacheMisses: 0,
    durationMs: 0,
  };
  return diagnostics.byDomain[domain];
}

class ReadCoordinator {
  constructor({
    worldStateService,
    collectorRegistry,
    maxConcurrency = 3,
    highPriorityBurstLimit = 5,
    now = () => Date.now(),
  } = {}) {
    if (!worldStateService || typeof worldStateService.peek !== 'function' || typeof worldStateService.applyPatch !== 'function') {
      throw new TypeError('ReadCoordinator requires WorldStateService');
    }
    if (!collectorRegistry || typeof collectorRegistry.resolve !== 'function') {
      throw new TypeError('ReadCoordinator requires CollectorRegistry');
    }
    this.worldStateService = worldStateService;
    this.collectorRegistry = collectorRegistry;
    this.maxConcurrency = Math.max(1, Math.min(32, Math.trunc(Number(maxConcurrency) || 1)));
    this.highPriorityBurstLimit = Math.max(1, Math.trunc(Number(highPriorityBurstLimit) || 5));
    this.now = now;
    this.queue = [];
    this.flights = new Map();
    this.accountGenerations = new Map();
    this.activeCount = 0;
    this.sequence = 0;
    this.highPrioritySelections = 0;
    this.drainScheduled = false;
    this.disposed = false;
    this.diagnostics = emptyDiagnostics();
  }

  _assertActive() {
    if (this.disposed) throw new ReadCoordinatorError('READ_COORDINATOR_DISPOSED', 'Read coordinator is disposed');
  }

  _generation(accountKey) {
    return this.accountGenerations.get(accountKey) || 0;
  }

  peek(accountKey, domain, resourceKey = 'current') {
    this._assertActive();
    return this.worldStateService.peek(accountKey, domain, resourceKey);
  }

  invalidate(accountKey, domain, resourceKey = 'current', reason = 'invalidated') {
    this._assertActive();
    return this.worldStateService.invalidate(accountKey, domain, resourceKey, reason);
  }

  read(rawRequest) {
    this._assertActive();
    const request = createReadRequest(rawRequest);
    if (!this.worldStateService.hasAccount(request.accountKey)) {
      throw new ReadCoordinatorError('WORLD_STATE_ACCOUNT_MISMATCH', 'World State account is not registered');
    }
    if (request.signal?.aborted) return Promise.reject(abortError());

    this.diagnostics.requestsRequested += 1;
    domainDiagnostics(this.diagnostics, request.domain).requested += 1;
    const cached = this.worldStateService.peek(request.accountKey, request.domain, request.resourceKey);
    const cacheHit = request.force !== true
      && request.maxAgeMs > 0
      && cached
      && isFreshEnough(cached.meta || {}, { now: this.now(), maxAgeMs: request.maxAgeMs });
    if (cacheHit) {
      this.diagnostics.cacheHits += 1;
      domainDiagnostics(this.diagnostics, request.domain).cacheHits += 1;
      return Promise.resolve(clone(cached));
    }

    this.diagnostics.cacheMisses += 1;
    domainDiagnostics(this.diagnostics, request.domain).cacheMisses += 1;
    const key = buildResourceKey(request);
    let flight = this.flights.get(key);
    if (flight) {
      this.diagnostics.coalescedWaiters += 1;
      const requestedRank = PRIORITY_RANK[request.priority];
      if (flight.status === 'queued' && requestedRank < flight.rank) {
        flight.rank = requestedRank;
        flight.priority = request.priority;
        this.diagnostics.queuePromotions += 1;
      }
      return this._attachWaiter(flight, request.signal);
    }

    flight = {
      key,
      accountKey: request.accountKey,
      domain: request.domain,
      resourceKey: request.resourceKey,
      priority: request.priority,
      rank: PRIORITY_RANK[request.priority],
      sequence: this.sequence++,
      generation: this._generation(request.accountKey),
      controller: new AbortController(),
      waiters: new Set(),
      status: 'queued',
      cancelled: false,
      startedAt: null,
    };
    this.flights.set(key, flight);
    this.queue.push(flight);
    const promise = this._attachWaiter(flight, request.signal);
    this._scheduleDrain();
    return promise;
  }

  _attachWaiter(flight, signal) {
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abortListener: null, settled: false };
      waiter.abortListener = () => this._abortWaiter(flight, waiter);
      if (signal) signal.addEventListener('abort', waiter.abortListener, { once: true });
      flight.waiters.add(waiter);
      if (signal?.aborted) this._abortWaiter(flight, waiter);
    });
  }

  _settleWaiter(flight, waiter, method, value) {
    if (waiter.settled) return false;
    waiter.settled = true;
    if (waiter.signal && waiter.abortListener) waiter.signal.removeEventListener('abort', waiter.abortListener);
    flight.waiters.delete(waiter);
    waiter[method](value);
    return true;
  }

  _abortWaiter(flight, waiter) {
    if (!this._settleWaiter(flight, waiter, 'reject', abortError())) return;
    this.diagnostics.cancellations += 1;
    if (flight.waiters.size === 0) this._cancelFlight(flight, 'No read waiters remain');
  }

  _cancelFlight(flight, message) {
    if (flight.cancelled) return false;
    flight.cancelled = true;
    let cancelledWaiters = 0;
    for (const waiter of [...flight.waiters]) {
      if (this._settleWaiter(flight, waiter, 'reject', abortError(message))) cancelledWaiters += 1;
    }
    this.diagnostics.cancellations += cancelledWaiters;
    flight.controller.abort();
    if (flight.status === 'queued') {
      const index = this.queue.indexOf(flight);
      if (index >= 0) this.queue.splice(index, 1);
    }
    if (this.flights.get(flight.key) === flight) this.flights.delete(flight.key);
    return true;
  }

  _scheduleDrain() {
    if (this.disposed || this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this._drain();
    });
  }

  _selectNextFlight() {
    if (this.queue.length === 0) return null;
    const mutations = this.queue.filter(flight => flight.rank === PRIORITY_RANK[ReadPriority.MUTATION_REVALIDATION]);
    let selected = null;
    if (mutations.length > 0) {
      selected = mutations.reduce((left, right) => left.sequence < right.sequence ? left : right);
    } else {
      const priorityChoice = this.queue.reduce((left, right) => (
        right.rank < left.rank || (right.rank === left.rank && right.sequence < left.sequence) ? right : left
      ));
      const oldest = this.queue.reduce((left, right) => left.sequence < right.sequence ? left : right);
      selected = this.highPrioritySelections >= this.highPriorityBurstLimit && oldest.rank > priorityChoice.rank
        ? oldest
        : priorityChoice;
    }
    const index = this.queue.indexOf(selected);
    this.queue.splice(index, 1);
    if (selected.rank < PRIORITY_RANK[ReadPriority.BACKGROUND]) this.highPrioritySelections += 1;
    else this.highPrioritySelections = 0;
    if (selected.sequence === Math.min(...[selected, ...this.queue].map(flight => flight.sequence))
      && selected.rank > 0) this.highPrioritySelections = 0;
    return selected;
  }

  _drain() {
    if (this.disposed) return;
    while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const flight = this._selectNextFlight();
      if (!flight || flight.cancelled || flight.waiters.size === 0) continue;
      this._executeFlight(flight);
    }
  }

  async _executeFlight(flight) {
    flight.status = 'active';
    flight.startedAt = Number(this.now());
    this.activeCount += 1;
    this.diagnostics.collectorStarts += 1;
    domainDiagnostics(this.diagnostics, flight.domain).starts += 1;
    try {
      const collector = this.collectorRegistry.resolve(flight.domain);
      if (!collector) {
        throw new ReadCoordinatorError('COLLECTOR_NOT_REGISTERED', `No collector registered for ${flight.domain}`);
      }
      const previous = this.worldStateService.peek(flight.accountKey, flight.domain, flight.resourceKey);
      const request = createCollectorRequest({
        accountKey: flight.accountKey,
        resourceKey: flight.resourceKey,
        previous: previous?.value || null,
        signal: flight.controller.signal,
      });
      const rawResult = await collector.collect(request);
      if (flight.cancelled || this.disposed || flight.generation !== this._generation(flight.accountKey)) return;
      let patch;
      try {
        patch = createWorldPatch(rawResult);
        assertAccountScope(flight.accountKey, patch.accountKey);
        if (patch.domain !== flight.domain || patch.resourceKey !== flight.resourceKey) {
          throw new Error('Collector result does not match the requested resource');
        }
      } catch (error) {
        throw new ReadCoordinatorError('INVALID_COLLECTOR_RESULT', 'Collector returned an invalid observation', error);
      }
      const applied = this.worldStateService.applyPatch(patch);
      if (!applied.applied) this.diagnostics.stalePatchesDropped += 1;
      const value = this.worldStateService.peek(flight.accountKey, flight.domain, flight.resourceKey);
      this.diagnostics.collectorCompletions += 1;
      domainDiagnostics(this.diagnostics, flight.domain).completions += 1;
      for (const waiter of [...flight.waiters]) this._settleWaiter(flight, waiter, 'resolve', clone(value));
    } catch (error) {
      if (flight.cancelled || this.disposed || flight.controller.signal.aborted) {
        for (const waiter of [...flight.waiters]) this._settleWaiter(flight, waiter, 'reject', abortError());
      } else {
        const normalized = error instanceof ReadCoordinatorError
          ? error
          : new ReadCoordinatorError('COLLECTOR_FAILED', 'Collector read failed', error);
        this.diagnostics.collectorFailures += 1;
        domainDiagnostics(this.diagnostics, flight.domain).failures += 1;
        for (const waiter of [...flight.waiters]) this._settleWaiter(flight, waiter, 'reject', normalized);
      }
    } finally {
      const duration = Math.max(0, Number(this.now()) - Number(flight.startedAt || this.now()));
      this.diagnostics.latestDurationMs = duration;
      this.diagnostics.totalDurationMs += duration;
      domainDiagnostics(this.diagnostics, flight.domain).durationMs += duration;
      this.activeCount = Math.max(0, this.activeCount - 1);
      flight.status = 'settled';
      if (this.flights.get(flight.key) === flight) this.flights.delete(flight.key);
      for (const waiter of [...flight.waiters]) this._settleWaiter(flight, waiter, 'reject', abortError());
      this._scheduleDrain();
    }
  }

  cancelAccount(accountKey) {
    this._assertActive();
    const key = assertAccountKey(accountKey);
    this.accountGenerations.set(key, this._generation(key) + 1);
    let cancelled = 0;
    for (const flight of [...this.flights.values()]) {
      if (flight.accountKey !== key) continue;
      if (this._cancelFlight(flight, 'Account read operations cancelled')) cancelled += 1;
    }
    this._scheduleDrain();
    return cancelled;
  }

  getDiagnostics() {
    return {
      ...clone(this.diagnostics),
      activeFlights: this.activeCount,
      queuedFlights: this.queue.length,
      flights: this.flights.size,
      disposed: this.disposed,
    };
  }

  dispose() {
    if (this.disposed) return false;
    for (const flight of [...this.flights.values()]) this._cancelFlight(flight, 'Read coordinator disposed');
    this.queue.length = 0;
    this.flights.clear();
    this.activeCount = 0;
    this.disposed = true;
    return true;
  }
}

module.exports = {
  PRIORITY_RANK,
  ReadCoordinator,
  ReadCoordinatorError,
  abortError,
};
