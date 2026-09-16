const EventEmitter = require('events');
const { BotFSM, BotState } = require('./fsm');
const { stateStore } = require('./stateStore');
const { deepMerge, validateConfig } = require('./configManager');
const { ActionExecutor, MUTATING_ACTIONS } = require('./actionExecutor');
const { ModuleRegistry } = require('./moduleRegistry');
const { TargetLedger } = require('./targetLedger');
const { LootLimitLedger } = require('./lootLimitLedger');
const { ProgressionAction } = require('./progressionEngine');

function parseCompactAmount(value) {
  const match = String(value ?? '').trim().replace(/,/g, '').match(/^([\d.]+)\s*([kmb])?$/i);
  if (!match) return Number(value) || 0;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1;
  return Number(match[1]) * scale;
}

class BotEngine extends EventEmitter {
  constructor(dependencies) {
    super();
    if (!dependencies?.gameAPI || !dependencies?.gameReader || !dependencies?.strategyEngine) {
      throw new Error('BotEngine requires the API-driven engine dependencies');
    }

    this.accountName = dependencies.accountName || null;
    this.configManager = dependencies.configManager || null;
    this.config = validateConfig(dependencies.config || this.configManager?.getConfig() || {});
    this.timingEngine = dependencies.timingEngine;
    this.httpClient = dependencies.httpClient;
    this.gameAPI = dependencies.gameAPI;
    this.gameController = dependencies.gameController;
    this.gameReader = dependencies.gameReader;
    this.battleManager = dependencies.battleManager;
    this.strategy = dependencies.strategyEngine;
    this.moduleRegistry = dependencies.moduleRegistry || this.strategy.moduleRegistry || new ModuleRegistry();
    this.targetLedger = dependencies.targetLedger || new TargetLedger(this.config, this.configManager);
    this.lootLimitLedger = dependencies.lootLimitLedger || new LootLimitLedger(this.config, this.configManager);
    this.resourcePolicyEngine = dependencies.resourcePolicyEngine || null;
    this.loadoutService = dependencies.loadoutService || null;
    this.monsterCatalogService = dependencies.monsterCatalogService || null;
    this.damageObservationStore = dependencies.damageObservationStore || null;
    this.xpModel = dependencies.xpModel || null;
    this.progressionEngine = dependencies.progressionEngine || null;
    this.chapterFarmer = dependencies.chapterFarmer;
    this.getMangaTargets = dependencies.getMangaTargets || (() => []);
    this.onChapterFarmed = dependencies.onChapterFarmed || (() => {});

    this.fsm = new BotFSM(BotState.STOPPED);
    this.isRunning = false;
    this.isPaused = false;
    this.loopPromise = null;
    this.runController = null;
    this.lastStatsRefresh = 0;
    this.statsRefreshPromise = null;
    this.farmCycleId = null;
    this.consecutiveErrors = 0;
    this.currentTarget = null;
    this.currentAction = null;
    this.currentReason = null;
    this.lastResult = null;
    this.currentLoadoutSnapshot = null;
    this.currentCombatContext = null;
    this.currentClassSkillTree = null;
    this.classSkillTreeReadAt = 0;
    this.ignoredTargetIds = new Set();
    this.progressionLootSnapshot = { candidates: [], refreshedAt: 0, errors: [] };
    this.progressionLootRefreshPromise = null;
    this.currentProgressionDecision = null;
    this.failedStaminaPotionIds = new Set();
    this.failedManaPotionIds = new Set();
    this.appliedLoadoutSelections = { gear: null, pets: null };
    this.progressionLootBatchActive = false;
    this.progressionLootBatchConfig = null;
    this.pendingMutation = null;
    this.overflowStaminaSpent = 0;
    this.actionExecutor = dependencies.actionExecutor || new ActionExecutor({
      SCAN: (params, context) => this._scan(params, context.signal),
      JOIN: (params, context) => this._join(context.signal),
      ATTACK: (params, context) => this._attack(params.skill, context.signal),
      LOOT: (params, context) => this._loot(context.signal),
      CLAIM_LOOT: (params, context) => this._claimProgressionLoot(params.claim, context.signal),
      HEAL: (params, context) => this._heal(params.mode, context.signal),
      FARM: (params, context) => this._farm(params, context.signal),
      APPLY_LOADOUT: (params, context) => this._applyLoadout(params, context.signal),
      USE_STAMINA_POTION: (params, context) => this._useStaminaPotion(params, context.signal),
      USE_MANA_POTION: (params, context) => this._useManaPotion(params, context.signal),
      WAIT: (params, context) => this._wait(context.decision.reason, context.signal),
    });

    this.stats = {
      actionsCount: 0,
      attacks: 0,
      monstersKilled: 0,
      lootCollected: 0,
      damageDealt: 0,
      xpGained: 0,
      energyFarmed: 0,
      healthPotionsUsed: 0,
      staminaPotionsUsed: { small: 0, large: 0, full: 0, adventure: 0 },
      manaPotionsUsed: { small: 0, large: 0 },
      errors: 0,
      startTime: null,
    };

    this.strategy.updateConfig(this.config);
    this.targetLedger.updateConfig(this.config);
    this.lootLimitLedger.updateConfig(this.config);
    this.resourcePolicyEngine?.updateConfig(this.config);
    this.progressionEngine?.updateConfig(this.config);
    this._updateTiming();
    this.fsm.onTransition((state, previousState, reason) => {
      this.log('STATE', `${previousState} → ${state}${reason ? ` (${reason})` : ''}`);
      this.emit('state-change', { state, prevState: previousState, reason });
      this.emit('telemetry', this.getTelemetry());
    });
  }

  log(level, message) {
    this.emit('log', {
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
    });
  }

  updateConfig(patch) {
    this.config = this.configManager ? this.configManager.update(patch) : validateConfig(deepMerge(this.config, patch));
    this.strategy.updateConfig(this.config);
    this.targetLedger.updateConfig(this.config);
    this.lootLimitLedger.updateConfig(this.config);
    this.resourcePolicyEngine?.updateConfig(this.config);
    this.progressionEngine?.updateConfig(this.config);
    if ((patch.general || patch.looting || patch.progression) && !this.progressionLootBatchActive) {
      this.progressionLootSnapshot = { candidates: [], refreshedAt: 0, errors: [] };
      this.progressionLootBatchActive = false;
      this.progressionLootBatchConfig = null;
    } else if ((patch.general || patch.looting || patch.progression) && this.progressionLootBatchActive) {
      this.log('INFO', 'Progression settings changed; the active verified claim batch remains locked until it finishes or the bot is paused.');
    }
    this._updateTiming();
    if (this.currentTarget && (patch.general || patch.monsters)) {
      if (!this._currentTargetIsConfigured()) {
        this.battleManager.clear();
        this.currentTarget = null;
        this.currentCombatContext = null;
        this.log('INFO', 'Current target was released because its map or Target settings changed.');
      } else {
        const settings = this.config.monsters.maps[this.currentTarget.areaKey][this.currentTarget.monsterKey];
        Object.assign(this.currentTarget, {
          targetDamage: settings.targetDamage,
          minimumHp: settings.minimumHp,
          priority: settings.priority,
          staminaPotion: settings.staminaPotion,
          gearSet: settings.gearSet || 'default',
          petSet: settings.petSet || 'default',
        });
      }
    }
    this.log('INFO', `Configuration updated${this.config.safety.dryRun ? ' (dry-run enabled)' : ''}.`);
    return this.config;
  }

  replaceConfig(config) {
    this.config = this.configManager ? this.configManager.replace(config) : validateConfig(config);
    this.strategy.updateConfig(this.config);
    this.targetLedger.updateConfig(this.config);
    this.lootLimitLedger.updateConfig(this.config);
    this.resourcePolicyEngine?.updateConfig(this.config);
    this.progressionEngine?.updateConfig(this.config);
    if (!this.progressionLootBatchActive) {
      this.progressionLootSnapshot = { candidates: [], refreshedAt: 0, errors: [] };
      this.progressionLootBatchActive = false;
      this.progressionLootBatchConfig = null;
    } else {
      this.log('INFO', 'The loaded preset will apply to Progression after the active verified claim batch finishes or the bot is paused.');
    }
    this.overflowStaminaSpent = 0;
    this._updateTiming();
    if (this.currentTarget) {
      if (!this._currentTargetIsConfigured()) {
        this.battleManager.clear();
        this.currentTarget = null;
        this.currentCombatContext = null;
        this.log('INFO', 'Current target was released because a configuration preset was loaded.');
      } else {
        const settings = this.config.monsters.maps[this.currentTarget.areaKey][this.currentTarget.monsterKey];
        Object.assign(this.currentTarget, {
          targetDamage: settings.targetDamage,
          minimumHp: settings.minimumHp,
          priority: settings.priority,
          staminaPotion: settings.staminaPotion,
          gearSet: settings.gearSet || 'default',
          petSet: settings.petSet || 'default',
        });
      }
    }
    this.log('INFO', `Configuration preset loaded${this.config.safety.dryRun ? ' (dry-run enabled)' : ''}.`);
    return this.config;
  }

