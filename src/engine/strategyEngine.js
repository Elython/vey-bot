/**
 * Strategy Engine
 * Central decision-maker that evaluates game state and returns the next action.
 * 
 * Priority order (highest → lowest):
 * 1. HEAL      — HP is 0 or below threshold → heal
 * 2. LOOT      — Dead monster we joined → claim loot + XP
 * 3. ATTACK    — Active battle + has stamina → attack
 * 4. SCAN      — No active battle → find next monster from gates
 * 5. FARM      — Stamina below threshold → farm chapters for +2 each
 * 6. WAIT      — Nothing to do, wait for stamina regen
 */

const { ModuleRegistry } = require('./moduleRegistry');
const { AttackPlanner } = require('./attackPlanner');

/**
 * @typedef {Object} GameState
 * @property {number} stamina
 * @property {number} maxStamina
 * @property {number} playerHp
 * @property {number} playerMaxHp
 * @property {number} level
 * @property {number} attack
 * @property {number} defense
 * @property {Object|null} currentBattle - Current battle config if in battle
 * @property {boolean} monsterDead - Whether current monster is dead
 * @property {boolean} isJoined - Whether player has joined current battle
 * @property {number} farmedEnergy - How many chapters farmed this session
 * @property {number} farmedEnergyLimit - Max energy farmable (1000/12h)
 */

/**
 * @typedef {Object} BotConfig
 * @property {Object} gates - { targetGate, targetWave }
 * @property {Object} combat - { preferredSkill, staminaReserve, attackDelayMs }
 * @property {Object} healing - { mode, hpThresholdPercent }
 * @property {Object} looting - { autoLoot, lootDelay }
 * @property {Object} energyFarming - { enabled, farmWhenStaminaBelow, reactionType, maxPerSession }
 */

class StrategyEngine {
  /**
   * @param {BotConfig} config
   * @param {string} [accountName]
   */
  constructor(config, accountName = null, moduleRegistry = new ModuleRegistry(), attackPlanner = null) {
    this.config = config;
    this.accountName = accountName;
    this.moduleRegistry = moduleRegistry;
    this.attackPlanner = attackPlanner || new AttackPlanner(config);
  }

  updateConfig(config) {
    this.config = config;
    this.attackPlanner.updateConfig(config);
  }

  setAccount(accountName) {
    this.accountName = accountName;
  }

