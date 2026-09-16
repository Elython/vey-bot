/**
 * Game API Client
 * Direct API client for all demonicscans.org game endpoints.
 * Verified from saved HTML pages in screen/ directory.
 * 
 * Navigation flow: gates.php → active_wave.php?gate=X&wave=Y → battle.php?id=MONSTER_ID
 * 
 * All combat actions are fetch() POST requests to PHP endpoints:
 *   - damage.php     (attack)
 *   - user_join_battle.php (join battle)
 *   - loot.php       (claim loot)
 *   - user_heal.php  (free heal, 1h cooldown)
 *   - user_heal_potion.php (use inventory potion)
 *   - use_item.php (use one account-owned Stamina potion by discovered inv_id)
 */

const { Logger } = require('../main/logger');
const {
  parseGates,
  parseWaveMonsters,
  parseWaveLootSummary,
  parseWaveDeadPageNumbers,
  parseWavePlayerResources,
  parseBattlePage,
  parseGearInventoryPage,
  parsePetInventoryPage,
  parseClassSkillTreePage,
  parseGuildDungeonIndex,
  parseDungeonInstancePage,
  parseDungeonLocationPage,
  parseStatsPage,
  parseTopbar,
} = require('./gameParsers');

const BASE_URL = 'https://demonicscans.org';

class GameAPI {
  /**
   * @param {import('./httpClient').HttpClient} httpClient
   * @param {string} [accountName]
   */
  constructor(httpClient, accountName = null) {
    this.http = httpClient;
    this.accountName = accountName;
  }

  setAccount(accountName) {
    this.accountName = accountName;
    this.http.setAccount?.(accountName);
  }

  // ─── Discovery ─────────────────────────────────────────────────────