  _updateTiming() {
    this.timingEngine.updateConfig({
      minDelay: this.config.scheduler.minDelay,
      maxDelay: this.config.scheduler.maxDelay,
      jitterRatio: this.config.scheduler.jitterRatio,
    });
  }

  start() {
    if (this.isRunning) return false;
    this.isRunning = true;
    this.isPaused = false;
    this.consecutiveErrors = 0;
    this.stats.startTime = Date.now();
    this.runController = new AbortController();
    this.ignoredTargetIds.clear();
    this.failedStaminaPotionIds.clear();
    this.failedManaPotionIds.clear();
    this.overflowStaminaSpent = 0;
    this.progressionLootSnapshot = { candidates: [], refreshedAt: 0, errors: [] };
    this.progressionLootBatchActive = false;
    this.progressionLootBatchConfig = null;
    this.pendingMutation = null;
    this.fsm.transition(BotState.IDLE, 'Started by user');
    this.log('INFO', `API bot started${this.config.safety.dryRun ? ' in DRY-RUN mode' : ''}.`);
    this.loopPromise = this._mainLoop(this.runController.signal).finally(() => {
      this.loopPromise = null;
    });
    return true;
  }

  pause() {
    if (!this.isRunning || this.isPaused) return false;
    this.isPaused = true;
    this.timingEngine.cancelAll();
    this.httpClient.cancelAll();
    this.progressionLootSnapshot = { candidates: [], refreshedAt: 0, errors: [] };
    this.progressionLootBatchActive = false;
    this.progressionLootBatchConfig = null;
    this.currentProgressionDecision = null;
    this.fsm.transition(BotState.PAUSED, 'Paused by user');
    return true;
  }

  resume() {
    if (!this.isRunning || !this.isPaused) return false;
    this.isPaused = false;
    this.fsm.transition(BotState.IDLE, 'Resumed by user');
    return true;
  }

  stop() {
    const wasRunning = this.isRunning;
    this.isRunning = false;
    this.isPaused = false;
    this.runController?.abort();
    this.httpClient.cancelAll();
    this.timingEngine.cancelAll();
    this.battleManager.clear();
    this.currentTarget = null;
    this.currentCombatContext = null;
    this.currentAction = null;
    this.currentProgressionDecision = null;
    this.progressionLootBatchActive = false;
    this.progressionLootBatchConfig = null;
    this.pendingMutation = null;
    if (!this.fsm.is(BotState.STOPPED)) this.fsm.transition(BotState.STOPPED, 'Stopped by user');
    return wasRunning;
  }

  setWebContents(webContents) {
    this.httpClient.setWebContents(webContents);
    this.gameReader.setWebContents(webContents);
  }

  async refreshStats() {
    if (this.statsRefreshPromise) return this.statsRefreshPromise;
    const refresh = (async () => {
      const stats = await this.gameReader.fetchStatsNow();
      this.lastStatsRefresh = Date.now();
      const epoch = stats.serverEpoch ?? Math.floor(Date.now() / 1000);
      const offset = stats.serverTzOff ?? 19800;
      const cycleId = Math.floor((epoch + offset) / (12 * 60 * 60));
      if (this.farmCycleId !== null && cycleId !== this.farmCycleId) {
        this.chapterFarmer.resetCycle();
        this.stats.energyFarmed = 0;
        this.log('INFO', 'A new 12-hour farming cycle was detected. Session chapter tracking was reset.');
      }
      this.farmCycleId = cycleId;
      this.emit('telemetry', this.getTelemetry());
      return stats;
    })();
    this.statsRefreshPromise = refresh;
    try {
      return await refresh;
    } finally {
      if (this.statsRefreshPromise === refresh) this.statsRefreshPromise = null;
    }
  }

  getTelemetry() {
    const runtimeSeconds = this.stats.startTime ? Math.floor((Date.now() - this.stats.startTime) / 1000) : 0;
    return {
      state: this.fsm.state,
      currentAction: this.currentAction,
      currentReason: this.currentReason,
      module: this.moduleRegistry.describe(this.config.general),
      target: this.currentTarget ? {
        ...this.currentTarget,
        userDmg: this.battleManager.getCurrentBattle()?.userDamage ?? this.currentTarget.userDmg ?? 0,
      } : null,
      lastResult: this.lastResult,
      dryRun: this.config.safety.dryRun,
      connection: {
        connected: stateStore.getState().isConnected === true,
        lastUpdated: stateStore.getState().lastUpdated || null,
      },
      potions: typeof this.battleManager.getLastConsumables === 'function'
        ? this.battleManager.getLastConsumables()
        : { recognized: false, items: [], updatedAt: null },
      attackStrategy: {
        mode: this.config.combat?.attackStrategy?.mode || 'fixed',
        loadoutHash: this.currentLoadoutSnapshot?.hash?.value || null,
        contextHash: this.currentCombatContext?.hash || null,
        estimate: this.damageObservationStore?.getPlanningEstimate(this.currentCombatContext) || null,
      },
      progression: this.currentProgressionDecision ? {
        status: this.currentProgressionDecision.status,
        xpNeeded: this.currentProgressionDecision.xpNeeded,
        eligibleLootXp: this.progressionLootSnapshot.refreshedAt > 0
          ? this.currentProgressionDecision.eligibleLootXp
          : null,
        eligibleLootCount: this.progressionLootSnapshot.refreshedAt > 0
          ? this.currentProgressionDecision.eligibleLootCount || 0
          : null,
        claimCount: this.currentProgressionDecision.claimCount,
        unknownLootCount: this.currentProgressionDecision.unknownLootCount || 0,
        lootXpBoostActive: this.currentProgressionDecision.lootXpBoostActive === true,
        lootXpBoostPercent: this.currentProgressionDecision.lootXpBoostPercent || 0,
        lootXpMultiplier: this.currentProgressionDecision.lootXpMultiplier || 1,
        lootXpBoostEndsAt: this.currentProgressionDecision.lootXpBoostEndsAt || null,
        lootScannedAt: this.progressionLootSnapshot.refreshedAt || null,
        lootScanErrorCount: this.progressionLootSnapshot.errors.length,
        lootBatchActive: this.progressionLootBatchActive,
        lootBatchRemaining: this.progressionLootSnapshot.candidates.length,
      } : {
        status: this.config.progression?.enabled ? 'Monitoring' : 'Disabled',
        xpNeeded: null,
        eligibleLootXp: null,
        eligibleLootCount: null,
        claimCount: 0,
        unknownLootCount: 0,
        lootXpBoostActive: false,
        lootXpBoostPercent: 0,
        lootXpMultiplier: 1,
        lootXpBoostEndsAt: null,
        lootScannedAt: this.progressionLootSnapshot.refreshedAt || null,
        lootScanErrorCount: this.progressionLootSnapshot.errors.length,
        lootBatchActive: this.progressionLootBatchActive,
        lootBatchRemaining: this.progressionLootSnapshot.candidates.length,
      },
      stats: {
        ...this.stats,
        runtimeSeconds,
        actionsPerMinute: runtimeSeconds > 0 ? Math.round((this.stats.actionsCount / runtimeSeconds) * 60) : 0,
      },
    };
  }

