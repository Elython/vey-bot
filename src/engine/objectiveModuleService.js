const { getMonsterArea } = require('./monsterCatalog');
const {
  ReadPriority,
  WorldDomain,
  assertAccountKey,
  assertAccountScope,
  buildObjectiveKey,
  createCollectorResult,
} = require('./worldState');

const REFRESH_MS = 10000;
const BATTLE_PASS_RESOURCE_KEY = 'current';
const ADVENTURE_QUESTS_RESOURCE_KEY = 'board';

const MODULE_RESOURCE = Object.freeze({
  battle_pass: Object.freeze({ domain: WorldDomain.BATTLE_PASS, resourceKey: BATTLE_PASS_RESOURCE_KEY }),
  adventure_quests: Object.freeze({ domain: WorldDomain.ADVENTURE_QUESTS, resourceKey: ADVENTURE_QUESTS_RESOURCE_KEY }),
});

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function throwIfAborted(signal, message = 'Objective read cancelled') {
  if (!signal?.aborted) return;
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'READ_ABORTED';
  throw error;
}

function normalizedQuestText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function questPolicyFor(quest, config = {}) {
  const direct = quest?.id ? config.adventureQuests?.quests?.[String(quest.id)] : null;
  // Quest IDs are stable across accounts. The authenticated board is the
  // authority; title/draft fallbacks could attach another account's imported
  // policy to a different quest and must not participate in automation.
  return direct || null;
}

function objectiveScan(policy, metadata = {}) {
  const area = getMonsterArea(policy?.areaKey);
  const monsterKey = String(policy?.monsterKey || '');
  const preferredTargets = (Array.isArray(policy?.preferredTargets) ? policy.preferredTargets : [])
    .filter(entry => entry?.monsterKey && entry.enabled !== false)
    .map(entry => ({
      monsterKey: String(entry.monsterKey),
      name: String(entry.name || entry.monsterKey),
      targetDamage: Math.max(1, Number(entry.targetDamage) || 1),
      priority: Math.max(0, Number(entry.priority) || 0),
      enabled: true,
    }));
  if (!area || (!monsterKey && preferredTargets.length === 0)) return null;
  const route = area.type === 'dungeon'
    ? { kind: 'dungeon', areaKey: area.key }
    : area.type === 'event'
      ? { kind: 'event', eventId: area.eventId, wave: area.wave, areaKey: area.key }
      : { kind: 'gate', gateId: area.gateId, wave: area.wave, areaKey: area.key };
  return {
    ...route,
    preferredMonsterKey: monsterKey || null,
    preferredTargets,
    objective: {
      ...metadata,
      monsterKey: monsterKey || null,
      targetDamage: monsterKey ? Math.max(1, Number(policy.targetDamage) || 1) : null,
      targets: preferredTargets,
      requiresLoot: metadata.requiresLoot === true,
      abilityId: Math.max(0, Math.trunc(Number(policy.abilityId) || 0)),
    },
  };
}

function normalizeBattlePassObservation(page = {}) {
  if (page?.recognized !== true) throw new Error('Battle Pass observation is not recognized');
  const seasonId = finiteOrNull(page.seasonId);
  const seasonIdentity = seasonId === null ? 'unknown' : String(Math.trunc(seasonId));
  return {
    recognized: true,
    active: page.active === true,
    seasonId,
    title: String(page.title || ''),
    endsText: String(page.endsText || ''),
    objectives: (Array.isArray(page.objectives) ? page.objectives : []).map((objective, index) => {
      const type = String(objective?.type || `unknown_${index + 1}`);
      return {
        objectiveKey: buildObjectiveKey({ kind: 'battle_pass_objective', serverId: `${seasonIdentity}:${type}` }),
        type,
        name: String(objective?.name || ''),
        current: finiteOrNull(objective?.current),
        required: finiteOrNull(objective?.required),
        completed: objective?.completed === true,
        minimumDamage: finiteOrNull(objective?.minimumDamage),
      };
    }),
  };
}

