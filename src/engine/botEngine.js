const EventEmitter = require('events');
const { CustomRunCoordinator, projectStep } = require('./customRunCoordinator');
const { isDeepStrictEqual } = require('util');
const { BotFSM, BotState } = require('./fsm');
const { stateStore } = require('./stateStore');
const { deepMerge, validateConfig } = require('./configManager');
const { ActionExecutor, MUTATING_ACTIONS } = require('./actionExecutor');
const { ModuleRegistry } = require('./moduleRegistry');
const { bossTargetKey, configuredBossAreas } = require('./bossHunt');
const { TargetLedger } = require('./targetLedger');
const { LootLimitLedger } = require('./lootLimitLedger');
const { ProgressionAction } = require('./progressionEngine');
const { getMonsterArea, monsterTypeKey } = require('./monsterCatalog');
const { ReadPriority } = require('./worldState');
const { isAutoFarmAttackLockMessage } = require('./autoFarmService');
const { staminaMinimumAmount } = require('./resourcePolicyEngine');
const { nextUnfarmedChapter } = require('./chapterCatalog');

function parseCompactAmount(value) {
  const match = String(value ?? '').trim().replace(/,/g, '').match(/^([\d.]+)\s*([kmb])?$/i);
  if (!match) return Number(value) || 0;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[String(match[2] || '').toLowerCase()] || 1;
  return Number(match[1]) * scale;
}

function targetProgressDamage(target, battle) {
  const total = Math.max(0, Number(battle?.userDamage ?? target?.userDmg) || 0);
  const baseline = target?.phaseDamageBaseline == null ? NaN : Number(target.phaseDamageBaseline);
  return Number.isFinite(baseline) ? Math.max(0, total - Math.max(0, baseline)) : total;
}

function isActiveDungeonCombat(target, battle) {
  return target?.isDungeon === true && Boolean(battle) && battle.isDead !== true;
}

const { LoadoutCoordinator } = require('./loadoutCoordinator');

function loadoutCoordinatorFor(engine) {
  return new LoadoutCoordinator({
    gameController: engine.gameController, loadoutService: engine.loadoutService,
    crystalService: engine.powerCrystalService, getConfig: () => engine.config,
    getSelections: () => engine.appliedLoadoutSelections,
    invalidateCombat: () => { engine.currentLoadoutSnapshot = null; engine.currentCombatContext = null; },
    recordAction: result => engine._recordAction(result), refreshStats: () => engine.refreshStats(),
    log: (level, message) => engine.log(level, message),
  });
}

function shouldRefreshProgressionLoot({
  progressionReadWindow,
  activeDungeonCombat,
  hasSnapshot,
  batchActive,
  batchCandidateCount,
}) {
  if (!progressionReadWindow) return false;
  if (batchActive && batchCandidateCount > 0) return false;
  // Progression may need one authoritative snapshot when Stamina first crosses
  // its reserve. Once that snapshot exists, do not repeatedly stop a live
  // first-come-first-served Dungeon battle to rescan historical loot areas.
  if (activeDungeonCombat && hasSnapshot) return false;
  return true;
}