  async _mainLoop(signal) {
    if (!this.lastStatsRefresh || Date.now() - this.lastStatsRefresh > 30000) {
      try {
        await this.refreshStats();
      } catch (error) {
        this.log('WARN', `Initial stats refresh failed: ${error.message}`);
      }
    }

    while (this.isRunning && !signal.aborted) {
      try {
        if (this.isPaused) {
          await this.timingEngine.sleepRandom(600, 1200, signal);
          continue;
        }

        const liveState = await this.gameReader.readState();
        if (!this.isRunning || signal.aborted) break;
        if (!liveState.isConnected) {
          this.log('WARN', 'Waiting for the game browser session...');
          await this.timingEngine.sleepRandom(1500, 3000, signal);
          continue;
        }
        if (liveState.hasCloudflare) {
          this._enterChallenge('Cloudflare / Captcha detected');
          await this.timingEngine.sleepRandom(1500, 3000, signal);
          continue;
        }
        if (this.fsm.is(BotState.CHALLENGE_WAIT)) {
          this.emit('captcha-alert', { active: false });
          this.fsm.transition(BotState.IDLE, 'Challenge cleared');
        }
        if (liveState.isLoginPage) {
          this.log('ERROR', 'Game session is no longer authenticated. Bot stopped.');
          this.stop();
          break;
        }

        if (Date.now() - this.lastStatsRefresh > 30000) await this.refreshStats();
        if (!this.isRunning || signal.aborted) break;
        if (this.currentTarget && this.battleManager.getCurrentBattle()) {
          await Promise.all([this._prepareCombatContext(), this._prepareClassSkills()]);
          if (!this.isRunning || signal.aborted) break;
        }
        const gameState = this._gatherState(liveState);
        const dungeonPriorityModule = ['dungeons', 'gates_dungeons'].includes(this.config.general?.module);
        const progressionReadThreshold = Math.max(
          0,
          Number(this.config.combat?.staminaReserve) || 0,
          this.config.energyFarming?.enabled === true
            ? (Number(this.config.energyFarming?.farmWhenStaminaBelow) || 0)
            : 0,
        );
        const progressionReadWindow = !dungeonPriorityModule
          ? (!gameState.currentBattle || gameState.monsterDead)
          : (Number(gameState.stamina) <= progressionReadThreshold
            || (gameState.monsterDead && gameState.isDungeon !== true));
        if (this.config.progression?.enabled === true
          && this.config.progression?.useLootForLeveling === true
          && progressionReadWindow
          && !(this.progressionLootBatchActive && this.progressionLootSnapshot.candidates.length > 0)) {
          await this._refreshProgressionLoot(gameState.monsterDead === true);
          if (!this.isRunning || signal.aborted) break;
        }
        this.currentProgressionDecision = this.progressionEngine?.evaluate({
          accountName: this.accountName,
          state: gameState,
          lootCandidates: this.progressionLootSnapshot.candidates,
          chaptersAvailable: this._availableRewardChapters(),
          configOverride: this.progressionLootBatchActive ? this.progressionLootBatchConfig : null,
        }) || null;
        gameState.progression = this.currentProgressionDecision || {};
        let decision;
        if (this.currentProgressionDecision?.action === ProgressionAction.CLAIM_LOOT) {
          decision = {
            action: 'CLAIM_LOOT',
            params: { claim: this.currentProgressionDecision.claim },
            reason: this.currentProgressionDecision.status,
          };
        } else if (this.currentProgressionDecision?.action === ProgressionAction.FARM_CHAPTER_TOP_OFF) {
          decision = {
            action: 'FARM',
            params: {
              reactionType: this.config.energyFarming?.reactionType || 'random',
              maxPerSession: this.config.energyFarming?.maxPerSession || 500,
              progressionTopOff: true,
            },
            reason: this.currentProgressionDecision.status,
          };
        } else {
          decision = this.strategy.decideNextAction(gameState);
        }
        if (decision.action !== 'CLAIM_LOOT' && this.progressionLootBatchActive) {
          this.progressionLootBatchActive = false;
          this.progressionLootBatchConfig = null;
        } else if (decision.action === 'CLAIM_LOOT' && !this.progressionLootBatchActive) {
          this.progressionLootBatchActive = true;
          this.progressionLootBatchConfig = JSON.parse(JSON.stringify(this.config));
        }
        this.currentAction = decision.action;
        this.currentReason = decision.reason;
        this.log('INFO', `${decision.action}: ${decision.reason}`);

        if (!this.isRunning || signal.aborted) break;

        this.pendingMutation = MUTATING_ACTIONS.has(decision.action)
          ? this._captureMutationContext(decision, gameState)
          : null;
        const executionResult = await this.actionExecutor.execute(decision, {
          decision,
          gameState,
          signal,
          dryRun: this.config.safety.dryRun,
        });
        if (executionResult?.dryRun) {
          this.pendingMutation = null;
          this.lastResult = executionResult;
          this.log('ACTION', `[DRY RUN] Would execute ${decision.action}. No POST request sent.`);
          this.emit('telemetry', this.getTelemetry());
          await this.timingEngine.sleepRandom(5000, 12000, signal);
          continue;
        }
        this.pendingMutation = null;
        this.consecutiveErrors = 0;
        this.emit('telemetry', this.getTelemetry());
        const fastDungeonCycle = (gameState.isDungeon === true || decision.params?.kind === 'dungeon')
          && ['SCAN', 'JOIN', 'ATTACK', 'HEAL'].includes(decision.action);
        const fastLootCycle = ['LOOT', 'CLAIM_LOOT'].includes(decision.action);
        if (!fastDungeonCycle && !fastLootCycle) await this.timingEngine.sleepRandom(300, 800, signal);
      } catch (error) {
        if (error.name === 'AbortError' || error.code === 'CANCELLED') {
          if (!this.isRunning || signal.aborted) break;
          continue;
        }
        if (error.code === 'CLOUDFLARE') {
          this._enterChallenge(error.message);
          continue;
        }
        if (error.code === 'AUTH_REQUIRED') {
          this.log('ERROR', 'Authentication expired. Bot stopped.');
          this.stop();
          break;
        }

        if (this.pendingMutation && this._isAmbiguousMutationError(error)) {
          const pending = this.pendingMutation;
          this.pendingMutation = null;
          const reconciliation = await this._reconcileAmbiguousMutation(pending, signal).catch(reconcileError => ({
            confirmed: false,
            detail: `authoritative refresh failed: ${reconcileError.message}`,
          }));
          if (reconciliation.confirmed) {
            this.consecutiveErrors = 0;
            this.lastResult = {
              success: true,
              reconciled: true,
              action: pending.action,
              message: reconciliation.detail,
            };
            this.log('WARN', `${pending.action} response was lost, but a fresh server read confirmed the mutation (${reconciliation.detail}). It will not be posted again.`);
            this.emit('telemetry', this.getTelemetry());
            continue;
          }
          this.stats.errors++;
          this.lastResult = {
            success: false,
            ambiguous: true,
            action: pending.action,
            error: error.message,
            reconciliation: reconciliation.detail,
          };
          this.log('ERROR', `${pending.action} may have reached the server, but its result could not be confirmed (${reconciliation.detail}). Automation is paused to prevent a duplicate POST.`);
          this.pause();
          continue;
        }
        this.pendingMutation = null;

        if (this.currentAction === 'CLAIM_LOOT') {
          this.progressionLootBatchActive = false;
          this.progressionLootBatchConfig = null;
        }

        this.consecutiveErrors++;
        this.stats.errors++;
        this.lastResult = { success: false, error: error.message, code: error.code || 'UNKNOWN' };
        this.log('ERROR', `Engine error ${this.consecutiveErrors}/${this.config.safety.maxConsecutiveErrors}: ${error.message}`);
        if (this.consecutiveErrors >= this.config.safety.maxConsecutiveErrors) {
          this.log('ERROR', 'Maximum consecutive errors reached. Bot stopped.');
          this.stop();
          break;
        }
        await this.timingEngine.sleepRandom(1500, 3500, signal);
      }
    }
  }

  _gatherState(liveState) {
    const stored = stateStore.getState();
    const battle = this.battleManager.getCurrentBattle();
    const targetStaminaPotion = this._targetStaminaPotionState(battle);
    const targetManaPotion = this._targetManaPotionState(battle, stored);
    const overflow = this._overflowState(stored);
    return {
      isConnected: liveState.isConnected,
      stamina: this.battleManager.lastStamina ?? stored.stamina.current,
      maxStamina: stored.stamina.max,
      playerHp: battle?.playerHp ?? stored.hp.current,
      playerMaxHp: battle?.playerMaxHp || stored.hp.max,
      level: stored.level,
      attack: stored.attack,
      defense: stored.defense,
      mana: battle?.playerMana ?? stored.mp.current,
      maxMana: stored.mp.max,
      abilities: this.currentClassSkillTree?.unlockedSkills || [],
      currentBattle: battle,
      currentTargetId: this.currentTarget?.id || null,
      currentTargetIsOverflow: this.currentTarget?.overflow === true,
      isDungeon: Boolean(this.currentTarget?.isDungeon || battle?.battleLocator?.isDungeon),
      monsterHp: battle?.monsterHp ?? this.currentTarget?.hp ?? null,
      monsterDead: Boolean(battle?.isDead),
      isJoined: Boolean(battle?.isJoined),
      farmedEnergy: stored.farmedEnergy ?? this.stats.energyFarmed,
      sessionEnergyFarmed: this.stats.energyFarmed,
      farmedEnergyLimit: 1000,
      targetReached: Boolean(
        this.currentTarget?.targetDamage > 0 &&
        (battle?.userDamage ?? this.currentTarget?.userDmg ?? 0) >= this.currentTarget.targetDamage
      ),
      remainingTargetDamage: this.currentTarget?.targetDamage > 0
        ? Math.max(0, this.currentTarget.targetDamage - (battle?.userDamage ?? this.currentTarget?.userDmg ?? 0))
        : null,
      targetDamage: this.currentTarget?.targetDamage > 0 ? this.currentTarget.targetDamage : null,
      damageEstimate: this.damageObservationStore?.getPlanningEstimate(this.currentCombatContext) || null,
      staminaSpendRemaining: this.currentTarget?.overflowMode === 'spend_stamina'
        ? overflow.remainingSpend
        : 0,
      overflow,
      pendingLoadoutAction: this._pendingLoadoutAction(),
      exp: stored.exp,
      expCurrent: stored.expCurrent,
      expRequired: stored.expRequired,
      targetStaminaPotion,
      targetManaPotion,
      currentLootAllowed: this.lootLimitLedger.isAllowed(this.currentTarget),
    };
  }

  _captureMutationContext(decision, gameState) {
    const battle = this.battleManager.getCurrentBattle();
    return {
      action: decision.action,
      params: decision.params || {},
      target: this.currentTarget ? { ...this.currentTarget } : null,
      before: {
        stamina: Number(gameState.stamina),
        playerHp: Number(gameState.playerHp),
        mana: Number(gameState.mana),
        level: Number(gameState.level),
        expCurrent: Number(gameState.expCurrent),
        userDamage: Number(battle?.userDamage ?? this.currentTarget?.userDmg),
        monsterHp: Number(battle?.monsterHp ?? this.currentTarget?.hp),
        isJoined: battle?.isJoined === true,
      },
    };
  }