  /**
   * Evaluate game state and return next action
   * @param {GameState} state
   * @returns {{ action: string, params: Object, reason: string }}
   */
  decideNextAction(state) {
    const module = this.config.general?.module || 'idle';
    if (module === 'idle') {
      return this._waitForConfiguredModule();
    }
    if (module === 'auto_farm') {
      return state.autoFarmSynchronized === true
        ? { action: 'WAIT', params: {}, reason: 'Server Auto Farm is running' }
        : { action: 'AUTO_FARM_START', params: { areaKey: this.config.autoFarm?.areaKey }, reason: 'Synchronizing and starting server Auto Farm' };
    }

    // Monster-phase PvP has its own combat resources. Normal Stamina/HP/Mana
    // policies must not block the verified duel watcher.
    if (state.currentBattle?.phaseDuel) {
      return {
        action: 'MONSTER_PHASE_DUEL',
        params: { ...state.currentBattle.phaseDuel },
        reason: 'Monster phase requires its PvP duel before normal attacks can resume',
      };
    }

    const stopBelow = Math.max(0, Number(this.config.resources?.stamina?.stopBelow) || 0);
    const staminaPercent = Number(state.maxStamina) > 0
      ? (Math.max(0, Number(state.stamina) || 0) / Number(state.maxStamina)) * 100
      : null;
    if (stopBelow > 0 && staminaPercent !== null && staminaPercent < stopBelow) {
      return {
        action: 'STOP',
        params: {},
        reason: `Stamina is ${staminaPercent.toFixed(1)}%, below the ${stopBelow}% hard stop`,
      };
    }

    // ── Priority 1: HEAL ──
    if (this._needsHeal(state)) {
      const mode = this.config.resources?.health?.usePotions === true ? 'potion_first' : 'timed_only';
      return {
        action: 'HEAL',
        params: { mode },
        reason: `HP is ${state.playerHp}/${state.playerMaxHp} (below ${Math.max(0, Number(this.config.resources?.health?.sleepBelow) || 0)}% threshold)`,
      };
    }

    if (['battle_pass', 'adventure_quests'].includes(module) && state.objective?.nextAction) {
      return state.objective.nextAction;
    }

    if (['battle_pass', 'adventure_quests'].includes(module) && state.objective?.claim) {
      return {
        action: 'CLAIM_OBJECTIVE_LOOT',
        params: { claim: state.objective.claim },
        reason: `Claiming ${state.objective.claim.name || 'objective loot'}`,
      };
    }

    // ── Priority 2: LOOT ──
    if (state.monsterDead && state.isJoined && this.config.looting?.autoLoot !== false
      && state.currentLootAllowed === true && state.progression?.deferCurrentLoot !== true) {
      return {
        action: 'LOOT',
        params: {},
        reason: 'Monster is dead and loot is available',
      };
    }

    if (state.monsterDead && (this.config.looting?.autoLoot === false
      || state.currentLootAllowed !== true || state.progression?.deferCurrentLoot === true)) {
      const scan = this._scanParams(state);
      if (!scan) return this._waitForConfiguredModule();
      return {
        action: 'SCAN',
        params: scan,
        reason: state.progression?.deferCurrentLoot === true
          ? 'Monster loot is banked for Progression'
          : state.currentLootAllowed !== true
            ? 'Monster loot is disabled or its configured limit was reached'
            : 'Monster is dead and automatic looting is disabled',
      };
    }

    if (state.currentBattle && state.monsterDead !== true && state.pendingLoadoutAction) {
      return {
        action: 'APPLY_LOADOUT',
        params: { ...state.pendingLoadoutAction },
        reason: `Applying ${state.pendingLoadoutAction.selection.replaceAll('_', ' ')} ${state.pendingLoadoutAction.kind} set`,
      };
    }

    if (state.currentBattle && state.targetReached && !state.monsterDead && state.progression?.ignoreSoftStaminaRules !== true) {
      const scan = this._scanParams(state);
      return scan ? {
        action: 'SCAN',
        params: {
          ...scan,
          ignoreInstanceId: state.currentTargetId
            || state.currentBattle?.battleLocator?.dgmid
            || state.currentBattle?.battleCfg?.dgmid
            || state.currentBattle?.battleCfg?.id
            || null,
        },
        reason: 'Configured target damage was reached; selecting another monster',
      } : this._waitForConfiguredModule();
    }

    // ── Priority 3: ATTACK ──
    if (state.currentBattle && state.isJoined && !state.monsterDead) {
      if (state.progression?.useTargetStaminaPotion === true
          && state.progression?.usePotionImmediately === true
          && state.targetStaminaPotion?.available === true) {
        return {
          action: 'USE_STAMINA_POTION',
          params: {
            type: state.targetStaminaPotion.type,
            inventoryId: state.targetStaminaPotion.inventoryId,
          },
          reason: `Using one ${state.targetStaminaPotion.name} without draining remaining Stamina`,
        };
      }
      if (this._shouldUseManaPotion(state)) {
        return {
          action: 'USE_MANA_POTION',
          params: {
            type: state.targetManaPotion.type,
            inventoryId: state.targetManaPotion.inventoryId,
            quantity: state.targetManaPotion.useQuantity || 1,
            buyIfMissing: state.targetManaPotion.buyIfMissing === true,
          },
          reason: state.targetManaPotion.buyIfMissing === true
            ? 'Buying and using a Small Mana Potion for an allowed class ability'
            : `Using ${state.targetManaPotion.useQuantity || 1} ${state.targetManaPotion.name}${(state.targetManaPotion.useQuantity || 1) === 1 ? '' : 's'} to restore Mana`,
        };
      }
      const skill = this._selectSkill(state);
      if (skill?.blocked) {
        const plan = skill.planning || {};
        if (skill.ignoreTarget) {
          const scan = this._scanParams(state);
          return scan ? {
            action: 'SCAN',
            params: { ...scan, ignoreInstanceId: state.currentTargetId || state.currentBattle?.battleCfg?.id },
            reason: 'No permitted Nuke can reach the remaining contribution before this monster dies; selecting another monster',
          } : this._waitForConfiguredModule();
        }
        // "Require stamina to reach target damage" may prevent a partial
        // attack, but it must not prevent an explicitly authorized target
        // potion from making that target reachable. Potion limits, inventory,
        // target policy, and Progression drain ordering are still enforced by
        // _shouldUseTargetStaminaPotion and the mutation boundary.
        if (this._shouldUseTargetStaminaPotion(state)) {
          return {
            action: 'USE_STAMINA_POTION',
            params: {
              type: state.targetStaminaPotion.type,
              inventoryId: state.targetStaminaPotion.inventoryId,
            },
            reason: `Using one ${state.targetStaminaPotion.name} because the configured target is not reachable with current Stamina`,
          };
        }
        // A target-stamina requirement is a combat constraint, not a reason
        // to strand the engine.  When the explicitly enabled Chapter fallback
        // can still supply stamina, hand control to it before waiting.  The
        // progression snapshot can mark Chapters unavailable after its
        // configured/session/server limits are exhausted.
        if (plan.source === 'insufficient-target-stamina' && this._shouldFarmEnergy(state)) {
          return {
            action: 'FARM',
            params: {
              reactionType: this.config.energyFarming?.reactionType || 'random',
              maxPerSession: this.config.energyFarming?.maxPerSession || 500,
            },
            reason: `Target requires about ${plan.requiredStamina || 0} stamina; using Chapter fallback before waiting`,
          };
        }
        return {
          action: 'WAIT',
          params: {},
          reason: `Target requires about ${plan.requiredStamina || 0} stamina; ${plan.availableStamina || 0} is available after reserve`,
        };
      }
      if (this._canAffordSkill(state, skill)) {
        const plan = skill.planning || {};
        const estimate = plan.estimatedDamage ? `, estimate ${plan.estimatedDamage.toLocaleString()}` : '';
        return {
          action: 'ATTACK',
          params: { skill },
          reason: `Attacking with ${skill.name} (cost: ${skill.stamCost} stamina${estimate})`,
        };
      }
    }

    // ── Priority 3b: JOIN ──
    if (state.currentBattle && !state.isJoined && !state.monsterDead) {
      return {
        action: 'JOIN',
        params: {},
        reason: 'Monster found but not yet joined',
      };
    }

    // ── Priority 4: FARM ENERGY ──
    if (this._shouldFarmEnergy(state)) {
      return {
        action: 'FARM',
        params: {
          reactionType: this.config.energyFarming?.reactionType || 'random',
          maxPerSession: this.config.energyFarming?.maxPerSession || 500,
        },
        reason: `Stamina ${state.stamina} below farm threshold ${this.config.energyFarming?.farmWhenStaminaBelow || 100}`,
      };
    }

    if (this._shouldUseTargetStaminaPotion(state)) {
      const progressionFallback = state.progression?.useTargetStaminaPotion === true;
      return {
        action: 'USE_STAMINA_POTION',
        params: {
          type: state.targetStaminaPotion.type,
          inventoryId: state.targetStaminaPotion.inventoryId,
        },
        reason: progressionFallback
          ? `Using one ${state.targetStaminaPotion.name} after draining available Stamina`
          : `Using one ${state.targetStaminaPotion.name}; no permitted attack is affordable above the Stamina reserve`,
      };
    }

    // ── Priority 5: SCAN ──
    const scanForTargetPotion = !state.currentBattle
      && !this._hasStamina(state)
      && this._canScanForTargetStaminaPotion(state);
    if (!state.currentBattle && (this._hasStamina(state) || scanForTargetPotion)) {
      const scan = this._scanParams(state);
      if (!scan) return this._waitForConfiguredModule();
      return {
        action: 'SCAN',
        params: scan,
        reason: scanForTargetPotion
          ? 'Stamina is below reserve; locating a target-authorized Stamina potion'
          : 'No active battle, scanning for monsters',
      };
    }

    // ── Priority 6: WAIT ──
    return {
      action: 'WAIT',
      params: {},
      reason: `Stamina ${state.stamina}/${state.maxStamina}, waiting for regen`,
    };
  }

