const { NORMAL_ATTACKS } = require('./attackPlanner');
const { LootRewardLedger } = require('./lootRewardLedger');
const { parseXpProgress } = require('./xpModel');

const ProgressionAction = Object.freeze({
  FOLLOW_BASE: 'FOLLOW_BASE',
  DRAIN_STAMINA: 'DRAIN_STAMINA',
  FARM_CHAPTER_TOP_OFF: 'FARM_CHAPTER_TOP_OFF',
  CLAIM_LOOT: 'CLAIM_LOOT',
});

function resolveLootXpBoost(state = {}, nowEpoch = Math.floor(Date.now() / 1000)) {
  const boost = state.lootXpBoost || {};
  const percent = Number(boost.percent);
  const endsAt = Number(boost.endsAt);
  const serverEpoch = Number(state.serverEpoch);
  const effectiveNow = Math.max(
    Number.isFinite(Number(nowEpoch)) ? Number(nowEpoch) : 0,
    Number.isFinite(serverEpoch) ? serverEpoch : 0,
  );
  const active = boost.recognized === true
    && Number.isFinite(percent)
    && percent > 0
    && Number.isFinite(endsAt)
    && endsAt > effectiveNow;
  return {
    active,
    percent: active ? percent : 0,
    multiplier: active ? 1 + (percent / 100) : 1,
    endsAt: active ? endsAt : null,
    name: active ? (boost.name || `XP Boost +${percent}%`) : null,
  };
}

class ProgressionEngine {
  constructor(config = {}, xpModel, lootLedger = new LootRewardLedger()) {
    this.xpModel = xpModel;
    this.lootLedger = lootLedger;
    this.updateConfig(config);
  }

  updateConfig(config = {}) {
    this.config = config;
  }