  _isAmbiguousMutationError(error) {
    return ['TIMEOUT', 'REQUEST_FAILED', 'SESSION_DESTROYED'].includes(error?.code);
  }

  async _reconcileAmbiguousMutation(pending, signal) {
    if (!pending || signal?.aborted) return { confirmed: false, detail: 'the run was cancelled' };
    const before = pending.before || {};
    const action = pending.action;

    if (action === 'APPLY_LOADOUT') {
      const selection = String(pending.params?.selection || '');
      const setNumber = Number(selection.match(/^quick_set_(\d+)$/)?.[1]);
      const kind = pending.params?.kind;
      if (!this.loadoutService || !Number.isInteger(setNumber) || !['gear', 'pets'].includes(kind)) {
        return { confirmed: false, detail: 'the selected Quick Set cannot be verified' };
      }
      const active = await this.loadoutService.isSavedSetActive({ kind, setNumber, context: 'attack', force: true });
      if (active) {
        this.appliedLoadoutSelections[kind] = selection;
        this.loadoutService.invalidateActive();
        this.currentLoadoutSnapshot = null;
        this.currentCombatContext = null;
        return { confirmed: true, detail: 'the active loadout matches the selected Quick Set' };
      }
    }

    if (['ATTACK', 'JOIN', 'LOOT', 'USE_STAMINA_POTION', 'USE_MANA_POTION'].includes(action)) {
      const fresh = await this.battleManager.refresh();
      if (fresh) this._applyBattleResourceSnapshot(fresh);
      if (action === 'JOIN' && fresh?.isJoined === true && before.isJoined !== true) {
        return { confirmed: true, detail: 'the battle page now shows the account joined' };
      }
      if (action === 'ATTACK') {
        const contributionIncreased = Number.isFinite(before.userDamage)
          && Number(fresh?.userDamage) > before.userDamage;
        const staminaDecreased = Number.isFinite(before.stamina)
          && Number(fresh?.stamina) < before.stamina;
        const monsterHpDecreased = Number.isFinite(before.monsterHp)
          && Number(fresh?.monsterHp) < before.monsterHp;
        if (contributionIncreased || staminaDecreased || monsterHpDecreased) {
          if (this.currentTarget) {
            this.currentTarget.userDmg = Number(fresh?.userDamage) || this.currentTarget.userDmg;
            this.currentTarget.hp = Number.isFinite(Number(fresh?.monsterHp)) ? Number(fresh.monsterHp) : this.currentTarget.hp;
          }
          return { confirmed: true, detail: 'battle contribution/resources changed' };
        }
      }
      if (action === 'LOOT' && fresh?.isDead === true && fresh?.hasLootButton === false) {
        this.stats.lootCollected += 1;
        this._applyRecordedLootConfig(this.lootLimitLedger.recordLooted(pending.target, 1));
        this.battleManager.clear();
        this.currentTarget = null;
        this.currentCombatContext = null;
        return { confirmed: true, detail: 'the refreshed battle no longer offers its loot action' };
      }
      if (action === 'USE_STAMINA_POTION' && Number.isFinite(before.stamina)
        && Number(fresh?.stamina) > before.stamina) {
        const type = pending.params?.type;
        if (type && Object.prototype.hasOwnProperty.call(this.stats.staminaPotionsUsed, type)) {
          this.stats.staminaPotionsUsed[type] += 1;
        }
        return { confirmed: true, detail: 'the refreshed battle shows increased Stamina' };
      }
      if (action === 'USE_MANA_POTION' && Number.isFinite(before.mana)
        && Number(fresh?.playerMana) > before.mana) {
        const type = pending.params?.type;
        if (type && Object.prototype.hasOwnProperty.call(this.stats.manaPotionsUsed, type)) {
          this.stats.manaPotionsUsed[type] += 1;
        }
        return { confirmed: true, detail: 'the refreshed battle shows increased Mana' };
      }
    }

    if (action === 'CLAIM_LOOT') {
      const claim = pending.params?.claim;
      const areaKey = claim?.areaKey;
      if (!areaKey || !this.monsterCatalogService) {
        return { confirmed: false, detail: 'the claimed monster cannot be re-read' };
      }
      const lockedConfig = this.progressionLootBatchConfig || this.config;
      const result = await this.monsterCatalogService.getProgressionLootCandidates(
        areaKey,
        lockedConfig.looting?.maps?.[areaKey] || {},
      );
      if ((result.errors || []).length > 0) {
        return { confirmed: false, detail: 'loot discovery returned an area error' };
      }
      const claimKey = this._progressionLootCandidateKey(claim);
      const stillClaimable = (result.candidates || []).some(candidate => this._progressionLootCandidateKey(candidate) === claimKey);
      if (!stillClaimable) {
        this.stats.lootCollected += Math.max(1, Number(claim.stackSize) || 1);
        this._applyRecordedLootConfig(this.lootLimitLedger.recordLooted(claim, claim.stackSize));
        this._removeProgressionClaim(claim);
        await this.refreshStats();
        return { confirmed: true, detail: 'the claimed monster is absent from a fresh loot scan' };
      }
    }

    if (['HEAL', 'FARM', 'USE_STAMINA_POTION', 'USE_MANA_POTION'].includes(action)) {
      await this.refreshStats();
      const stored = stateStore.getState();
      if (action === 'HEAL' && Number.isFinite(before.playerHp) && Number(stored.hp.current) > before.playerHp) {
        return { confirmed: true, detail: 'authoritative Stats shows increased HP' };
      }
      if (['FARM', 'USE_STAMINA_POTION'].includes(action) && Number.isFinite(before.stamina)
        && Number(stored.stamina.current) > before.stamina) {
        if (action === 'USE_STAMINA_POTION') {
          const type = pending.params?.type;
          if (type && Object.prototype.hasOwnProperty.call(this.stats.staminaPotionsUsed, type)) {
            this.stats.staminaPotionsUsed[type] += 1;
          }
        }
        return { confirmed: true, detail: 'authoritative Stats shows increased Stamina' };
      }
      if (action === 'USE_MANA_POTION' && Number.isFinite(before.mana)
        && Number(stored.mp.current) > before.mana) {
        const type = pending.params?.type;
        if (type && Object.prototype.hasOwnProperty.call(this.stats.manaPotionsUsed, type)) {
          this.stats.manaPotionsUsed[type] += 1;
        }
        return { confirmed: true, detail: 'authoritative Stats shows increased Mana' };
      }
    }

    return { confirmed: false, detail: 'fresh server state did not prove whether the POST was applied' };
  }

  _applyBattleResourceSnapshot(battle) {
    if (!battle) return;
    const stored = stateStore.getState();
    const updates = {};
    if (Number.isFinite(Number(battle.stamina))) {
      updates.stamina = { current: Number(battle.stamina), max: Number(battle.maxStamina) || stored.stamina.max };
    }
    if (Number.isFinite(Number(battle.playerHp))) {
      updates.hp = { current: Number(battle.playerHp), max: Number(battle.playerMaxHp) || stored.hp.max };
    }
    if (Number.isFinite(Number(battle.playerMana))) {
      updates.mp = { current: Number(battle.playerMana), max: Number(battle.playerMaxMana) || stored.mp.max };
    }
    if (Object.keys(updates).length > 0) stateStore.update(updates);
  }

  _targetStaminaPotionState(battle) {
    const type = this.currentTarget?.staminaPotion;
    if (!['small', 'large', 'full', 'adventure'].includes(type)) return null;
    const item = (battle?.consumables?.items || []).find(candidate =>
      candidate.category === 'stamina'
      && candidate.type === type
      && Number(candidate.quantity) > 0
      && candidate.inventoryId
      && !this.failedStaminaPotionIds.has(String(candidate.inventoryId))
    );
    const used = Number(this.stats.staminaPotionsUsed?.[type]) || 0;
    const policy = this.resourcePolicyEngine?.canUseStaminaPotion(type, used);
    return {
      type,
      inventoryId: item?.inventoryId || null,
      name: item?.name || `${type} Stamina potion`,
      quantity: Number(item?.quantity) || 0,
      available: Boolean(item && policy?.allowed),
      reason: item ? (policy?.reason || 'Stamina potion policy is unavailable') : 'Potion is not present in the battle drawer',
    };
  }

