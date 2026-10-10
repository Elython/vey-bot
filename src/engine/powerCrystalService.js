const { ActionExecutor } = require('./actionExecutor');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function numericId(value) {
  const text = String(value ?? '');
  return /^\d{1,30}$/.test(text) ? text : null;
}

function normalizedSlot(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function quickSetNumber(selection) {
  const number = Number(String(selection || '').match(/^quick_set_(\d+)$/)?.[1]);
  return Number.isInteger(number) && number >= 1 && number <= 10 ? number : null;
}

function throwIfCancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Crystal operation cancelled');
  error.name = 'AbortError';
  throw error;
}

function ambiguousMutation(error) {
  return ['TIMEOUT', 'REQUEST_FAILED', 'SESSION_DESTROYED'].includes(error?.code);
}

class PowerCrystalService {
  constructor({ gameAPI, configManager, loadoutService = null, gameController = null } = {}) {
    if (!gameAPI || !configManager) throw new TypeError('Power Crystal service requires GameAPI and ConfigManager');
    this.gameAPI = gameAPI;
    this.configManager = configManager;
    this.owner = configManager.activeAccount || null;
    this.draining = false;
    this.loadoutService = loadoutService;
    this.tail = Promise.resolve();
    const mutations = gameController || gameAPI;
    this.executor = new ActionExecutor({
      POWER_CRYSTAL_EQUIP: (params, context) => mutations.equipPowerCrystal(params, context.signal),
      POWER_CRYSTAL_UNEQUIP: (params, context) => mutations.unequipPowerCrystal(params, context.signal),
    });
  }

  _exclusive(task) {
    const execute = () => {
      if (this.draining) throw Object.assign(new Error('Crystal session is closing'), { name: 'AbortError' });
      this._assertAccount();
      return task();
    };
    const run = this.tail.then(execute, execute);
    this.tail = run.catch(() => null);
    return run;
  }

  _assertAccount() {
    if ((this.configManager.activeAccount || null) !== this.owner) {
      throw Object.assign(new Error('The active Crystal account changed'), { name: 'AbortError' });
    }
  }

  async dispose() {
    this.draining = true;
    // Let an in-progress reversible learning pair restore its item before logout switches config owners.
    await this.tail;
  }

  _crystalConfig() {
    this._assertAccount();
    return this.configManager.getConfig().powerCrystals;
  }

  async _readRaw() {
    this._assertAccount();
    const raw = await this.gameAPI.getPowerCrystals();
    this._assertAccount();
    if (!raw?.recognized) throw new Error('Power Crystals inventory was not recognized');
    return raw;
  }

  async _gearDetails() {
    try {
      const gear = await this.gameAPI.getGearInventory('attack');
      return new Map([...(gear.instances || []), ...(gear.equipped || [])]
        .filter(item => item.inventoryRef)
        .map(item => [String(item.inventoryRef), {
          name: item.name || `Equipment #${item.inventoryRef}`,
          slot: normalizedSlot(item.slot),
          rarity: item.rarity || 'unknown',
        }]));
    } catch {
      return new Map();
    }
  }

  async _loadoutItems(selection, signal = null) {
    const setNumber = quickSetNumber(selection);
    if (selection !== 'default' && setNumber === null) throw new Error('Unknown Crystal source Gear set');
    if (this.loadoutService) {
      if (setNumber === null) {
        const active = await this.loadoutService.getActiveLoadout({
          gearContext: 'attack', petContext: 'attack', force: true, signal,
        });
        return clone(active?.gear?.equipped || []);
      }
      const saved = await this.loadoutService.getSavedSet({
        kind: 'gear', context: 'attack', setNumber, force: true, signal,
      });
      return clone(saved?.items || []);
    }
    const parsed = await this.gameAPI.getGearInventory('attack', setNumber);
    return clone(parsed?.equipped || []);
  }

  _resolve(raw, knownLinks = {}) {
    const equipment = (raw.equipment || []).map((item, index) => {
      const remembered = [...new Set((item.crystalIds || []).map(id => knownLinks[String(id)]).filter(Boolean))];
      const inventoryRef = numericId(item.inventoryRef) || (remembered.length === 1 ? numericId(remembered[0]) : null);
      return { ...item, index, inventoryRef, resolved: Boolean(inventoryRef) };
    });
    const crystals = (raw.crystals || []).map(crystal => {
      const card = equipment.find(item => (item.crystalIds || []).includes(String(crystal.id)));
      return { ...crystal, equipmentRef: card?.inventoryRef || null };
    });
    return { equipment, crystals };
  }

