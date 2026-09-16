const { monsterTypeKey } = require('./monsterCatalog');

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(number) ? number : null;
}

function estimateRewardXp(candidate, playerLevel, lootXpMultiplier = 1) {
  if (candidate?.verified !== true) return null;
  const damage = finiteNumber(candidate.userDamage);
  const rate = finiteNumber(candidate.expPerDamage);
  const cap = finiteNumber(candidate.expCapDamage);
  const rewardsUpTo = finiteNumber(candidate.rewardsUpToLevel);
  const stackSize = Math.max(1, Math.trunc(Number(candidate.stackSize) || 1));
  if (damage === null || damage < 0 || rate === null || rate <= 0) return null;
  if (rewardsUpTo !== null && finiteNumber(playerLevel) !== null && Number(playerLevel) > rewardsUpTo) return 0;
  const rewardedDamage = cap !== null && cap >= 0 ? Math.min(damage, cap) : damage;
  const baseXp = Math.max(0, Math.floor(rewardedDamage * rate * stackSize));
  const multiplier = Math.max(1, finiteNumber(lootXpMultiplier) || 1);
  // Apply the boost conservatively after the verified base reward is floored.
  // This cannot overstate the server result if its internal rounding differs.
  return Math.max(0, Math.floor(baseXp * multiplier));
}

class LootRewardLedger {
  build(candidates = [], lootingMaps = {}, playerLevel = null, options = {}) {
    const lootXpMultiplier = Math.max(1, finiteNumber(options.lootXpMultiplier) || 1);
    const acceptedByType = new Map();
    const eligible = [];
    const excluded = [];
    for (const raw of Array.isArray(candidates) ? candidates : []) {
      const areaKey = String(raw.areaKey || '');
      const monsterKey = monsterTypeKey(raw.monsterKey || raw.name);
      const settings = lootingMaps?.[areaKey]?.[monsterKey];
      const maxLooting = Math.max(0, Math.trunc(Number(settings?.maxLooting) || 0));
      const unlimited = settings?.unlimited === true;
      const previouslyLooted = Math.max(0, Math.trunc(Number(settings?.lootedCount) || 0));
      const logicalCount = Math.max(1, Math.trunc(Number(raw.stackSize) || 1));
      const typeKey = `${areaKey}:${monsterKey}`;
      const accepted = acceptedByType.get(typeKey) || 0;
      let reason = null;
      if (!settings?.enabled) reason = 'Loot is disabled for this monster type';
      else if (!unlimited && maxLooting <= 0) reason = 'Max looting is zero';
      else if (!unlimited && previouslyLooted + accepted + logicalCount > maxLooting) reason = 'Max looting reached';
      const rewardXp = reason ? null : estimateRewardXp(raw, playerLevel, lootXpMultiplier);
      if (!reason && rewardXp === null) reason = raw.verificationError || 'Reward XP cannot be verified';
      const candidate = {
        ...raw,
        areaKey,
        monsterKey,
        priority: Math.max(0, Math.trunc(Number(settings?.priority) || 0)),
        maxLooting,
        unlimited,
        previouslyLooted,
        rewardXp,
      };
      if (reason) {
        excluded.push({ ...candidate, excludedReason: reason });
        continue;
      }
      acceptedByType.set(typeKey, accepted + logicalCount);
      eligible.push(candidate);
    }
    eligible.sort((left, right) =>
      (Number(left.areaRank) || 0) - (Number(right.areaRank) || 0) ||
      left.priority - right.priority ||
      String(left.name || '').localeCompare(String(right.name || '')) ||
      String(left.id || '').localeCompare(String(right.id || ''))
    );
    return {
      eligible,
      excluded,
      eligibleXp: eligible.reduce((total, candidate) => total + candidate.rewardXp, 0),
      lootXpMultiplier,
    };
  }

  planToLevel(ledger, xpNeeded) {
    const needed = Math.max(0, Number(xpNeeded) || 0);
    const claims = [];
    let predictedXp = 0;
    for (const candidate of ledger?.eligible || []) {
      if (predictedXp >= needed) break;
      claims.push(candidate);
      predictedXp += candidate.rewardXp;
    }
    return {
      enough: needed > 0 && predictedXp >= needed,
      needed,
      predictedXp,
      claims,
      eligibleXp: Number(ledger?.eligibleXp) || 0,
    };
  }
}

module.exports = { LootRewardLedger, estimateRewardXp };
