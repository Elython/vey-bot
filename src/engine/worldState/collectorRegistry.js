const { WorldDomain } = require('./contracts');

const VALID_DOMAINS = new Set(Object.values(WorldDomain));

class CollectorRegistry {
  constructor() {
    this.collectors = new Map();
  }

  register(domain, collector) {
    if (!VALID_DOMAINS.has(domain)) throw new Error(`Unsupported world-state domain: ${domain || 'missing'}`);
    if (!collector || typeof collector.collect !== 'function') {
      throw new TypeError('Collector must expose collect(request)');
    }
    if (this.collectors.has(domain)) throw new Error(`Collector already registered for ${domain}`);
    this.collectors.set(domain, collector);
    let registered = true;
    return () => {
      if (!registered) return false;
      registered = false;
      if (this.collectors.get(domain) !== collector) return false;
      this.collectors.delete(domain);
      return true;
    };
  }

  resolve(domain) {
    return this.collectors.get(domain) || null;
  }

  has(domain) {
    return this.collectors.has(domain);
  }

  unregister(domain) {
    return this.collectors.delete(domain);
  }

  clear() {
    const count = this.collectors.size;
    this.collectors.clear();
    return count;
  }

  get size() {
    return this.collectors.size;
  }
}

module.exports = { CollectorRegistry };