  _rememberResolved(resolved) {
    const learned = {};
    for (const item of resolved.equipment || []) {
      if (!item.inventoryRef) continue;
      for (const crystalId of item.crystalIds || []) learned[String(crystalId)] = String(item.inventoryRef);
    }
    if (Object.keys(learned).length) this.configManager.rememberPowerCrystalLinks(learned);
    return learned;
  }

  async _project(raw = null) {
    const source = raw || await this._readRaw();
    const config = this._crystalConfig();
    const resolved = this._resolve(source, config.knownLinks || {});
    this._rememberResolved(resolved);
    const details = await this._gearDetails();
    const equipment = resolved.equipment.map((item, index) => {
      const detail = details.get(String(item.inventoryRef || ''));
      return {
        inventoryRef: item.inventoryRef,
        name: item.inventoryRef ? (detail?.name || `Equipment #${item.inventoryRef}`) : `Full equipment ${index + 1}`,
        slot: detail?.slot || '',
        rarity: detail?.rarity || 'unknown',
        crystalIds: clone(item.crystalIds || []),
        slotCount: Math.max(0, Number(item.slotCount) || 0),
        resolved: item.resolved,
      };
    });
    const crystals = resolved.crystals.map(crystal => {
      const detail = details.get(String(crystal.equipmentRef || ''));
      return {
        id: String(crystal.id), name: crystal.name, level: crystal.level, linked: crystal.linked === true,
        equipmentRef: crystal.equipmentRef,
        equipmentName: crystal.equipmentRef
          ? (detail?.name || `Equipment #${crystal.equipmentRef}`)
          : crystal.linked ? 'Full equipment identity not learned' : 'Not equipped',
        routeSlot: config.slotRoutes?.[String(crystal.id)] || null,
      };
    });
    return { raw: source, equipment, crystals, config: this._crystalConfig() };
  }

  hasPendingMutation() {
    return Boolean(this._crystalConfig().pendingMutation);
  }

  reconcilePending(signal = null) {
    return this._exclusive(async () => {
      throwIfCancelled(signal);
      if (this.hasPendingMutation()) await this._reconcilePending(await this._readRaw());
    });
  }

  read() {
    return this._exclusive(async () => {
      const projected = await this._project();
      return { equipment: projected.equipment, crystals: projected.crystals, config: projected.config };
    });
  }

  _isUnequipped(raw, crystalId) {
    return !(raw.equipment || []).some(item => (item.crystalIds || []).includes(String(crystalId)))
      && raw.crystals?.some(crystal => String(crystal.id) === String(crystalId) && crystal.linked !== true);
  }

  _isEquipped(raw, crystalId, equipmentRef, anchors = []) {
    const card = (raw.equipment || []).find(item => (item.crystalIds || []).includes(String(crystalId)));
    if (!card) return false;
    if (card.inventoryRef) return String(card.inventoryRef) === String(equipmentRef);
    return anchors.length > 0 && anchors.every(id => (card.crystalIds || []).includes(String(id)));
  }

  async _reconcilePending(raw) {
    const pending = this._crystalConfig().pendingMutation;
    if (!pending) return;
    const confirmed = pending.action === 'POWER_CRYSTAL_UNEQUIP'
      ? this._isUnequipped(raw, pending.crystalId)
      : this._isEquipped(raw, pending.crystalId, pending.equipmentRef, pending.anchors);
    if (!confirmed) {
      const error = new Error('The previous Crystal request is still unconfirmed. Check the Crystal layout before continuing.');
      error.code = 'CRYSTAL_MUTATION_AMBIGUOUS';
      throw error;
    }
    this.configManager.savePowerCrystalMutation(null);
    this.loadoutService?.invalidateActive('Crystal mutation reconciled');
  }

  async _mutate(action, params, verify, dryRun, signal = null, anchors = []) {
    throwIfCancelled(signal);
    if (!dryRun) this.configManager.savePowerCrystalMutation({ action, crystalId: params.crystalId,
      equipmentRef: params.equipmentRef, anchors });
    let result;
    try {
      result = await this.executor.execute({ action, params }, { dryRun: dryRun === true, signal });
    } catch (error) {
      if (!ambiguousMutation(error)) {
        if (error.notSubmitted === true) this.configManager.savePowerCrystalMutation(null);
        else if (!['AUTH_REQUIRED', 'CLOUDFLARE'].includes(error.code)) error.code = 'CRYSTAL_MUTATION_UNCONFIRMED';
        throw error;
      }
      const refreshed = await this._readRaw();
      if (verify(refreshed)) {
        this.configManager.savePowerCrystalMutation(null);
        this.loadoutService?.invalidateActive('Crystal mutation reconciled');
        return { raw: refreshed, reconciled: true };
      }
      const ambiguous = new Error(`${action} may have reached the server, but a fresh Crystal page did not confirm it`);
      ambiguous.code = 'CRYSTAL_MUTATION_AMBIGUOUS';
      throw ambiguous;
    }
    if (result?.dryRun) {
      const error = new Error('Dry Run is enabled. Power Crystal movement was blocked.');
      error.code = 'DRY_RUN';
      throw error;
    }
    const refreshed = await this._readRaw();
    if (!verify(refreshed)) {
      const error = new Error(`The server response was empty and the refreshed Crystal page did not confirm ${action}`);
      error.code = 'CRYSTAL_MUTATION_UNCONFIRMED';
      throw error;
    }
    this.configManager.savePowerCrystalMutation(null);
    this.loadoutService?.invalidateActive('Power Crystal link changed');
    return { raw: refreshed, reconciled: false };
  }