  evaluate({ accountName, state = {}, lootCandidates = [], chaptersAvailable = 0, configOverride = null } = {}) {
    const activeConfig = configOverride || this.config;
    const policy = activeConfig.progression || {};
    const chapterFallbackEnabled = policy.allowChapterFallback === true
      && activeConfig.energyFarming?.enabled === true;
    const potionFallbackEnabled = activeConfig.resources?.stamina?.allowPotions === true;
    const progress = parseXpProgress(state);
    const lootXpBoost = resolveLootXpBoost(state);
    const base = {
      action: ProgressionAction.FOLLOW_BASE,
      deferCurrentLoot: policy.useLootForLeveling === true,
      status: 'Monitoring',
      xpNeeded: progress.needed,
      eligibleLootXp: 0,
      eligibleLootCount: 0,
      claimCount: 0,
      unknownLootCount: 0,
      lootXpBoostActive: lootXpBoost.active,
      lootXpBoostPercent: lootXpBoost.percent,
      lootXpMultiplier: lootXpBoost.multiplier,
      lootXpBoostEndsAt: lootXpBoost.endsAt,
      staminaFlow: {
        current: 'waiting',
        steps: {
          looting: { enabled: policy.useLootForLeveling === true, available: false },
          chapters: { enabled: chapterFallbackEnabled, available: chapterFallbackEnabled && Number(chaptersAvailable) > 0 },
          // A missing target potion observation means combat has not loaded a
          // target/drawer yet, not that the global potion path is exhausted.
          potions: {
            enabled: potionFallbackEnabled,
            available: potionFallbackEnabled && (
              state.targetStaminaPotion == null || state.targetStaminaPotion.available === true
            ),
          },
          waiting: { enabled: true, available: true },
        },
      },
    };
    if (!progress.recognized) return { ...base, status: 'Waiting for XP data' };

    const ledger = this.lootLedger.build(
      lootCandidates,
      activeConfig.looting?.maps || {},
      state.level,
      { lootXpMultiplier: lootXpBoost.multiplier },
    );
    const claimPlan = this.lootLedger.planToLevel(ledger, progress.needed);
    const statusBase = {
      ...base,
      eligibleLootXp: ledger.eligibleXp,
      eligibleLootCount: ledger.eligible.length,
      claimCount: claimPlan.claims.length,
      unknownLootCount: ledger.excluded.filter(candidate => /cannot be verified|unavailable|markup/i.test(candidate.excludedReason || '')).length,
      staminaFlow: {
        ...base.staminaFlow,
        steps: {
          ...base.staminaFlow.steps,
          looting: { enabled: policy.useLootForLeveling === true, available: claimPlan.enough },
        },
      },
    };

    if (policy.useLootForLeveling === true && claimPlan.enough) {
      const imminent = this._imminentLevelPlan(accountName, state, chaptersAvailable, activeConfig);
      if ((Number(state.stamina) || 0) > 0) {
        if (chapterFallbackEnabled && imminent?.plan?.chapters > 0) {
          return {
            ...statusBase,
            staminaFlow: { ...statusBase.staminaFlow, current: 'chapters' },
            action: ProgressionAction.FARM_CHAPTER_TOP_OFF,
            chapters: imminent.plan.chapters,
            preferredStaminaCost: imminent.plan.staminaCost,
            status: `Top off ${imminent.plan.chapters} chapter${imminent.plan.chapters === 1 ? '' : 's'} before level`,
          };
        }
        return {
          ...statusBase,
          staminaFlow: { ...statusBase.staminaFlow, current: 'looting' },
          action: ProgressionAction.DRAIN_STAMINA,
          ignoreSoftStaminaRules: true,
          preferredStaminaCost: imminent?.plan?.chapters === 0 ? imminent.plan.staminaCost : null,
          status: 'Draining Stamina before loot',
        };
      }
      return {
        ...statusBase,
        staminaFlow: { ...statusBase.staminaFlow, current: 'looting' },
        action: ProgressionAction.CLAIM_LOOT,
        claim: claimPlan.claims[0],
        claims: claimPlan.claims,
        status: `Claiming ${claimPlan.claims.length} prioritized loot action${claimPlan.claims.length === 1 ? '' : 's'}`,
      };
    }

    if (chapterFallbackEnabled) {
      const imminent = this._imminentLevelPlan(accountName, state, chaptersAvailable, activeConfig);
      if (imminent?.plan?.chapters > 0) {
        return {
          ...statusBase,
          staminaFlow: { ...statusBase.staminaFlow, current: 'chapters' },
          action: ProgressionAction.FARM_CHAPTER_TOP_OFF,
          chapters: imminent.plan.chapters,
          preferredStaminaCost: imminent.plan.staminaCost,
          status: `Top off ${imminent.plan.chapters} chapter${imminent.plan.chapters === 1 ? '' : 's'} before natural level`,
        };
      }
    }
    const chapterFallbackAvailable = chapterFallbackEnabled
      && Number(chaptersAvailable) > 0;
    if (potionFallbackEnabled
      && !chapterFallbackAvailable
      && state.currentBattle
      && state.isJoined === true
      && state.monsterDead !== true
      && state.targetStaminaPotion?.available === true) {
      const drainBeforePots = policy.drainBeforePots !== false;
      return {
        ...statusBase,
        staminaFlow: { ...statusBase.staminaFlow, current: 'potions' },
        ignoreSoftStaminaRules: drainBeforePots,
        useTargetStaminaPotion: true,
        usePotionImmediately: !drainBeforePots,
        status: drainBeforePots && Number(state.stamina) > 0
          ? `Draining Stamina before ${state.targetStaminaPotion.name}`
          : `Using target-authorized ${state.targetStaminaPotion.name}`,
      };
    }
    return {
      ...statusBase,
      status: policy.useLootForLeveling === true ? 'Banking loot; not enough XP yet' : 'Following base Stamina policy',
    };
  }

  _imminentLevelPlan(accountName, state, chaptersAvailable, config = this.config) {
    if (!this.xpModel) return null;
    const strategy = config.combat?.attackStrategy || {};
    const configuredMaximum = strategy.mode === 'fixed'
      ? Number(strategy.fixedMultiplier) || 1
      : Number(strategy.maxMultiplier) || 1;
    const allowedStaminaCosts = NORMAL_ATTACKS
      .filter(attack => attack.multiplier <= configuredMaximum)
      .map(attack => attack.stamCost);
    return this.xpModel.planImminentLevel({
      accountName,
      state,
      allowedStaminaCosts,
      chaptersAvailable,
    });
  }
}

module.exports = { ProgressionEngine, ProgressionAction, resolveLootXpBoost };