  _overflowState(stored = stateStore.getState()) {
    const policy = this.config.resources?.stamina || {};
    const current = Math.max(0, Number(this.battleManager.lastStamina ?? stored.stamina?.current) || 0);
    const maximum = Math.max(0, Number(stored.stamina?.max) || 0);
    const excess = Math.max(0, current - maximum);
    if (policy.spendInRed !== true || excess <= 0 || !policy.overflowArea || !policy.overflowMonster) {
      if (excess <= 0) this.overflowStaminaSpent = 0;
      return { active: false, excess, remainingSpend: 0 };
    }
    const configuredAmount = Math.max(0, Number(policy.overflowAmount) || 0);
    if (configuredAmount <= 0) return { active: false, excess, remainingSpend: 0 };
    const requestedRemaining = configuredAmount > 0
      ? Math.max(0, configuredAmount - this.overflowStaminaSpent)
      : excess;
    const remainingSpend = Math.min(excess, requestedRemaining);
    const active = policy.overflowMode === 'target_damage' || remainingSpend > 0;
    return {
      active,
      excess,
      areaKey: policy.overflowArea,
      monsterKey: policy.overflowMonster,
      backupAreaKey: policy.overflowBackupArea,
      backupMonsterKey: policy.overflowBackupMonster,
      mode: policy.overflowMode,
      amount: configuredAmount,
      spent: this.overflowStaminaSpent,
      remainingSpend,
    };
  }

  _targetManaPotionState(battle, stored = stateStore.getState()) {
    const manaPolicy = this.config.resources?.mana || {};
    if (manaPolicy.allowPotions !== true || this.config.combat?.allowAbilities !== true
      || manaPolicy.allowAbilities !== true) return null;
    const allowedIds = new Set((this.config.combat?.allowedAbilityIds || []).map(Number));
    const currentStamina = Math.max(0, Number(this.battleManager.lastStamina ?? stored.stamina?.current) || 0);
    const staminaReserve = Math.max(0, Number(this.config.combat?.staminaReserve) || 0);
    const abilities = (this.currentClassSkillTree?.unlockedSkills || [])
      .filter(skill => skill?.owned === true
        && skill.passive !== true
        && allowedIds.has(Number(skill.id))
        && Math.max(0, Number(skill.staminaCost) || 0) <= Math.max(0, currentStamina - staminaReserve));
    if (abilities.length === 0) return null;
    const currentMana = Math.max(0, Number(battle?.playerMana ?? stored.mp?.current) || 0);
    const maxMana = Math.max(0, Number(battle?.playerMaxMana ?? stored.mp?.max) || 0);
    const reserve = maxMana > 0 ? Math.ceil(maxMana * Math.min(100, Math.max(0, Number(manaPolicy.stopBelow) || 0)) / 100) : 0;
    const cheapestCost = Math.min(...abilities.map(skill => Math.max(0, Number(skill.manaCost) || 0)));
    const neededAmount = Math.max(0, reserve + cheapestCost - currentMana);
    if (neededAmount <= 0) return { needed: false, available: false };

    const candidates = (battle?.consumables?.items || [])
      .filter(item => item.category === 'mana'
        && ['small', 'large'].includes(item.type)
        && Number(item.quantity) > 0
        && item.inventoryId
        && !this.failedManaPotionIds.has(String(item.inventoryId)))
      .map(item => ({
        item,
        restored: Math.max(0, Number(item.restoreAmount) || (item.type === 'large' ? 200 : 20)),
        policy: this.resourcePolicyEngine?.canUseManaPotion(
          item.type,
          Number(this.stats.manaPotionsUsed?.[item.type]) || 0,
        ),
      }))
      .filter(candidate => candidate.policy?.allowed)
      .sort((left, right) => {
        const leftFits = left.restored >= neededAmount ? 0 : 1;
        const rightFits = right.restored >= neededAmount ? 0 : 1;
        return leftFits - rightFits || left.restored - right.restored;
      });
    const selected = candidates[0];
    if (selected) {
      return {
        needed: true,
        available: true,
        type: selected.item.type,
        inventoryId: selected.item.inventoryId,
        name: selected.item.name,
        quantity: selected.item.quantity,
        neededAmount,
      };
    }
    const smallPolicy = this.resourcePolicyEngine?.canUseManaPotion('small', Number(this.stats.manaPotionsUsed?.small) || 0);
    const purchase = this.resourcePolicyEngine?.canPurchase('mana', { gold: parseCompactAmount(stored.gold) });
    return {
      needed: true,
      available: false,
      type: 'small',
      inventoryId: null,
      name: 'Small Mana Potion',
      neededAmount,
      buyIfMissing: smallPolicy?.allowed === true && purchase?.allowed === true,
    };
  }

  _progressionAreaKeys() {
    const sources = this.config.progression?.lootSources || {};
    const dungeonAreas = sources.dungeons?.enabled === true && Array.isArray(sources.dungeons.areas)
      ? sources.dungeons.areas
      : [];
    const eventAreas = sources.events?.enabled === true && Array.isArray(sources.events.areas)
      ? sources.events.areas
      : [];
    const gateAreas = sources.gates?.enabled === true && Array.isArray(sources.gates.areas)
      ? sources.gates.areas
      : [];
    return [...new Set([...dungeonAreas, ...eventAreas, ...gateAreas].filter(Boolean))];
  }

  _availableRewardChapters() {
    const targets = this.getMangaTargets(this.accountName) || [];
    const configuredRemaining = targets.reduce((total, manga) =>
      total + Math.max(0, Number(manga.chapters || 0) - Number(manga.farmedCount || 0)), 0);
    const farmedReward = Math.max(0, Number(stateStore.getState().farmedEnergy) || 0);
    const rewardRemaining = Math.floor(Math.max(0, 1000 - farmedReward) / 2);
    return Math.max(0, Math.min(configuredRemaining, rewardRemaining));
  }

  async _refreshProgressionLoot(force = false) {
    if (!this.monsterCatalogService || !this.progressionEngine) return this.progressionLootSnapshot;
    if (this.progressionLootRefreshPromise) return this.progressionLootRefreshPromise;
    if (!force && this.progressionLootBatchActive && this.progressionLootSnapshot.candidates.length > 0) {
      return this.progressionLootSnapshot;
    }
    const hasDungeonSource = (this.config.progression?.lootSources?.dungeons?.enabled === true)
      && (this.config.progression?.lootSources?.dungeons?.areas?.length > 0);
    const maxAgeMs = hasDungeonSource ? 1000 : 10000;
    if (!force && Date.now() - this.progressionLootSnapshot.refreshedAt < maxAgeMs) {
      return this.progressionLootSnapshot;
    }
    const refresh = (async () => {
      const candidates = [];
      const errors = [];
      const areas = this._progressionAreaKeys();
      for (let areaRank = 0; areaRank < areas.length; areaRank += 1) {
        const areaKey = areas[areaRank];
        try {
          const result = await this.monsterCatalogService.getProgressionLootCandidates(
            areaKey,
            this.config.looting?.maps?.[areaKey] || {},
          );
          candidates.push(...result.candidates.map(candidate => ({ ...candidate, areaRank })));
          if (force) {
            this.log(
              'INFO',
              `Progression loot scan ${result.area?.label || areaKey}: ${result.verifiedCount || 0} verified, ${result.unknownCount || 0} unverified configured reward(s).`,
            );
          }
          errors.push(...(result.errors || []).map(error => ({
            areaKey,
            instanceId: error.instanceId || null,
            message: `${result.area?.label || areaKey}: ${error.message || String(error)}`,
          })));
        } catch (error) {
          errors.push({ areaKey, message: `${areaKey}: ${error.message}` });
        }
      }
      this.progressionLootSnapshot = { candidates, errors, refreshedAt: Date.now() };
      if (errors.length > 0 && candidates.length === 0) {
        this.log('WARN', `Progression loot discovery is unavailable: ${errors.map(error => error.message).join('; ')}`);
      }
      return this.progressionLootSnapshot;
    })();
    this.progressionLootRefreshPromise = refresh;
    try {
      return await refresh;
    } finally {
      if (this.progressionLootRefreshPromise === refresh) this.progressionLootRefreshPromise = null;
    }
  }

  async refreshProgressionLoot() {
    if (this.config.progression?.enabled !== true || this.config.progression?.useLootForLeveling !== true) {
      throw new Error('Enable Progression and Use loot for leveling before scanning');
    }
    if (this._progressionAreaKeys().length === 0) {
      throw new Error('Enable at least one Dungeon, Event, or Gate loot source in Progression before scanning');
    }
    await this.refreshStats();
    await this._refreshProgressionLoot(true);
    const stored = stateStore.getState();
    this.currentProgressionDecision = this.progressionEngine.evaluate({
      accountName: this.accountName,
      state: this._gatherState({ isConnected: stored.isConnected }),
      lootCandidates: this.progressionLootSnapshot.candidates,
      chaptersAvailable: this._availableRewardChapters(),
    });
    const telemetry = this.getTelemetry();
    this.emit('telemetry', telemetry);
    return telemetry.progression;
  }

  async _wait(reason, signal) {
    this._transition(BotState.IDLE, reason);
    return this.timingEngine.sleepRandom(5000, 15000, signal);
  }