  async _unequip(raw, crystalId, dryRun, signal = null) {
    const intent = raw.intents?.unequip;
    if (!intent) throw new Error('Fresh unequip intent was missing from the Power Crystals page');
    return this._mutate('POWER_CRYSTAL_UNEQUIP', { crystalId: String(crystalId), intent },
      fresh => this._isUnequipped(fresh, crystalId), dryRun, signal);
  }

  async _equip(raw, crystalId, equipmentRef, anchors, dryRun, signal = null) {
    const intent = raw.intents?.equip;
    if (!intent) throw new Error('Fresh equip intent was missing from the Power Crystals page');
    return this._mutate('POWER_CRYSTAL_EQUIP', {
      crystalId: String(crystalId), equipmentRef: String(equipmentRef), intent,
    }, fresh => this._isEquipped(fresh, crystalId, equipmentRef, anchors), dryRun, signal, anchors);
  }

  async _learnFullItems(raw, dryRun, signal = null) {
    let current = raw;
    const learned = {};
    while (true) {
      throwIfCancelled(signal);
      const resolved = this._resolve(current, { ...this._crystalConfig().knownLinks, ...learned });
      const unknown = resolved.equipment.find(item => !item.inventoryRef && item.crystalIds.length > 0);
      if (!unknown) break;
      if (unknown.crystalIds.length < 2) {
        throw new Error('A full one-slot item cannot be identified safely from the captured contract');
      }
      const crystalId = unknown.crystalIds.at(-1);
      const anchors = unknown.crystalIds.slice(0, -1);
      current = (await this._unequip(current, crystalId, dryRun, signal)).raw;
      const exposed = (current.equipment || []).find(item => numericId(item.inventoryRef)
        && anchors.every(id => (item.crystalIds || []).includes(String(id))));
      if (!exposed) throw new Error('Unequip succeeded, but the equipment ID was not exposed by the refreshed page');
      const equipmentRef = String(exposed.inventoryRef);
      for (const id of [...anchors, crystalId]) learned[String(id)] = equipmentRef;
      this.configManager.rememberPowerCrystalLinks(learned);
      // Finish this reversible learning cycle even if Stop was pressed after removal.
      current = (await this._equip(current, crystalId, equipmentRef, anchors, dryRun)).raw;
    }
    return { raw: current, learned };
  }

  captureRouting(sourceSelection = 'default', { dryRun = false, signal = null, allowLearning = true } = {}) {
    return this._exclusive(async () => {
      throwIfCancelled(signal);
      const initial = await this._readRaw();
      await this._reconcilePending(initial);
      const unresolved = this._resolve(initial, this._crystalConfig().knownLinks || {})
        .equipment.some(item => !item.inventoryRef && item.crystalIds.length > 0);
      const learningAllowed = typeof allowLearning === 'function' ? allowLearning() : allowLearning;
      if (unresolved && !learningAllowed) {
        const error = new Error('Pause the bot to identify a fully occupied Crystal item safely');
        error.code = 'CRYSTAL_SCAN_REQUIRES_PAUSE';
        throw error;
      }
      const learned = await this._learnFullItems(initial, dryRun, signal);
      const projected = await this._project(learned.raw);
      const sourceItems = await this._loadoutItems(sourceSelection, signal);
      const sourceByRef = new Map(sourceItems.filter(item => item.inventoryRef)
        .map(item => [String(item.inventoryRef), item]));
      const slotRoutes = {};
      const unmapped = [];
      for (const crystal of projected.crystals) {
        if (!crystal.equipmentRef) continue;
        const sourceItem = sourceByRef.get(String(crystal.equipmentRef));
        const slot = normalizedSlot(sourceItem?.slot);
        if (slot) slotRoutes[String(crystal.id)] = slot;
        else unmapped.push(crystal.name || `Crystal #${crystal.id}`);
      }
      if (!Object.keys(slotRoutes).length) {
        throw new Error('None of the linked crystals belong to the selected Gear set');
      }
      const config = this.configManager.savePowerCrystalRouting(sourceSelection, slotRoutes).powerCrystals;
      const refreshed = await this._project(learned.raw);
      return {
        config,
        equipment: refreshed.equipment,
        crystals: refreshed.crystals,
        mapped: Object.keys(slotRoutes).length,
        unmapped,
      };
    });
  }