  /**
   * Check if player needs healing
   * @param {GameState} state
   * @returns {boolean}
   */
  _needsHeal(state) {
    if (state.playerHp === null || state.playerHp === undefined) return false;
    if (state.playerHp <= 0) return true;
    if (state.playerMaxHp <= 0) return false;

    const threshold = Math.max(0, Number(this.config.resources?.health?.sleepBelow) || 0);
    const hpPercent = (state.playerHp / state.playerMaxHp) * 100;
    return hpPercent < threshold;
  }

  /**
   * Check if player has enough stamina to act (above reserve)
   * @param {GameState} state
   * @returns {boolean}
   */
  _hasStamina(state) {
    const reserve = state.progression?.ignoreSoftStaminaRules === true
      ? 0
      : (this.config.combat?.staminaReserve || 0);
    return (state.stamina || 0) > reserve;
  }

  _canAffordSkill(state, skill) {
    if (!skill) return false;
    const reserve = state.progression?.ignoreSoftStaminaRules === true
      ? 0
      : (this.config.combat?.staminaReserve || 0);
    if ((state.stamina || 0) < reserve + Math.max(0, skill?.stamCost || 0)) return false;
    const manaReserve = Math.max(0, Number(this.config.resources?.mana?.keepMin) || 0);
    if ((state.mana || 0) < manaReserve + Math.max(0, Number(skill.manaCost) || 0)) return false;
    return true;
  }