  async _scan({
    kind = 'gate', gateId, eventId, wave, areaKey, ignoreInstanceId = null, fallback = null,
    preferredMonsterKey = null, overflow = null, replaceCurrent = false,
  }, signal) {
    if (replaceCurrent) {
      this.battleManager.clear();
      this.currentTarget = null;
      this.currentCombatContext = null;
    }
    if (ignoreInstanceId) {
      this.ignoredTargetIds.add(String(ignoreInstanceId));
      if (this.ignoredTargetIds.size > 1000) this.ignoredTargetIds.delete(this.ignoredTargetIds.values().next().value);
      this.battleManager.clear();
      this.currentTarget = null;
      this.currentCombatContext = null;
    }
    const isDungeon = kind === 'dungeon';
    const isEvent = kind === 'event';
    this._transition(
      BotState.SCANNING_GATES,
      isDungeon ? 'Discovering dungeon monsters' : isEvent ? `Event ${eventId}, wave ${wave}` : `Gate ${gateId}, wave ${wave}`,
    );
    let monsters;
    if (isDungeon) {
      if (!this.monsterCatalogService) throw new Error('Dungeon discovery service is unavailable');
      try {
        await this.monsterCatalogService.listArea(areaKey);
      } catch (error) {
        if (!fallback) throw error;
        this.log('INFO', `Dungeon ${areaKey} is not currently available (${error.message}); using configured Gate fallback.`);
        return this._scan(fallback, signal);
      }
      monsters = this.monsterCatalogService.getLiveMonsters(areaKey)
        .filter(monster => !this.ignoredTargetIds.has(String(monster.id)));
    } else if (isEvent) {
      monsters = (await this.gameAPI.getEventWaveMonsters(eventId, wave))
        .filter(monster => !this.ignoredTargetIds.has(String(monster.id || monster.battleId)));
    } else {
      const resolvedWave = await this.gameAPI.resolveWave(gateId, wave);
      monsters = (await this.gameAPI.getWaveMonsters(gateId, resolvedWave))
        .filter(monster => !this.ignoredTargetIds.has(String(monster.id || monster.battleId)));
    }
    const target = this.targetLedger.selectTarget(areaKey, monsters, undefined, {
      preferredMonsterKey,
      targetDamage: overflow?.mode === 'target_damage'
        ? Math.max(1, Number(overflow.amount) || 1)
        : Number.MAX_SAFE_INTEGER,
    });
    if (!target) {
      if (fallback) {
        this.log('INFO', `No eligible Targets in ${areaKey}; using configured Gate fallback.`);
        return this._scan(fallback, signal);
      }
      this.battleManager.clear();
      this.currentTarget = null;
      this.currentCombatContext = null;
      this._transition(BotState.IDLE, 'No configured monster targets are currently eligible');
      this.lastResult = { success: true, monstersFound: monsters.length, eligibleTargets: 0 };
      await this.timingEngine.sleepRandom(isDungeon ? 500 : 5000, isDungeon ? 1000 : 15000, signal);
      return this.lastResult;
    }

    this.currentTarget = {
      id: target.id,
      name: target.name,
      hp: target.hp,
      maxHp: target.maxHp,
      userDmg: target.userDmg || 0,
      areaKey,
      monsterKey: target.monsterKey,
      targetDamage: target.targetSettings.targetDamage,
      minimumHp: target.targetSettings.minimumHp,
      priority: target.targetSettings.priority,
      staminaPotion: target.targetSettings.staminaPotion,
      gearSet: target.targetSettings.gearSet || 'default',
      petSet: target.targetSettings.petSet || 'default',
      overflow: Boolean(overflow),
      overflowMode: overflow?.mode || null,
      overflowAmount: Math.max(0, Number(overflow?.amount) || 0),
      isDungeon,
      instanceId: target.instanceId || null,
      instanceName: target.dungeonName || null,
      areaName: target.dungeonName || null,
      locationId: target.locationId || null,
      locationName: target.locationName || null,
      stats: {
        maxHp: target.maxHp ?? null,
        attack: target.attack ?? null,
        defense: target.defense ?? null,
        expPerDamage: target.expPerDamage ?? null,
      },
    };
    const battle = await this.battleManager.loadBattle(isDungeon ? target.battleRef : (target.battleId || target.id));
    if (battle.monsterStats) this.currentTarget.monsterStats = battle.monsterStats;
    battle.isJoined = target.joined || battle.isJoined;
    battle.userDamage = Math.max(Number(battle.userDamage || 0), Number(target.userDmg || 0));
    await Promise.all([this._prepareCombatContext(), this._prepareClassSkills()]);
    this._transition(battle.isJoined ? BotState.ATTACKING : BotState.JOINING_BATTLE, target.name);
    this.lastResult = { success: true, target: this.currentTarget };
    return this.lastResult;
  }

  async _join(signal) {
    this._transition(BotState.JOINING_BATTLE, this.currentTarget?.name || 'monster');
    const result = await this.battleManager.joinCurrentBattle(signal, this.config.scheduler.attackIntervals);
    this._recordAction(result);
    if (!result.success) {
      if (this.currentTarget?.isDungeon && this.currentTarget.id) this.ignoredTargetIds.add(String(this.currentTarget.id));
      this.battleManager.clear();
      this.currentTarget = null;
      this.currentCombatContext = null;
      this._transition(BotState.SCANNING_GATES, 'Join failed; selecting another target');
      return result;
    }
    this._transition(BotState.ATTACKING, 'Battle joined');
    return result;
  }

  _pendingLoadoutAction() {
    if (!this.currentTarget) return null;
    const desiredGear = this.currentTarget.gearSet !== 'default'
      ? this.currentTarget.gearSet
      : this.config.equipment?.gear?.pve;
    const desiredPets = this.currentTarget.petSet !== 'default'
      ? this.currentTarget.petSet
      : this.config.equipment?.pets?.pve;
    if (/^quick_set_(?:[1-9]|10)$/.test(String(desiredGear || ''))
      && this.appliedLoadoutSelections.gear !== desiredGear) {
      return { kind: 'gear', selection: desiredGear };
    }
    if (/^quick_set_(?:[1-9]|10)$/.test(String(desiredPets || ''))
      && this.appliedLoadoutSelections.pets !== desiredPets) {
      return { kind: 'pets', selection: desiredPets };
    }
    return null;
  }

  async _applyLoadout({ kind, selection }, signal) {
    const setNumber = Number(String(selection).match(/^quick_set_(\d+)$/)?.[1]);
    if (!Number.isInteger(setNumber) || setNumber < 1 || setNumber > 10) {
      return { success: false, message: 'Invalid Quick Set selection' };
    }
    if (this.appliedLoadoutSelections[kind] === selection) {
      return { success: true, skipped: true, message: `${selection} ${kind} is already active` };
    }
    if (this.loadoutService) {
      try {
        if (await this.loadoutService.isSavedSetActive({ kind, setNumber, context: 'attack' })) {
          this.appliedLoadoutSelections[kind] = selection;
          return { success: true, skipped: true, message: `${selection} ${kind} already matches the active set` };
        }
      } catch (error) {
        this.log('WARN', `Could not verify active ${kind} set before applying: ${error.message}`);
      }
    }
    const result = await this.gameController.applyQuickSet({
      setNumber,
      targetSet: 'attack',
      applyType: kind === 'gear' ? 'equipments' : 'pets',
    }, signal);
    this._recordAction(result);
    if (!result.success) throw new Error(result.message || `Quick Set ${setNumber} could not be applied`);
    this.appliedLoadoutSelections[kind] = selection;
    this.loadoutService?.invalidateActive();
    this.currentLoadoutSnapshot = null;
    this.currentCombatContext = null;
    await this.refreshStats();
    return result;
  }