function normalizeAdventureQuestObservation(page = {}) {
  if (page?.recognized !== true) throw new Error('Adventurer Quest observation is not recognized');
  const statusRank = Object.freeze({ claimable: 6, active: 5, cooldown: 4, completed: 3, available: 2, saved: 1, unknown: 0 });
  const normalizedRows = (Array.isArray(page.quests) ? page.quests : []).map(quest => {
    const rawId = finiteOrNull(quest?.id);
    const id = rawId === null ? null : Math.trunc(rawId);
    const title = String(quest?.title || 'Untitled quest');
    const objective = String(quest?.objective || '');
    return {
      id,
      acceptQuestId: finiteOrNull(quest?.acceptQuestId),
      finishQuestId: finiteOrNull(quest?.finishQuestId),
      giveUpQuestId: finiteOrNull(quest?.giveUpQuestId),
      title,
      description: String(quest?.description || ''),
      objective,
      reward: String(quest?.reward || ''),
      status: String(quest?.status || 'unknown'),
      current: finiteOrNull(quest?.current),
      required: finiteOrNull(quest?.required),
      cooldownUntil: finiteOrNull(quest?.cooldownUntil),
      cooldownText: String(quest?.cooldownText || ''),
    };
  });
  const byTitle = new Map();
  for (const row of normalizedRows) {
    const titleKey = normalizedQuestText(row.title);
    const existing = byTitle.get(titleKey);
    if (!existing) {
      byTitle.set(titleKey, row);
      continue;
    }
    const primary = (statusRank[row.status] || 0) > (statusRank[existing.status] || 0) ? row : existing;
    const secondary = primary === row ? existing : row;
    byTitle.set(titleKey, {
      ...secondary,
      ...primary,
      id: primary.id ?? secondary.id,
      title: primary.title || secondary.title,
      description: primary.description || secondary.description,
      objective: primary.objective || secondary.objective,
      reward: primary.reward || secondary.reward,
      current: primary.current ?? secondary.current,
      required: primary.required ?? secondary.required,
      cooldownUntil: primary.cooldownUntil ?? secondary.cooldownUntil,
      cooldownText: primary.cooldownText || secondary.cooldownText,
    });
  }
  const quests = [...byTitle.values()].map(quest => ({
    ...quest,
    objectiveKey: buildObjectiveKey({
      kind: 'adventure_quest',
      serverId: quest.id === null ? null : String(quest.id),
      provisionalText: quest.id === null
        ? `${normalizedQuestText(quest.title)}\n${normalizedQuestText(quest.objective)}`
        : null,
    }),
  }));
  const active = quests.find(quest => ['active', 'claimable'].includes(quest.status)) || null;
  return {
    recognized: true,
    quests,
    activeQuestId: active?.id ?? finiteOrNull(page.activeQuestId),
    activeQuestKey: active?.objectiveKey || null,
    refreshAt: finiteOrNull(page.refreshAt),
  };
}

function projectAdventureState(page, config = {}) {
  const active = page.quests.find(quest => ['active', 'claimable'].includes(quest.status)) || null;
  if (active) {
    const policy = questPolicyFor(active, config);
    if (policy?.enabled !== true) {
      const giveUpQuestId = active.giveUpQuestId ?? active.id;
      return {
        module: 'adventure_quests',
        status: giveUpQuestId ? 'active_not_selected' : 'active_not_configured',
        page,
        activeQuest: active,
        policy: policy || null,
        scan: null,
        nextAction: giveUpQuestId
          ? {
            action: 'ADV_QUEST_GIVE_UP',
            params: { questId: giveUpQuestId },
            reason: `Abandoning unselected active quest ${active.title}`,
          }
          : null,
      };
    }
    if (active.status === 'claimable') {
      const finishQuestId = active.finishQuestId ?? active.id;
      return {
        module: 'adventure_quests', status: 'ready_to_finish', page, activeQuest: active, policy,
        scan: null,
        nextAction: finishQuestId
          ? { action: 'ADV_QUEST_FINISH', params: { questId: finishQuestId }, reason: `Turning in ${active.title}` }
          : null,
      };
    }
    const requiresLoot = ['kill_loot', 'item_loot'].includes(policy?.type);
    return {
      module: 'adventure_quests',
      status: policy?.enabled === true ? 'working' : 'active_not_configured',
      page,
      activeQuest: active,
      policy: policy || null,
      scan: policy?.enabled === true
        ? objectiveScan(policy, { module: 'adventure_quests', questId: active.id, type: policy.type, requiresLoot })
        : null,
      nextAction: null,
    };
  }
  const candidate = page.quests
    .filter(quest => quest.id && quest.status === 'available' && questPolicyFor(quest, config)?.enabled === true)
    .sort((left, right) => Number(questPolicyFor(left, config)?.priority || 0) - Number(questPolicyFor(right, config)?.priority || 0)
      || left.id - right.id)[0] || null;
  return {
    module: 'adventure_quests',
    status: candidate ? 'ready_to_accept' : 'waiting_for_quest',
    page,
    activeQuest: null,
    scan: null,
    nextAction: candidate
      ? { action: 'ADV_QUEST_ACCEPT', params: { questId: candidate.id }, reason: `Accepting ${candidate.title}` }
      : null,
  };
}