  /**
   * Check if should farm energy
   * @param {GameState} state
   * @returns {boolean}
   */
  _shouldFarmEnergy(state) {
    if (['battle_pass', 'adventure_quests'].includes(this.config.general?.module)) return false;
    if (state.progression?.ignoreSoftStaminaRules === true) return false;
    // Progression owns every automatic Chapter-farming decision. The Chapters
    // module still supplies the manga/reaction settings, but its Automatic mode
    // must never bypass the user's visible "Allow Chapter fallback" switch.
    if (this.config.progression?.allowChapterFallback !== true) return false;
    if (!this.config.energyFarming?.enabled) return false;
    const chapterStep = state.progression?.staminaFlow?.steps?.chapters;
    if (chapterStep && chapterStep.available !== true) return false;
    const threshold = this.config.energyFarming?.farmWhenStaminaBelow || 100;
    if ((state.stamina || 0) >= threshold) return false;
    const limit = this.config.energyFarming?.maxPerSession || 500;
    if ((state.sessionChaptersFarmed ?? state.sessionEnergyFarmed ?? 0) >= limit) return false;
    if ((state.farmedEnergy || 0) >= (state.farmedEnergyLimit || 1000)) return false;
    return true;
  }

  _shouldUseTargetStaminaPotion(state) {
    if (!state.currentBattle || state.isJoined !== true || state.monsterDead === true) return false;
    if (state.targetStaminaPotion?.available !== true) return false;
    // The always-on Progression coordinator owns the resource fallback order:
    // loot -> Chapters -> target-authorized potion -> wait. It explicitly
    // authorizes this action only after higher-priority sources are exhausted.
    return state.progression?.useTargetStaminaPotion === true;
  }

  _shouldUseManaPotion(state) {
    if (state.targetManaPotion?.needed !== true) return false;
    return state.targetManaPotion.available === true || state.targetManaPotion.buyIfMissing === true;
  }

  _canScanForTargetStaminaPotion(state = null) {
    const staminaPolicy = this.config.resources?.stamina || {};
    if (staminaPolicy.allowPotions !== true) return false;
    const scan = this._scanParams(state);
    if (!scan) return false;
    const areaKeys = [scan.areaKey, scan.fallback?.areaKey].filter(Boolean);
    for (const areaKey of areaKeys) {
      const targets = Object.values(this.config.monsters?.maps?.[areaKey] || {});
      for (const target of targets) {
        const type = target?.staminaPotion;
        if (!['auto', 'small', 'large', 'full', 'adventure'].includes(type)) continue;
        if (target.enabled !== true || Number(target.targetDamage) <= 0) continue;
        if (target.unlimited !== true && Number(target.completedCount) >= Number(target.killCount)) continue;
        if (type === 'auto') {
          if (!['small', 'large', 'full', 'adventure'].some(candidate => Number(staminaPolicy.potionLimits?.[candidate]) > 0)) continue;
        } else if (Number(staminaPolicy.potionLimits?.[type]) <= 0) continue;
        return true;
      }
    }
    return false;
  }

  _scanParams(state = null) {
    if (state?.objective?.scan) return state.objective.scan;
    return this.moduleRegistry.resolveScan(this.config.general);
  }

  _waitForConfiguredModule() {
    const moduleName = this.config.general?.module || 'idle';
    const map = this.config.general?.map;
    return {
      action: 'WAIT',
      params: {},
      reason: moduleName === 'idle'
        ? 'Module is Idle'
        : `${moduleName}${map ? ` / ${map}` : ''} automation is not available`,
    };
  }

  /**
   * Select the best attack skill based on config
   * @param {GameState} state
   * @returns {{ id: number, name: string, stamCost: number }}
   */
  _selectSkill(state) {
    const objectiveAbilityId = Math.max(0, Math.trunc(Number(state.objectiveAbilityId) || 0));
    if (objectiveAbilityId > 0) {
      const skill = (state.abilities || []).find(candidate => Number(candidate.id) === objectiveAbilityId);
      if (skill) {
        return {
          id: objectiveAbilityId,
          name: String(skill.name || `Ability ${objectiveAbilityId}`),
          kind: 'class-ability',
          stamCost: Math.max(0, Number(skill.staminaCost) || 0),
          requestStamCost: 1,
          manaCost: Math.max(0, Number(skill.manaCost) || 0),
          planning: { mode: 'objective', source: 'adventure-quest-ability', estimatedDamage: null },
        };
      }
    }
    return state.supportAbilitySkill || state.plannedDamageSkill || this.attackPlanner.plan(state);
  }
}

module.exports = { StrategyEngine };