  async _attack(skill, signal) {
    this._transition(BotState.ATTACKING, this.currentTarget?.name || 'monster');
    const context = this.currentCombatContext;
    const playerStateBefore = stateStore.getState();
    const playerHpBefore = this.battleManager.getCurrentBattle()?.playerHp;
    const result = await this.battleManager.attackOnce(skill, this.config.scheduler.attackIntervals, signal);
    this._recordAction(result);
    this.stats.attacks++;
    if (result.success) {
      try {
        if (skill?.kind !== 'class-ability') {
          const observation = this.damageObservationStore?.recordAttack({
            context,
            result,
            skill,
            playerHpBefore,
          });
          if (observation?.recorded) result.observation = observation;
          else if (this.config.combat?.attackStrategy?.mode === 'adaptive') {
            this.log('WARN', `Adaptive damage sample was not learned: ${observation?.reason || 'unclassified response'}`);
          }
        }
      } catch (error) {
        this.log('WARN', `Damage observation could not be saved: ${error.message}`);
      }
      this.stats.damageDealt += result.damage || 0;
      this.stats.xpGained += result.xpDelta || 0;
      if (this.currentTarget?.overflowMode === 'spend_stamina') {
        this.overflowStaminaSpent = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.overflowStaminaSpent + Math.max(0, Number(skill?.stamCost) || 0),
        );
      }
      if (skill?.kind !== 'class-ability') {
        try {
          this.xpModel?.observeAttack({
            accountName: this.accountName,
            level: playerStateBefore.level,
            xpDelta: result.xpDelta,
            staminaCost: skill?.stamCost,
          });
        } catch (error) {
          this.log('WARN', `XP-per-Stamina observation could not be saved: ${error.message}`);
        }
      }
      const updates = {};
      if (result.stamina !== null && result.stamina !== undefined) {
        updates.stamina = { current: result.stamina, max: stateStore.getState().stamina.max };
      }
      if (result.retaliation?.user_hp_after !== undefined) {
        updates.hp = {
          current: result.retaliation.user_hp_after,
          max: this.battleManager.getCurrentBattle()?.playerMaxHp || stateStore.getState().hp.max,
        };
      }
      if (result.mana !== null && result.mana !== undefined) {
        updates.mp = { current: result.mana, max: stateStore.getState().mp.max };
      }
      const xpDelta = Number(result.xpDelta);
      if (Number.isFinite(xpDelta) && xpDelta > 0 && Number.isFinite(Number(playerStateBefore.expCurrent))) {
        const nextXp = Number(playerStateBefore.expCurrent) + xpDelta;
        updates.expCurrent = nextXp;
        updates.expRequired = playerStateBefore.expRequired;
        updates.exp = `${nextXp} / ${playerStateBefore.expRequired}`;
      }
      stateStore.update(updates);
      const battle = this.battleManager.getCurrentBattle();
      if (this.currentTarget) {
        if (result.hp) this.currentTarget.hp = result.hp.value;
        if (battle?.userDamage !== undefined) this.currentTarget.userDmg = battle.userDamage;
      }
      const targetReached = this.currentTarget?.targetDamage > 0 &&
        (battle?.userDamage ?? 0) >= this.currentTarget.targetDamage;
      if (targetReached && this.currentTarget?.overflow !== true) this._recordCompletedTargetInstance();
      if (battle?.isDead) {
        this.stats.monstersKilled++;
        this._transition(BotState.WAITING_LOOT, 'Monster defeated');
      } else if (targetReached) {
        const completedName = this.currentTarget?.name || 'Monster';
        this.battleManager.clear();
        this.currentTarget = null;
        this.currentCombatContext = null;
        this._transition(BotState.IDLE, `${completedName} target damage reached`);
      }
      if (Number.isFinite(xpDelta) && xpDelta > 0
        && Number.isFinite(Number(playerStateBefore.expRequired))
        && Number(playerStateBefore.expCurrent) + xpDelta >= Number(playerStateBefore.expRequired)) {
        await this.refreshStats();
      }
      return result;
    }
    if (/already dead|invalid monster|monster not found/i.test(result.message || '')) {
      if (this.currentTarget?.isDungeon) {
        if (this.currentTarget.id) this.ignoredTargetIds.add(String(this.currentTarget.id));
        this.battleManager.clear();
        this.currentTarget = null;
        this.currentCombatContext = null;
        this._transition(BotState.SCANNING_GATES, 'Dungeon monster is no longer available; discovering another');
      } else {
        this.battleManager.getCurrentBattle().isDead = true;
        this._transition(BotState.WAITING_LOOT, 'Monster already dead');
      }
      return result;
    }
    if (/not enough (?:stamina|mana)/i.test(result.message || '')) {
      try {
        await this.battleManager.refresh();
      } catch (error) {
        this.log('WARN', `Resources could not be refreshed after a rejected attack: ${error.message}`);
      }
      return result;
    }
    throw new Error(result.message || 'Attack failed');
  }

  async _loot(signal) {
    if (this.fsm.is(BotState.ATTACKING)) this._transition(BotState.WAITING_LOOT, 'Preparing to loot');
    this._transition(BotState.LOOTING, this.currentTarget?.name || 'monster');
    const result = await this.battleManager.lootCurrent(this.config.looting.lootDelay, signal);
    this._recordAction(result);
    if (result.success) {
      this.stats.lootCollected++;
      this._applyRecordedLootConfig(this.lootLimitLedger.recordLooted(this.currentTarget, 1));
      this.currentTarget = null;
      this.currentCombatContext = null;
      this._transition(BotState.IDLE, 'Loot collected');
      await this.refreshStats();
      return result;
    }
    throw new Error(result.message || 'Loot failed');
  }

  async _claimProgressionLoot(claim, signal) {
    if (!this.isRunning || signal?.aborted) {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    }
    this._transition(BotState.LOOTING, claim?.name || 'Progression loot');
    const result = await this.gameController.claimLoot(
      claim.battleRef,
      this.config.scheduler.attackIntervals,
      signal,
    );
    this._recordAction(result);
    if (!result.success) throw new Error(result.message || 'Progression loot claim failed');
    if (!this.isRunning || signal?.aborted) {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    }
    this.stats.lootCollected += Math.max(1, Number(claim.stackSize) || 1);
    this._applyRecordedLootConfig(this.lootLimitLedger.recordLooted(claim, claim.stackSize));
    this.battleManager.clear();
    this.currentTarget = null;
    this.currentCombatContext = null;
    this._removeProgressionClaim(claim);
    await this.refreshStats();
    if (!this.isRunning || signal?.aborted) {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    }
    this._transition(BotState.IDLE, 'Progression loot claimed and XP refreshed');
    return result;
  }

  _progressionLootCandidateKey(candidate) {
    const areaKey = String(candidate?.areaKey || '');
    const battleRef = candidate?.battleRef;
    if (battleRef && typeof battleRef === 'object' && battleRef.isDungeon) {
      return `${areaKey}:dungeon:${String(battleRef.instanceId || candidate?.instanceId || '')}:${String(battleRef.dgmid || candidate?.dgmid || candidate?.id || '')}`;
    }
    const id = candidate?.id || candidate?.battleId || battleRef || '';
    return `${areaKey}:gate:${String(id)}`;
  }

  _applyRecordedLootConfig(recorded) {
    if (!recorded?.config) return;
    this.config = recorded.config;
    this.strategy.updateConfig(this.config);
    this.targetLedger.updateConfig(this.config);
    this.lootLimitLedger.updateConfig(this.config);
    this.progressionEngine?.updateConfig(this.config);
  }

  _removeProgressionClaim(claim) {
    const claimedKey = this._progressionLootCandidateKey(claim);
    this.progressionLootSnapshot.candidates = this.progressionLootSnapshot.candidates.filter(candidate => {
      return this._progressionLootCandidateKey(candidate) !== claimedKey;
    });
    this.progressionLootSnapshot.refreshedAt = Date.now();
    this.progressionLootBatchActive = this.progressionLootSnapshot.candidates.length > 0;
    if (!this.progressionLootBatchActive) this.progressionLootBatchConfig = null;
  }

  async _heal(mode, signal) {
    this._transition(BotState.HEALING, `Healing mode: ${mode}`);
    const battle = this.battleManager.getCurrentBattle();
    const heal = healingMode => battle
      ? this.battleManager.healCurrent(healingMode, signal, this.config.scheduler.attackIntervals)
      : this.gameController.heal(null, healingMode, signal, { delay: this.config.scheduler.attackIntervals });
    let result = null;
    const potionPolicy = this.resourcePolicyEngine?.canUseHealthPotion(this.stats.healthPotionsUsed);
    if (mode === 'potion_first' && potionPolicy?.allowed) {
      result = await heal('potion_only');
      if (!result.success && /do not have a healing potion/i.test(result.message || '')) {
        const purchase = await this._buyPotion('health', signal);
        if (purchase.success) {
          result = await heal('potion_only');
        }
      }
      if (result.success) this.stats.healthPotionsUsed += 1;
    }
    if (!result?.success) {
      result = await heal('timed_only');
    }
    this._recordAction(result);
    if (!result.success) throw new Error(result.message || 'Healing failed');
    if (battle) {
      const refreshed = await this.battleManager.refresh();
      this._applyBattleResourceSnapshot(refreshed);
      this._transition(BotState.ATTACKING, 'Healing completed');
    } else {
      await this.refreshStats();
      this._transition(BotState.IDLE, 'Healing completed');
    }
    return result;
  }

  async _buyPotion(type, signal) {
    const stored = stateStore.getState();
    const gold = parseCompactAmount(stored.gold);
    const policy = this.resourcePolicyEngine?.canPurchase(type, { gold });
    if (!policy?.allowed) {
      return { success: false, message: policy?.reason || 'Potion purchase is not allowed' };
    }
    const result = await this.gameController.buyPotion(type, signal);
    this._recordAction(result);
    if (!result.success) return result;
    if (result.gold !== null && result.gold !== undefined) stateStore.update({ gold: String(result.gold) });
    const resource = this.config.resources[type];
    this.updateConfig({ resources: { [type]: { purchasedCount: (resource.purchasedCount || 0) + 1 } } });
    return result;
  }

  async _useStaminaPotion({ type, inventoryId }, signal) {
    const normalizedInventoryId = String(inventoryId);
    const used = Number(this.stats.staminaPotionsUsed?.[type]) || 0;
    const policy = this.resourcePolicyEngine?.canUseStaminaPotion(type, used);
    if (!policy?.allowed) {
      return { success: false, message: policy?.reason || 'Stamina potion use is not allowed' };
    }

    let result;
    try {
      result = await this.gameController.useStaminaPotion(normalizedInventoryId, signal);
    } catch (error) {
      this.failedStaminaPotionIds.add(normalizedInventoryId);
      throw error;
    }
    this._recordAction(result);
    if (!result.success) {
      this.failedStaminaPotionIds.add(normalizedInventoryId);
      return result;
    }

    this.stats.staminaPotionsUsed[type] = used + 1;
    let refreshedBattle = null;
    try {
      // Refresh the battle first so consumable quantity and fight state are current,
      // but never treat its topbar as authoritative after an item mutation: that
      // page can retain the pre-potion Stamina value.
      refreshedBattle = await this.battleManager.refresh();
    } catch (error) {
      this.log('WARN', `Stamina potion succeeded, but the battle could not be refreshed: ${error.message}`);
    }

    this.battleManager.lastStamina = null;
    try {
      const captured = await this.refreshStats();
      const current = Number(captured?.stamina?.current);
      const maximum = Number(captured?.stamina?.max);
      if (!Number.isFinite(current)) throw new Error('Captured Stats did not include Stamina');
      this.battleManager.lastStamina = current;
      if (refreshedBattle) {
        refreshedBattle.stamina = current;
        if (Number.isFinite(maximum)) refreshedBattle.maxStamina = maximum;
      }
    } catch (error) {
      // Leave lastStamina empty so the engine falls back to the shared Stats state
      // instead of reusing the known-stale pre-potion battle value.
      this.battleManager.lastStamina = null;
      this.log('WARN', `Stamina potion succeeded, but authoritative Stamina capture failed: ${error.message}`);
    }
    this._transition(BotState.ATTACKING, `${type} Stamina potion consumed`);
    return result;
  }

  async _useManaPotion({ type, inventoryId, buyIfMissing = false }, signal) {
    const used = Number(this.stats.manaPotionsUsed?.[type]) || 0;
    const policy = this.resourcePolicyEngine?.canUseManaPotion(type, used);
    if (!policy?.allowed) return { success: false, message: policy?.reason || 'Mana potion use is not allowed' };

    let normalizedInventoryId = inventoryId ? String(inventoryId) : null;
    if (!normalizedInventoryId && buyIfMissing === true && type === 'small') {
      const purchase = await this._buyPotion('mana', signal);
      if (!purchase.success) return purchase;
      try {
        await this.battleManager.refresh();
      } catch (error) {
        this.log('WARN', `Mana potion was purchased, but the battle drawer could not be refreshed: ${error.message}`);
      }
      const purchased = (this.battleManager.getCurrentBattle()?.consumables?.items || []).find(item =>
        item.category === 'mana' && item.type === 'small' && Number(item.quantity) > 0 && item.inventoryId);
      normalizedInventoryId = purchased?.inventoryId ? String(purchased.inventoryId) : null;
      if (!normalizedInventoryId) {
        return { success: false, message: 'Mana potion was purchased but its inventory ID was not found in the refreshed battle drawer' };
      }
    }
    if (!/^\d{1,30}$/.test(String(normalizedInventoryId || ''))) {
      return { success: false, message: 'Mana potion inventory ID is unavailable' };
    }

    let result;
    try {
      result = await this.gameController.useManaPotion(normalizedInventoryId, signal);
    } catch (error) {
      this.failedManaPotionIds.add(normalizedInventoryId);
      throw error;
    }
    this._recordAction(result);
    if (!result.success) {
      this.failedManaPotionIds.add(normalizedInventoryId);
      return result;
    }
    this.stats.manaPotionsUsed[type] = used + 1;
    let refreshedBattle = null;
    try {
      refreshedBattle = await this.battleManager.refresh();
    } catch (error) {
      this.log('WARN', `Mana potion succeeded, but the battle could not be refreshed: ${error.message}`);
    }
    try {
      const captured = await this.refreshStats();
      const current = Number(captured?.mp?.current);
      const maximum = Number(captured?.mp?.max);
      if (refreshedBattle && Number.isFinite(current)) {
        refreshedBattle.playerMana = current;
        if (Number.isFinite(maximum)) refreshedBattle.playerMaxMana = maximum;
      }
    } catch (error) {
      this.log('WARN', `Mana potion succeeded, but authoritative Mana capture failed: ${error.message}`);
    }
    this._transition(BotState.ATTACKING, `${type} Mana potion consumed`);
    return result;
  }

  async _farm(params, signal) {
    this._transition(BotState.FARMING_ENERGY, 'Stamina below configured threshold');
    const targets = this.getMangaTargets(this.accountName) || [];
    const target = targets
      .filter(manga => (manga.chapters || 0) > (manga.farmedCount || 0))
      .sort((left, right) => (left.farmedCount || 0) - (right.farmedCount || 0))[0];
    if (!target) {
      this.lastResult = { success: false, message: 'No unfarmed manga chapters are configured' };
      this._transition(BotState.IDLE, this.lastResult.message);
      return this.lastResult;
    }
    const chapter = (target.farmedCount || 0) + 1;
    const result = await this.chapterFarmer.farmSingleChapter(
      this.accountName,
      target.slug,
      chapter,
      params.reactionType,
      signal
    );
    this._recordAction(result);
    if (result.isCloudflare) {
      const error = new Error(result.message);
      error.code = 'CLOUDFLARE';
      throw error;
    }
    if (result.code === 'AUTH_REQUIRED') {
      const error = new Error(result.message || 'Game session is not authenticated');
      error.code = 'AUTH_REQUIRED';
      throw error;
    }
    if (result.success) {
      this.stats.energyFarmed += 2;
      const stored = stateStore.getState();
      const current = stored.farmedEnergy || 0;
      const staminaCurrent = Math.max(0, Number(stored.stamina.current) || 0);
      const staminaMax = Math.max(staminaCurrent, Number(stored.stamina.max) || staminaCurrent);
      stateStore.update({
        farmedEnergy: Math.min(1000, current + 2),
        stamina: {
          current: Math.min(staminaMax, staminaCurrent + 2),
          max: staminaMax,
        },
      });
      this.onChapterFarmed(this.accountName, target.slug);
      await this.gameReader.fetchFarmedEnergy(target.slug, chapter);
    } else if (result.duplicate) {
      this.onChapterFarmed(this.accountName, target.slug);
      this.log('WARN', 'Skipped a chapter already processed during this session.');
    }
    this._transition(BotState.IDLE, result.success ? 'Chapter reaction completed' : result.message);
    return result;
  }

  _recordAction(result) {
    this.stats.actionsCount++;
    this.lastResult = result;
  }

  async _prepareCombatContext(force = false) {
    if (!this.currentTarget || !this.loadoutService || !this.damageObservationStore) {
      this.currentCombatContext = null;
      return null;
    }
    try {
      const snapshot = await this.loadoutService.getActiveLoadout({ force });
      this.currentLoadoutSnapshot = snapshot;
      const stored = stateStore.getState();
      this.currentCombatContext = this.damageObservationStore.createContext({
        accountName: this.accountName,
        target: this.currentTarget,
        player: { level: stored.level, attack: stored.attack, defense: stored.defense },
        loadoutHash: snapshot.hash.value,
      });
      return this.currentCombatContext;
    } catch (error) {
      this.currentCombatContext = null;
      this.log('WARN', `Active loadout could not be resolved; adaptive attacks will remain at x1: ${error.message}`);
      return null;
    }
  }

  async _prepareClassSkills(force = false) {
    const maxAgeMs = 5 * 60 * 1000;
    if (!force && this.currentClassSkillTree && Date.now() - this.classSkillTreeReadAt < maxAgeMs) {
      return this.currentClassSkillTree;
    }
    try {
      const tree = await this.gameAPI.getClassSkillTree();
      if (!tree?.recognized) throw new Error('Verified class Skill Tree data was not found');
      this.currentClassSkillTree = tree;
      this.classSkillTreeReadAt = Date.now();
      return tree;
    } catch (error) {
      this.currentClassSkillTree = { recognized: false, unlockedSkills: [] };
      this.classSkillTreeReadAt = Date.now();
      this.log('WARN', `Class abilities are unavailable: ${error.message}`);
      return this.currentClassSkillTree;
    }
  }

  _currentTargetIsConfigured() {
    return this.targetLedger.isAllowed(
      this.currentTarget,
      this.battleManager.getCurrentBattle(),
      this.config.general
    );
  }

  _recordCompletedTargetInstance() {
    const target = this.currentTarget;
    if (!target?.areaKey || !target?.monsterKey || !target.id) return;
    const settings = this.targetLedger.getSettings(target);
    const completion = this.targetLedger.recordCompleted(target);
    if (!completion || completion.duplicate) return;
    this.config = completion.config;
    this.strategy.updateConfig(this.config);
    this.lootLimitLedger.updateConfig(this.config);
    this.progressionEngine?.updateConfig(this.config);
    this.log('ACTION', `${target.name} target completed (${completion.completedCount}/${settings.unlimited === true ? '∞' : settings.killCount}).`);
  }

  _enterChallenge(reason) {
    if (!this.fsm.is(BotState.CHALLENGE_WAIT)) {
      this.fsm.transition(BotState.CHALLENGE_WAIT, reason);
      this.emit('captcha-alert', { active: true });
      this.log('CAPTCHA', 'Cloudflare challenge detected. Manual resolution is required.');
    }
  }

  _transition(state, reason) {
    if (!this.fsm.is(state)) this.fsm.transition(state, reason);
  }
}

module.exports = { BotEngine, MUTATING_ACTIONS };
