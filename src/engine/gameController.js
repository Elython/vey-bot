/**
 * API-only game action controller.
 * All mutating actions pass through this class so timing and cancellation are consistent.
 */

class GameController {
  constructor(gameAPI, timingEngine) {
    this.gameAPI = gameAPI;
    this.timing = timingEngine;
  }

  async joinBattle(battleRef, userId, signal = null, delay = {}) {
    const isDungeon = Boolean(
      battleRef.isDungeon ||
      battleRef.endpoints?.JOIN === 'dungeon_join_battle.php' ||
      battleRef.endpoints?.LOOT === 'dungeon_loot.php'
    );
    const profile = isDungeon ? delay?.dungeon : null;
    await this.timing.waitForAction(signal, isDungeon ? {
      minimumIntervalMs: 10,
      minDelayMs: profile?.minDelay,
      maxDelayMs: profile?.maxDelay,
    } : {});
    return this.gameAPI.joinBattle(battleRef, userId);
  }

  async attack(battleRef, skill, delay = {}, signal = null) {
    const isDungeon = Boolean(
      battleRef.isDungeon ||
      battleRef.endpoints?.JOIN === 'dungeon_join_battle.php' ||
      battleRef.endpoints?.LOOT === 'dungeon_loot.php'
    );
    const profile = isDungeon ? delay?.dungeon : delay?.gate;
    // Gates have a verified one-second server limit and use the user's requested
    // 0.05-second safety margin. Dungeons have no observed server limit; their
    // small floor only prevents an accidental literal zero-delay loop.
    await this.timing.waitForAction(signal, {
      minimumIntervalMs: isDungeon ? 10 : 1050,
      minDelayMs: profile?.minDelay,
      maxDelayMs: profile?.maxDelay,
    });
    return this.gameAPI.attack({
      monsterId: battleRef.dgmid || battleRef.id || battleRef.monsterId,
      skillId: skill.id,
      stamCost: skill.requestStamCost ?? skill.stamCost,
      isDungeon,
      instanceId: battleRef.instanceId,
      dgmid: battleRef.dgmid,
    });
  }

  async loot(battleRef, userId, delay = {}, signal = null) {
    await this.timing.waitForAction(signal, {
      minimumIntervalMs: 10,
      minDelayMs: 10,
      maxDelayMs: 10,
    });
    return this.gameAPI.loot(battleRef, userId);
  }

  async claimLoot(battleRef, delay = {}, signal = null) {
    await this.timing.waitForAction(signal, {
      minimumIntervalMs: 10,
      minDelayMs: 10,
      maxDelayMs: 10,
    });
    return this.gameAPI.loot(battleRef);
  }

  async heal(userId, mode = 'potion_first', signal = null, options = {}) {
    const actions = {
      potion: () => this.gameAPI.healPotion(userId),
      timed: () => this.gameAPI.heal(userId),
    };
    const order = mode === 'timed_first' ? ['timed', 'potion']
      : mode === 'timed_only' ? ['timed']
        : mode === 'potion_only' ? ['potion']
          : ['potion', 'timed'];

    let lastResult = { success: false, message: 'No healing method was attempted' };
    for (const method of order) {
      const profile = options.isDungeon ? options.delay?.dungeon : null;
      await this.timing.waitForAction(signal, options.isDungeon ? {
        minimumIntervalMs: 10,
        minDelayMs: profile?.minDelay,
        maxDelayMs: profile?.maxDelay,
      } : {});
      lastResult = await actions[method]();
      if (lastResult.success) return { ...lastResult, method };
    }
    return lastResult;
  }

  async buyPotion(type, signal = null) {
    await this.timing.waitForAction(signal);
    return this.gameAPI.buyPotion(type);
  }

  async useStaminaPotion(inventoryId, signal = null) {
    await this.timing.waitForAction(signal);
    return this.gameAPI.useStaminaPotion(inventoryId);
  }

  async useManaPotion(inventoryId, signal = null) {
    await this.timing.waitForAction(signal);
    return this.gameAPI.useManaPotion(inventoryId);
  }

  async applyQuickSet(params, signal = null) {
    await this.timing.waitForAction(signal);
    return this.gameAPI.applyQuickSet(params);
  }
}

module.exports = { GameController };