function projectBattlePassState(page, config = {}) {
  const objectiveRole = objective => {
    const text = `${objective?.type || ''} ${objective?.name || ''}`.toLowerCase();
    if (/spend[_\s-]*stamina|stamina.*(?:spend|use)/.test(text)) return 'spend_stamina';
    if (/monster[_\s-]*hunt|(?:kill|hunt).*monster|must.*loot/.test(text)) return 'monster_hunt';
    return null;
  };
  const stamina = page.objectives.find(objective => objectiveRole(objective) === 'spend_stamina') || null;
  const hunt = page.objectives.find(objective => objectiveRole(objective) === 'monster_hunt') || null;
  const complete = page.completed === true || Boolean(stamina?.completed && hunt?.completed);
  const policy = config.battlePass || {};
  const preferredTargets = Object.entries(policy.targets?.[policy.areaKey] || {})
    .map(([monsterKey, target]) => ({ monsterKey, ...target }))
    .filter(target => target.enabled === true)
    .sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0)
      || String(left.name || left.monsterKey).localeCompare(String(right.name || right.monsterKey)));
  return {
    module: 'battle_pass',
    status: !page.active ? 'inactive' : complete ? 'complete'
      : policy.enabled !== true ? 'not_configured'
        : preferredTargets.length > 0 ? 'working' : 'targets_not_configured',
    page,
    stamina,
    hunt,
    scan: page.active && !complete && policy.enabled === true && preferredTargets.length > 0
      ? objectiveScan({ ...policy, preferredTargets }, {
        module: 'battle_pass',
        type: hunt?.completed ? 'spend_stamina' : 'monster_hunt',
        requiresLoot: hunt?.completed !== true,
        lootIfAchievable: policy.lootIfAchievable === true,
        safeCheck: policy.safeCheck === true,
      })
      : null,
    nextAction: null,
  };
}

class ObjectiveModuleService {
  constructor(gameAPI, options = {}) {
    if (!gameAPI || typeof gameAPI.getAdventurerQuests !== 'function' || typeof gameAPI.getBattlePass !== 'function') {
      throw new TypeError('ObjectiveModuleService requires Battle Pass and Adventurer Quest readers');
    }
    this.gameAPI = gameAPI;
    this.now = options.now || (() => Date.now());
    this.readCoordinator = options.readCoordinator || null;
    this.mode = options.mode || 'shared';
    if (this.mode !== 'shared') throw new Error(`Unsupported objective mode: ${this.mode}`);
    if (!this.readCoordinator) throw new TypeError('Shared objectives require ReadCoordinator');
    this.accountKey = assertAccountKey(options.accountKey);
    this.sourceRevision = 0;
    this.collectors = Object.freeze({
      battle_pass: Object.freeze({ collect: request => this._collectBattlePass(request) }),
      adventure_quests: Object.freeze({ collect: request => this._collectAdventureQuests(request) }),
    });
  }

  getCollector(module) {
    const collector = this.collectors[module];
    if (!collector) throw new Error(`Unknown objective module: ${module || 'missing'}`);
    return collector;
  }

  _resource(module) {
    const resource = MODULE_RESOURCE[module];
    if (!resource) throw new Error(`Unknown objective module: ${module || 'missing'}`);
    return resource;
  }

  async _collectBattlePass(request = {}) {
    assertAccountScope(this.accountKey, request.accountKey);
    if (request.resourceKey !== BATTLE_PASS_RESOURCE_KEY) throw new Error('Unknown Battle Pass resource');
    const observedAt = Number(this.now());
    const sourceRevision = ++this.sourceRevision;
    throwIfAborted(request.signal);
    const page = normalizeBattlePassObservation(await this.gameAPI.getBattlePass());
    throwIfAborted(request.signal);
    return createCollectorResult({
      accountKey: this.accountKey,
      domain: WorldDomain.BATTLE_PASS,
      resourceKey: BATTLE_PASS_RESOURCE_KEY,
      observation: page,
      observedAt,
      sourceRevision,
      source: 'GET battle_pass.php',
    });
  }

