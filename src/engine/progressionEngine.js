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
    const progress = parseXpProgress(state);
    const lootXpBoost = resolveLootXpBoost(state);
    const base = {
      action: ProgressionAction.FOLLOW_BASE,
      deferCurrentLoot: policy.enabled === true && policy.useLootForLeveling === true,
      status: policy.enabled === true ? 'Monitoring' : 'Disabled',
      xpNeeded: progress.needed,
      eligibleLootXp: 0,
      eligibleLootCount: 0,
      claimCount: 0,
      unknownLootCount: 0,
      lootXpBoostActive: lootXpBoost.active,
      lootXpBoostPercent: lootXpBoost.percent,
      lootXpMultiplier: lootXpBoost.multiplier,
      lootXpBoostEndsAt: lootXpBoost.endsAt,
    };
    if (policy.enabled !== true) return base;
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
    };

    if (policy.useLootForLeveling === true && claimPlan.enough) {
      const imminent = this._imminentLevelPlan(accountName, state, chaptersAvailable, activeConfig);
      if ((Number(state.stamina) || 0) > 0) {
        if (policy.allowChapterFallback === true && imminent?.plan?.chapters > 0) {
          return {
            ...statusBase,
            action: ProgressionAction.FARM_CHAPTER_TOP_OFF,
            chapters: imminent.plan.chapters,
            preferredStaminaCost: imminent.plan.staminaCost,
            status: `Top off ${imminent.plan.chapters} chapter${imminent.plan.chapters === 1 ? '' : 's'} before level`,
          };
        }
        return {
          ...statusBase,
          action: ProgressionAction.DRAIN_STAMINA,
          ignoreSoftStaminaRules: true,
          preferredStaminaCost: imminent?.plan?.chapters === 0 ? imminent.plan.staminaCost : null,
          status: 'Draining Stamina before loot',
        };
      }
      return {
        ...statusBase,
        action: ProgressionAction.CLAIM_LOOT,
        claim: claimPlan.claims[0],
        claims: claimPlan.claims,
        status: `Claiming ${claimPlan.claims.length} prioritized loot action${claimPlan.claims.length === 1 ? '' : 's'}`,
      };
    }

    if (policy.allowChapterFallback === true) {
      const imminent = this._imminentLevelPlan(accountName, state, chaptersAvailable, activeConfig);
      if (imminent?.plan?.chapters > 0) {
        return {
          ...statusBase,
          action: ProgressionAction.FARM_CHAPTER_TOP_OFF,
          chapters: imminent.plan.chapters,
          preferredStaminaCost: imminent.plan.staminaCost,
          status: `Top off ${imminent.plan.chapters} chapter${imminent.plan.chapters === 1 ? '' : 's'} before natural level`,
        };
      }
    }
    const chapterFallbackAvailable = policy.allowChapterFallback === true
      && activeConfig.energyFarming?.enabled !== false
      && Number(chaptersAvailable) > 0;
    if (policy.allowTargetPotionFallback === true
      && !chapterFallbackAvailable
      && state.currentBattle
      && state.isJoined === true
      && state.monsterDead !== true
      && state.targetStaminaPotion?.available === true) {
      return {
        ...statusBase,
        ignoreSoftStaminaRules: true,
        useTargetStaminaPotion: true,
        status: Number(state.stamina) > 0
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