  applyForGearSelection(gearSelection, { dryRun = false, signal = null, policy = null } = {}) {
    return this._exclusive(async () => {
      const setNumber = quickSetNumber(gearSelection);
      if (setNumber === null) return { success: true, skipped: true, message: 'Default Gear does not require Crystal routing' };
      throwIfCancelled(signal);
      const config = clone(policy || this._crystalConfig());
      if (this._crystalConfig().pendingMutation) await this._reconcilePending(await this._readRaw());
      if (!config.enabled) {
        return { success: true, skipped: true, message: 'Automatic Crystal routing is turned off' };
      }
      if (!config.captured || !Object.keys(config.slotRoutes || {}).length) {
        return { success: true, skipped: true, message: 'Crystal routing has not been scanned yet' };
      }
      const targetItems = await this._loadoutItems(gearSelection, signal);
      const initial = await this._readRaw();
      await this._reconcilePending(initial);
      let learned = await this._learnFullItems(initial, dryRun, signal);
      let raw = learned.raw;
      let projected = await this._project(raw);
      const eligible = new Map(projected.equipment.filter(item => item.inventoryRef)
        .map(item => [String(item.inventoryRef), item]));
      const targetBySlot = new Map(targetItems
        .filter(item => item.inventoryRef && eligible.has(String(item.inventoryRef)))
        .map(item => [normalizedSlot(item.slot), String(item.inventoryRef)]));
      const owned = new Set(projected.crystals.map(crystal => String(crystal.id)));
      const desired = {};
      const missingSlots = new Set();
      for (const [crystalId, slot] of Object.entries(config.slotRoutes)) {
        if (!owned.has(crystalId)) continue;
        const destination = targetBySlot.get(normalizedSlot(slot));
        if (!destination) missingSlots.add(slot);
        else desired[crystalId] = destination;
      }
      if (!Object.keys(desired).length || missingSlots.size) {
        const missing = [...missingSlots].sort();
        const warning = missing.length
          ? `Quick Set ${setNumber} has no crystal-compatible item for: ${missing.join(', ')}`
          : `Quick Set ${setNumber} has no crystal-compatible routed items`;
        return { success: true, skipped: true, warning, missingSlots: missing };
      }
      const counts = new Map();
      for (const equipmentRef of Object.values(desired)) counts.set(equipmentRef, (counts.get(equipmentRef) || 0) + 1);
      for (const [equipmentRef, count] of counts) {
        const target = eligible.get(equipmentRef);
        const capacity = target?.slotCount || 0;
        const otherCrystals = (target?.crystalIds || []).filter(id => !Object.hasOwn(desired, String(id))).length;
        if (count + otherCrystals > capacity) {
          return { success: true, skipped: true, warning: `Crystal routing needs ${count} slots on equipment #${equipmentRef}, but only ${capacity} are available` };
        }
      }
      const current = Object.fromEntries(projected.crystals.map(crystal => [String(crystal.id), crystal.equipmentRef || null]));
      const changed = Object.keys(desired).filter(id => (current[id] || null) !== desired[id]);
      for (const crystalId of changed) {
        if (!current[crystalId]) continue;
        raw = (await this._unequip(raw, crystalId, dryRun, signal)).raw;
        current[crystalId] = null;
      }
      for (const crystalId of changed) {
        const equipmentRef = desired[crystalId];
        const target = (raw.equipment || []).find(item => String(item.inventoryRef || '') === equipmentRef);
        const anchors = clone(target?.crystalIds || []);
        raw = (await this._equip(raw, crystalId, equipmentRef, anchors, dryRun, signal)).raw;
        current[crystalId] = equipmentRef;
        this.configManager.rememberPowerCrystalLinks({ [crystalId]: equipmentRef });
      }
      projected = await this._project(raw);
      for (const [crystalId, equipmentRef] of Object.entries(desired)) {
        const actual = projected.crystals.find(crystal => String(crystal.id) === crystalId)?.equipmentRef || null;
        if (actual !== equipmentRef) throw new Error(`Crystal #${crystalId} did not reach its Quick Set slot`);
      }
      return {
        success: true,
        skipped: changed.length === 0,
        changed: changed.length,
        message: changed.length ? `Moved ${changed.length} Crystal(s) for Quick Set ${setNumber}` : `Quick Set ${setNumber} already has the routed Crystal items`,
        equipment: projected.equipment,
        crystals: projected.crystals,
        config: projected.config,
      };
    });
  }
}

module.exports = { PowerCrystalService };