  async _collectAdventureQuests(request = {}) {
    assertAccountScope(this.accountKey, request.accountKey);
    if (request.resourceKey !== ADVENTURE_QUESTS_RESOURCE_KEY) throw new Error('Unknown Adventurer Quest resource');
    const observedAt = Number(this.now());
    const sourceRevision = ++this.sourceRevision;
    throwIfAborted(request.signal);
    const page = normalizeAdventureQuestObservation(await this.gameAPI.getAdventurerQuests());
    throwIfAborted(request.signal);
    return createCollectorResult({
      accountKey: this.accountKey,
      domain: WorldDomain.ADVENTURE_QUESTS,
      resourceKey: ADVENTURE_QUESTS_RESOURCE_KEY,
      observation: page,
      observedAt,
      sourceRevision,
      source: 'GET adventurers_guild.php',
    });
  }

  async _sharedRead(module, { force, priority, maxAgeMs, signal }) {
    const { domain, resourceKey } = this._resource(module);
    try {
      const snapshot = await this.readCoordinator.read({
        accountKey: this.accountKey,
        domain,
        resourceKey,
        priority,
        maxAgeMs,
        force,
        signal,
      });
      return clone(snapshot?.value);
    } catch (error) {
      if (error?.code !== 'READ_ABORTED' && error?.name !== 'AbortError') {
        this.readCoordinator.invalidate(this.accountKey, domain, resourceKey, `${module} refresh failed`);
      }
      if (error?.code === 'COLLECTOR_FAILED' && error?.cause?.message) {
        error.message = `Collector read failed: ${error.cause.message}`;
      }
      throw error;
    }
  }

  async refresh(module, config, {
    force = false,
    priority = ReadPriority.ACTIVE_MODULE,
    maxAgeMs = REFRESH_MS,
    signal = null,
  } = {}) {
    if (!MODULE_RESOURCE[module]) return { module, status: 'inactive', scan: null, nextAction: null };
    const page = await this._sharedRead(module, { force, priority, maxAgeMs: force ? 0 : maxAgeMs, signal });
    return module === 'adventure_quests'
      ? projectAdventureState(page, config)
      : projectBattlePassState(page, config);
  }

  invalidateObservation(module = null, reason = 'objective observation invalidated') {
    const modules = module ? [module] : Object.keys(MODULE_RESOURCE);
    let changed = false;
    for (const entry of modules) {
      const resource = MODULE_RESOURCE[entry];
      if (!resource) continue;
      changed = this.readCoordinator.invalidate(
        this.accountKey,
        resource.domain,
        resource.resourceKey,
        reason,
      ) || changed;
    }
    return changed;
  }

  invalidate(module = null, reason = 'objective observation invalidated') {
    return this.invalidateObservation(module, reason);
  }

  peekObservation(module) {
    const resource = this._resource(module);
    return clone(this.readCoordinator.peek(this.accountKey, resource.domain, resource.resourceKey)?.value || null);
  }

  async acceptQuest(questId) {
    const result = await this.gameAPI.acceptAdventurerQuest(questId);
    if (result?.success) this.invalidateObservation('adventure_quests', 'Adventurer Quest accepted');
    return result;
  }

  async finishQuest(questId) {
    const result = await this.gameAPI.finishAdventurerQuest(questId);
    const staleBoard = result?.success !== true
      && /No active quest found or already completed/i.test(String(result?.message || ''));
    if (result?.success || staleBoard) {
      this.invalidateObservation(
        'adventure_quests',
        result?.success ? 'Adventurer Quest completed' : 'Adventurer Quest finish rejected; board must be refreshed',
      );
    }
    return staleBoard ? { ...result, staleBoard: true } : result;
  }

  async giveUpQuest(questId) {
    const result = await this.gameAPI.giveUpAdventurerQuest(questId);
    if (result?.success) this.invalidateObservation('adventure_quests', 'Adventurer Quest abandoned');
    return result;
  }
}

module.exports = {
  ADVENTURE_QUESTS_RESOURCE_KEY,
  BATTLE_PASS_RESOURCE_KEY,
  MODULE_RESOURCE,
  ObjectiveModuleService,
  REFRESH_MS,
  normalizeAdventureQuestObservation,
  normalizeBattlePassObservation,
  objectiveScan,
  projectAdventureState,
  projectBattlePassState,
  questPolicyFor,
};