  /**
   * Fetch all gates from the gates page
   * @returns {Promise<Array<{name: string, url: string, active: boolean, recommendedLevel: number}>>}
   */
  async getGates() {
    const resp = await this.http.get(`${BASE_URL}/gates.php`);
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch gates: HTTP ${resp.status}`, 'GATES_FETCH_FAILED');
    }

    const gates = parseGates(resp.text);

    Logger.logClient(this.accountName, `[GameAPI] Found ${gates.length} gates`);
    return gates;
  }

  /**
   * Fetch monsters from a wave page
   * @param {number} gateId
   * @param {number|string} waveNum - Wave number or 'latest'
   * @returns {Promise<Array<MonsterInfo>>}
   */
  async getWaveMonsters(gateId, waveNum) {
    return (await this.getWaveSnapshot(gateId, waveNum)).monsters;
  }

  async getWaveSnapshot(gateId, waveNum) {
    return this._fetchWaveSnapshot(gateId, waveNum, {
      hide_dead_monsters: '1',
      show_dead_bosses_only: '0',
    });
  }

  /**
   * Fetch the dead/lootable view without changing the companion browser.
   * Lootable cards are omitted from active_wave.php when hide_dead_monsters=1.
   */
  async getLootableWaveSnapshot(gateId, waveNum) {
    return this._fetchPaginatedLootableWaveSnapshot(gateId, waveNum, {
      hide_dead_monsters: '0',
      show_dead_bosses_only: '0',
    });
  }

  async getEventWaveMonsters(eventId, waveNum) {
    return (await this.getEventWaveSnapshot(eventId, waveNum)).monsters;
  }

  async getEventWaveSnapshot(eventId, waveNum) {
    return this._fetchWaveSnapshot(eventId, waveNum, {
      hide_dead_monsters: '1',
      show_dead_bosses_only: '0',
    }, 'event');
  }

  async getLootableEventWaveSnapshot(eventId, waveNum) {
    return this._fetchPaginatedLootableWaveSnapshot(eventId, waveNum, {
      hide_dead_monsters: '0',
      show_dead_bosses_only: '0',
    }, 'event');
  }

  async _fetchPaginatedLootableWaveSnapshot(routeId, waveNum, cookieOverrides, routeType = 'gate') {
    const first = await this._fetchWaveSnapshot(routeId, waveNum, cookieOverrides, routeType, 1);
    const queued = new Set(first.deadPages || []);
    const visited = new Set([1]);
    const lootById = new Map();
    const rememberLoot = (monster) => {
      const identity = String(monster.id || monster.battleRef || monster.battleId || '');
      if (identity && !lootById.has(identity)) lootById.set(identity, monster);
    };
    for (const monster of first.loot.monsters || []) rememberLoot(monster);

    while (queued.size > 0) {
      const batch = [...queued].filter(page => !visited.has(page)).slice(0, 100);
      for (const page of batch) queued.delete(page);
      if (batch.length === 0) break;
      const snapshots = await Promise.all(batch.map(page =>
        this._fetchWaveSnapshot(routeId, waveNum, cookieOverrides, routeType, page)));
      for (let index = 0; index < snapshots.length; index += 1) {
        const snapshot = snapshots[index];
        visited.add(batch[index]);
        if (snapshot.loot.recognized !== true) {
          throw new GameAPIError(`Dead-monster page ${batch[index]} was not recognized`, 'WAVE_PAGINATION_FAILED');
        }
        for (const monster of snapshot.loot.monsters || []) rememberLoot(monster);
        for (const page of snapshot.deadPages || []) {
          if (!visited.has(page)) queued.add(page);
        }
      }
      if (visited.size > 1000) {
        throw new GameAPIError('Dead-monster pagination exceeded its safety limit', 'WAVE_PAGINATION_FAILED');
      }
    }

    const monsters = [...lootById.values()];
    return {
      ...first,
      deadPagesRead: [...visited].sort((left, right) => left - right),
      loot: {
        ...first.loot,
        visibleLootable: monsters.reduce((total, monster) => total + Math.max(1, Number(monster.stackSize) || 1), 0),
        visibleLootActions: monsters.length,
        monsters,
      },
    };
  }

  async _fetchWaveSnapshot(routeId, waveNum, cookieOverrides = null, routeType = 'gate', deadPage = 1) {
    const routeKey = routeType === 'event' ? 'event' : 'gate';
    const pageSuffix = deadPage > 1 ? `&dead_page=${deadPage}` : '';
    const url = `${BASE_URL}/active_wave.php?${routeKey}=${routeId}&wave=${waveNum}${pageSuffix}`;
    const resp = cookieOverrides && typeof this.http.getWithCookieOverrides === 'function'
      ? await this.http.getWithCookieOverrides(url, cookieOverrides)
      : await this.http.get(url);
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch wave: HTTP ${resp.status}`, 'WAVE_FETCH_FAILED');
    }

    const monsters = this._parseMonsterCards(resp.text);
    const loot = parseWaveLootSummary(resp.text);
    return {
      monsters,
      deadPages: parseWaveDeadPageNumbers(resp.text),
      resources: parseWavePlayerResources(resp.text),
      loot: {
        recognized: loot.recognized,
        reportedUnclaimed: loot.reportedUnclaimed,
        visibleLootable: loot.visibleLootable,
        visibleLootActions: loot.visibleLootActions,
        monsters: loot.lootableMonsters,
      },
    };
  }

  async fetchPlayerResources(gateId = 3, waveNum = 5) {
    const url = `${BASE_URL}/active_wave.php?gate=${gateId}&wave=${waveNum}`;
    const resp = await this.http.get(url);
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch player resources: HTTP ${resp.status}`, 'PLAYER_RESOURCES_FETCH_FAILED');
    }
    const resources = parseWavePlayerResources(resp.text);
    if (!resources.hp && !resources.mp) {
      throw new GameAPIError('Wave page loaded but player HP and Mana were missing', 'PLAYER_RESOURCES_PARSE_FAILED');
    }
    return resources;
  }

  async resolveWave(gateId, requestedWave) {
    if (requestedWave !== 'latest') return requestedWave;
    const gates = await this.getGates();
    for (const gate of gates) {
      try {
        const url = new URL(gate.url, `${BASE_URL}/gates.php`);
        if (url.pathname.endsWith('/active_wave.php') && url.searchParams.get('gate') === String(gateId)) {
          const wave = Number.parseInt(url.searchParams.get('wave'), 10);
          if (Number.isInteger(wave) && wave > 0) return wave;
        }
      } catch (error) {
        Logger.logClient(this.accountName, `[GameAPI] Ignored invalid gate link: ${error.message}`);
      }
    }
    throw new GameAPIError(`Could not resolve latest wave for gate ${gateId}`, 'WAVE_RESOLUTION_FAILED');
  }

  async getOpenDungeons() {
    return (await this.getDungeonInstances()).filter(dungeon => dungeon.active);
  }

  async getDungeonInstances() {
    const resp = await this.http.get(`${BASE_URL}/guild_dungeon.php`);
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch Guild Dungeons: HTTP ${resp.status}`, 'DUNGEON_INDEX_FETCH_FAILED');
    }
    const parsed = parseGuildDungeonIndex(resp.text);
    if (!parsed.recognized) {
      throw new GameAPIError('Guild Dungeons loaded but verified instance cards were missing', 'DUNGEON_INDEX_PARSE_FAILED');
    }
    return parsed.instances;
  }

  async _getDungeonInstanceSnapshot(dungeon) {
    const instanceResp = await this.http.get(new URL(dungeon.url, BASE_URL).toString());
    if (!instanceResp.ok) {
      throw new GameAPIError(`Failed to fetch dungeon instance ${dungeon.instanceId}: HTTP ${instanceResp.status}`, 'DUNGEON_INSTANCE_FETCH_FAILED');
    }
    const instance = parseDungeonInstancePage(instanceResp.text);
    if (!instance.recognized || instance.instanceId !== dungeon.instanceId) {
      throw new GameAPIError(`Dungeon instance ${dungeon.instanceId} loaded but verified location links were missing`, 'DUNGEON_INSTANCE_PARSE_FAILED');
    }

    const locations = await Promise.all(instance.locations.map(async location => {
      const response = await this.http.get(new URL(location.url, BASE_URL).toString());
      if (!response.ok) {
        throw new GameAPIError(`Failed to fetch dungeon location ${location.locationId}: HTTP ${response.status}`, 'DUNGEON_LOCATION_FETCH_FAILED');
      }
      const parsed = parseDungeonLocationPage(response.text, {
        dungeonName: instance.dungeonName,
        instanceId: instance.instanceId,
        locationId: location.locationId,
        locationName: location.name,
        boss: location.boss,
      });
      if (!parsed.recognized) {
        throw new GameAPIError(`Dungeon location ${location.locationId} did not match the verified markup`, 'DUNGEON_LOCATION_PARSE_FAILED');
      }
      return parsed;
    }));
    return { dungeon, instance, locations };
  }

  async getDungeonSnapshot(dungeonName, { includePrevious = false } = {}) {
    const wanted = String(dungeonName || '').trim().toLowerCase();
    if (!wanted) throw new GameAPIError('Dungeon name is required', 'INVALID_DUNGEON_NAME');
    const available = (await this.getDungeonInstances())
      .filter(entry => entry.name.trim().toLowerCase() === wanted)
      .filter(entry => entry.status !== 'failed' && entry.guildLootState !== 'none');
    const selected = includePrevious
      ? available
      : available.filter(entry => entry.active).slice(0, 1);
    if (selected.length === 0) {
      return { sourceAvailable: true, dungeon: null, locations: [], monsters: [], resources: {}, message: `${dungeonName} is not currently open.` };
    }

    const reads = await Promise.allSettled(selected.map(dungeon => this._getDungeonInstanceSnapshot(dungeon)));
    const snapshots = reads.filter(result => result.status === 'fulfilled').map(result => result.value);
    const errors = reads
      .map((result, index) => result.status === 'rejected'
        ? { instanceId: selected[index].instanceId, message: result.reason?.message || String(result.reason) }
        : null)
      .filter(Boolean);
    if (snapshots.length === 0 && errors.length > 0) {
      throw new GameAPIError(errors[0].message, 'DUNGEON_INSTANCE_PARSE_FAILED');
    }

    const locations = snapshots.flatMap(snapshot => snapshot.locations);
    const resources = locations.find(location => location.resources?.hp)?.resources || {};
    const primary = snapshots[0];
    return {
      sourceAvailable: true,
      dungeon: primary
        ? { ...primary.dungeon, name: primary.instance.dungeonName, active: snapshots.some(snapshot => snapshot.dungeon.active) }
        : null,
      instances: snapshots.map(snapshot => ({
        ...snapshot.dungeon,
        name: snapshot.instance.dungeonName,
        active: snapshot.dungeon.active,
      })),
      locations: locations.map(({ monsters, ...location }) => location),
      monsters: locations.flatMap(location => location.monsters),
      resources,
      errors,
      message: '',
    };
  }

  /**
   * Parse monster cards from wave/dungeon HTML
   * Each .monster-card has data attributes with all info we need
   * @param {string} html
   * @returns {Array<MonsterInfo>}
   */
  _parseMonsterCards(html) {
    const monsters = parseWaveMonsters(html);

    Logger.logClient(this.accountName, `[GameAPI] Parsed ${monsters.length} monsters from wave page`);
    return monsters;
  }

  /**
   * Fetch battle page config (BATTLE_CFG, player constants, available skills)
   * @param {Object|string|number} battleRef - Normal monster ID or dungeon locator
   * @returns {Promise<BattleConfig>}
   */
  async getBattleConfig(battleRef) {
    const locator = this._normalizeBattleLocator(battleRef);
    const url = locator.isDungeon
      ? `${BASE_URL}/battle.php?dgmid=${encodeURIComponent(locator.dgmid)}&instance_id=${encodeURIComponent(locator.instanceId)}`
      : `${BASE_URL}/battle.php?id=${encodeURIComponent(locator.monsterId)}`;
    const resp = await this.http.get(url);
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch battle page: HTTP ${resp.status}`, 'BATTLE_FETCH_FAILED');
    }

    const config = this._parseBattlePage(resp.text);
    config.userId = await this.getAuthenticatedUserId(config.userId);
    // The requested locator is authoritative. Some Dungeon battle pages expose
    // a Gate-shaped or incomplete BATTLE_CFG even though their mutations require
    // instance_id + dgmid. Preserve those IDs independently from page markup.
    if (locator.isDungeon) {
      config.battleCfg = {
        ...config.battleCfg,
        id: locator.dgmid,
        isDungeon: true,
        instanceId: locator.instanceId,
        dgmid: locator.dgmid,
        endpoints: {
          ...(config.battleCfg.endpoints || {}),
          ATTACK: 'damage.php',
          JOIN: 'dungeon_join_battle.php',
          LOOT: 'dungeon_loot.php',
        },
      };
    }
    config.battleLocator = locator;
    return config;
  }

  async getMonsterStats(monsterId) {
    const normalizedId = String(monsterId ?? '');
    if (!/^\d{1,30}$/.test(normalizedId)) {
      throw new GameAPIError('Invalid monster ID', 'INVALID_MONSTER_ID');
    }
    const resp = await this.http.get(`${BASE_URL}/battle.php?id=${encodeURIComponent(normalizedId)}`);
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch monster stats: HTTP ${resp.status}`, 'MONSTER_STATS_FETCH_FAILED');
    }
    const stats = parseBattlePage(resp.text).monsterStats;
    if (!stats) {
      throw new GameAPIError('Battle page loaded but Monster Stats were missing', 'MONSTER_STATS_PARSE_FAILED');
    }
    return stats;
  }

  async getGearInventory(context = 'attack', quickSetNumber = null) {
    const normalized = this._normalizeLoadoutContext(context);
    const qset = this._normalizeQuickSetNumber(quickSetNumber);
    const suffix = qset ? `&qset=${qset}` : '';
    const resp = await this.http.get(`${BASE_URL}/inventory.php?set=${encodeURIComponent(normalized)}${suffix}`);
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch Gear inventory: HTTP ${resp.status}`, 'GEAR_FETCH_FAILED');
    }
    const parsed = parseGearInventoryPage(resp.text);
    if (!parsed.recognized || parsed.context !== normalized || (qset && parsed.quickSetNumber !== qset)) {
      throw new GameAPIError('Gear page loaded but verified inventory markup was missing', 'GEAR_PARSE_FAILED');
    }
    Logger.logClient(this.accountName, `[GameAPI] Gear: ${parsed.equipped.length} equipped, ${parsed.definitions.length} definitions`);
    return parsed;
  }

  async getPetInventory(context = 'attack', quickSetNumber = null) {
    const normalized = this._normalizeLoadoutContext(context);
    const qset = this._normalizeQuickSetNumber(quickSetNumber);
    const suffix = qset ? `&qset=${qset}` : '';
    const resp = await this.http.get(`${BASE_URL}/pets.php?team=${encodeURIComponent(normalized)}${suffix}`);
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch Pet inventory: HTTP ${resp.status}`, 'PETS_FETCH_FAILED');
    }
    const parsed = parsePetInventoryPage(resp.text);
    if (!parsed.recognized || parsed.context !== normalized || (qset && parsed.quickSetNumber !== qset)) {
      throw new GameAPIError('Pet page loaded but verified inventory markup was missing', 'PETS_PARSE_FAILED');
    }
    Logger.logClient(this.accountName, `[GameAPI] Pets: ${parsed.equipped.length} equipped, ${parsed.definitions.length} definitions`);
    return parsed;
  }

  async applyQuickSet({ setNumber, targetSet = 'attack', applyType }) {
    const normalizedSet = this._normalizeLoadoutContext(targetSet);
    const normalizedNumber = this._normalizeQuickSetNumber(setNumber, true);
    if (!['equipments', 'pets'].includes(applyType)) {
      throw new GameAPIError('Invalid Quick Set apply type', 'INVALID_QUICK_SET_TYPE');
    }
    const body = new URLSearchParams({
      set_number: String(normalizedNumber),
      target_set: normalizedSet,
      apply_type: applyType,
    });
    const resp = await this.http.post(`${BASE_URL}/quick_sets_apply.php`, body);
    const text = String(resp.text || '').trim();
    const countName = applyType === 'equipments' ? 'equipped_items' : 'equipped_pets';
    const success = text.match(new RegExp(`^success\\s*\\|\\s*${countName}=(\\d+)\\s*$`, 'i'));
    if (success) {
      return { success: true, equippedCount: Number(success[1]), setNumber: normalizedNumber, targetSet: normalizedSet, applyType };
    }
    return { success: false, message: text.slice(0, 200) || `Quick Set ${normalizedNumber} could not be applied` };
  }

  async getClassSkillTree() {
    const resp = await this.http.get(`${BASE_URL}/class_skill_tree.php`);
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch class skill tree: HTTP ${resp.status}`, 'CLASS_SKILLS_FETCH_FAILED');
    }
    const parsed = parseClassSkillTreePage(resp.text);
    if (!parsed.recognized) {
      throw new GameAPIError('Class skill page loaded but verified skill data was missing', 'CLASS_SKILLS_PARSE_FAILED');
    }
    Logger.logClient(this.accountName, `[GameAPI] ${parsed.className}: ${parsed.unlockedSkills.length}/${parsed.skills.length} skills unlocked`);
    return parsed;
  }

  /**
   * Parse BATTLE_CFG, player constants, and skills from battle page HTML
   * @param {string} html
   * @returns {BattleConfig}
   */
  _parseBattlePage(html) {
    const config = parseBattlePage(html);
    if (!config.battleCfg) {
      throw new GameAPIError(`Unable to parse BATTLE_CFG: ${config.battleConfigError}`, 'BATTLE_PARSE_FAILED');
    }

    Logger.logClient(this.accountName, `[GameAPI] Battle config: monster=${config.battleCfg?.id}, HP=${config.monsterHp}/${config.monsterMaxHp}, skills=${config.skills.length}, joined=${config.isJoined}`);
    return config;
  }

  // ─── Combat Actions ────────────────────────────────────────────────

  /**
   * Join a battle
   * @param {Object|string|number} battleRef
   * @param {string|number} userId
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async joinBattle(battleRef, userId = null) {
    const locator = this._normalizeBattleLocator(battleRef);
    const resolvedUserId = await this.getAuthenticatedUserId(userId);
    const endpoint = locator.isDungeon ? 'dungeon_join_battle.php' : 'user_join_battle.php';
    const url = `${BASE_URL}/${endpoint}`;
    let resp;

    if (locator.isDungeon) {
      const body = new URLSearchParams();
      body.set('instance_id', locator.instanceId);
      body.set('dgmid', locator.dgmid);
      body.set('user_id', String(resolvedUserId));
      Logger.logApi(this.accountName, 'POST', url, null, `Joining dungeon battle: monster=${locator.dgmid}`);
      resp = await this.http.post(url, body);
    } else {
      Logger.logApi(this.accountName, 'POST', url, null, `Joining battle: monster=${locator.monsterId}`);
      resp = await this.http.postMultipart(url, {
        monster_id: locator.monsterId,
        user_id: resolvedUserId,
      });
    }
    const text = resp.text.trim();
    const success = text.toLowerCase().startsWith('you have successfully');

    Logger.logApi(this.accountName, 'POST', url, resp.status, success ? 'Battle joined' : text.slice(0, 200));
    return { success, message: text };
  }

  /**
   * Attack a monster
   * @param {Object} params
   * @param {string|number} params.monsterId - For gates (non-dungeon)
   * @param {number} params.skillId - Skill ID (0=Slash, -1=Power Slash, etc.)
   * @param {number} params.stamCost - Stamina cost
   * @param {boolean} [params.isDungeon=false]
   * @param {string|number} [params.instanceId] - Dungeon instance ID
   * @param {string|number} [params.dgmid] - Dungeon monster ID
   * @returns {Promise<AttackResult>}
   */
  async attack({ monsterId, skillId, stamCost, isDungeon = false, instanceId, dgmid }) {
    const body = new URLSearchParams();

    if (isDungeon) {
      body.set('instance_id', this._requireNumericId(instanceId, 'Dungeon instance ID'));
      body.set('dgmid', this._requireNumericId(dgmid || monsterId, 'Dungeon monster ID'));
    } else {
      body.set('monster_id', this._requireNumericId(monsterId, 'Monster ID'));
    }

    body.set('skill_id', String(skillId));
    body.set('stamina_cost', String(stamCost));

    Logger.logApi(this.accountName, 'POST', `${BASE_URL}/damage.php`, null, `Attack: skill=${skillId}, cost=${stamCost}`);

    const resp = await this.http.post(`${BASE_URL}/damage.php`, body, { retries: 1 });
    const data = this._parseJsonSafe(resp.text);

    if (!data) {
      Logger.logApi(this.accountName, 'POST', `${BASE_URL}/damage.php`, resp.status, `Invalid JSON response`);
      return { success: false, message: 'Invalid response from damage.php', raw: resp.text.slice(0, 200) };
    }

    const result = {
      success: data.status === 'success',
      message: data.message || '',
      hp: data.hp || null,             // { value, max, percent }
      stamina: data.stamina ?? null,
      damage: data.damage ?? null,
      mana: data.mana ?? null,
      xpDelta: data.xp_delta ?? null,
      totalDmgDealt: data.totaldmgdealt ?? null,
      retaliation: data.retaliation || null, // { user_hp_after }
      leaderboard: data.leaderboard || [],
      logs: data.logs || [],
      phase: data.phase || null,       // { changed, image }
    };

    Logger.logApi(this.accountName, 'POST', `${BASE_URL}/damage.php`, resp.status,
      result.success
        ? `DMG dealt, HP=${result.hp?.value}/${result.hp?.max}, Stamina=${result.stamina}`
        : `Attack failed: ${result.message}`
    );

    return result;
  }

  /**
   * Loot a dead monster
   * @param {Object|string|number} battleRef
   * @param {string|number} userId
   * @returns {Promise<{success: boolean, message: string, items?: Array, redirect?: string, rewards?: Object|null}>}
   */
  async loot(battleRef, userId = null) {
    const locator = this._normalizeBattleLocator(battleRef);
    const resolvedUserId = await this.getAuthenticatedUserId(userId);
    const body = new URLSearchParams();
    if (locator.isDungeon) {
      body.set('instance_id', locator.instanceId);
      body.set('dgmid', locator.dgmid);
    } else {
      body.set('monster_id', locator.monsterId);
    }
    body.set('user_id', String(resolvedUserId));

    const endpoint = locator.isDungeon ? 'dungeon_loot.php' : 'loot.php';
    const url = `${BASE_URL}/${endpoint}`;
    Logger.logApi(this.accountName, 'POST', url, null, `Looting monster=${locator.dgmid || locator.monsterId}`);
    const resp = await this.http.post(url, body);
    const data = this._parseJsonSafe(resp.text);

    if (!data) {
      Logger.logApi(this.accountName, 'POST', url, resp.status, 'Invalid JSON response');
      return { success: false, message: `Invalid response from ${endpoint}` };
    }

    const result = {
      success: data.status === 'success',
      message: data.message || '',
      items: data.items || [],
      redirect: data.redirect_url || '',
      note: data.note ?? null,
      rewards: data.rewards || null,
      requestId: data.request_id || null,
    };

    Logger.logApi(this.accountName, 'POST', url, resp.status,
      result.success ? `Loot claimed: ${result.message}` : `Loot failed: ${result.message}`
    );

    return result;
  }

  // ─── Healing ───────────────────────────────────────────────────────

  /**
   * Free timed heal (1-hour cooldown)
   * @param {string|number} userId
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async heal(userId = null) {
    const resolvedUserId = await this.getAuthenticatedUserId(userId);
    const body = new URLSearchParams();
    body.set('user_id', String(resolvedUserId));

    Logger.logApi(this.accountName, 'POST', `${BASE_URL}/user_heal.php`, null, 'Attempting free timed heal');
    const resp = await this.http.post(`${BASE_URL}/user_heal.php`, body);
    const data = this._parseJsonSafe(resp.text);

    const result = {
      success: data?.status?.trim() === 'success',
      message: data?.message || resp.text.slice(0, 200),
    };

    Logger.logApi(this.accountName, 'POST', `${BASE_URL}/user_heal.php`, resp.status,
      result.success ? 'Healed successfully' : `Heal failed: ${result.message}`
    );

    return result;
  }

  /**
   * Use a heal potion from inventory
   * @param {string|number} userId
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async healPotion(userId = null) {
    const resolvedUserId = await this.getAuthenticatedUserId(userId);
    const body = new URLSearchParams();
    body.set('user_id', String(resolvedUserId));

    Logger.logApi(this.accountName, 'POST', `${BASE_URL}/user_heal_potion.php`, null, 'Using heal potion');
    const resp = await this.http.post(`${BASE_URL}/user_heal_potion.php`, body);
    const data = this._parseJsonSafe(resp.text);

    const result = {
      success: data?.status?.trim() === 'success',
      message: data?.message || resp.text.slice(0, 200),
    };

    Logger.logApi(this.accountName, 'POST', `${BASE_URL}/user_heal_potion.php`, resp.status,
      result.success ? 'Potion used successfully' : `Potion failed: ${result.message}`
    );

    return result;
  }

  async buyPotion(type) {
    const offer = type === 'health' ? 'hp_potion' : type === 'mana' ? 'small_mana' : null;
    if (!offer) throw new GameAPIError('Unknown potion purchase type', 'INVALID_PURCHASE_TYPE');
    const body = new URLSearchParams({ offer, qty: '1' });
    const url = `${BASE_URL}/olympus_damon_buy.php`;
    Logger.logApi(this.accountName, 'POST', url, null, `Buying ${offer}`);
    const resp = await this.http.post(url, body);
    const data = this._parseJsonSafe(resp.text);
    const result = {
      success: data?.status?.trim() === 'success',
      message: data?.message || resp.text.slice(0, 200),
      gold: data?.gold ?? null,
      offers: Array.isArray(data?.offers) ? data.offers : [],
      offer,
    };
    Logger.logApi(this.accountName, 'POST', url, resp.status,
      result.success ? `${offer} purchased` : `${offer} purchase failed: ${result.message}`);
    return result;
  }

  async useStaminaPotion(inventoryId) {
    const result = await this._useConsumable(inventoryId, 'Stamina');
    const restoredMatch = result.detail.match(/([\d,]+)\s+stamina\b/i);
    const { detail, ...publicResult } = result;
    return {
      ...publicResult,
      staminaRestored: restoredMatch ? Number(restoredMatch[1].replace(/,/g, '')) : null,
    };
  }

  async useManaPotion(inventoryId) {
    const result = await this._useConsumable(inventoryId, 'Mana');
    const restoredMatch = result.detail.match(/([\d,]+)\s+mana\b/i);
    const { detail, ...publicResult } = result;
    return {
      ...publicResult,
      manaRestored: restoredMatch ? Number(restoredMatch[1].replace(/,/g, '')) : null,
    };
  }

  async _useConsumable(inventoryId, resourceName = 'Consumable') {
    const normalizedInventoryId = String(inventoryId ?? '').trim();
    if (!/^\d{1,30}$/.test(normalizedInventoryId)) {
      throw new GameAPIError('Invalid Stamina potion inventory ID', 'INVALID_INVENTORY_ID');
    }
    const body = new URLSearchParams({ inv_id: normalizedInventoryId });
    const url = `${BASE_URL}/use_item.php`;
    Logger.logApi(this.accountName, 'POST', url, null, `Using one discovered ${resourceName} potion`);
    const resp = await this.http.post(url, body);
    const message = String(resp.text || '').trim();
    const successMatch = message.match(/^Item consumed successfully!\s*\(([^()]{1,180});\s*used\s+1x\)\s*$/i);
    const result = {
      success: Boolean(successMatch),
      message: message.slice(0, 240),
      usedQuantity: successMatch ? 1 : 0,
      detail: successMatch?.[1] || '',
    };
    Logger.logApi(this.accountName, 'POST', url, resp.status,
      result.success ? `${resourceName} potion consumed` : `${resourceName} potion use was not confirmed`);
    return result;
  }

  // ─── Stats ─────────────────────────────────────────────────────────

  /**
   * Fetch player stats from stats.php
   * @returns {Promise<{attack: number, defense: number, level: number, stamina: number, maxStamina: number, gold: string, gems: string}>}
   */
  async fetchStats() {
    const resp = await this.http.get(`${BASE_URL}/stats.php`);
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch stats: HTTP ${resp.status}`, 'STATS_FETCH_FAILED');
    }

    const stats = parseStatsPage(resp.text);
    const required = ['level', 'attack', 'defense', 'maxStamina'];
    if (required.some(key => !Number.isFinite(stats[key]))) {
      throw new GameAPIError('Stats page loaded but required player values were missing', 'STATS_PARSE_FAILED');
    }

    Logger.logClient(this.accountName, `[GameAPI] Stats: ATK=${stats.attack}, DEF=${stats.defense}, LV=${stats.level}, Stam=${stats.stamina}/${stats.maxStamina}`);
    return stats;
  }

  /**
   * Fetch dashboard state (topbar stats)
   * @returns {Promise<Object>}
   */
  async fetchDashboard() {
    const resp = await this.http.get(`${BASE_URL}/game_dash.php`);
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch dashboard: HTTP ${resp.status}`, 'DASHBOARD_FETCH_FAILED');
    }

    const dashboard = this._parseTopbar(resp.text);
    if (Object.keys(dashboard).length === 0) {
      throw new GameAPIError('Dashboard loaded but no authenticated top-bar values were found', 'DASHBOARD_PARSE_FAILED');
    }
    return dashboard;
  }

  // ─── Internal Helpers ──────────────────────────────────────────────

  async getAuthenticatedUserId(fallback = null) {
    if (typeof this.http.getCookies === 'function') {
      const cookies = await this.http.getCookies(BASE_URL);
      const demon = cookies.find(cookie => cookie.name === 'demon')?.value;
      if (demon !== undefined) return Number(this._requireNumericId(demon, 'demon cookie user ID'));
    }
    if (fallback !== null && fallback !== undefined) {
      return Number(this._requireNumericId(fallback, 'User ID'));
    }
    throw new GameAPIError('Authenticated demon cookie is missing', 'USER_ID_MISSING');
  }

  _normalizeLoadoutContext(value) {
    const context = String(value || '').toLowerCase();
    if (!['attack', 'pvp_attack', 'defense'].includes(context)) {
      throw new GameAPIError('Invalid loadout context', 'INVALID_LOADOUT_CONTEXT');
    }
    return context;
  }

  _normalizeQuickSetNumber(value, required = false) {
    if ((value === null || value === undefined || value === '') && !required) return null;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 10) {
      throw new GameAPIError('Invalid Quick Set number', 'INVALID_QUICK_SET_NUMBER');
    }
    return number;
  }

  _normalizeBattleLocator(battleRef) {
    if (battleRef && typeof battleRef === 'object') {
      const endpoints = battleRef.endpoints || {};
      const isDungeon = Boolean(
        battleRef.isDungeon ||
        endpoints.JOIN === 'dungeon_join_battle.php' ||
        endpoints.LOOT === 'dungeon_loot.php'
      );
      if (isDungeon) {
        return {
          isDungeon: true,
          instanceId: this._requireNumericId(battleRef.instanceId, 'Dungeon instance ID'),
          dgmid: this._requireNumericId(battleRef.dgmid || battleRef.id, 'Dungeon monster ID'),
          monsterId: null,
        };
      }
      return {
        isDungeon: false,
        monsterId: this._requireNumericId(battleRef.id ?? battleRef.monsterId, 'Monster ID'),
        instanceId: null,
        dgmid: null,
      };
    }
    return {
      isDungeon: false,
      monsterId: this._requireNumericId(battleRef, 'Monster ID'),
      instanceId: null,
      dgmid: null,
    };
  }

  _requireNumericId(value, label) {
    const normalized = String(value ?? '').trim();
    if (!/^\d+$/.test(normalized) || normalized === '0') {
      throw new GameAPIError(`${label} is missing or invalid`, 'INVALID_ACTION_ID');
    }
    return normalized;
  }

  /**
   * Parse topbar stats present on all game pages
   * @param {string} html
   * @returns {Object}
   */
  _parseTopbar(html) {
    return parseTopbar(html);
  }

  /**
   * Extract an attribute value from an HTML attributes string
   * @param {string} attrs - Raw attribute string
   * @param {string} name - Attribute name
   * @returns {string|null}
   */
  _attr(attrs, name) {
    const match = attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'));
    return match ? match[1] : null;
  }

  /**
   * Safely parse JSON, handling common game response quirks
   * (BOM, leading whitespace, truncated responses)
   * @param {string} text
   * @returns {Object|null}
   */
  _parseJsonSafe(text) {
    if (!text) return null;
    const trimmed = text.replace(/^\uFEFF/, '').trim();

    // Try direct parse first
    try {
      return JSON.parse(trimmed);
    } catch {
      // noop
    }

    // Try extracting first JSON object
    const start = trimmed.indexOf('{');
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = false; }
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}

/**
 * Custom error for GameAPI operations
 */
class GameAPIError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GameAPIError';
    this.code = code;
  }
}

/**
 * @typedef {Object} MonsterInfo
 * @property {string} id
 * @property {boolean} dead
 * @property {boolean} boss
 * @property {string} name
 * @property {boolean} joined
 * @property {boolean} unjoined
 * @property {number} userDmg
 * @property {boolean} eligible
 * @property {number} expire - Unix timestamp
 * @property {number} [hp]
 * @property {number} [maxHp]
 * @property {string} [battleId]
 */

/**
 * @typedef {Object} BattleConfig
 * @property {Object} battleCfg - Raw BATTLE_CFG from page
 * @property {number} playerMaxHp
 * @property {number} playerMaxMana
 * @property {number} userId
 * @property {Array<{id: number, name: string, stamCost: number}>} skills
 * @property {number|null} monsterHp
 * @property {number|null} monsterMaxHp
 * @property {number|null} playerHp
 * @property {number|null} playerMana
 * @property {boolean} isDead
 * @property {boolean} isJoined
 * @property {boolean} hasLootButton
 * @property {boolean} hasJoinButton
 * @property {number|null} userDamage
 * @property {{recognized: boolean, expPerDamage: number|null, expCapPercent: number|null, expCapDamage: number|null, minimumLevel: number|null, rewardsUpToLevel: number|null}} rewardInfo
 */

/**
 * @typedef {Object} AttackResult
 * @property {boolean} success
 * @property {string} message
 * @property {Object|null} hp - { value, max, percent }
 * @property {number|null} stamina
 * @property {number|null} damage
 * @property {number|null} mana
 * @property {number|null} xpDelta
 * @property {number|null} totalDmgDealt
 * @property {Object|null} retaliation - { user_hp_after }
 * @property {Array} leaderboard
 * @property {Array} logs
 * @property {Object|null} phase - { changed, image }
 */

module.exports = { GameAPI, GameAPIError };
