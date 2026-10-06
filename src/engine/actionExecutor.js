const MUTATING_ACTIONS = new Set(['JOIN', 'ATTACK', 'LOOT', 'CLAIM_LOOT', 'CLAIM_OBJECTIVE_LOOT', 'ADV_QUEST_ACCEPT', 'ADV_QUEST_FINISH', 'ADV_QUEST_GIVE_UP', 'HEAL', 'FARM', 'APPLY_LOADOUT', 'USE_STAMINA_POTION', 'USE_MANA_POTION', 'AUTO_FARM_START', 'CUBE_PVP_JOIN', 'MONSTER_PHASE_DUEL']);
const KNOWN_ACTIONS = new Set([...MUTATING_ACTIONS, 'SCAN', 'CUBE_SCAN', 'WAIT', 'STOP']);
const ACTION_PARAM_VALIDATORS = Object.freeze({
  JOIN: () => true,
  LOOT: () => true,
  CLAIM_LOOT: params => params.claim && typeof params.claim === 'object'
    && params.claim.battleRef !== null && params.claim.battleRef !== undefined,
  CLAIM_OBJECTIVE_LOOT: params => params.claim && typeof params.claim === 'object'
    && params.claim.battleRef !== null && params.claim.battleRef !== undefined,
  ADV_QUEST_ACCEPT: params => /^\d{1,12}$/.test(String(params.questId || '')),
  ADV_QUEST_FINISH: params => /^\d{1,12}$/.test(String(params.questId || '')),
  ADV_QUEST_GIVE_UP: params => /^\d{1,12}$/.test(String(params.questId || '')),
  WAIT: () => true,
  SCAN: params => params.kind === 'boss_hunt' || (typeof params.areaKey === 'string' && params.areaKey.length > 0
    && (params.kind === 'dungeon' || (
      params.kind === 'event'
      && Number.isInteger(params.eventId) && params.eventId > 0
      && Number.isInteger(params.wave) && params.wave > 0
    ) || (
      (params.kind === undefined || params.kind === 'gate')
      && Number.isInteger(params.gateId) && params.gateId > 0
      && Number.isInteger(params.wave) && params.wave > 0
    ))),
  ATTACK: params => params.skill && typeof params.skill === 'object'
    && Number.isFinite(Number(params.skill.id))
    && Number.isFinite(Number(params.skill.stamCost))
    && Number(params.skill.stamCost) >= 0,
  HEAL: params => typeof params.mode === 'string' && params.mode.length > 0,
  APPLY_LOADOUT: params => ['gear', 'pets'].includes(params.kind)
    && /^quick_set_(?:[1-9]|10)$/.test(String(params.selection || '')),
  USE_STAMINA_POTION: params => ['small', 'large', 'full', 'adventure'].includes(params.type)
    && /^\d{1,30}$/.test(String(params.inventoryId ?? '')),
  USE_MANA_POTION: params => ['small', 'large'].includes(params.type)
    && Number.isInteger(Number(params.quantity)) && Number(params.quantity) >= 1 && Number(params.quantity) <= 10
    && (/^\d{1,30}$/.test(String(params.inventoryId ?? '')) || params.buyIfMissing === true),
  FARM: params => typeof params.reactionType === 'string' && params.reactionType.length > 0
    && Number.isInteger(params.maxPerSession) && params.maxPerSession > 0,
  // Auto Farm can resolve its read page from any configured supported map;
  // one explicit areaKey is optional when the account has multiple targets.
  AUTO_FARM_START: params => params && (params.areaKey === undefined || params.areaKey === null
    || (typeof params.areaKey === 'string' && params.areaKey.length > 0)),
  CUBE_SCAN: () => true,
  CUBE_PVP_JOIN: params => ['instanceId', 'nodeId', 'matchNo', 'slotIndex']
    .every(field => Number.isInteger(Number(params[field])) && Number(params[field]) > 0),
  MONSTER_PHASE_DUEL: params => /^\d{1,30}$/.test(String(params.activeId || ''))
    && typeof params.url === 'string' && params.url.length > 0,
  STOP: () => true,
});

class ActionExecutor {
  constructor(handlers = {}) {
    this.handlers = { ...handlers };
  }

  async execute(decision, context = {}) {
    if (!decision || !KNOWN_ACTIONS.has(decision.action)) {
      throw new Error(`Unsupported strategy action: ${decision?.action || 'missing'}`);
    }
    if (!decision.params || typeof decision.params !== 'object' || Array.isArray(decision.params)) {
      throw new Error(`Strategy action ${decision.action} has invalid parameters`);
    }
    if (!ACTION_PARAM_VALIDATORS[decision.action](decision.params)) {
      throw new Error(`Strategy action ${decision.action} is missing required parameters`);
    }
    if (context.dryRun && MUTATING_ACTIONS.has(decision.action)) {
      return { dryRun: true, decision };
    }
    const handler = this.handlers[decision.action];
    if (typeof handler !== 'function') throw new Error(`No executor handler exists for ${decision.action}`);
    return handler(decision.params, context);
  }
}

module.exports = { ActionExecutor, MUTATING_ACTIONS, KNOWN_ACTIONS, ACTION_PARAM_VALIDATORS };
