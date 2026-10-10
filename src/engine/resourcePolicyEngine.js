const { validateConfig } = require('./configManager');

const PURCHASE_TYPES = Object.freeze({
  health: Object.freeze({ offer: 'hp_potion', unitCost: 30000 }),
  mana: Object.freeze({ offer: 'small_mana', unitCost: 60000 }),
});

const STAMINA_POTION_TYPES = new Set(['small', 'large', 'full', 'adventure']);
const MANA_POTION_TYPES = new Set(['small', 'large']);

function staminaMinimumAmount(config = {}, state = {}) {
  if (state.progression?.ignoreSoftStaminaRules === true || state.progression?.drainForChapterFallback === true) return 0;
  const keepMinPercent = Math.min(100, Math.max(
    0,
    Number(config.resources?.stamina?.keepMin) || 0,
  ));
  const maxStamina = Math.max(0, Number(state.maxStamina) || 0);
  if (keepMinPercent <= 0 || maxStamina <= 0) return 0;
  return Math.ceil((maxStamina * keepMinPercent) / 100);
}

class ResourcePolicyEngine {
  constructor(config = {}) {
    this.updateConfig(config);
  }

  updateConfig(config = {}) {
    this.config = validateConfig(config);
  }

  canPurchase(type, { gold = 0 } = {}) {
    const purchase = PURCHASE_TYPES[type];
    if (!purchase) return { allowed: false, reason: 'Unknown purchase type' };
    const policy = this.config.resources[type];
    const details = {
      type,
      offer: purchase.offer,
      qty: 1,
      unitCost: purchase.unitCost,
      maxPurchases: policy.maxPurchases,
      purchasedCount: policy.purchasedCount,
    };
    if (!policy.buyPotionIfNeeded) return { ...details, allowed: false, reason: 'Automatic buying is disabled' };
    if (policy.maxPurchases <= 0) return { ...details, allowed: false, reason: 'Purchase limit is zero' };
    if (policy.purchasedCount >= policy.maxPurchases) return { ...details, allowed: false, reason: 'Purchase limit reached' };
    if (Number(gold) < purchase.unitCost) return { ...details, allowed: false, reason: 'Not enough gold' };
    return { ...details, allowed: true, reason: 'Purchase is within policy' };
  }

  canUseStaminaPotion(type, usedCount = 0) {
    if (!STAMINA_POTION_TYPES.has(type)) return { allowed: false, reason: 'Unknown stamina potion type' };
    const stamina = this.config.resources.stamina;
    const limit = stamina.potionLimits[type];
    const used = Math.max(0, Math.trunc(Number(usedCount) || 0));
    if (!stamina.allowPotions) return { type, limit, used, allowed: false, reason: 'Stamina potion use is disabled' };
    if (limit <= 0) return { type, limit, used, allowed: false, reason: 'Potion limit is zero' };
    if (used >= limit) return { type, limit, used, allowed: false, reason: 'Potion limit reached' };
    return { type, limit, used, allowed: true, reason: 'Potion use is within policy' };
  }

  canUseManaPotion(type, usedCount = 0) {
    if (!MANA_POTION_TYPES.has(type)) return { allowed: false, reason: 'Unknown mana potion type' };
    const mana = this.config.resources.mana;
    const limit = mana.potionLimits[type];
    const used = Math.max(0, Math.trunc(Number(usedCount) || 0));
    const remaining = Math.max(0, limit - used);
    if (!mana.allowPotions) return { type, limit, used, remaining, allowed: false, reason: 'Mana potion use is disabled' };
    if (limit <= 0) return { type, limit, used, remaining, allowed: false, reason: 'Potion limit is zero' };
    if (used >= limit) return { type, limit, used, remaining, allowed: false, reason: 'Potion limit reached' };
    return { type, limit, used, remaining, allowed: true, reason: 'Potion use is within policy' };
  }

  canUseHealthPotion(usedCount = 0) {
    const health = this.config.resources.health;
    const used = Math.max(0, Math.trunc(Number(usedCount) || 0));
    const limit = Math.max(0, Math.trunc(Number(health.maxPotions) || 0));
    if (!health.usePotions) return { limit, used, allowed: false, reason: 'Healing potion use is disabled' };
    if (limit <= 0) return { limit, used, allowed: false, reason: 'Healing potion limit is zero' };
    if (used >= limit) return { limit, used, allowed: false, reason: 'Healing potion limit reached' };
    return { limit, used, allowed: true, reason: 'Healing potion use is within policy' };
  }
}

module.exports = { ResourcePolicyEngine, PURCHASE_TYPES, staminaMinimumAmount };
