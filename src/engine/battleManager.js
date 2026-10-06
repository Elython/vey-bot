const { Logger } = require('../main/logger');

/**
 * Holds the current battle context and applies one API action at a time.
 * BotEngine owns the outer loop so pause, stop, and challenge handling stay responsive.
 */
class BattleManager {
  constructor(gameAPI, gameController, accountName = null) {
    this.gameAPI = gameAPI;
    this.controller = gameController;
    this.accountName = accountName;
    this.currentBattle = null;
    this.lastStamina = null;
    this.lastConsumables = { recognized: false, items: [], updatedAt: null };
  }

  setAccount(accountName) {
    this.accountName = accountName;
    this.lastConsumables = { recognized: false, items: [], updatedAt: null };
    this.gameAPI.setAccount(accountName);
  }

  async loadBattle(battleRef) {
    const displayId = typeof battleRef === 'object' ? (battleRef.dgmid || battleRef.id) : battleRef;
    Logger.logClient(this.accountName, `[BattleManager] Loading battle ${displayId}`);
    const battle = await this.gameAPI.getBattleConfig(battleRef);
    return this.adoptBattle(battle);
  }

  adoptBattle(battle) {
    if (!battle.battleCfg?.id) throw new Error('Battle configuration is missing a monster ID');
    if (!battle.userId) throw new Error('Battle configuration is missing a user ID');
    this.currentBattle = battle;
    if (battle.consumables?.recognized === true) {
      this.lastConsumables = {
        recognized: true,
        items: (battle.consumables.items || []).map(item => ({ ...item })),
        updatedAt: Date.now(),
      };
    }
    if (Number.isFinite(Number(battle.stamina))) this.lastStamina = Number(battle.stamina);
    return battle;
  }

  async refresh() {
    if (!this.currentBattle?.battleCfg?.id) return null;
    return this.loadBattle(this.currentBattle.battleLocator || this.currentBattle.battleCfg);
  }

  async joinCurrentBattle(signal = null, delay = {}) {
    const battle = this._requireBattle();
    if (battle.isJoined) return { success: true, message: 'Already joined' };
    const result = await this.controller.joinBattle(battle.battleLocator || battle.battleCfg, battle.userId, signal, delay);
    if (result.success) {
      battle.isJoined = true;
      battle.hasJoinButton = false;
    }
    return result;
  }

  async attackOnce(skill, delay, signal = null) {
    const battle = this._requireBattle();
    if (battle.isDead) return { success: false, message: 'Monster is already dead' };
    const result = await this.controller.attack(battle.battleLocator || battle.battleCfg, skill, delay, signal);
    this.applyAttackResult(result, { supportAbility: skill?.supportAbility === true });
    return result;
  }

  applyAttackResult(result, options = {}) {
    if (!this.currentBattle || !result) return;
    const previousUserDamage = Number(this.currentBattle.userDamage ?? this.currentBattle.userDmg ?? 0) || 0;
    if (result.hp) {
      this.currentBattle.monsterHp = result.hp.value;
      this.currentBattle.monsterMaxHp = result.hp.max;
      if (result.hp.value <= 0) {
        this.currentBattle.isDead = true;
        this.currentBattle.hasLootButton = true;
      }
    }
    const placeholderSupportResources = options.supportAbility === true;
    if (result.stamina !== null && result.stamina !== undefined
      && !(placeholderSupportResources && Number(result.stamina) === 0)) {
      this.lastStamina = result.stamina;
    }
    if (result.retaliation?.user_hp_after !== undefined) {
      const nextHp = Number(result.retaliation.user_hp_after);
      const retaliationDamage = Number(result.retaliation?.damage);
      const falseSupportZero = placeholderSupportResources
        && nextHp === 0
        && Number(this.currentBattle.playerHp) > 0
        && !(Number.isFinite(retaliationDamage) && retaliationDamage > 0);
      if (!falseSupportZero) this.currentBattle.playerHp = result.retaliation.user_hp_after;
    }
    if (result.mana !== null && result.mana !== undefined) this.currentBattle.playerMana = result.mana;
    if (result.totalDmgDealt !== null && result.totalDmgDealt !== undefined) {
      const total = Number(result.totalDmgDealt) || 0;
      this.currentBattle.userDamage = total;
      if (result.damage === null || result.damage === undefined) {
        result.damage = Math.max(0, total - previousUserDamage);
      }
    }
  }

  async lootCurrent(delay, signal = null) {
    const battle = this._requireBattle();
    const result = await this.controller.loot(battle.battleLocator || battle.battleCfg, battle.userId, delay, signal);
    if (result.success) this.clear();
    return result;
  }

  async healCurrent(mode, signal = null, delay = {}) {
    const battle = this._requireBattle();
    return this.controller.heal(battle.userId, mode, signal, {
      isDungeon: battle.battleLocator?.isDungeon === true,
      delay,
    });
  }

  getCurrentBattle() {
    return this.currentBattle;
  }

  getLastConsumables() {
    return {
      ...this.lastConsumables,
      items: this.lastConsumables.items.map(item => ({ ...item })),
    };
  }

  clear() {
    this.currentBattle = null;
    this.lastStamina = null;
  }

  stop() {
    this.clear();
  }

  _requireBattle() {
    if (!this.currentBattle?.battleCfg) throw new Error('No battle is loaded');
    return this.currentBattle;
  }
}

module.exports = { BattleManager };
