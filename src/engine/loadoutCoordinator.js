const { ReadPriority } = require('./worldState');

// Dependencies are explicit: this coordinator does not own bot lifecycle or config persistence.
class LoadoutCoordinator {
  constructor({ gameController, loadoutService, crystalService, getConfig, getSelections,
    invalidateCombat, recordAction, refreshStats, log }) {
    Object.assign(this, { gameController, loadoutService, crystalService, getConfig, getSelections,
      invalidateCombat, recordAction, refreshStats, log });
  }

  async routeCrystals(kind, selection, signal) {
    if (kind !== 'gear' || !this.crystalService) return { success: true, skipped: true };
    if (signal?.aborted) throw Object.assign(new Error('Loadout operation cancelled'), { name: 'AbortError' });
    const config = this.getConfig() || {};
    const result = await this.crystalService.applyForGearSelection(selection, {
      dryRun: config.safety?.dryRun === true, signal, policy: config.powerCrystals,
    });
    if (result?.warning) this.log('WARN', 'Power Crystals: ' + result.warning);
    else if (!result?.skipped) this.log('INFO', result.message || 'Power Crystals moved for ' + selection);
    return result;
  }

  async apply({ kind, selection, forceVerify = false }, signal) {
    const match = String(selection).match(/^quick_set_(\d+)$/);
    const setNumber = Number(match?.[1]);
    if (!['gear', 'pets'].includes(kind) || !Number.isInteger(setNumber) || setNumber < 1 || setNumber > 10) {
      return { success: false, message: 'Invalid Quick Set selection' };
    }
    if (signal?.aborted) throw Object.assign(new Error('Loadout operation cancelled'), { name: 'AbortError' });
    const selections = this.getSelections();
    if (!forceVerify && selections[kind] === selection) {
      const crystals = await this.routeCrystals(kind, selection, signal);
      return { success: true, skipped: true, crystals, message: selection + ' ' + kind + ' is already active' };
    }
    let alreadyActive = false;
    if (this.loadoutService) {
      try { alreadyActive = await this.loadoutService.isSavedSetActive({ kind, setNumber, context: 'attack' }); }
      catch (error) {
        if (error.name === 'AbortError') throw error;
        this.log('WARN', 'Could not verify the active ' + kind + ' set: ' + error.message);
      }
    }
    if (alreadyActive) {
      selections[kind] = selection;
      const crystals = await this.routeCrystals(kind, selection, signal);
      return { success: true, skipped: true, crystals, message: selection + ' ' + kind + ' already matches the active set' };
    }
    const result = await this.gameController.applyQuickSet({
      setNumber, targetSet: 'attack', applyType: kind === 'gear' ? 'equipments' : 'pets',
    }, signal);
    this.recordAction(result);
    if (!result.success) throw new Error(result.message || 'Quick Set ' + setNumber + ' could not be applied');
    selections[kind] = selection;
    this.loadoutService?.invalidateActive('Quick Set applied');
    this.invalidateCombat();
    const crystals = await this.routeCrystals(kind, selection, signal);
    if (this.loadoutService?.getActiveLoadout) {
      try {
        await this.loadoutService.getActiveLoadout({ gearContext: 'attack', petContext: 'attack',
          force: true, priority: ReadPriority.MUTATION_REVALIDATION, signal });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        this.log('WARN', 'Quick Set applied but loadout revalidation was deferred: ' + error.message);
      }
    }
    await this.refreshStats();
    return { ...result, crystals };
  }
}

module.exports = { LoadoutCoordinator };