class BotEngine extends EventEmitter {
  constructor(dependencies) {
    super();
    if (!dependencies?.gameAPI || !dependencies?.gameReader || !dependencies?.strategyEngine) {
      throw new Error('BotEngine requires the API-driven engine dependencies');
    }

    this.accountName = dependencies.accountName || null;
    this.accountKey = dependencies.accountKey || null;
    this.accountRef = this.accountKey || this.accountName;
    this.configManager = dependencies.configManager || null;
    this.config = validateConfig(dependencies.config || this.configManager?.getConfig() || {});
    this.customRun = null;
    this.customRunSelected = this.config.general.module === 'custom_runs';
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
    this.powerCrystalService = dependencies.powerCrystalService || null;
    this.monsterCatalogService = dependencies.monsterCatalogService || null;
    this.targetDiscoveryService = dependencies.targetDiscoveryService || null;
    this.lootDiscoveryService = dependencies.lootDiscoveryService || null;
    this.damageObservationStore = dependencies.damageObservationStore || null;
    this.xpModel = dependencies.xpModel || null;
    this.progressionEngine = dependencies.progressionEngine || null;
    this.activityHistoryStore = dependencies.activityHistoryStore || null;
    this.accountDatabase = dependencies.accountDatabase || this.activityHistoryStore?.database || null;
    this.autoFarmService = dependencies.autoFarmService || null;
    this.objectiveModuleService = dependencies.objectiveModuleService || null;
    this.windowManager = dependencies.windowManager || null;
    this.soloPvpService = dependencies.soloPvpService || null;
    this.allowSoloPvp = dependencies.allowSoloPvp !== false;
    this.chapterFarmer = dependencies.chapterFarmer;
    this.getMangaTargets = dependencies.getMangaTargets || (() => []);
    this.onChapterCycleReset = dependencies.onChapterCycleReset || (() => {});
    this.onChapterFarmed = dependencies.onChapterFarmed || (() => {});

    this.fsm = new BotFSM(BotState.STOPPED);
    this.isRunning = false;
    this.isPaused = false;
    this.loopPromise = null;
    this.runController = null;
    this.lastStatsRefresh = 0;
    this.statsRefreshPromise = null;
    this.farmCycleId = null;
    this.chapterFallbackBlockedUntil = 0;
    this.consecutiveErrors = 0;
    this.currentTarget = null;
    this.currentAction = null;
    this.currentReason = null;
    this.runtimeStatus = {
      kind: 'stopped',
      code: 'not_started',
      title: 'Bot stopped',
      detail: 'Choose a module and press Start.',
      since: Date.now(),
    };
    this.lastResult = null;
    this.currentLoadoutSnapshot = null;
    this.currentCombatContext = null;
    this.currentClassSkillTree = null;
    this.classSkillTreeReadAt = 0;
    this.ignoredTargetIds = new Set();
    this.progressionLootSnapshot = { candidates: [], refreshedAt: 0, errors: [] };
    this.progressionLootRevision = 0;
    this.progressionLootScanGeneration = 0;
    this.progressionLootRefreshPromise = null;
    this.currentProgressionDecision = null;
    this.failedStaminaPotionIds = new Set();
    this.failedManaPotionIds = new Set();
    this.appliedLoadoutSelections = { gear: null, pets: null };
    this.progressionLootBatchActive = false;
    this.progressionLootBatchConfig = null;
    this.progressionLootBatchStartLevel = null;
    this.progressionLootRefreshPending = false;
    this.pendingMutation = null;
    this.autoFarmSynchronized = false;
    this.autoFarmPveCleared = false;
    this.abilityTurnState = { battleKey: null, attackTurn: 0, usedAtTurn: {}, useCounts: {} };
    this.autoFarmServerEnabled = false;
    this.autoFarmPausePromise = null;
    this.monsterPhaseDuelState = null;
    this.phaseDuelProbeCache = new Map();
    this.phaseDamageBaselines = new Map();
    this.currentObjectiveState = null;
    this.objectiveClaimedKeys = new Set();
    this.objectivePreparedLootKeys = new Set();
    this.objectiveRejectedMonsterKeys = new Set();
    this.actionExecutor = dependencies.actionExecutor || new ActionExecutor({
      SOLO_PVP_JOIN: (params, context) => this._executeSoloPvp('SOLO_PVP_JOIN', params, context),
      SOLO_PVP_CONTROL: (params, context) => this._executeSoloPvp('SOLO_PVP_CONTROL', params, context),
      SOLO_PVP_SKILL: (params, context) => this._executeSoloPvp('SOLO_PVP_SKILL', params, context),
      SOLO_PVP_SURRENDER: (params, context) => this._executeSoloPvp('SOLO_PVP_SURRENDER', params, context),
      SCAN: (params, context) => this._scan(params, context.signal),
      JOIN: (params, context) => this._join(context.signal),
      ATTACK: (params, context) => this._attack(params.skill, context.signal),
      LOOT: (params, context) => this._loot(context.signal),
      CLAIM_LOOT: (params, context) => this._claimProgressionLoot(params.claim, context.signal),
      CLAIM_OBJECTIVE_LOOT: (params, context) => this._claimObjectiveLoot(params.claim, context.signal),
      ADV_QUEST_ACCEPT: (params) => this._acceptAdventureQuest(params.questId),
      ADV_QUEST_FINISH: (params) => this._finishAdventureQuest(params.questId),
      ADV_QUEST_GIVE_UP: (params) => this._giveUpAdventureQuest(params.questId),
      HEAL: (params, context) => this._heal(params.mode, context.signal),
      FARM: (params, context) => this._farm(params, context.signal),
      APPLY_LOADOUT: (params, context) => this._applyLoadout(params, context.signal),
      USE_STAMINA_POTION: (params, context) => this._useStaminaPotion(params, context.signal),
      USE_MANA_POTION: (params, context) => this._useManaPotion(params, context.signal),
      AUTO_FARM_START: (params, context) => this._startAutoFarm(params, context.signal),
      MONSTER_PHASE_DUEL: (params, context) => this._monsterPhaseDuel(params, context.signal),
      STOP: () => this._stopFromPolicy(),
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
      // Chapter reactions and the +2 Stamina reward are different server
      // counters.  Keep both so a 500-reaction limit cannot be reached after
      // only 250 reactions by comparing against the stamina amount.
      chaptersFarmed: 0,
      healthPotionsUsed: 0,
      staminaPotionsUsed: { small: 0, large: 0, full: 0, adventure: 0 },
      manaPotionsUsed: { small: 0, large: 0 },
      deaths: 0,
      errors: 0,
      startTime: null,
    };

    if(this.accountDatabase && this.accountRef)Object.assign(this.stats,this.accountDatabase.getUsageCounters?.(this.accountRef) || {});
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

  _setRuntimeStatus(kind, title, detail, code = kind) {
    const normalized = {
      kind: String(kind || 'active'),
      code: String(code || kind || 'active'),
      title: String(title || 'Working'),
      detail: String(detail || title || 'Working'),
    };
    const previous = this.runtimeStatus || {};
    const unchanged = previous.kind === normalized.kind
      && previous.code === normalized.code
      && previous.title === normalized.title
      && previous.detail === normalized.detail;
    this.runtimeStatus = {
      ...normalized,
      since: unchanged ? previous.since : Date.now(),
    };
    if (!unchanged) this.emit('telemetry', this.getTelemetry());
    return this.runtimeStatus;
  }

  _setDecisionRuntimeStatus(decision) {
    const action = String(decision?.action || '').toUpperCase();
    const reason = decision?.reason || 'Waiting for the next decision.';
    const labels = {
      SOLO_PVP_JOIN: ['active', 'Finding Solo PvP match', 'solo_pvp_join'],
      SOLO_PVP_CONTROL: ['active', 'Setting Solo PvP strategy', 'solo_pvp_control'],
      SOLO_PVP_SKILL: ['active', 'Playing Solo PvP', 'solo_pvp_skill'],
      SOLO_PVP_SURRENDER: ['active', 'Surrendering Solo PvP match', 'solo_pvp_surrender'],
      ATTACK: ['active', 'Attacking', 'attack'],
      JOIN: ['active', 'Joining battle', 'join'],
      SCAN: ['scanning', 'Finding a target', 'target_scan'],
      LOOT: ['active', 'Looting', 'loot'],
      CLAIM_LOOT: ['active', 'Looting for Progression', 'progression_loot'],
      CLAIM_OBJECTIVE_LOOT: ['active', 'Looting for objective', 'objective_loot'],
      HEAL: ['active', 'Healing', 'heal'],
      FARM: ['active', 'Farming Chapters', 'chapter_farm'],
      APPLY_LOADOUT: ['active', 'Applying loadout', 'loadout'],
      USE_STAMINA_POTION: ['active', 'Using Stamina potion', 'stamina_potion'],
      USE_MANA_POTION: ['active', 'Using Mana potion', 'mana_potion'],
      AUTO_FARM_START: ['active', 'Starting Auto Farm', 'auto_farm'],
      MONSTER_PHASE_DUEL: ['active', 'Phase PvP running', 'phase_pvp'],
      WAIT: ['waiting', 'Waiting', 'wait'],
      STOP: ['stopped', 'Bot stopped', 'policy_stop'],
    };
    const [kind, title, code] = labels[action] || ['active', action || 'Working', 'action'];
    this._setRuntimeStatus(kind, title, reason, code);
  }

  _resetProgressionLootSnapshot() {
    this.progressionLootScanGeneration += 1;
    this.progressionLootRevision += 1;
    this.progressionLootSnapshot = { candidates: [], refreshedAt: 0, errors: [] };
  }

  _commitProgressionLootSnapshot(snapshot) {
    this.progressionLootSnapshot = {
      candidates: Array.isArray(snapshot?.candidates) ? snapshot.candidates : [],
      errors: Array.isArray(snapshot?.errors) ? snapshot.errors : [],
      refreshedAt: Number(snapshot?.refreshedAt) || Date.now(),
    };
    this.progressionLootRevision += 1;
    return this.progressionLootSnapshot;
  }

  updateConfig(patch, options = {}) {
    const previousModule = this.config.general?.module;
    // Runtime counters must be persisted without pulling unrelated pending UI
    // edits into the live engine before the user presses Apply.
    if (this.configManager && options.persist !== false) this.configManager.update(patch);
    // ConfigManager validates the persisted copy, but runtime-only updates can
    // also originate inside the engine. Validate the merged runtime snapshot
    // independently so malformed counters/settings can never bypass the same
    // canonical bounds merely because persistence was intentionally skipped.
    this.config = validateConfig(deepMerge(this.config, patch));
    if (patch.general?.module) {
      this.customRunSelected = this.config.general.module === 'custom_runs';
      this.customRun = null;
    }
    this.strategy.updateConfig(this.config);
    this.targetLedger.updateConfig(this.config);
    this.lootLimitLedger.updateConfig(this.config);
    this.resourcePolicyEngine?.updateConfig(this.config);
    this.progressionEngine?.updateConfig(this.config);
    if (patch.general || patch.adventureQuests || patch.battlePass) {
      this.currentObjectiveState = null;
      this.objectiveClaimedKeys.clear();
      this.objectivePreparedLootKeys.clear();
      this.objectiveRejectedMonsterKeys.clear();
    }
    const progressionLootInputsChanged = Boolean(patch.looting || patch.progression);
    if (progressionLootInputsChanged && !this.progressionLootBatchActive) {
      this._resetProgressionLootSnapshot();
      this.progressionLootBatchActive = false;
      this.progressionLootBatchConfig = null;
      this.progressionLootRefreshPending = false;
    } else if (progressionLootInputsChanged && this.progressionLootBatchActive) {
      this.progressionLootRefreshPending = true;
      this.log('INFO', 'Progression settings changed; the active verified claim batch remains locked until it finishes or the bot is paused.');
    }
    this._updateTiming();
    if (patch.autoFarm || patch.general) {
      this.autoFarmSynchronized = false;
      this.autoFarmPveCleared = false;
    }
    if (previousModule === 'auto_farm' && this.config.general?.module !== 'auto_farm' && this.autoFarmServerEnabled) {
      this._requestAutoFarmPause('Auto Farm module was deselected');
    }
    if (patch.general || patch.looting || patch.progression || patch.battlePass || patch.adventureQuests) {
      this.emit('discovery-demand-changed');
    }
    if (this.currentTarget && (patch.general || patch.monsters)) {
      if (!this._currentTargetIsConfigured()) {
        this.battleManager.clear();
        this.currentTarget = null;
        this.currentCombatContext = null;
        this.log('INFO', 'Current target was released because its map or Target settings changed.');
      } else if (!this.currentTarget.objective) {
        const settings = this.config.monsters.maps[this.currentTarget.areaKey][this.currentTarget.monsterKey];
        Object.assign(this.currentTarget, {
          targetDamage: settings.targetDamage,
          minimumHp: settings.minimumHp,
          priority: settings.priority,
          staminaPotion: settings.staminaPotion,
          allowAbilities: settings.allowAbilities === true,
          gearSet: settings.gearSet || 'default',
          petSet: settings.petSet || 'default',
        });
      }
    }
    this.log('INFO', `Configuration updated${this.config.safety.dryRun ? ' (dry-run enabled)' : ''}.`);
    return this.config;
  }

  replaceConfig(config, options = {}) {
    const previousModule = this.config.general?.module;
    const previousProgression = this.config.progression;
    const previousLooting = this.config.looting;
    this.config = this.configManager ? this.configManager.replace(config) : validateConfig(config);
    this.customRunSelected = this.config.general.module === 'custom_runs';
    this.customRun = null;
    const progressionLootInputsChanged = !isDeepStrictEqual(previousProgression, this.config.progression)
      || !isDeepStrictEqual(previousLooting, this.config.looting);
    const preserveProgressionSnapshot = options.preserveProgressionSnapshot === true
      && !progressionLootInputsChanged;
    this.strategy.updateConfig(this.config);
    this.targetLedger.updateConfig(this.config);
    this.lootLimitLedger.updateConfig(this.config);
    this.resourcePolicyEngine?.updateConfig(this.config);
    this.progressionEngine?.updateConfig(this.config);
    this.currentObjectiveState = null;
    this.objectiveClaimedKeys.clear();
    this.objectivePreparedLootKeys.clear();
    this.objectiveRejectedMonsterKeys.clear();
    if (!preserveProgressionSnapshot && !this.progressionLootBatchActive) {
      this._resetProgressionLootSnapshot();
      this.progressionLootBatchActive = false;
      this.progressionLootBatchConfig = null;
      this.progressionLootRefreshPending = false;
    } else if (!preserveProgressionSnapshot) {
      this.progressionLootRefreshPending = true;
      this.log('INFO', 'The loaded preset will apply to Progression after the active verified claim batch finishes or the bot is paused.');
    }
    this.objectivePreparedLootKeys.clear();
    this.objectiveRejectedMonsterKeys.clear();
    this.autoFarmSynchronized = false;
    this.autoFarmPveCleared = false;
    if (previousModule === 'auto_farm' && this.config.general?.module !== 'auto_farm' && this.autoFarmServerEnabled) {
      this._requestAutoFarmPause('Auto Farm module was replaced');
    }
    this.emit('discovery-demand-changed');
    this._updateTiming();
    if (this.currentTarget) {
      if (!this._currentTargetIsConfigured()) {
        this.battleManager.clear();
        this.currentTarget = null;
        this.currentCombatContext = null;
        this.log('INFO', 'Current target was released because a configuration preset was loaded.');
      } else if (!this.currentTarget.objective) {
        const settings = this.config.monsters.maps[this.currentTarget.areaKey][this.currentTarget.monsterKey];
        Object.assign(this.currentTarget, {
          targetDamage: settings.targetDamage,
          minimumHp: settings.minimumHp,
          priority: settings.priority,
          staminaPotion: settings.staminaPotion,
          allowAbilities: settings.allowAbilities === true,
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

  _applyCustomRunStep(step) {
    if (!step) return;
    const previous = this.config.progression;
    this.config = validateConfig(projectStep(this.config, step));
    this.strategy.updateConfig(this.config);
    this.targetLedger.updateConfig(this.config);
    this.lootLimitLedger.updateConfig(this.config);
    this.resourcePolicyEngine?.updateConfig(this.config);
    this.progressionEngine?.updateConfig(this.config);
    if (!isDeepStrictEqual(previous, this.config.progression)) this._resetProgressionLootSnapshot();
    this.battleManager.clear();this.currentTarget=null;this.currentCombatContext=null;this.currentObjectiveState=null;
    this.emit('discovery-demand-changed');
    this.emit('custom-run-step', this.config);
    this.log('INFO','Custom Run: '+this.customRun.run.name+' → step '+(this.customRun.index+1)+' ('+step.module+')');
  }

  _observeCustomRun(kind) {
    if (!this.customRun) return;
    if(this.isRunning===false || this.isPaused===true || this.runController?.signal.aborted){this.customRun.observe('blocked');return;}
    const battle=this.battleManager.getCurrentBattle();
    const solo=this.soloPvpService?.getStatus?.();
    const protectedState=Boolean(this.pendingMutation||this.progressionLootBatchActive||battle?.phaseDuel
      || this.customRunCubeStatus?.()?.pendingJoin
      || (this.customRunCubeStatus?.()?.commitment && ['joined','live'].includes(this.customRunCubeStatus?.()?.state))
      ||(this.config.general.module==='pvp'&&['battle','loading'].includes(solo?.phase)));
    const next=this.customRun.observe(kind,protectedState);
    if(next)this._applyCustomRunStep(next);
  }

  start(options = {}) {
    const selectedRun=this.config.customRuns?.runs?.[this.config.customRuns?.activeId];
    if(!this.allowSoloPvp && (this.config.general.module==='pvp'||(this.customRunSelected&&selectedRun?.steps.some(step=>step.enabled&&step.module==='pvp')))){
      this.log('WARN','Solo PvP is not available in release builds');return false;
    }
    if (!this.isRunning && !this.loopPromise && this.customRunSelected) {
      const run=this.config.customRuns.runs[this.config.customRuns.activeId];
      if(!run||!run.steps.some(s=>s.enabled)){this.log('WARN','Custom Run needs an enabled valid step');return false;}
      this.customRun=new CustomRunCoordinator(run);this._applyCustomRunStep(this.customRun.step);
    }
    if (!this.isRunning && !this.loopPromise && options.preserveProgressionSnapshot !== true) this.soloPvpService?.resetRun?.();
    if (this.isRunning || this.loopPromise) return false;
    this.isRunning = true;
    this.isPaused = false;
    this.consecutiveErrors = 0;
    this.stats.startTime = Date.now();
    const runController = new AbortController();
    this.runController = runController;
    this.ignoredTargetIds.clear();
    this.failedStaminaPotionIds.clear();
    this.failedManaPotionIds.clear();
    this.objectivePreparedLootKeys.clear();
    this.objectiveRejectedMonsterKeys.clear();
    if (options.preserveProgressionSnapshot !== true) this._resetProgressionLootSnapshot();
    this.progressionLootBatchActive = false;
    this.progressionLootBatchConfig = null;
    this.progressionLootRefreshPending = false;
    this.pendingMutation = null;
    this.autoFarmSynchronized = false;
    this.autoFarmPveCleared = false;
    this.abilityTurnState = { battleKey: null, attackTurn: 0, usedAtTurn: {}, useCounts: {} };
    this.currentAction = 'START';
    this.currentReason = 'Starting automation';
    this._setRuntimeStatus('active', 'Starting', this.currentReason, 'starting');
    this.fsm.transition(BotState.IDLE, 'Started by user');
    this.log('INFO', `API bot started${this.config.safety.dryRun ? ' in DRY-RUN mode' : ''}.`);
    const loopPromise = this._mainLoop(runController.signal)
      .catch(error => {
        if (this._isCancellationError(error, runController.signal)) return;
        this.isRunning = false;
        this.isPaused = false;
        this.pendingMutation = null;
        this.stats.errors++;
        this.lastResult = { success: false, error: error.message, code: error.code || 'UNKNOWN' };
        this.currentAction = 'STOP';
        this.currentReason = `Unexpected engine error: ${error.message}`;
        this._setRuntimeStatus('error', 'Bot stopped after an error', this.currentReason, 'engine_error');
        this.log('ERROR', `Bot loop stopped after an unexpected error: ${error.message}`);
        if (!this.fsm.is(BotState.STOPPED)) {
          this.fsm.transition(BotState.STOPPED, 'Engine loop failed');
        }
      })
      .finally(() => {
        // A completed older run must never clear the controller/promise owned by
        // a newer run. start() also waits for this cleanup before allowing one.
        if (this.loopPromise === loopPromise) this.loopPromise = null;
        if (this.runController === runController) this.runController = null;
      });
    this.loopPromise = loopPromise;
    return true;
  }

  _isCancellationError(error, signal = null) {
    return error?.name === 'AbortError'
      || error?.code === 'CANCELLED'
      || signal?.aborted === true;
  }

  pause(reason = 'Paused by user') {
    if (!this.isRunning || this.isPaused) return false;
    this.isPaused = true;
    this.customRun?.observe('blocked');
    this.timingEngine.cancelAll();
    this.httpClient.cancelAll();
    this._resetProgressionLootSnapshot();
    this.progressionLootBatchActive = false;
    this.progressionLootBatchConfig = null;
    this.progressionLootRefreshPending = false;
    this.currentProgressionDecision = null;
    this.currentObjectiveState = null;
    this.currentAction = 'PAUSE';
    this.currentReason = reason;
    this._setRuntimeStatus('paused', 'Bot paused', reason, 'paused');
    if (this.autoFarmServerEnabled) this._requestAutoFarmPause('Bot paused');
    this.autoFarmSynchronized = false;
    this.autoFarmPveCleared = false;
    this.windowManager?.destroyMonsterPhasePvpWatcher?.(this.accountName);
    this.fsm.transition(BotState.PAUSED, reason);
    return true;
  }

  async pauseAndWait(reason = 'Paused by user') {
    const paused = this.pause(reason);
    if (this.autoFarmPausePromise) await this.autoFarmPausePromise;
    return paused;
  }

  resume() {
    if (!this.isRunning || !this.isPaused) return false;
    if(this.customRunSelected && !this.customRun){
      const run=this.config.customRuns.runs[this.config.customRuns.activeId];
      if(!run||!run.steps.some(s=>s.enabled)){this.log('WARN','Custom Run needs an enabled valid step');return false;}
      this.customRun=new CustomRunCoordinator(run);this._applyCustomRunStep(this.customRun.step);
    }
    this.isPaused = false;
    if (this.config.general?.module === 'auto_farm') this.autoFarmSynchronized = false;
    this.autoFarmPveCleared = false;
    this.currentAction = 'RESUME';
    this.currentReason = 'Resuming automation';
    this._setRuntimeStatus('active', 'Resuming', this.currentReason, 'resuming');
    this.fsm.transition(BotState.IDLE, 'Resumed by user');
    return true;
  }

  stop(reason = 'Stopped by user', code = 'user_stop') {
    const wasRunning = this.isRunning || Boolean(this.loopPromise);
    this.isRunning = false;
    this.isPaused = false;
    this.runController?.abort();
    this.httpClient.cancelAll();
    this.timingEngine.cancelAll();
    this.battleManager.clear();
    this.currentTarget = null;
    this.currentCombatContext = null;
    this.currentAction = 'STOP';
    this.currentReason = reason;
    this.currentProgressionDecision = null;
    this.progressionLootBatchActive = false;
    this.progressionLootBatchConfig = null;
    this.progressionLootRefreshPending = false;
    this.pendingMutation = null;
    if (this.autoFarmServerEnabled) this._requestAutoFarmPause('Bot stopped');
    this.autoFarmSynchronized = false;
    this.autoFarmPveCleared = false;
    this.monsterPhaseDuelState = null;
    this.windowManager?.destroyMonsterPhasePvpWatcher?.(this.accountName);
    this._setRuntimeStatus('stopped', 'Bot stopped', reason, code);
    if (!this.fsm.is(BotState.STOPPED)) this.fsm.transition(BotState.STOPPED, reason);
    return wasRunning;
  }

  async stopAndWait() {
    const activeLoop = this.loopPromise;
    const stopped = this.stop();
    if (this.autoFarmPausePromise) await this.autoFarmPausePromise;
    if (activeLoop) await activeLoop;
    return stopped;
  }

  _requestAutoFarmPause(reason) {
    if (!this.autoFarmService) {
      this.autoFarmServerEnabled = false;
      return null;
    }
    if (this.autoFarmPausePromise) return this.autoFarmPausePromise;
    const pause = this.autoFarmService.pause()
      .then(() => {
        this.autoFarmServerEnabled = false;
        this.log('INFO', `${reason}; server Auto Farm paused.`);
      })
      .catch(error => {
        this.log('ERROR', `Could not pause server Auto Farm: ${error.message}`);
        throw error;
      })
      .finally(() => {
        if (this.autoFarmPausePromise === pause) this.autoFarmPausePromise = null;
      });
    // stop() remains synchronous for internal lifecycle callers, so attach a
    // handler immediately. IPC/logout can additionally await stopAndWait().
    pause.catch(() => {});
    this.autoFarmPausePromise = pause;
    return pause;
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
      const epoch = Number(stats.serverEpoch);
      const offset = stats.serverTzOff ?? 19800;
      const cycleId = Math.floor((epoch + offset) / (12 * 60 * 60));
      if (Number.isFinite(epoch) && epoch > 0 && (this.farmCycleId === null || cycleId > this.farmCycleId)) {
        this.chapterFarmer.resetCycle();
        this.stats.energyFarmed = 0;
        this.stats.chaptersFarmed = 0;
        this.chapterFallbackBlockedUntil = 0;
        this.onChapterCycleReset(this.accountName, cycleId);
        if (this.farmCycleId !== null) {
          this.log('INFO', 'A new 12-hour farming cycle was detected. Session chapter tracking was reset.');
        }
      }
      if (Number.isFinite(epoch) && epoch > 0) this.farmCycleId = Math.max(this.farmCycleId ?? cycleId, cycleId);
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
    if(this.accountRef)this.accountDatabase?.setUsageCounters?.(this.accountRef,{deaths:this.stats.deaths,healthPotionsUsed:this.stats.healthPotionsUsed,staminaPotionsUsed:this.stats.staminaPotionsUsed,manaPotionsUsed:this.stats.manaPotionsUsed});
    const runtimeSeconds = this.stats.startTime ? Math.floor((Date.now() - this.stats.startTime) / 1000) : 0;
    const currentBattle = this.battleManager.getCurrentBattle();
    return {
      state: this.fsm.state,
      currentAction: this.currentAction,
      currentReason: this.currentReason,
      runtimeStatus: { ...this.runtimeStatus },
      soloPvp: this.soloPvpService?.getStatus() || null,
      customRun: this.customRun?.status() || null,
      module: this.moduleRegistry.describe(this.config.general),
      target: this.currentTarget ? {
        ...this.currentTarget,
        userDmg: this._targetProgressDamage(this.currentTarget, currentBattle),
      } : null,
      lastResult: this.lastResult,
      dryRun: this.config.safety.dryRun,
      autoFarm: {
        running: this.config.general?.module === 'auto_farm' && this.autoFarmServerEnabled === true,
        synchronized: this.autoFarmSynchronized === true,
        serverEnabled: this.autoFarmServerEnabled === true,
      },
      monsterPhasePvp: this.monsterPhaseDuelState ? {
        active: true,
        activeId: this.monsterPhaseDuelState.activeId,
        targetName: this.monsterPhaseDuelState.targetName || this.currentTarget?.name || 'Phase opponent',
        status: this.monsterPhaseDuelState.status || 'opening',
        watcherActive: this.monsterPhaseDuelState.watcherActive === true,
        roomStatus: this.monsterPhaseDuelState.roomStatus || null,
        winnerSide: this.monsterPhaseDuelState.winnerSide || null,
        startedAt: this.monsterPhaseDuelState.startedAt || null,
        updatedAt: this.monsterPhaseDuelState.updatedAt || null,
      } : { active: false },
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
      objective: this.currentObjectiveState,
      progression: this.currentProgressionDecision ? {
        status: this.currentProgressionDecision.status,
        action: this.currentProgressionDecision.action,
        staminaFlow: this.currentProgressionDecision.staminaFlow || null,
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
        lootRevision: this.progressionLootRevision,
      } : {
        status: 'Monitoring',
        action: 'FOLLOW_BASE',
        staminaFlow: null,
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
        lootRevision: this.progressionLootRevision,
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

        // Recovery is independent of selected Gear policy: Default/Off cannot bypass an unresolved POST.
        if (this.powerCrystalService?.hasPendingMutation?.()) {
          await this.powerCrystalService.reconcilePending(signal);
          if (!this.isRunning || signal.aborted) break;
        }

        if(this.customRun?.status().backoff){
          this.currentAction='WAIT';this.currentReason=this.customRun.reason;
          this.emit('telemetry',this.getTelemetry());
          await this.timingEngine.sleepRandom(1000,1500,signal);continue;
        }
        const liveState = await this.gameReader.readState();
        if (!this.isRunning || signal.aborted) break;
        if (!liveState.isConnected) {
          this.currentAction = 'WAIT';
          this.currentReason = 'Waiting for the authenticated game browser session';
          this._setRuntimeStatus('blocked', 'Game session unavailable', this.currentReason, 'game_disconnected');
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
          this.stop('Game session is no longer authenticated', 'authentication_expired');
          break;
        }

        const soloPvpModule = this.config.general?.module === 'pvp';
        const maxDeaths = Math.max(0, Math.trunc(Number(this.config.resources?.health?.maxDeaths) || 0));
        if (!soloPvpModule && maxDeaths > 0 && this.stats.deaths >= maxDeaths) {
          const reason = `Maximum deaths reached (${this.stats.deaths}/${maxDeaths})`;
          this.log('WARN', `${reason}. Bot stopped.`);
          this.stop(reason, 'max_deaths');
          break;
        }

        const loadedBattle = this.battleManager.getCurrentBattle();
        const activeDungeonCombat = isActiveDungeonCombat(this.currentTarget, loadedBattle);
        // damage.php is authoritative for Stamina, HP, Mana, and XP while a
        // Dungeon battle is active. Defer the much slower full Stats read until
        // the battle boundary so it cannot interrupt a 0.05s Dungeon schedule.
        if (Date.now() - this.lastStatsRefresh > 30000 && !activeDungeonCombat) {
          this._setRuntimeStatus('scanning', 'Refreshing account stats', 'Reading the latest account resources before the next decision.', 'stats_refresh');
          await this.refreshStats();
        }
        if (!this.isRunning || signal.aborted) break;
        if (!soloPvpModule && this.currentTarget && loadedBattle) {
          await Promise.all([this._prepareCombatContext(), this._prepareClassSkills()]);
          if (!this.isRunning || signal.aborted) break;
        }
        const objectiveModule = this._isObjectiveModule();
        if (objectiveModule) {
          await this._refreshObjectiveState();
          if (!this.isRunning || signal.aborted) break;
        } else {
          this.currentObjectiveState = null;
        }
        const gameState = this._gatherState(liveState);
        if (soloPvpModule) {
          if (!this.soloPvpService) throw new Error('Solo PvP service is unavailable');
          gameState.soloPvpDecision = await this.soloPvpService.nextDecision(this.config.soloPvp, { signal });
          if (!this.isRunning || signal.aborted) break;
        }
        gameState.objective = this.currentObjectiveState;
        const autoFarmModule = this.config.general?.module === 'auto_farm';
        const hardStopPercent = Math.max(0, Number(this.config.resources?.stamina?.stopBelow) || 0);
        const currentStaminaPercent = Number(gameState.maxStamina) > 0
          ? (Math.max(0, Number(gameState.stamina) || 0) / Number(gameState.maxStamina)) * 100
          : null;
        if (!autoFarmModule && !soloPvpModule && hardStopPercent > 0 && currentStaminaPercent !== null
          && currentStaminaPercent < hardStopPercent) {
          this.currentReason = `Stamina is ${currentStaminaPercent.toFixed(1)}%, below the ${hardStopPercent}% hard stop`;
          this._stopFromPolicy('stamina_hard_stop');
          break;
        }
        const dungeonPriorityModule = this.config.general?.module === 'dungeons';
        const progressionReadThreshold = Math.max(
          0,
          staminaMinimumAmount(this.config, gameState),
          this.config.energyFarming?.enabled === true
            ? (Number(this.config.energyFarming?.farmWhenStaminaBelow) || 0)
            : 0,
        );
        const progressionReadWindow = !dungeonPriorityModule
          ? (!gameState.currentBattle || gameState.monsterDead)
          : (Number(gameState.stamina) <= progressionReadThreshold
            || (gameState.monsterDead && gameState.isDungeon !== true));
        const refreshProgressionLoot = shouldRefreshProgressionLoot({
          progressionReadWindow,
          activeDungeonCombat: gameState.isDungeon === true
            && Boolean(gameState.currentBattle)
            && gameState.monsterDead !== true,
          hasSnapshot: this.progressionLootSnapshot.refreshedAt > 0,
          batchActive: this.progressionLootBatchActive,
          batchCandidateCount: this.progressionLootSnapshot.candidates.length,
        });
        if (!autoFarmModule && !objectiveModule && !soloPvpModule && this.config.progression?.useLootForLeveling === true
          && refreshProgressionLoot) {
          const sourceCount = this._progressionAreaKeys().length;
          this._setRuntimeStatus(
            'scanning',
            'Checking progression loot',
            `Reviewing ${sourceCount} enabled loot area${sourceCount === 1 ? '' : 's'} before deciding how to spend Stamina.`,
            'progression_scan',
          );
          await this._refreshProgressionLoot(gameState.monsterDead === true);
          if (!this.isRunning || signal.aborted) break;
        }
        this.currentProgressionDecision = (autoFarmModule || objectiveModule || soloPvpModule) ? null : this.progressionEngine?.evaluate({
          accountName: this.accountName,
          state: gameState,
          lootCandidates: this.progressionLootSnapshot.candidates,
          chaptersAvailable: this._availableRewardChapters(),
          configOverride: this.progressionLootBatchActive ? this.progressionLootBatchConfig : null,
        }) || null;
        gameState.progression = this.currentProgressionDecision || {};
        if (!soloPvpModule) this._planCombatTurn(gameState);
        let decision;
        if (gameState.currentBattle?.phaseDuel) {
          decision = this.strategy.decideNextAction(gameState);
        } else if (this.currentProgressionDecision?.action === ProgressionAction.CLAIM_LOOT) {
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
          this._releaseProgressionLootBatch();
        } else if (decision.action === 'CLAIM_LOOT' && !this.progressionLootBatchActive) {
          this.progressionLootBatchActive = true;
          this.progressionLootBatchConfig = JSON.parse(JSON.stringify(this.config));
          this.progressionLootBatchStartLevel = Number.isFinite(Number(gameState.level)) ? Number(gameState.level) : null;
          this.progressionLootRefreshPending = false;
        }
        this.currentAction = decision.action;
        this.currentReason = decision.reason;
        this._setDecisionRuntimeStatus(decision);
        this.log('INFO', `${decision.action}: ${decision.reason}`);

        if (!this.isRunning || signal.aborted) break;

        this.pendingMutation = MUTATING_ACTIONS.has(decision.action)
          ? this._captureMutationContext(decision, gameState)
          : null;
        this.lastResult = null;
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
        const noTargets=(executionResult||this.lastResult)?.eligibleTargets===0;
        const idle=(decision.action==='WAIT'&&['no_work','resources_exhausted'].includes(decision.waitKind))||(decision.action==='SCAN'&&noTargets);
        this._observeCustomRun(idle?'idle':['SCAN','WAIT'].includes(decision.action)?'blocked':'work');
        this.emit('telemetry', this.getTelemetry());
        const fastDungeonCycle = (gameState.isDungeon === true || decision.params?.kind === 'dungeon')
          && ['SCAN', 'JOIN', 'ATTACK', 'HEAL'].includes(decision.action);
        const fastLootCycle = ['LOOT', 'CLAIM_LOOT', 'CLAIM_OBJECTIVE_LOOT'].includes(decision.action);
        if (!fastDungeonCycle && !fastLootCycle) await this.timingEngine.sleepRandom(300, 800, signal);
      } catch (error) {
        this.customRun?.observe('blocked');
        if (this._isCancellationError(error, signal)) {
          if (!this.isRunning || signal.aborted) break;
          continue;
        }
        if (error.code === 'CLOUDFLARE') {
          this._enterChallenge(error.message);
          continue;
        }
        if (error.code === 'AUTH_REQUIRED') {
          this.log('ERROR', 'Authentication expired. Bot stopped.');
          this.stop('Authentication expired', 'authentication_expired');
          break;
        }
        if (error.code === 'AUTO_FARM_ACTIVE') {
          this.pendingMutation = null;
          this.consecutiveErrors = 0;
          this.lastResult = {
            success: false,
            recoverable: true,
            code: error.code,
            error: error.message,
          };
          this.currentReason = error.message;
          this._setRuntimeStatus('blocked', 'Waiting for Auto Farm to stop', error.message, 'auto_farm_attack_lock');
          this.log('WARN', error.message);
          this.emit('telemetry', this.getTelemetry());
          try {
            await this.timingEngine.sleepRandom(1500, 3000, signal);
          } catch (sleepError) {
            if (!this._isCancellationError(sleepError, signal)) throw sleepError;
            if (!this.isRunning || signal.aborted) break;
          }
          continue;
        }

        if (String(error.code || '').startsWith('CRYSTAL_MUTATION_')) {
          this.pendingMutation = null;
          this.lastResult = { success: false, ambiguous: true, error: error.message, code: error.code };
          this.log('ERROR', error.message);
          this.pause('Safety pause: Crystal movement could not be confirmed');
          continue;
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
          this.pause(`Safety pause: ${pending.action} result could not be confirmed`);
          continue;
        }
        this.pendingMutation = null;

        if (this.currentAction === 'CLAIM_LOOT') {
          this._releaseProgressionLootBatch();
        }

        this.consecutiveErrors++;
        this.stats.errors++;
        this.lastResult = { success: false, error: error.message, code: error.code || 'UNKNOWN' };
        this.currentAction = 'WAIT';
        this.currentReason = `Retrying after error ${this.consecutiveErrors}/${this.config.safety.maxConsecutiveErrors}: ${error.message}`;
        this._setRuntimeStatus('error', 'Recovering from an error', this.currentReason, 'error_backoff');
        this.log('ERROR', `Engine error ${this.consecutiveErrors}/${this.config.safety.maxConsecutiveErrors}: ${error.message}`);
        if (this.consecutiveErrors >= this.config.safety.maxConsecutiveErrors) {
          this.log('ERROR', 'Maximum consecutive errors reached. Bot stopped.');
          this.stop(`Maximum consecutive errors reached (${this.consecutiveErrors}/${this.config.safety.maxConsecutiveErrors}): ${error.message}`, 'max_errors');
          break;
        }
        try {
          await this.timingEngine.sleepRandom(1500, 3500, signal);
        } catch (sleepError) {
          // Stop/Pause may cancel this error-backoff sleep while execution is
          // already inside the surrounding catch block. Handle that expected
          // cancellation here so it cannot reject the background loop.
          if (!this._isCancellationError(sleepError, signal)) throw sleepError;
          if (!this.isRunning || signal.aborted) break;
        }
      }
    }
  }

  _gatherState(liveState) {
    const stored = stateStore.getState();
    const battle = this.battleManager.getCurrentBattle();
    const targetStaminaPotion = this._targetStaminaPotionState(battle);
    const targetManaPotion = this._targetManaPotionState(battle, stored);
    const objectiveAbilityId = Math.max(0, Number(this.currentTarget?.objective?.abilityId) || 0);
    const targetAllowsAbilities = this.currentTarget?.allowAbilities === true || objectiveAbilityId > 0;
    const gathered = {
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
      abilities: targetAllowsAbilities ? (this.currentClassSkillTree?.unlockedSkills || [])
        .filter(skill => (objectiveAbilityId > 0
          ? Number(skill.id) === objectiveAbilityId
          : this._abilityIsDue(skill, battle, 'attack')))
        : [],
      objectiveAbilityId,
      supportAbilitySkill: null,
      plannedDamageSkill: null,
      currentBattle: battle,
      artemisMarkTurns: Number(this._ensureAbilityTurnState(battle).artemisMarkTurns) || 0,
      currentTargetId: this.currentTarget?.id || null,
      combatTargetEligible: Boolean(this.currentTarget && this.targetLedger.isAllowed(this.currentTarget, battle, this.config.general)),
      progressionLootBatchActive: this.progressionLootBatchActive === true,
      isDungeon: Boolean(this.currentTarget?.isDungeon || battle?.battleLocator?.isDungeon),
      monsterHp: battle?.monsterHp ?? this.currentTarget?.hp ?? null,
      monsterDead: Boolean(battle?.isDead),
      isJoined: Boolean(battle?.isJoined),
      farmedEnergy: stored.farmedEnergy ?? this.stats.energyFarmed,
      sessionEnergyFarmed: this.stats.energyFarmed,
      sessionChaptersFarmed: this.stats.chaptersFarmed,
      farmedEnergyLimit: 1000,
      targetReached: Boolean(
        this.currentTarget?.targetDamage > 0 &&
        this._targetProgressDamage(this.currentTarget, battle) >= this.currentTarget.targetDamage
      ),
      remainingTargetDamage: this.currentTarget?.targetDamage > 0
        ? Math.max(0, this.currentTarget.targetDamage - this._targetProgressDamage(this.currentTarget, battle))
        : null,
      targetDamage: this.currentTarget?.targetDamage > 0 ? this.currentTarget.targetDamage : null,
      damageEstimate: this.damageObservationStore?.getPlanningEstimate(this.currentCombatContext) || null,
      pendingLoadoutAction: this._pendingLoadoutAction(),
      exp: stored.exp,
      expCurrent: stored.expCurrent,
      expRequired: stored.expRequired,
      targetStaminaPotion,
      targetManaPotion,
      deaths: Math.max(0, Number(this.stats.deaths) || 0),
      currentLootAllowed: this.currentTarget?.objective?.requiresLoot === true
        || this.lootLimitLedger.isAllowed(this.currentTarget),
      autoFarmSynchronized: this.autoFarmSynchronized,
    };
    return gathered;
  }

  _planCombatTurn(gameState) {
    if (!gameState || !gameState.currentBattle || gameState.monsterDead === true) return gameState;
    const plannedDamage = this.strategy?.attackPlanner?.plan(gameState) || null;
    gameState.plannedDamageSkill = plannedDamage;
    const objectiveAbilityId = Math.max(0, Number(gameState.objectiveAbilityId) || 0);
    if (objectiveAbilityId < 1 && this.currentTarget?.allowAbilities === true && plannedDamage?.planning?.source !== 'artemis-curse') {
      gameState.supportAbilitySkill = this._supportAbilitySkill(
        gameState.currentBattle,
        stateStore.getState(),
        plannedDamage?.stamCost,
      );
    }
    return gameState;
  }

  async _startAutoFarm(params = {}) {
    if (!this.autoFarmService) throw new Error('Auto Farm service is unavailable');
    if (!this.isRunning || this.runController?.signal.aborted) {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    }
    this.battleManager.clear();
    this.currentTarget = null;
    this.currentCombatContext = null;
    const result = await this.autoFarmService.syncAndStart({
      ...this.config.autoFarm,
      areaKey: params.areaKey || this.config.autoFarm?.areaKey,
    });
    this.autoFarmSynchronized = true;
    this.autoFarmServerEnabled = true;
    this.autoFarmPveCleared = false;
    this.lastResult = result;
    this.log('ACTION', `Server Auto Farm started with ${result.targets} enabled target(s).`);
    return result;
  }

  async _monsterPhaseDuel(params, signal) {
    if (!this.windowManager?.ensureMonsterPhasePvpWatcher || !this.gameAPI?.getMonsterPhasePvpState) {
      throw new Error('Monster-phase PvP support is unavailable');
    }
    const activeId = Number(params.activeId);
    if (this.monsterPhaseDuelState?.activeId !== activeId) {
      this.monsterPhaseDuelState = {
        activeId,
        lastLogId: 0,
        targetName: this.currentTarget?.name || 'Phase opponent',
        status: 'opening',
        watcherActive: false,
        roomStatus: null,
        winnerSide: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
    }
    try {
      await this.windowManager.ensureMonsterPhasePvpWatcher(this.accountName, params.url);
      this.monsterPhaseDuelState.watcherActive = true;
      this.monsterPhaseDuelState.status = 'fighting';
      this.monsterPhaseDuelState.updatedAt = Date.now();
      this.emit('telemetry', this.getTelemetry());
    } catch (error) {
      this.monsterPhaseDuelState.status = 'error';
      this.monsterPhaseDuelState.updatedAt = Date.now();
      throw error;
    }
    let state;
    try {
      state = await this.gameAPI.getMonsterPhasePvpState(activeId, this.monsterPhaseDuelState.lastLogId || 0);
    } catch (error) {
      this.monsterPhaseDuelState.status = 'error';
      this.monsterPhaseDuelState.updatedAt = Date.now();
      this.emit('telemetry', this.getTelemetry());
      throw error;
    }
    this.monsterPhaseDuelState.lastLogId = Math.max(
      Number(this.monsterPhaseDuelState.lastLogId) || 0,
      Number(state.lastLogId) || 0,
    );
    this.monsterPhaseDuelState.roomStatus = state.roomStatus || null;
    this.monsterPhaseDuelState.winnerSide = state.winnerSide || null;
    this.monsterPhaseDuelState.status = state.ended === true ? 'complete' : 'fighting';
    this.monsterPhaseDuelState.updatedAt = Date.now();
    if (state.ended !== true) {
      this._transition(BotState.IDLE, 'Monster phase PvP duel is running');
      await this.timingEngine.sleepRandom(2200, 3000, signal);
      return { success: true, pending: true, state };
    }

    this.emit('telemetry', this.getTelemetry());
    this.windowManager.destroyMonsterPhasePvpWatcher(this.accountName);
    this.monsterPhaseDuelState = null;
    if (String(state.winnerSide || '').toLowerCase() !== 'ally') {
      if (this.currentTarget?.id) this.ignoredTargetIds.add(String(this.currentTarget.id));
      this.log('WARN', 'Monster phase PvP duel was not won. Retry remains a manual recovery action; selecting another target.');
      this.battleManager.clear();
      this.currentTarget = null;
      this.currentCombatContext = null;
      this._transition(BotState.SCANNING_GATES, 'Monster phase PvP duel lost');
      return { success: false, ended: true, winnerSide: state.winnerSide || null };
    }

    const battle = await this.battleManager.refresh();
    if (battle) {
      battle.phaseDuel = null;
      this._applyBattleResourceSnapshot(battle);
    }
    const rejoinRequired = battle?.isJoined !== true;
    this._transition(
      rejoinRequired ? BotState.JOINING_BATTLE : BotState.ATTACKING,
      rejoinRequired
        ? 'Monster phase PvP won; server requires the normal battle to be joined'
        : 'Monster phase PvP won; resuming the existing normal battle',
    );
    return { success: true, ended: true, winnerSide: state.winnerSide, rejoinRequired };
  }

  _stopFromPolicy(code = 'resource_policy_stop') {
    const reason = this.currentReason || 'Hard resource stop reached';
    this.log('WARN', `${reason}. Bot stopped.`);
    this.stop(reason, code);
    return { success: true, stopped: true, reason };
  }

  _supportAbilitySkill(battle, stored = stateStore.getState(), nextAttackStamina = 0) {
    if (!battle || this.currentTarget?.allowAbilities !== true || this.config.combat?.allowAbilities !== true) return null;
    const allowed = new Set((this.config.combat.allowedAbilityIds || []).map(Number));
    this._ensureAbilityTurnState(battle);
    const policies = this.config.combat.abilityPolicies || {};
    const skills = (this.currentClassSkillTree?.unlockedSkills || [])
      .filter(skill => skill?.owned === true && !skill.passive && allowed.has(Number(skill.id)))
      .map(skill => ({ skill, policy: policies[String(skill.id)] || { role: 'select' } }))
      .filter(({ skill, policy }) => ['buff', 'debuff'].includes(policy.role)
        && this._abilityIsDue(skill, battle, policy.role)
        && Math.max(0, Number(nextAttackStamina) || 0) >= Math.max(0, Number(policy.minimumNextAttackStamina) || 0));
    const due = skills
      .sort((left, right) => (
        (left.policy.role === 'buff' ? 0 : 1) - (right.policy.role === 'buff' ? 0 : 1)
        || Number(left.skill.id) - Number(right.skill.id)
      ))[0];
    if (!due) return null;
    return {
      id: Number(due.skill.id),
      name: String(due.skill.name || `Ability ${due.skill.id}`),
      kind: 'class-ability',
      abilityRole: due.policy.role,
      supportAbility: true,
      stamCost: Math.max(0, Number(due.skill.staminaCost) || 0),
      requestStamCost: 1,
      manaCost: Math.max(0, Number(due.skill.manaCost) || 0),
    };
  }

  _ensureAbilityTurnState(battle) {
    const battleKey = `${this.currentTarget?.isDungeon ? this.currentTarget?.instanceId || '' : 'gate'}:${this.currentTarget?.id || battle?.battleCfg?.id || ''}`;
    if (this.abilityTurnState.battleKey !== battleKey) {
      this.abilityTurnState = { battleKey, attackTurn: 0, usedAtTurn: {}, useCounts: {} };
    }
    // Older in-memory state can survive a live configuration update. Keep the
    // scheduler tolerant of that shape rather than failing during an attack.
    this.abilityTurnState.usedAtTurn ||= {};
    this.abilityTurnState.useCounts ||= {};
    this.abilityTurnState.blockedSupportRoles ||= {};
    return this.abilityTurnState;
  }

  _abilityIsDue(skill, battle, expectedRole = null) {
    if (!skill || skill.owned !== true || skill.passive === true) return false;
    const id = String(skill.id);
    const policy = this.config.combat?.abilityPolicies?.[id] || {};
    const role = policy.role || 'select';
    if (expectedRole && role !== expectedRole) return false;
    if (role === 'passive' || role === 'select') return false;
    const turnState = this._ensureAbilityTurnState(battle);
    if (turnState.blockedSupportRoles[role]) return false;
    const uses = Math.max(0, Number(turnState.useCounts[id]) || 0);
    const maxUses = Math.max(0, Number(policy.maxUses) || 0);
    if (maxUses > 0 && uses >= maxUses) return false;
    const lastTurn = turnState.usedAtTurn[id];
    if (lastTurn === undefined) {
      return turnState.attackTurn >= Math.max(0, Number(policy.initialWaitTurns) || 0);
    }
    return turnState.attackTurn - lastTurn >= Math.max(1, Number(policy.reapplyTurns) || 1);
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
        objective: this.currentObjectiveState?.page ? {
          activeQuestId: this.currentObjectiveState.page.activeQuestId ?? null,
          activeQuestKey: this.currentObjectiveState.page.activeQuestKey ?? null,
          quests: (this.currentObjectiveState.page.quests || []).map(quest => ({
            id: quest.id ?? null,
            objectiveKey: quest.objectiveKey || null,
            title: String(quest.title || ''),
            status: String(quest.status || 'unknown'),
          })),
        } : null,
      },
    };
  }

  _historyEntry(source, extras = {}) {
    const battle = this.battleManager.getCurrentBattle();
    const battleRef = source?.battleRef || source?.battleLocator || battle?.battleLocator || battle?.battleCfg || {};
    const isDungeon = battleRef?.isDungeon === true || source?.isDungeon === true;
    const monsterId = String(
      (isDungeon ? (battleRef.dgmid || source?.dgmid) : (battleRef.monsterId || battleRef.id || source?.battleId))
      || source?.id
      || battle?.battleCfg?.id
      || '',
    );
    const instanceId = isDungeon ? String(battleRef.instanceId || source?.instanceId || '') : null;
    let pageUrl = '';
    if (/^\d+$/.test(monsterId)) {
      pageUrl = isDungeon && /^\d+$/.test(String(instanceId || ''))
        ? `/battle.php?dgmid=${encodeURIComponent(monsterId)}&instance_id=${encodeURIComponent(instanceId)}`
        : `/battle.php?id=${encodeURIComponent(monsterId)}`;
    }
    const area = getMonsterArea(source?.areaKey);
    return {
      areaKey: source?.areaKey || '',
      areaType: area?.type || (isDungeon ? 'dungeon' : ''),
      areaName: source?.areaName || source?.dungeonName || source?.instanceName || area?.label || '',
      monsterKey: source?.monsterKey || '',
      monsterName: source?.name || 'Unknown monster',
      phase: Number(source?.phase) || null,
      module: this.config.general?.module || '',
      monsterId,
      instanceId,
      boss: source?.boss === true,
      pageUrl,
      ...extras,
    };
  }

  _recordActivity(kind, source, extras = {}) {
    try {
      return this.activityHistoryStore?.record(this.accountRef, kind, this._historyEntry(source, extras)) || null;
    } catch (error) {
      this.log('WARN', `Activity history could not be saved: ${error.message}`);
      return null;
    }
  }

  _recordEvent(type, details = {}) {
    try {
      return this.activityHistoryStore?.recordEvent?.(this.accountRef, type, details) || null;
    } catch (error) {
      this.log('WARN', `Account event could not be saved: ${error.message}`);
      return null;
    }
  }

  _isAmbiguousMutationError(error) {
    return ['TIMEOUT', 'REQUEST_FAILED', 'SESSION_DESTROYED'].includes(error?.code);
  }

  async _reconcileAmbiguousMutation(pending, signal) {
    if (!pending || signal?.aborted) return { confirmed: false, detail: 'the run was cancelled' };
    const before = pending.before || {};
    const action = pending.action;

    if (['ADV_QUEST_ACCEPT', 'ADV_QUEST_FINISH', 'ADV_QUEST_GIVE_UP'].includes(action) && this.objectiveModuleService) {
      const questId = Number(pending.params?.questId);
      if (!Number.isInteger(questId) || questId < 1) {
        return { confirmed: false, detail: 'the Adventurer Quest ID cannot be verified' };
      }
      const beforeQuests = Array.isArray(before.objective?.quests) ? before.objective.quests : [];
      const previous = beforeQuests.find(quest => Number(quest.id) === questId) || null;
      const normalizeTitle = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const previousTitle = normalizeTitle(previous?.title);
      const fresh = await this.objectiveModuleService.refresh('adventure_quests', this.config, {
        force: true,
        priority: ReadPriority.MUTATION_REVALIDATION,
        maxAgeMs: 0,
        signal,
      });
      const freshQuests = Array.isArray(fresh?.page?.quests) ? fresh.page.quests : [];
      const sameId = freshQuests.find(quest => Number(quest.id) === questId) || null;
      const sameTitle = previousTitle
        ? freshQuests.find(quest => normalizeTitle(quest.title) === previousTitle) || null
        : null;
      const observed = sameId || sameTitle;

      if (action === 'ADV_QUEST_ACCEPT') {
        const accepted = Number(fresh?.page?.activeQuestId) === questId
          || ['active', 'claimable'].includes(String(observed?.status || ''));
        if (accepted) {
          this.currentObjectiveState = fresh;
          return { confirmed: true, detail: 'the fresh Adventurer Guild board shows the quest active' };
        }
        return { confirmed: false, detail: 'the fresh Adventurer Guild board does not show the quest active' };
      }

      if (action === 'ADV_QUEST_GIVE_UP') {
        const stillActive = Number(fresh?.page?.activeQuestId) === questId
          || ['active', 'claimable'].includes(String(observed?.status || ''));
        if (!stillActive) {
          this.currentObjectiveState = fresh;
          return { confirmed: true, detail: 'the fresh Adventurer Guild board no longer shows the abandoned quest active' };
        }
        return { confirmed: false, detail: 'the fresh Adventurer Guild board still shows the quest active' };
      }

      const wasFinishable = ['active', 'claimable'].includes(String(previous?.status || ''))
        || Number(before.objective?.activeQuestId) === questId;
      const stillActive = Number(fresh?.page?.activeQuestId) === questId
        || ['active', 'claimable'].includes(String(observed?.status || ''));
      const completedState = ['cooldown', 'completed'].includes(String(observed?.status || ''));
      if (completedState || (wasFinishable && !stillActive)) {
        this.currentObjectiveState = fresh;
        this.objectiveClaimedKeys?.clear?.();
        return {
          confirmed: true,
          detail: completedState
            ? 'the fresh Adventurer Guild board shows the quest on cooldown/completed'
            : 'the fresh Adventurer Guild board no longer shows the quest active',
        };
      }
      return { confirmed: false, detail: 'the fresh Adventurer Guild board still shows the quest active' };
    }

    if (action === 'AUTO_FARM_START' && this.autoFarmService) {
      const state = await this.autoFarmService.readState(this.config.autoFarm || {}, {
        force: true,
        priority: ReadPriority.MUTATION_REVALIDATION,
        maxAgeMs: 0,
        signal,
      });
      if (state.enabled === true) {
        this.autoFarmSynchronized = true;
        this.autoFarmServerEnabled = true;
        return { confirmed: true, detail: 'the Dashboard shows server Auto Farm running' };
      }
      return { confirmed: false, detail: 'the Dashboard does not show server Auto Farm running' };
    }

    if (action === 'APPLY_LOADOUT') {
      const selection = String(pending.params?.selection || '');
      const setNumber = Number(selection.match(/^quick_set_(\d+)$/)?.[1]);
      const kind = pending.params?.kind;
      if (!this.loadoutService || !Number.isInteger(setNumber) || !['gear', 'pets'].includes(kind)) {
        return { confirmed: false, detail: 'the selected Quick Set cannot be verified' };
      }
      const active = await this.loadoutService.isSavedSetActive({ kind, setNumber, context: 'attack', signal });
      if (active) {
        this.appliedLoadoutSelections[kind] = selection;
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
          const targetDamage = Number(pending.target?.targetDamage || this.currentTarget?.targetDamage);
          const progressDamage = targetProgressDamage(this.currentTarget || pending.target, fresh);
          const targetReached = targetDamage > 0 && progressDamage >= targetDamage;
          const completed = targetReached ? this._recordCompletedTargetInstance() : false;
          this._recordActivity?.('target', pending.target, {
            damage: contributionIncreased ? Number(fresh.userDamage) - before.userDamage : null,
            totalDamage: progressDamage,
            staminaSpent: staminaDecreased ? Math.max(0, Number(before.stamina) - Number(fresh.stamina)) : Number(pending.params?.skill?.stamCost) || 0,
            targetDamage,
            completed,
            actionName: pending.params?.skill?.name || 'Attack',
            result: 'Confirmed after an interrupted response',
          });
          return { confirmed: true, detail: 'battle contribution/resources changed' };
        }
      }
      if (action === 'LOOT' && fresh?.isDead === true && fresh?.hasLootButton === false) {
        this.stats.lootCollected += 1;
        this._invalidateLootCandidates?.(pending.target, 'battle loot reconciled as claimed');
        this._applyRecordedLootConfig(this.lootLimitLedger.recordLooted(pending.target, 1));
        this._recordActivity?.('loot', pending.target, { result: 'Loot confirmed after an interrupted response' });
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
          this.stats.manaPotionsUsed[type] += Math.max(1, Math.trunc(Number(pending.params?.quantity) || 1));
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
      const configuredLoot = lockedConfig.looting?.maps?.[areaKey] || {};
      const result = this.lootDiscoveryService
        ? await this.lootDiscoveryService.progressionCandidates(areaKey, configuredLoot, {
          force: true,
          directoryPriority: ReadPriority.ACTIVE_MODULE,
          directoryMaxAgeMs: 5000,
        })
        : await this.monsterCatalogService.getProgressionLootCandidates(areaKey, configuredLoot);
      if ((result.errors || []).length > 0) {
        return { confirmed: false, detail: 'loot discovery returned an area error' };
      }
      const claimKey = this._progressionLootCandidateKey(claim);
      const stillClaimable = (result.candidates || []).some(candidate => this._progressionLootCandidateKey(candidate) === claimKey);
      if (!stillClaimable) {
        this.stats.lootCollected += Math.max(1, Number(claim.stackSize) || 1);
        this._invalidateLootCandidates?.(claim, 'Progression loot reconciled as claimed');
        this._applyRecordedLootConfig(this.lootLimitLedger.recordLooted(claim, claim.stackSize));
        this._recordActivity?.('loot', claim, { result: 'Progression loot confirmed after an interrupted response' });
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
          this.stats.manaPotionsUsed[type] += Math.max(1, Math.trunc(Number(pending.params?.quantity) || 1));
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
    if (Object.keys(updates).length > 0) {
      if (typeof this._observeStats === 'function') {
        this._observeStats(updates, 'verified battle-page resource snapshot');
      } else if (typeof this.gameReader?.observeStats === 'function') {
        this.gameReader.observeStats(updates, 'verified battle-page resource snapshot');
      } else {
        stateStore.update(updates);
      }
    }
  }

  _observeStats(partial, source) {
    if (typeof this.gameReader?.observeStats === 'function') {
      return this.gameReader.observeStats(partial, source);
    }
    stateStore.update(partial);
    return { applied: true };
  }

  _targetStaminaPotionState(battle) {
    const stored = stateStore.getState();
    const maxStamina = Math.max(0, Number(stored.stamina?.max) || 0);
    const reserve = Math.ceil(maxStamina * Math.max(0, Number(this.config?.resources?.stamina?.keepMin) || 0) / 100);
    const selection = this.currentTarget?.staminaPotion;
    const types = ['small', 'large', 'full', 'adventure'];
    if (selection !== 'auto' && !types.includes(selection)) return null;
    const priority = this.config?.resources?.stamina?.priority;
    const ordered = selection === 'auto'
      ? [priority, ...types].filter((type, index, values) => types.includes(type) && values.indexOf(type) === index)
      : [selection];
    let lastReason = 'No allowed Stamina potion is available';
    const refillOptions = [];
    let selected = null;
    for (const type of ordered) {
      const item = (battle?.consumables?.items || []).find(candidate =>
        candidate.category === 'stamina'
        && candidate.type === type
        && Number(candidate.quantity) > 0
        && candidate.inventoryId
        && !this.failedStaminaPotionIds.has(String(candidate.inventoryId))
      );
      const used = Number(this.stats.staminaPotionsUsed?.[type]) || 0;
      const policy = this.resourcePolicyEngine?.canUseStaminaPotion(type, used);
      if (item && policy?.allowed) {
        const usesRemaining = Math.min(Math.max(0, Number(item.quantity) || 0), Math.max(0, (Number(policy.limit) || 0) - (Number(policy.used) || 0)));
        const restored = type === 'full' ? maxStamina
          : type === 'small' ? 20
            : type === 'large' ? Math.min(5000, maxStamina / 2)
              : Math.max(0, Number(item.restoreAmount) || 0);
        refillOptions.push({ type, usesRemaining, restored: Math.max(0, Math.min(maxStamina - reserve, restored)) });
        if (!selected) selected = { type, inventoryId: item.inventoryId, name: item.name || `${type} Stamina potion`, quantity: Number(item.quantity) || 0, available: true, reason: policy.reason || '' };
      }
      lastReason = item ? (policy?.reason || lastReason) : `${type} Stamina potion is not present in the battle drawer`;
    }
    if (selected) return { ...selected, refillStamina: refillOptions.reduce((sum, option) => sum + option.usesRemaining * option.restored, 0) };
    return { type: selection, inventoryId: null, name: selection === 'auto' ? 'Automatic Stamina potion' : `${selection} Stamina potion`, quantity: 0, available: false, reason: lastReason };
  }

  _targetManaPotionState(battle, stored = stateStore.getState()) {
    if (this.config.combat?.attackStrategy?.avoidArtemisCurse === true
      && Number(this._ensureAbilityTurnState(battle).artemisMarkTurns) > 0) return null;
    const manaPolicy = this.config.resources?.mana || {};
    if (manaPolicy.allowPotions !== true) return null;
    const currentMana = Math.max(0, Number(battle?.playerMana ?? stored.mp?.current) || 0);
    const maxMana = Math.max(0, Number(battle?.playerMaxMana ?? stored.mp?.max) || 0);
    const minimum = Math.max(0, Number(manaPolicy.keepMin) || 0);
    const configuredMaximum = Math.max(minimum, Number(manaPolicy.keepMax) || 0);
    const refillTarget = maxMana > 0 ? Math.min(maxMana, configuredMaximum) : configuredMaximum;
    const neededAmount = Math.max(0, refillTarget - currentMana);
    if (currentMana > minimum) return { needed: false, available: false };
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
        const priority = manaPolicy.priority || 'small';
        const leftPriority = left.item.type === priority ? 0 : 1;
        const rightPriority = right.item.type === priority ? 0 : 1;
        const leftFits = left.restored >= neededAmount ? 0 : 1;
        const rightFits = right.restored >= neededAmount ? 0 : 1;
        return leftPriority - rightPriority || leftFits - rightFits || left.restored - right.restored;
      });
    const selected = candidates[0];
    if (selected) {
      const requestedQuantity = selected.item.type === 'small'
        ? Math.ceil(neededAmount / Math.max(1, selected.restored))
        : 1;
      const quantity = Math.max(1, Math.min(
        selected.item.type === 'small' ? 10 : 1,
        Number(selected.item.quantity) || 0,
        Number(selected.policy.remaining) || 0,
        requestedQuantity,
      ));
      return {
        needed: true,
        available: true,
        type: selected.item.type,
        inventoryId: selected.item.inventoryId,
        name: selected.item.name,
        quantity: selected.item.quantity,
        useQuantity: quantity,
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
      useQuantity: 1,
    };
  }

  _isObjectiveModule() {
    return ['battle_pass', 'adventure_quests'].includes(this.config.general?.module);
  }

  async _refreshObjectiveState({ force = false } = {}) {
    const module = this.config.general?.module;
    if (!this.objectiveModuleService || !['battle_pass', 'adventure_quests'].includes(module)) {
      this.currentObjectiveState = null;
      return null;
    }
    const state = await this.objectiveModuleService.refresh(module, this.config, {
      force,
      priority: ReadPriority.ACTIVE_MODULE,
      maxAgeMs: force ? 0 : 10000,
      signal: this.runController?.signal || null,
    });
    if (module === 'battle_pass' && state?.scan?.preferredTargets) {
      state.scan.preferredTargets = state.scan.preferredTargets.filter(target => (
        !this.objectiveRejectedMonsterKeys.has(String(target.monsterKey))
      ));
      if (state.scan.objective) state.scan.objective.targets = state.scan.preferredTargets;
      if (state.scan.preferredTargets.length === 0) {
        state.scan = null;
        state.status = 'safe_check_blocked';
      }
    }
    if (state?.scan?.objective?.requiresLoot === true && !this.battleManager.getCurrentBattle()
      && this.lootDiscoveryService) {
      const result = await this.lootDiscoveryService.progressionCandidates(state.scan.areaKey, null, {
        force,
        maxAgeMs: force ? 0 : 5000,
        directoryPriority: ReadPriority.ACTIVE_MODULE,
        directoryMaxAgeMs: force ? 0 : 5000,
        forceDirectory: force,
      });
      const targetDamage = Math.max(1, Number(state.scan.objective.targetDamage) || 1);
      const monsterKey = String(state.scan.preferredMonsterKey || '');
      const targetPolicies = new Map((state.scan.preferredTargets || []).map(target => [String(target.monsterKey), target]));
      const allowExisting = module !== 'battle_pass' || state.scan.objective.lootIfAchievable === true;
      const claim = (result.candidates || []).find(candidate => (
        candidate.eligible !== false
        && (monsterKey ? candidate.monsterKey === monsterKey : targetPolicies.has(String(candidate.monsterKey)))
        && Number(candidate.userDamage) >= (monsterKey
          ? targetDamage
          : Math.max(1, Number(targetPolicies.get(String(candidate.monsterKey))?.targetDamage) || 1))
        && (allowExisting || this.objectivePreparedLootKeys.has(this._progressionLootCandidateKey(candidate)))
        && !this.objectiveClaimedKeys.has(this._progressionLootCandidateKey(candidate))
      )) || null;
      state.claim = claim;
      state.lootErrors = result.errors || [];
    }
    this.currentObjectiveState = state;
    return state;
  }

  async refreshObjectiveModule(module, { force = true } = {}) {
    if (!['battle_pass', 'adventure_quests'].includes(module)) {
      throw new Error('Unknown objective module');
    }
    if (!this.objectiveModuleService) throw new Error('Objective module service is unavailable');
    return this.objectiveModuleService.refresh(module, this.config, {
      force,
      priority: ReadPriority.VISIBLE_UI,
      maxAgeMs: force ? 0 : 10000,
    });
  }

  async _acceptAdventureQuest(questId) {
    if (!this.objectiveModuleService) throw new Error('Adventurer Quest service is unavailable');
    const result = await this.objectiveModuleService.acceptQuest(questId);
    this._recordAction(result);
    if (!result.success) throw new Error(result.message || 'Adventurer Quest could not be accepted');
    this.currentObjectiveState = null;
    this.log('ACTION', `Accepted Adventurer Quest ${questId}.`);
    return result;
  }

  async _finishAdventureQuest(questId) {
    if (!this.objectiveModuleService) throw new Error('Adventurer Quest service is unavailable');
    const result = await this.objectiveModuleService.finishQuest(questId);
    this._recordAction(result);
    if (result?.staleBoard === true) {
      this.currentObjectiveState = null;
      this.log('WARN', `Adventurer Quest ${questId} was not ready to turn in. Refreshing the Guild board instead of retrying the POST.`);
      return { ...result, success: true, skipped: true };
    }
    if (!result.success) throw new Error(result.message || 'Adventurer Quest could not be completed');
    this.currentObjectiveState = null;
    this.objectiveClaimedKeys.clear();
    this.log('ACTION', `Completed Adventurer Quest ${questId}.`);
    return result;
  }

  async _giveUpAdventureQuest(questId) {
    if (!this.objectiveModuleService) throw new Error('Adventurer Quest service is unavailable');
    const result = await this.objectiveModuleService.giveUpQuest(questId);
    this._recordAction(result);
    if (!result.success) throw new Error(result.message || 'Adventurer Quest could not be abandoned');
    this.currentObjectiveState = null;
    this.objectiveClaimedKeys.clear();
    this.objectivePreparedLootKeys.clear();
    this.log('ACTION', `Abandoned unselected Adventurer Quest ${questId}.`);
    return result;
  }

  async _claimObjectiveLoot(claim, signal) {
    if (!this.isRunning || signal?.aborted) {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    }
    this._handoffToProgressionLoot(claim);
    this._transition(BotState.LOOTING, claim?.name || 'Objective loot');
    const result = await this.gameController.claimLoot(
      claim.battleRef,
      this.config.scheduler.attackIntervals,
      signal,
    );
    this._recordAction(result);
    if (!result.success) {
      if (this._isUnavailableProgressionClaim(result)) {
        this._invalidateLootCandidates?.(claim, 'objective loot is no longer available');
        this.objectiveClaimedKeys.add(this._progressionLootCandidateKey(claim));
        this.objectiveModuleService?.invalidateObservation(
          this.config.general?.module,
          'Objective loot is no longer available',
        );
        this.currentObjectiveState = null;
        this._transition(BotState.IDLE, 'Unavailable objective loot skipped');
        return { ...result, success: true, skipped: true };
      }
      throw new Error(result.message || 'Objective loot claim failed');
    }
    this.stats.lootCollected += Math.max(1, Number(claim.stackSize) || 1);
    this._invalidateLootCandidates?.(claim, 'objective loot claimed');
    this._recordActivity?.('loot', claim, {
      stackSize: claim.stackSize,
      xp: result.rewards?.exp,
      gold: result.rewards?.gold,
      itemsCount: result.items?.length,
      items: result.items,
      result: result.message || 'Objective loot collected',
    });
    const claimKey = this._progressionLootCandidateKey(claim);
    this.objectiveClaimedKeys.add(claimKey);
    this.objectivePreparedLootKeys.delete(claimKey);
    await this._verifyBattlePassLootProgress(claim, signal);
    this.objectiveModuleService?.invalidateObservation(
      this.config.general?.module,
      'Confirmed objective loot changed server progress',
    );
    this.currentObjectiveState = null;
    this.battleManager.clear();
    this.currentTarget = null;
    this.currentCombatContext = null;
    await this.refreshStats();
    this._transition(BotState.IDLE, 'Objective loot claimed');
    return result;
  }

  async _verifyBattlePassLootProgress(claim, signal) {
    if (this.config.general?.module !== 'battle_pass' || this.config.battlePass?.safeCheck !== true) return true;
    const before = Number(this.currentObjectiveState?.hunt?.current);
    if (!Number.isFinite(before)) return true;
    let refreshed = await this.objectiveModuleService.refresh('battle_pass', this.config, {
      force: true,
      priority: ReadPriority.MUTATION_REVALIDATION,
      maxAgeMs: 0,
      signal,
    });
    if (Number(refreshed?.hunt?.current) <= before) {
      await this.timingEngine.sleepRandom(750, 1250, signal);
      refreshed = await this.objectiveModuleService.refresh('battle_pass', this.config, {
        force: true,
        priority: ReadPriority.MUTATION_REVALIDATION,
        maxAgeMs: 0,
        signal,
      });
    }
    if (Number(refreshed?.hunt?.current) > before || refreshed?.hunt?.completed === true) return true;
    const monsterKey = String(claim?.monsterKey || '');
    if (monsterKey) this.objectiveRejectedMonsterKeys.add(monsterKey);
    this.log('WARN', `${claim?.name || 'Battle Pass loot'} did not advance the Battle Pass counter after two checks; this monster type is disabled for the current run.`);
    return false;
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
    if (this.chapterFallbackBlockedUntil > Date.now()) return 0;
    const targets = this.getMangaTargets(this.accountName) || [];
    const configuredRemaining = targets.reduce((total, manga) => {
      const completed = new Set((manga.farmedChapterNumbers || []).map(Number));
      const known = Array.isArray(manga.chapterEntries) && manga.chapterEntries.length > 0
        ? manga.chapterEntries.map(entry => Number(entry.number)).filter(number => Number.isFinite(number) && number > 0)
        : Array.from({ length: Math.max(0, Number(manga.chapters) || 0) }, (_, index) => index + 1);
      return total + known.filter(chapter => !completed.has(chapter)).length;
    }, 0);
    const farmedReward = Math.max(0, Number(stateStore.getState().farmedEnergy) || 0);
    const rewardRemaining = Math.floor(Math.max(0, 1000 - farmedReward) / 2);
    const sessionLimit = Math.max(0, Number(this.config.energyFarming?.maxPerSession) || 500);
    const sessionRemaining = Math.max(0, sessionLimit - (this.stats.chaptersFarmed || 0));
    return Math.max(0, Math.min(configuredRemaining, rewardRemaining, sessionRemaining));
  }

  async _refreshProgressionLoot(force = false) {
    if (!this.monsterCatalogService || !this.progressionEngine) return this.progressionLootSnapshot;
    if (this.progressionLootRefreshPromise) {
      const activeRefresh = this.progressionLootRefreshPromise;
      await activeRefresh;
      // A configuration apply can invalidate a scan while it is in flight.
      // A manual refresh that joined that stale read should immediately start
      // one fresh scan instead of returning an empty invalidated snapshot.
      if (force && !this.progressionLootBatchActive && this.progressionLootSnapshot.refreshedAt === 0) {
        return this._refreshProgressionLoot(true);
      }
      return this.progressionLootSnapshot;
    }
    if (this.progressionLootBatchActive) return this.progressionLootSnapshot;
    const hasDungeonSource = (this.config.progression?.lootSources?.dungeons?.enabled === true)
      && (this.config.progression?.lootSources?.dungeons?.areas?.length > 0);
    const maxAgeMs = hasDungeonSource ? 1000 : 10000;
    if (!force && Date.now() - this.progressionLootSnapshot.refreshedAt < maxAgeMs) {
      return this.progressionLootSnapshot;
    }
    const scanGeneration = ++this.progressionLootScanGeneration;
    const refresh = (async () => {
      const areas = this._progressionAreaKeys();
      const areaResults = [];
      for (let areaRank = 0; areaRank < areas.length; areaRank += 1) {
        const areaKey = areas[areaRank];
        try {
          const configuredLoot = this.config.looting?.maps?.[areaKey] || {};
          const result = this.lootDiscoveryService
            ? await this.lootDiscoveryService.progressionCandidates(areaKey, configuredLoot, {
              force,
              maxAgeMs,
              directoryPriority: ReadPriority.ACTIVE_MODULE,
              directoryMaxAgeMs: force ? 0 : 5000,
              forceDirectory: force,
            })
            : await this.monsterCatalogService.getProgressionLootCandidates(areaKey, configuredLoot);
          areaResults.push({
            candidates: result.candidates.map(candidate => ({ ...candidate, areaRank })),
            errors: (result.errors || []).map(error => ({
              areaKey,
              instanceId: error.instanceId || null,
              message: `${result.area?.label || areaKey}: ${error.message || String(error)}`,
            })),
            logMessage: force
              ? `Progression loot scan ${result.area?.label || areaKey}: ${result.verifiedCount || 0} verified, ${result.unknownCount || 0} unverified configured reward(s).`
              : null,
          });
        } catch (error) {
          areaResults.push({ candidates: [], errors: [{ areaKey, message: `${areaKey}: ${error.message}` }], logMessage: null });
        }
      }
      const candidates = areaResults.flatMap(result => result.candidates);
      const errors = areaResults.flatMap(result => result.errors);
      for (const result of areaResults) {
        if (result.logMessage) this.log('INFO', result.logMessage);
      }
      // Configuration, Pause/Start, or a locked claim batch can supersede a
      // long read. Never let that stale result replace the current authority.
      if (scanGeneration !== this.progressionLootScanGeneration || this.progressionLootBatchActive) {
        return this.progressionLootSnapshot;
      }
      this._commitProgressionLootSnapshot({ candidates, errors, refreshedAt: Date.now() });
      if (errors.length > 0 && (force || candidates.length === 0)) {
        this.log('WARN', `Progression loot scan source error${errors.length === 1 ? '' : 's'}: ${errors.map(error => error.message).join('; ')}`);
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
    if (this.config.progression?.useLootForLeveling !== true) {
      throw new Error('Enable Use loot for leveling before scanning');
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
    return {
      ...telemetry.progression,
      availableLoot: this._progressionLootView(this.progressionLootSnapshot),
    };
  }

  _progressionLootView(snapshot = this.progressionLootSnapshot) {
    const candidates = Array.isArray(snapshot?.candidates) ? snapshot.candidates : [];
    const errors = Array.isArray(snapshot?.errors) ? snapshot.errors : [];
    return {
      revision: this.progressionLootRevision,
      refreshedAt: snapshot?.refreshedAt || null,
      errors,
      entries: candidates.map(candidate => {
        const history = this._historyEntry(candidate);
        return {
          areaKey: candidate.areaKey || '',
          areaName: candidate.dungeonName || candidate.areaName || candidate.areaKey || '',
          monsterKey: candidate.monsterKey || '',
          monsterName: candidate.name || 'Unknown monster',
          monsterId: history.monsterId,
          instanceId: history.instanceId,
          pageUrl: history.pageUrl,
          stackSize: Math.max(1, Number(candidate.stackSize) || 1),
          userDamage: Number.isFinite(Number(candidate.userDamage)) ? Number(candidate.userDamage) : null,
          expPerDamage: Number.isFinite(Number(candidate.expPerDamage)) ? Number(candidate.expPerDamage) : null,
          verified: candidate.verified === true,
          verificationError: candidate.verificationError || null,
        };
      }),
    };
  }

  async refreshAvailableProgressionLoot() {
    return this._progressionLootView(this.progressionLootSnapshot);
  }

  async claimDiscoveredLoot(areaKey, candidateKey) {
    if (!this.lootDiscoveryService) return { success: false, message: 'Loot discovery is unavailable' };
    if (this.config.safety?.dryRun === true) {
      return { success: false, message: 'Dry Run blocks manual loot claims' };
    }
    let pausedBot = false;
    if (this.isRunning && !this.isPaused) {
      // The explicit Loot button is a one-shot mutation. Pause the normal
      // loop so it cannot select or claim a different candidate concurrently.
      // Never cancel an already-issued POST: its outcome must be reconciled
      // before any second mutation is allowed.
      if (this.pendingMutation) {
        return {
          success: false,
          message: 'Wait for the current bot action to finish, then press Loot again',
        };
      }
      pausedBot = await this.pauseAndWait();
    }
    const snapshot = await this.lootDiscoveryService.scan(areaKey, {
      force: true,
      directoryPriority: ReadPriority.MUTATION_REVALIDATION,
      directoryMaxAgeMs: 0,
      forceDirectory: true,
    });
    const claim = (snapshot?.candidates || [])
      .find(candidate => this._progressionLootCandidateKey(candidate) === candidateKey);
    if (!claim) return { success: false, message: 'This monster is no longer lootable' };

    const result = await this.gameController.claimLoot(claim.battleRef, this.config.scheduler.attackIntervals);
    this._recordAction(result);
    if (!result.success) return result;

    this.stats.lootCollected += Math.max(1, Number(claim.stackSize) || 1);
    this._invalidateLootCandidates?.(claim, 'manual loot claimed');
    this._applyRecordedLootConfig(this.lootLimitLedger.recordLooted(claim, claim.stackSize));
    this._recordActivity('loot', claim, {
      stackSize: claim.stackSize,
      xp: result.rewards?.exp,
      gold: result.rewards?.gold,
      itemsCount: result.items?.length,
      items: result.items,
      result: result.message || 'Manual loot collected',
    });
    // The mutation is confirmed above. Follow-up reads are best-effort so a
    // stale Stats or discovery page cannot make a successful claim look like
    // a failed claim and tempt the user to retry it.
    let refreshed = null;
    const warnings = [];
    try {
      await this.refreshStats();
    } catch (error) {
      warnings.push(`Stats refresh failed: ${error.message}`);
    }
    try {
      refreshed = await this.lootDiscoveryService.progressionCandidates(areaKey, null, {
        force: true,
        directoryPriority: ReadPriority.ACTIVE_MODULE,
        directoryMaxAgeMs: 5000,
      });
    } catch (error) {
      warnings.push(`Loot list refresh failed: ${error.message}`);
    }
    return {
      ...result,
      snapshot: refreshed,
      warning: warnings.length > 0 ? warnings.join('; ') : null,
      pausedBot,
    };
  }

  async _wait(reason, signal) {
    this._transition(BotState.IDLE, reason);
    if (this.config.general?.module === 'pvp') return this.timingEngine.sleepRandom(this.soloPvpService?.getStatus()?.phase === 'battle' ? 900 : 30000, this.soloPvpService?.getStatus()?.phase === 'battle' ? 1100 : 45000, signal);
    return this.timingEngine.sleepRandom(5000, 15000, signal);
  }

  async _executeSoloPvp(action, params, context = {}) {
    if (!this.soloPvpService) throw new Error('Solo PvP service is unavailable');
    const result = await this.soloPvpService.execute(action, params, this.config.soloPvp, context);
    this.lastResult = result;
    if (result.denied) this.log('WARN', result.message);
    return result;
  }

  _phaseInstanceKey(areaKey, monsterId) {
    return `${String(areaKey || '')}:${String(monsterId || '')}`;
  }

  _targetProgressDamage(target = this.currentTarget, battle = this.battleManager.getCurrentBattle()) {
    return targetProgressDamage(target, battle);
  }

  _phaseDuelProbeCandidates(areaKey, monsters = []) {
    const configured = this.config.monsters?.maps?.[areaKey] || {};
    const typeCounts = new Map();
    for (const monster of monsters) {
      const key = monsterTypeKey(monster?.name);
      if (key && monster?.dead !== true && Number(monster?.hp) > 0) {
        typeCounts.set(key, (typeCounts.get(key) || 0) + 1);
      }
    }
    return monsters.flatMap(monster => {
      const monsterKey = monsterTypeKey(monster?.name);
      const settings = configured[monsterKey];
      const id = String(monster?.id || monster?.battleId || monster?.dgmid || '');
      if (!settings?.enabled || !/^\d{1,30}$/.test(id)) return [];
      if ((settings.completedInstanceIds || []).map(String).includes(id)) return [];
      if (monster?.joined !== true || monster?.dead === true || Number(monster?.hp) <= 0) return [];
      if (monster?.attackable === false || monster?.capNotReached === false) return [];
      if (Number(monster?.expire) > 0 && Number(monster.expire) <= Math.floor(Date.now() / 1000)) return [];
      if (settings.unlimited !== true && Number(settings.completedCount) >= Number(settings.killCount)) return [];
      if (Number(settings.targetDamage) <= 0 || Number(monster?.userDmg) < Number(settings.targetDamage)) return [];
      if (Number(monster?.hp) < Number(settings.minimumHp || 0)) return [];
      // The current Wave is enough to identify a bounded probe candidate even
      // when all historical monster data was purged: phase bosses are a
      // singleton live type, already joined, whose old-stage contribution has
      // reached the configured target. The battle page still has to prove the
      // phase before this candidate can bypass ordinary completion filtering.
      if (typeCounts.get(monsterKey) !== 1 && monster?.boss !== true && !monster?.phase) return [];
      return [{ ...monster, id, monsterKey, targetSettings: { ...settings } }];
    }).sort((left, right) =>
      (Number(left.targetSettings.priority) || 0) - (Number(right.targetSettings.priority) || 0)
      || left.name.localeCompare(right.name));
  }

  async _probePhaseDuelTarget(areaKey, monsters, signal = null) {
    const now = Date.now();
    for (const [key, entry] of this.phaseDuelProbeCache) {
      if (Number(entry?.expiresAt) <= now) this.phaseDuelProbeCache.delete(key);
    }
    // Four probes is an intentionally small ceiling. In normal waves the
    // singleton condition reduces this to one boss request, while the cache
    // prevents a completed ordinary boss from being fetched every scan.
    for (const candidate of this._phaseDuelProbeCandidates(areaKey, monsters).slice(0, 4)) {
      if (signal?.aborted) {
        const error = new Error('cancelled');
        error.name = 'AbortError';
        throw error;
      }
      const instanceKey = this._phaseInstanceKey(areaKey, candidate.id);
      const hasKnownBaseline = this.phaseDamageBaselines.has(instanceKey);
      const knownBaseline = this.phaseDamageBaselines.get(instanceKey);
      const cached = this.phaseDuelProbeCache.get(instanceKey);
      if (cached?.expiresAt > now && !hasKnownBaseline) continue;
      let battle;
      try {
        battle = await this.gameAPI.getBattleConfig(candidate.battleRef || candidate.battleId || candidate.id);
      } catch (error) {
        this.phaseDuelProbeCache.set(instanceKey, { expiresAt: now + 15_000, error: error.message });
        continue;
      }
      if (!battle?.phaseDuel && !hasKnownBaseline) {
        this.phaseDuelProbeCache.set(instanceKey, { expiresAt: now + 60_000, verified: false });
        continue;
      }
      const baseline = battle?.phaseDamage != null
        ? Math.max(0,(Number(battle.userDamage ?? candidate.userDmg)||0)-Number(battle.phaseDamage))
        : hasKnownBaseline && Number.isFinite(Number(knownBaseline)) ? Number(knownBaseline) : Math.max(0,Number(battle?.userDamage ?? candidate.userDmg)||0);
      this.phaseDamageBaselines.set(instanceKey, baseline);
      this.phaseDuelProbeCache.delete(instanceKey);
      this.monsterCatalogService?.markPhaseDuel?.(areaKey, candidate.id, 3);
      this.targetDiscoveryService?.invalidate?.(areaKey, 'verified monster phase duel');
      this.log('INFO', `Verified Phase 3 PvP for ${candidate.name}; new-phase damage starts after ${baseline.toLocaleString()} prior damage.`);
      return {
        ...candidate,
        phase: 3,
        boss: false,
        bossEvidence: null,
        phaseDamageBaseline: baseline,
        phaseBattle: battle,
      };
    }
    return null;
  }

  async _scan({
    kind = 'gate', gateId, eventId, wave, areaKey, ignoreInstanceId = null, fallback = null,
    preferredMonsterKey = null, objective = null, replaceCurrent = false,
    monstersOverride = null, targetNamespace = null,
  }, signal) {
    if (kind === 'boss_hunt') return this._scanBossHunt(signal);
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
    if (Array.isArray(monstersOverride)) {
      monsters = monstersOverride;
    } else if (this.targetDiscoveryService) {
      try {
        monsters = await this.targetDiscoveryService.listCombatMonsters(areaKey, { signal });
      } catch (error) {
        if (error?.code === 'READ_ABORTED' || error?.name === 'AbortError') throw error;
        if (!isDungeon || !fallback) throw error;
        this.log('INFO', `Dungeon ${areaKey} is not currently available (${error.message}); using configured Gate fallback.`);
        return this._scan(fallback, signal);
      }
      monsters = monsters.filter(monster => !this.ignoredTargetIds.has(String(
        monster.id || monster.battleId || monster.dgmid || monster.battleRef?.dgmid || '',
      )));
    } else if (isDungeon) {
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
    const configuredTargets = targetNamespace === 'boss_hunt'
      ? this.config.bossHunt?.targets?.[areaKey] || {}
      : null;
    let target = this.targetLedger.selectTarget(areaKey, monsters, undefined, {
      preferredMonsterKey,
      preferredTargets: objective?.targets || null,
      targetDamage: objective?.targetDamage > 0
        ? Number(objective.targetDamage)
        : (objective ? Number.MAX_SAFE_INTEGER : undefined),
      configuredTargets,
      targetKeyResolver: targetNamespace === 'boss_hunt' ? bossTargetKey : null,
    });
    if (!target && !objective && targetNamespace !== 'boss_hunt') {
      target = await this._probePhaseDuelTarget(areaKey, monsters, signal);
    }
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
      const targetScanDelay = Math.max(1, Number(this.config.scheduler?.targetScanIntervalSeconds) || 1) * 1000;
      await this.timingEngine.sleepRandom(targetScanDelay, Math.ceil(targetScanDelay * 1.15), signal);
      return this.lastResult;
    }

    this.currentTarget = {
      id: target.id,
      name: target.name,
      hp: target.hp,
      maxHp: target.maxHp,
      userDmg: target.userDmg || 0,
      areaKey,
      monsterKey: target.catalogMonsterKey || target.monsterKey,
      configKey: target.monsterKey,
      policyNamespace: targetNamespace,
      targetDamage: target.targetSettings.targetDamage,
      minimumHp: target.targetSettings.minimumHp,
      priority: target.targetSettings.priority,
      staminaPotion: target.targetSettings.staminaPotion,
      allowAbilities: target.targetSettings.allowAbilities === true,
      gearSet: target.targetSettings.gearSet || 'default',
      petSet: target.targetSettings.petSet || 'default',
      objective: objective ? { ...objective } : null,
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
      boss: target.boss === true,
      phase: Number(target.phase) || null,
      phaseDamageBaseline: target.phaseDamageBaseline != null && Number.isFinite(Number(target.phaseDamageBaseline))
        ? Number(target.phaseDamageBaseline)
        : null,
    };
    const battle = target.phaseBattle && typeof this.battleManager.adoptBattle === 'function'
      ? this.battleManager.adoptBattle(target.phaseBattle)
      : await this.battleManager.loadBattle(isDungeon ? target.battleRef : (target.battleId || target.id));
    if (battle.phaseDuel || this.currentTarget.phase === 3) {
      const instanceKey = this._phaseInstanceKey(areaKey, target.id);
      const baseline = battle.phaseDamage != null
        ? Math.max(0,(Number(battle.userDamage ?? target.userDmg)||0)-Number(battle.phaseDamage))
        : this.phaseDamageBaselines.has(instanceKey) ? Number(this.phaseDamageBaselines.get(instanceKey)) : Math.max(0,Number(battle.userDamage ?? target.userDmg)||0);
      this.phaseDamageBaselines.set(instanceKey, baseline);
      Object.assign(this.currentTarget, {
        phase: 3,
        boss: false,
        phaseDamageBaseline: baseline,
      });
      this.monsterCatalogService?.markPhaseDuel?.(areaKey, target.id, 3);
      this.targetDiscoveryService?.invalidate?.(areaKey, 'verified monster phase duel');
    }
    if (battle.monsterStats) this.currentTarget.monsterStats = battle.monsterStats;
    battle.isJoined = target.joined || battle.isJoined;
    battle.userDamage = Math.max(Number(battle.userDamage || 0), Number(target.userDmg || 0));
    await Promise.all([this._prepareCombatContext(), this._prepareClassSkills()]);
    this._transition(battle.isJoined ? BotState.ATTACKING : BotState.JOINING_BATTLE, target.name);
    this.lastResult = { success: true, target: this.currentTarget };
    return this.lastResult;
  }

  async _scanBossHunt(signal) {
    const areas = configuredBossAreas(this.config);
    this._transition(BotState.SCANNING_GATES, 'Discovering configured bosses across Gates and Events');
    if (areas.length === 0) {
      this.battleManager.clear();
      this.currentTarget = null;
      this.currentCombatContext = null;
      await this._wait('No enabled Boss Hunt targets are configured', signal);
      return {success:true,eligibleTargets:0};
    }
    const maxAgeMs = Math.max(
      15_000,
      Math.max(1, Number(this.config.scheduler?.targetScanIntervalSeconds) || 1) * 1000,
    );
    const settled = await Promise.all(areas.map(async area => {
      try {
        const monsters = await this.targetDiscoveryService.listCombatMonsters(area.key, {
          maxAgeMs,
          signal,
        });
        return {
          areaKey: area.key,
          monsters: monsters.filter(monster => !this.ignoredTargetIds.has(String(
            monster.id || monster.battleId || monster.dgmid || monster.battleRef?.dgmid || '',
          ))),
        };
      } catch (error) {
        if (error?.code === 'READ_ABORTED' || error?.name === 'AbortError') throw error;
        this.log('INFO', `Boss Hunt skipped ${area.label}: ${error.message}`);
        return { areaKey: area.key, monsters: [], failed: true };
      }
    }));
    const target = this.targetLedger.selectBossTarget(settled);
    if (!target) {
      this.battleManager.clear();
      this.currentTarget = null;
      this.currentCombatContext = null;
      this._transition(BotState.IDLE, 'No configured boss is currently active and eligible');
      const delay = Math.max(1, Number(this.config.scheduler?.targetScanIntervalSeconds) || 1) * 1000;
      await this.timingEngine.sleepRandom(delay, Math.ceil(delay * 1.15), signal);
      return { success: true, areasScanned: areas.length, eligibleTargets: settled.some(area=>area.failed) ? null : 0 };
    }
    const route = this.moduleRegistry.resolveArea(target.areaKey);
    if (!route) return this._wait(`Boss Hunt area ${target.areaKey} is unavailable`, signal);
    const snapshot = settled.find(entry => entry.areaKey === target.areaKey);
    return this._scan({
      ...route,
      areaKey: target.areaKey,
      monstersOverride: snapshot?.monsters || [],
      preferredMonsterKey: target.monsterKey,
      targetNamespace: 'boss_hunt',
    }, signal);
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

  async applyConfiguredPveLoadouts(signal) {
    const requested = [
      { kind: 'gear', selection: this.config.equipment?.gear?.pve },
      { kind: 'pets', selection: this.config.equipment?.pets?.pve },
    ].filter(({ selection }) => /^quick_set_(?:[1-9]|10)$/.test(String(selection || '')));
    const results = [];
    for (const params of requested) {
      const decision = {
        action: 'APPLY_LOADOUT',
        reason: `Apply configured PvE ${params.kind} set`,
        params: { ...params, forceVerify: true },
      };
      let result;
      try {
        result = await this.actionExecutor.execute(decision, {
          decision,
          signal,
          dryRun: this.config.safety.dryRun,
        });
      } catch (error) {
        if (!this._isAmbiguousMutationError(error)) throw error;
        const reconciliation = await this._reconcileAmbiguousMutation({
          action: decision.action,
          params: decision.params,
          before: {},
        }, signal);
        if (!reconciliation.confirmed) {
          error.message = `${error.message}; Quick Set result could not be confirmed (${reconciliation.detail})`;
          throw error;
        }
        result = { success: true, reconciled: true, message: reconciliation.detail };
      }
      results.push({ ...params, ...(result || {}) });
    }
    return {
      success: true,
      requested: requested.length,
      applied: results.filter(result => result.success === true && result.skipped !== true).length,
      skipped: results.filter(result => result.skipped === true).length,
      dryRun: results.filter(result => result.dryRun === true).length,
      results,
    };
  }

  async _routePowerCrystals(kind, selection, signal) {
    return loadoutCoordinatorFor(this).routeCrystals(kind, selection, signal);
  }

  async _applyLoadout(params, signal) {
    return loadoutCoordinatorFor(this).apply(params, signal);
  }

  async _attack(skill, signal) {
    if (this.config.general?.module !== 'auto_farm' && this.autoFarmService && this.autoFarmPveCleared !== true) {
      const pauseResult = await this.autoFarmService.ensurePausedForPve(this.config.autoFarm || {}, { signal });
      if (pauseResult?.state?.enabled !== true) {
        this.autoFarmServerEnabled = false;
        this.autoFarmPveCleared = true;
      }
    }
    this._transition(BotState.ATTACKING, this.currentTarget?.name || 'monster');
    const context = this.currentCombatContext;
    const playerStateBefore = stateStore.getState();
    const playerHpBefore = this.battleManager.getCurrentBattle()?.playerHp;
    const result = await this.battleManager.attackOnce(skill, this.config.scheduler.attackIntervals, signal);
    this._recordAction(result);
    if (!result.success && /entered a PvP duel phase/i.test(String(result.message || ''))) {
      const refreshed = await this.battleManager.refresh();
      if (refreshed?.phaseDuel) {
        this.log('INFO', `Monster phase PvP detected for active battle ${refreshed.phaseDuel.activeId}.`);
        return { ...result, recovered: true, phaseDuelRequired: true };
      }
      const error = new Error('Monster entered a PvP duel phase, but its verified duel link could not be read');
      error.code = 'MONSTER_PHASE_DUEL_UNRESOLVED';
      throw error;
    }
    if (!result.success && isAutoFarmAttackLockMessage(result.message)) {
      this.autoFarmServerEnabled = true;
      this.log('WARN', 'The server rejected a PvE attack because Auto Farm is running; pausing and revalidating it before combat continues.');
      const reconciled = await this.autoFarmService?.reconcileAttackLock(this.config.autoFarm || {});
      if (!reconciled) {
        const error = new Error('Normal PvE is waiting because server Auto Farm is still active');
        error.code = 'AUTO_FARM_ACTIVE';
        throw error;
      }
      this.autoFarmServerEnabled = false;
      this.autoFarmPveCleared = true;
      return { ...result, recovered: true, retryAllowed: true };
    }
    const fightState = this._ensureAbilityTurnState(this.battleManager.getCurrentBattle());
    if (skill?.supportAbility === true && /couldn['’]t pierce the monster['’]s divine shield\.\s*No stamina spent\./i.test(result.message || '')) {
      const role = skill.abilityRole || this.config.combat?.abilityPolicies?.[String(skill.id)]?.role;
      if (['buff', 'debuff'].includes(role)) fightState.blockedSupportRoles[role] = true;
      this.log('INFO', `${skill.name || 'Support ability'} blocked by divine shield; ${role || 'support'} disabled for this fight. No resources spent.`);
      this.lastResult = { ...result, success: true, skipped: true, noResourcesSpent: true };
      return this.lastResult;
    }
    if (skill?.supportAbility !== true) this.stats.attacks++;
    if (result.success) {
      if (skill?.supportAbility !== true) {
        fightState.artemisMarkTurns = Math.max(0, (Number(fightState.artemisMarkTurns) || 0) - 1);
        const ownLog = (result.logs || []).find(entry => String(entry?.USERNAME || '').trim() === String(this.accountName || '').trim());
        const mark = [result.message || '', ownLog?.EXTRA_INFO || ''].join(' ').match(/Artemis marked you for (\d+) turns?/i);
        if (mark) fightState.artemisMarkTurns = Math.min(100, Number(mark[1]));
        if (this.config.combat?.attackStrategy?.avoidArtemisCurse === true && fightState.artemisMarkTurns > 0) {
          this.log('INFO', `Artemis mark active: ${fightState.artemisMarkTurns} turn(s); using the configured curse hit.`);
        }
      }
      if (skill?.kind === 'class-ability') {
        const abilityId = String(skill.id);
        this.abilityTurnState.usedAtTurn[abilityId] = this.abilityTurnState.attackTurn;
        this.abilityTurnState.useCounts[abilityId] = (Number(this.abilityTurnState.useCounts[abilityId]) || 0) + 1;
      }
      if (skill?.supportAbility !== true) {
        this.abilityTurnState.attackTurn += 1;
      }
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
      const falseSupportStamina = skill?.supportAbility === true
        && Number(result.stamina) === 0
        && Number(playerStateBefore.stamina?.current ?? playerStateBefore.stamina) > 0;
      if (result.stamina !== null && result.stamina !== undefined && !falseSupportStamina) {
        updates.stamina = { current: result.stamina, max: stateStore.getState().stamina.max };
      }
      if (result.retaliation?.user_hp_after !== undefined) {
        const nextHp = Number(result.retaliation.user_hp_after);
        const retaliationDamage = Number(result.retaliation?.damage);
        const hpBefore = Number(playerHpBefore ?? playerStateBefore.hp?.current);
        const falseSupportZero = skill?.supportAbility === true && nextHp === 0 && hpBefore > 0
          && !(Number.isFinite(retaliationDamage) && retaliationDamage > 0);
        if (!falseSupportZero) {
          updates.hp = {
            current: result.retaliation.user_hp_after,
            max: this.battleManager.getCurrentBattle()?.playerMaxHp || stateStore.getState().hp.max,
          };
          if (skill?.supportAbility !== true && hpBefore > 0 && nextHp <= 0) {
            this.stats.deaths = Math.max(0, Number(this.stats.deaths) || 0) + 1;
            this.log('WARN', `Player death recorded (${this.stats.deaths}${Number(this.config.resources?.health?.maxDeaths) > 0 ? `/${this.config.resources.health.maxDeaths}` : '/∞'}).`);
          }
        }
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
      this._observeStats(updates, 'verified damage.php action response');
      const battle = this.battleManager.getCurrentBattle();
      if (this.currentTarget) {
        if (result.hp) this.currentTarget.hp = result.hp.value;
        if (battle?.userDamage !== undefined) this.currentTarget.userDmg = battle.userDamage;
      }
      const progressDamage = this._targetProgressDamage(this.currentTarget, battle);
      const targetReached = this.currentTarget?.targetDamage > 0 &&
        progressDamage >= this.currentTarget.targetDamage;
      const completedTarget = targetReached ? this._recordCompletedTargetInstance() : false;
      if (skill?.supportAbility !== true) {
        const serverStamina = Number(result.stamina);
        const beforeStamina = Number(playerStateBefore.stamina?.current ?? playerStateBefore.stamina);
        const staminaSpent = Number.isFinite(serverStamina) && Number.isFinite(beforeStamina)
          ? Math.max(0, beforeStamina - serverStamina)
          : Math.max(0, Number(skill?.stamCost) || 0);
        this._recordActivity?.('target', this.currentTarget, {
          damage: result.damage,
          totalDamage: progressDamage,
          staminaSpent,
          targetDamage: this.currentTarget?.targetDamage,
          completed: completedTarget,
          actionName: skill?.name || (skill?.multiplier ? `x${skill.multiplier}` : 'Attack'),
          result: result.message || 'Attack succeeded',
        });
      }
      if (battle?.isDead) {
        this.stats.monstersKilled++;
        this._transition(BotState.WAITING_LOOT, 'Monster defeated');
      } else if (targetReached) {
        const completedName = this.currentTarget?.name || 'Monster';
        if (this.currentTarget?.objective && this.currentTarget.id) {
          this.ignoredTargetIds.add(String(this.currentTarget.id));
        }
        this.battleManager.clear();
        this.currentTarget = null;
        this.currentCombatContext = null;
        this._transition(BotState.IDLE, `${completedName} target damage reached`);
      }
      if (Number.isFinite(xpDelta) && xpDelta > 0
        && Number.isFinite(Number(playerStateBefore.expRequired))
        && Number(playerStateBefore.expCurrent) + xpDelta >= Number(playerStateBefore.expRequired)) {
        await this.refreshStats();
        // The loadout hash is still valid, but the player level/Stats portion
        // of the damage-learning context changed after the level-up.
        this.currentCombatContext = null;
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
      this._invalidateLootCandidates?.(this.currentTarget, 'battle loot claimed');
      this._applyRecordedLootConfig(this.lootLimitLedger.recordLooted(this.currentTarget, 1));
      this._recordActivity?.('loot', this.currentTarget, {
        stackSize: 1,
        xp: result.rewards?.exp,
        gold: result.rewards?.gold,
        itemsCount: result.items?.length,
        items: result.items,
        result: result.message || 'Loot collected',
      });
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
    this._handoffToProgressionLoot(claim);
    this._transition(BotState.LOOTING, claim?.name || 'Progression loot');
    const result = await this.gameController.claimLoot(
      claim.battleRef,
      this.config.scheduler.attackIntervals,
      signal,
    );
    this._recordAction(result);
    if (!result.success) {
      if (this._isUnavailableProgressionClaim(result)) {
        this._invalidateLootCandidates?.(claim, 'Progression loot is no longer available');
        this._removeProgressionClaim(claim);
        this.log('WARN', `Progression skipped unavailable loot ${claim?.name || claim?.id || ''}: ${result.message}`);
        this._transition(BotState.IDLE, 'Unavailable Progression loot removed from the locked queue');
        return { ...result, success: true, skipped: true };
      }
      throw new Error(result.message || 'Progression loot claim failed');
    }
    if (!this.isRunning || signal?.aborted) {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    }
    this.stats.lootCollected += Math.max(1, Number(claim.stackSize) || 1);
    this._invalidateLootCandidates?.(claim, 'Progression loot claimed');
    this._applyRecordedLootConfig(this.lootLimitLedger.recordLooted(claim, claim.stackSize));
    this._recordActivity?.('loot', claim, {
      stackSize: claim.stackSize,
      xp: result.rewards?.exp,
      gold: result.rewards?.gold,
      itemsCount: result.items?.length,
      items: result.items,
      result: result.message || 'Progression loot collected',
    });
    this.battleManager.clear();
    this.currentTarget = null;
    this.currentCombatContext = null;
    this._removeProgressionClaim(claim);
    await this.refreshStats();
    const refreshedLevel = Number(stateStore.getState().level);
    if (this.progressionLootBatchActive
      && Number.isFinite(this.progressionLootBatchStartLevel)
      && Number.isFinite(refreshedLevel)
      && refreshedLevel > this.progressionLootBatchStartLevel) {
      this.log('INFO', `Progression reached level ${refreshedLevel}; releasing the remaining locked loot instead of consuming another level.`);
      this._releaseProgressionLootBatch();
      // Do not leave the remaining candidates available for the next loop.
      // A fresh discovery pass must prove that another level is intended.
      this._resetProgressionLootSnapshot();
    }
    if (!this.isRunning || signal?.aborted) {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      throw error;
    }
    this._transition(BotState.IDLE, 'Progression loot claimed and XP refreshed');
    return result;
  }

  _handoffToProgressionLoot(claim) {
    // The outer engine loop is serialized, so reaching this method means the
    // previous combat action has already settled. Progression owns a different
    // context: clear the loaded battle before moving through IDLE instead of
    // weakening the FSM with a direct ATTACKING -> LOOTING transition.
    this.battleManager.clear();
    this.currentTarget = null;
    this.currentCombatContext = null;
    if (!this.fsm.is(BotState.IDLE) && !this.fsm.is(BotState.LOOTING)) {
      this._transition(BotState.IDLE, `Handing combat control to Progression for ${claim?.name || 'verified loot'}`);
    }
  }

  _isUnavailableProgressionClaim(result) {
    return /already\s+(?:claimed|looted)|monster\s+not\s+found|invalid\s+monster|no\s+loot\s+(?:available|remaining)|not\s+eligible/i
      .test(String(result?.message || ''));
  }

  _progressionLootCandidateKey(candidate) {
    const areaKey = String(candidate?.areaKey || '');
    const battleRef = candidate?.battleRef;
    if (battleRef && typeof battleRef === 'object' && (battleRef.isDungeon || battleRef.instanceId)) {
      return `${areaKey}:dungeon:${String(battleRef.instanceId || candidate?.instanceId || '')}:${String(battleRef.dgmid || candidate?.dgmid || candidate?.id || '')}`;
    }
    const id = candidate?.id || candidate?.battleId || battleRef || '';
    return `${areaKey}:gate:${String(id)}`;
  }

  _invalidateLootCandidates(candidate, reason = 'confirmed loot mutation') {
    const areaKey = String(candidate?.areaKey || '').trim();
    if (!areaKey || typeof this.lootDiscoveryService?.invalidate !== 'function') return false;
    try {
      return this.lootDiscoveryService.invalidate(areaKey, reason);
    } catch (error) {
      this.log('WARN', `Loot observation invalidation failed for ${areaKey}: ${error.message}`);
      return false;
    }
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
    this.progressionLootRevision += 1;
    this.progressionLootBatchActive = this.progressionLootSnapshot.candidates.length > 0;
    if (!this.progressionLootBatchActive) this._releaseProgressionLootBatch();
  }

  _releaseProgressionLootBatch() {
    this.progressionLootBatchActive = false;
    this.progressionLootBatchConfig = null;
    this.progressionLootBatchStartLevel = null;
    if (!this.progressionLootRefreshPending) return;
    this.progressionLootRefreshPending = false;
    this._resetProgressionLootSnapshot();
  }

  async _heal(mode, signal) {
    this._transition(BotState.HEALING, `Healing mode: ${mode}`);
    const battle = this.battleManager.getCurrentBattle();
    const heal = healingMode => battle
      ? this.battleManager.healCurrent(healingMode, signal, this.config.scheduler.attackIntervals)
      : this.gameController.heal(null, healingMode, signal, { delay: this.config.scheduler.attackIntervals });
    let result = null;
    let healingMethod = 'free';
    const potionPolicy = this.resourcePolicyEngine?.canUseHealthPotion(this.stats.healthPotionsUsed);
    if (mode === 'potion_first' && potionPolicy?.allowed) {
      result = await heal('potion_only');
      healingMethod = 'potion';
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
      healingMethod = 'free';
    }
    this._recordAction(result);
    if (!result.success) throw new Error(result.message || 'Healing failed');
    this._recordEvent?.('healing', { method: healingMethod, message: result.message || 'Healing succeeded' });
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
    if (result.gold !== null && result.gold !== undefined) {
      this._observeStats({ gold: String(result.gold) }, 'verified potion purchase response');
    }
    const resource = this.config.resources[type];
    this.updateConfig({ resources: { [type]: { purchasedCount: (resource.purchasedCount || 0) + 1 } } });
    this._recordEvent?.('potion_purchase', { resource: type, quantity: 1, gold: result.gold });
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
    this._recordEvent?.('potion_use', { resource: 'stamina', potionType: type, quantity: 1 });
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

  async _useManaPotion({ type, inventoryId, quantity = 1, buyIfMissing = false }, signal) {
    const used = Number(this.stats.manaPotionsUsed?.[type]) || 0;
    const policy = this.resourcePolicyEngine?.canUseManaPotion(type, used);
    if (!policy?.allowed) return { success: false, message: policy?.reason || 'Mana potion use is not allowed' };

    const battleBefore = this.battleManager.getCurrentBattle?.() || null;
    const storedBefore = stateStore.getState();
    const manaBefore = Number(battleBefore?.playerMana ?? storedBefore.mp?.current);
    const maxManaBefore = Number(battleBefore?.playerMaxMana ?? storedBefore.mp?.max);
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

    const requestedQuantity = type === 'small'
      ? Math.max(1, Math.min(10, Math.trunc(Number(quantity) || 1), Number(policy.remaining) || 1))
      : 1;
    let result;
    try {
      result = await this.gameController.useManaPotion(normalizedInventoryId, requestedQuantity, signal);
    } catch (error) {
      this.failedManaPotionIds.add(normalizedInventoryId);
      throw error;
    }
    this._recordAction(result);
    if (!result.success) {
      this.failedManaPotionIds.add(normalizedInventoryId);
      return result;
    }
    const usedQuantity = Math.max(1, Number(result.usedQuantity) || requestedQuantity);
    this.stats.manaPotionsUsed[type] = used + usedQuantity;
    this._recordEvent?.('potion_use', { resource: 'mana', potionType: type, quantity: usedQuantity });
    let refreshedBattle = null;
    try {
      refreshedBattle = await this.battleManager.refresh();
    } catch (error) {
      this.log('WARN', `Mana potion succeeded, but the battle could not be refreshed: ${error.message}`);
    }
    // The refreshed battle and the verified use_item response are authoritative
    // for Mana. A general Stats read can retain the pre-potion value; allowing
    // that stale value to overwrite the battle made Buffs appear unaffordable
    // until an unrelated Stamina refresh reloaded combat resources.
    const refreshedMana = refreshedBattle?.playerMana;
    const refreshedMaxMana = refreshedBattle?.playerMaxMana;
    let currentMana = refreshedMana === null || refreshedMana === undefined ? NaN : Number(refreshedMana);
    let maximumMana = refreshedMaxMana === null || refreshedMaxMana === undefined ? NaN : Number(refreshedMaxMana);
    if (!Number.isFinite(currentMana)) {
      const restored = Number(result.manaRestored);
      if (Number.isFinite(manaBefore) && Number.isFinite(restored)) {
        currentMana = Number.isFinite(maxManaBefore) && maxManaBefore > 0
          ? Math.min(maxManaBefore, manaBefore + restored)
          : manaBefore + restored;
      }
    }
    if (!Number.isFinite(maximumMana) || maximumMana <= 0) maximumMana = maxManaBefore;
    if (Number.isFinite(currentMana)) {
      if (refreshedBattle) {
        refreshedBattle.playerMana = currentMana;
        if (Number.isFinite(maximumMana) && maximumMana > 0) refreshedBattle.playerMaxMana = maximumMana;
      }
      this._observeStats?.({
        mp: {
          current: currentMana,
          max: Number.isFinite(maximumMana) && maximumMana > 0 ? maximumMana : Math.max(0, currentMana),
        },
      }, 'verified Mana potion response/battle refresh');
    } else {
      this.log('WARN', 'Mana potion succeeded, but the refreshed battle did not expose current Mana.');
    }
    this._transition(BotState.ATTACKING, `${type} Mana potion consumed`);
    return result;
  }

  async _farm(params, signal) {
    if (this.config?.progression?.allowChapterFallback === false || this.config?.energyFarming?.enabled === false) {
      const result = { success: false, skipped: true, message: 'Automatic Chapter fallback is disabled' };
      this.lastResult = result;
      this._transition(BotState.IDLE, result.message);
      return result;
    }
    const sessionLimit = Math.max(1, Number(params?.maxPerSession || this.config.energyFarming?.maxPerSession) || 500);
    if ((this.stats.chaptersFarmed || 0) >= sessionLimit) {
      this.chapterFallbackBlockedUntil = Date.now() + 30000;
      const result = { success: false, skipped: true, message: 'Chapter fallback session limit reached' };
      this.lastResult = result;
      this._transition(BotState.IDLE, result.message);
      return result;
    }
    this._transition(BotState.FARMING_ENERGY, 'Stamina below configured threshold');
    const targets = this.getMangaTargets(this.accountName) || [];
    const target = targets
      .map(manga => ({ manga, nextChapter: nextUnfarmedChapter(manga) }))
      .filter(entry => entry.nextChapter)
      .sort((left, right) => (left.manga.farmedCount || 0) - (right.manga.farmedCount || 0))[0];
    if (!target) {
      this.chapterFallbackBlockedUntil = Date.now() + 30000;
      this.lastResult = { success: false, message: 'No unfarmed manga chapters are configured' };
      this._transition(BotState.IDLE, this.lastResult.message);
      return this.lastResult;
    }
    const manga = target.manga;
    const chapter = target.nextChapter.number;
    const result = await this.chapterFarmer.farmSingleChapter(
      this.accountName,
      manga.slug,
      chapter,
      params.reactionType,
      signal,
      { chapterUrl: target.nextChapter.url },
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
      this.chapterFallbackBlockedUntil = 0;
      this.stats.chaptersFarmed += 1;
      const staminaGained = Number.isFinite(Number(result.energy)) ? Math.max(0, Number(result.energy)) : 0;
      this.stats.energyFarmed += staminaGained;
      const stored = stateStore.getState();
      const current = stored.farmedEnergy || 0;
      const staminaCurrent = Math.max(0, Number(stored.stamina.current) || 0);
      const staminaMax = Math.max(staminaCurrent, Number(stored.stamina.max) || staminaCurrent);
      stateStore.update({ farmedEnergy: Math.min(1000, current + staminaGained) });
      this._observeStats({
        stamina: {
          current: Math.min(staminaMax, staminaCurrent + staminaGained),
          max: staminaMax,
        },
      }, 'confirmed chapter reaction reward');
      this.onChapterFarmed(this.accountName, manga.slug, {
        chapter,
        automatic: true,
        staminaGained,
        message: result.message || 'Chapter reaction accepted',
      });
      this._recordEvent?.('chapter_farm', {
        manga: manga.slug,
        chapter,
        staminaGained,
        reaction: result.reactionCode,
      });
      await this.gameReader.fetchFarmedEnergy(manga.slug, chapter, target.nextChapter.url);
    } else if (result.duplicate) {
      this.chapterFallbackBlockedUntil = 0;
      this.onChapterFarmed(this.accountName, manga.slug, {
        chapter,
        automatic: true,
        duplicate: true,
        message: result.message || 'Chapter was already processed',
      });
      this.log('WARN', 'Skipped a chapter already processed during this session.');
    } else {
      // A failed/empty chapter response must not suppress target-authorized
      // potions indefinitely.  Give the chapter endpoint a short cooldown,
      // then let the normal resource policy retry it on a later loop.
      this.chapterFallbackBlockedUntil = Date.now() + 30000;
    }
    this._transition(BotState.IDLE, result.success ? 'Chapter reaction completed' : result.message);
    return result;
  }

  _recordAction(result) {
    this.stats.actionsCount++;
    this.lastResult = result;
  }

  _recordPlayerDeath(hpBefore, hpAfter) {
    if (!Number.isFinite(hpBefore) || !Number.isFinite(hpAfter) || hpBefore <= 0 || hpAfter > 0) return false;
    this.stats.deaths = Math.max(0, Number(this.stats.deaths) || 0) + 1;
    const maxDeaths = Math.max(0, Math.trunc(Number(this.config.resources?.health?.maxDeaths) || 0));
    this.log('WARN', maxDeaths > 0
      ? `Player death recorded (${this.stats.deaths}/${maxDeaths} maximum).`
      : `Player death recorded (${this.stats.deaths}; no maximum configured).`);
    return true;
  }

  async _prepareCombatContext(force = false) {
    if (!this.currentTarget || !this.loadoutService || !this.damageObservationStore) {
      this.currentCombatContext = null;
      return null;
    }
    // Quick Set application and explicit invalidation clear both fields. While
    // they remain populated, the active battle already has a stable loadout
    // fingerprint and does not need another Gear/Pet page read every 30s.
    if (!force && this.currentCombatContext && this.currentLoadoutSnapshot) {
      return this.currentCombatContext;
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
    if (this.currentTarget?.objective) {
      const objective = this.currentObjectiveState?.scan?.objective;
      const allowedObjectiveTargets = new Set((this.currentObjectiveState?.scan?.preferredTargets || [])
        .map(target => String(target.monsterKey)));
      return Boolean(
        this._isObjectiveModule()
        && objective
        && objective.module === this.currentTarget.objective.module
        && this.currentObjectiveState.scan.areaKey === this.currentTarget.areaKey
        && (this.currentObjectiveState.scan.preferredMonsterKey === this.currentTarget.monsterKey
          || allowedObjectiveTargets.has(String(this.currentTarget.monsterKey)))
      );
    }
    return this.targetLedger.isAllowed(
      this.currentTarget,
      this.battleManager.getCurrentBattle(),
      this.config.general
    );
  }

  _recordCompletedTargetInstance() {
    const target = this.currentTarget;
    if (!target?.areaKey || !target?.monsterKey || !target.id) return false;
    if (target.objective) {
      if (target.objective.module === 'battle_pass' && target.id) {
        this.objectivePreparedLootKeys.add(this._progressionLootCandidateKey(target));
      }
      this.log('ACTION', `${target.name} objective damage reached (${Number(target.targetDamage).toLocaleString()}).`);
      return true;
    }
    const settings = this.targetLedger.getSettings(target);
    const completion = this.targetLedger.recordCompleted(target);
    if (!completion || completion.duplicate) return false;
    this.config = completion.config;
    this.strategy.updateConfig(this.config);
    this.lootLimitLedger.updateConfig(this.config);
    this.progressionEngine?.updateConfig(this.config);
    this.log('ACTION', `${target.name} target completed (${completion.completedCount}/${settings.unlimited === true ? '∞' : settings.killCount}).`);
    return true;
  }

  _enterChallenge(reason) {
    this.currentAction = 'WAIT';
    this.currentReason = reason;
    this._setRuntimeStatus('blocked', 'Manual challenge required', reason, 'challenge');
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

module.exports = {
  BotEngine,
  MUTATING_ACTIONS,
  isActiveDungeonCombat,
  shouldRefreshProgressionLoot,
};
