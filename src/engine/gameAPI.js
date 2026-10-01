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
  parseAutoSummonMonsterNames,
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
  parseAutoFarmPanel,
  parseCubeHomePage,
  parseCubePvpNodePage,
  parseCubePvpState,
  parseAdventurerQuests,
  parseBattlePass,
} = require('./gameParsers');
const { CUBE_PVP_NODES, CUBE_PVE_LOCATION_IDS } = require('./cubeCatalog');

const BASE_URL = 'https://demonicscans.org';

function isWaveAccessDenied(text) {
  return /\byou\s+can(?:not|['’]?t)\s+access\s+this\s+wave\s+yet\b/i.test(String(text || ''));
}

function isNoGuildResponse(response = {}) {
  try {
    const finalUrl = new URL(String(response.url || ''), BASE_URL);
    if (finalUrl.origin === BASE_URL && finalUrl.pathname === '/guild_join_create.php') return true;
  } catch {
    // The verified HTTP status/body contract below can still classify the response.
  }

  // A valid Guild Dungeons page can contain the global Guild Chat placeholder
  // "You are not in a guild yet" even while its dungeon directory is usable.
  // Only the captured 403 response makes that body text authoritative.
  return Number(response.status) === 403
    && /\byou\s+are\s+not\s+in\s+a\s+guild\b/i.test(String(response.text || ''));
}

function normalizedMonsterName(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

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

  async getAdventurerQuests() {
    const url = `${BASE_URL}/adventurers_guild.php`;
    const resp = await this.http.get(url);
    if (!resp.ok) throw new GameAPIError(`Failed to fetch Adventurer quests: HTTP ${resp.status}`, 'ADV_QUESTS_FETCH_FAILED');
    const parsed = parseAdventurerQuests(resp.text);
    if (!parsed.recognized) throw new GameAPIError('Adventurer Guild page loaded but the quest board was not recognized', 'ADV_QUESTS_PARSE_FAILED');
    return parsed;
  }

  async acceptAdventurerQuest(questId) {
    const id = this._requireNumericId(questId, 'Quest ID');
    const url = `${BASE_URL}/adventurers_accept_quest.php`;
    const resp = await this.http.post(url, new URLSearchParams({ quest_id: id }), { retries: 0 });
    const data = this._parseJsonSafe(resp.text);
    const success = data?.status === 'ok';
    Logger.logApi(this.accountName, 'POST', url, resp.status, success ? `Quest ${id} accepted` : String(data?.message || 'Invalid response').slice(0, 200));
    return { success, status: data?.status || 'error', message: data?.message || 'Invalid quest response' };
  }

  async finishAdventurerQuest(questId) {
    const id = this._requireNumericId(questId, 'Quest ID');
    const url = `${BASE_URL}/adventurers_finish_quest.php`;
    const resp = await this.http.post(url, new URLSearchParams({ quest_id: id }), { retries: 0 });
    const data = this._parseJsonSafe(resp.text);
    const success = data?.status === 'ok';
    Logger.logApi(this.accountName, 'POST', url, resp.status, success ? `Quest ${id} finished` : String(data?.message || 'Invalid response').slice(0, 200));
    return { success, status: data?.status || 'error', message: data?.message || 'Invalid quest response' };
  }

  async giveUpAdventurerQuest(questId) {
    const id = this._requireNumericId(questId, 'Quest ID');
    const url = `${BASE_URL}/adventurers_giveup_quest.php`;
    const resp = await this.http.post(url, new URLSearchParams({ quest_id: id }), { retries: 0 });
    const data = this._parseJsonSafe(resp.text);
    const success = data?.status === 'ok';
    Logger.logApi(this.accountName, 'POST', url, resp.status, success ? `Quest ${id} abandoned` : String(data?.message || 'Invalid response').slice(0, 200));
    return { success, status: data?.status || 'error', message: data?.message || 'Invalid quest response' };
  }

  async getBattlePass() {
    const url = `${BASE_URL}/battle_pass.php`;
    const resp = await this.http.get(url);
    if (!resp.ok) throw new GameAPIError(`Failed to fetch Battle Pass: HTTP ${resp.status}`, 'BATTLE_PASS_FETCH_FAILED');
    const parsed = parseBattlePass(resp.text);
    if (!parsed.recognized) throw new GameAPIError('Battle Pass page loaded but its daily objectives were not recognized', 'BATTLE_PASS_PARSE_FAILED');
    return parsed;
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
      // Dead-monster pages can be hundreds of kilobytes each. Reading up to
      // 100 concurrently caused large transient allocations and could retain
      // an entire scan when one response stalled. Keep this deliberately
      // sequential: background discovery is lower priority than combat and a
      // single parsed page is released before the next one is requested.
      const page = [...queued].find(candidate => !visited.has(candidate));
      queued.delete(page);
      if (!page) break;
      const snapshot = await this._fetchWaveSnapshot(routeId, waveNum, cookieOverrides, routeType, page);
      visited.add(page);
      if (snapshot.loot.recognized !== true) {
        throw new GameAPIError(`Dead-monster page ${page} was not recognized`, 'WAVE_PAGINATION_FAILED');
      }
      for (const monster of snapshot.loot.monsters || []) rememberLoot(monster);
      for (const discoveredPage of snapshot.deadPages || []) {
        if (!visited.has(discoveredPage)) queued.add(discoveredPage);
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
      ? await this.http.getWithCookieOverrides(url, cookieOverrides, { noRetryStatuses: [503] })
      : await this.http.get(url, { noRetryStatuses: [503] });
    if (!resp.ok) {
      if (resp.status === 503) {
        throw new GameAPIError('Wave is not currently available to this account (HTTP 503)', 'AREA_UNAVAILABLE', resp.status);
      }
      throw new GameAPIError(`Failed to fetch wave: HTTP ${resp.status}`, 'WAVE_FETCH_FAILED', resp.status);
    }

    if (isWaveAccessDenied(resp.text)) {
      throw new GameAPIError('Wave is not currently available to this account', 'AREA_UNAVAILABLE', resp.status);
    }

    const monsters = this._parseMonsterCards(resp.text);
    const parsedAutoSummonNames = parseAutoSummonMonsterNames(resp.text);
    const autoSummonNames = new Set(parsedAutoSummonNames.map(normalizedMonsterName));
    for (const monster of monsters) {
      if (monster.boss === true) monster.bossEvidence = 'server';
      else if (autoSummonNames.has(normalizedMonsterName(monster.name))) {
        monster.boss = true;
        monster.bossEvidence = 'auto_summon';
      }
    }
    const loot = parseWaveLootSummary(resp.text);
    if (loot.recognized !== true) {
      throw new GameAPIError('Wave page loaded but its verified structure was missing', 'WAVE_PARSE_FAILED', resp.status);
    }
    const autoFarm = parseAutoFarmPanel(resp.text);
    return {
      monsters,
      deadPages: parseWaveDeadPageNumbers(resp.text),
      resources: parseWavePlayerResources(resp.text),
      autoSummonBossNames: parsedAutoSummonNames,
      autoFarmAvailableMonsters: autoFarm.recognized ? autoFarm.availableMonsters : [],
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
    const resp = await this.http.get(url, { noRetryStatuses: [503] });
    if (!resp.ok) {
      if (resp.status === 503) {
        throw new GameAPIError('Player resource wave is not available to this account (HTTP 503)', 'AREA_UNAVAILABLE', resp.status);
      }
      throw new GameAPIError(`Failed to fetch player resources: HTTP ${resp.status}`, 'PLAYER_RESOURCES_FETCH_FAILED');
    }
    if (isWaveAccessDenied(resp.text)) {
      throw new GameAPIError('Player resource wave is not available to this account', 'AREA_UNAVAILABLE', resp.status);
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

  async getDungeonDirectory() {
    const resp = await this.http.get(`${BASE_URL}/guild_dungeon.php`, { noRetryStatuses: [403] });
    if (isNoGuildResponse(resp)) {
      return {
        recognized: true,
        guildMember: false,
        reason: 'not_in_guild',
        instances: [],
      };
    }
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch Guild Dungeons: HTTP ${resp.status}`, 'DUNGEON_INDEX_FETCH_FAILED');
    }
    const parsed = parseGuildDungeonIndex(resp.text);
    if (!parsed.recognized) {
      throw new GameAPIError('Guild Dungeons loaded but verified instance cards were missing', 'DUNGEON_INDEX_PARSE_FAILED');
    }
    return {
      recognized: true,
      guildMember: true,
      reason: null,
      instances: parsed.instances,
    };
  }

  async getDungeonInstances() {
    return (await this.getDungeonDirectory()).instances;
  }

  async getCubeHome({ directoryInstances = null } = {}) {
    const directory = Array.isArray(directoryInstances)
      ? directoryInstances
      : await this.getDungeonInstances();
    const cubes = directory
      .filter(entry => /polyhedral crucible/i.test(String(entry.name || '')))
      .sort((left, right) => Number(right.instanceId) - Number(left.instanceId));
    const cube = cubes.find(entry => entry.active) || cubes[0];
    if (!cube?.url) throw new GameAPIError('The Polyhedral Crucible is not available', 'CUBE_UNAVAILABLE');
    const url = new URL(cube.url, BASE_URL);
    if (url.origin !== BASE_URL) throw new GameAPIError('Cube link was not same-origin', 'CUBE_INVALID_URL');
    const resp = await this.http.get(url.toString());
    if (!resp.ok) throw new GameAPIError(`Failed to fetch Cube: HTTP ${resp.status}`, 'CUBE_FETCH_FAILED');
    const parsed = parseCubeHomePage(resp.text);
    if (!parsed.recognized) throw new GameAPIError('Cube loaded but its STATE document was missing', 'CUBE_PARSE_FAILED');
    parsed.instanceId ||= Number(cube.instanceId) || null;
    parsed.url = url.toString();
    return parsed;
  }

  async enterCubeNode(instanceId, node) {
    if (!/^\d+$/.test(String(instanceId || '')) || !/^\d+$/.test(String(node?.id || '')) || !/^[a-z_]{1,40}$/i.test(String(node?.faceKey || ''))) {
      throw new GameAPIError('Invalid Cube node locator', 'INVALID_CUBE_NODE');
    }
    const resp = await this.http.postMultipart(`${BASE_URL}/guild_dungeon_cube_action.php`, {
      action: 'enter_node',
      instance_id: instanceId,
      node_id: node.id,
      face_key: node.faceKey,
    }, { retries: 1 });
    if (!resp.ok) throw new GameAPIError(`Cube node entry failed: HTTP ${resp.status}`, 'CUBE_NODE_FAILED');
    let result;
    try { result = JSON.parse(resp.text); } catch { throw new GameAPIError('Cube node returned invalid JSON', 'CUBE_NODE_PARSE_FAILED'); }
    if (result.ok !== true || typeof result.redirect !== 'string') {
      throw new GameAPIError(String(result.message || 'Cube node entry was rejected'), 'CUBE_NODE_REJECTED');
    }
    const redirect = new URL(result.redirect, BASE_URL);
    if (redirect.origin !== BASE_URL) throw new GameAPIError('Cube redirect was not same-origin', 'CUBE_INVALID_REDIRECT');
    return { success: true, redirect: redirect.toString() };
  }

  async getCubePveLocation(instanceId, node) {
    if (!/^\d+$/.test(String(instanceId || '')) || !/^\d+$/.test(String(node?.linkedLocationId || ''))) {
      throw new GameAPIError('Cube PvE node has no verified location', 'INVALID_CUBE_PVE_NODE');
    }
    const url = `${BASE_URL}/guild_dungeon_location.php?instance_id=${encodeURIComponent(instanceId)}&location_id=${encodeURIComponent(node.linkedLocationId)}`;
    const resp = await this.http.get(url);
    if (!resp.ok) throw new GameAPIError(`Cube PvE location failed: HTTP ${resp.status}`, 'CUBE_PVE_FETCH_FAILED');
    if (/That route is still sealed\./i.test(resp.text)) {
      throw new GameAPIError('That route is still sealed.', 'CUBE_PVE_NODE_SEALED');
    }
    const parsed = parseDungeonLocationPage(resp.text, {
      dungeonName: 'The Polyhedral Crucible', instanceId: Number(instanceId),
      locationId: Number(node.linkedLocationId), locationName: node.name, boss: node.type === 'boss',
    });
    if (!parsed.recognized) throw new GameAPIError('Cube PvE location markup was not recognized', 'CUBE_PVE_PARSE_FAILED');
    return parsed;
  }

  async getCubeSnapshot({ includeCleared = false, directoryInstances = null } = {}) {
    const cube = await this.getCubeHome({ directoryInstances });
    const allowedLocations = new Set(CUBE_PVE_LOCATION_IDS);
    const nodes = cube.nodes.filter(node => ['pve', 'boss'].includes(node.type)
      && (['available', 'in_progress'].includes(node.status) || (includeCleared && node.status === 'cleared'))
      && allowedLocations.has(Number(node.linkedLocationId)));
    const locations = [];
    const errors = [];
    for (const node of nodes) {
      try {
        locations.push(await this.getCubePveLocation(cube.instanceId, node));
      } catch (error) {
        errors.push({ nodeId: node.id, message: error.message });
      }
    }
    return {
      sourceAvailable: true,
      dungeon: { name: 'The Polyhedral Crucible', instanceId: cube.instanceId, active: true, cube: true },
      cube,
      locations: locations.map(({ monsters, ...location }) => location),
      monsters: locations.flatMap(location => location.monsters),
      resources: locations.find(location => location.resources?.hp)?.resources || {},
      errors,
      message: locations.length === 0 ? 'No accessible Cube PvE nodes are available.' : '',
    };
  }

  async getCubePvpNode(instanceId, nodeId) {
    if (!/^\d+$/.test(String(instanceId || '')) || !CUBE_PVP_NODES.some(node => node.id === Number(nodeId))) {
      throw new GameAPIError('Invalid Cube PvP node locator', 'INVALID_CUBE_PVP_NODE');
    }
    const url = `${BASE_URL}/pvp_style_node.php?source=cube&instance_id=${encodeURIComponent(instanceId)}&node_id=${encodeURIComponent(nodeId)}`;
    const resp = await this.http.get(url);
    if (!resp.ok) throw new GameAPIError(`Cube PvP node failed: HTTP ${resp.status}`, 'CUBE_PVP_NODE_FETCH_FAILED');
    if (/PvP-style node not found\./i.test(resp.text)) {
      throw new GameAPIError('PvP-style node not found.', 'CUBE_PVP_NODE_SEALED');
    }
    const parsed = parseCubePvpNodePage(resp.text, { instanceId, nodeId });
    if (!parsed.recognized) throw new GameAPIError('Cube PvP node markup was not recognized', 'CUBE_PVP_NODE_PARSE_FAILED');
    return parsed;
  }

  async joinCubePvpSlot(locator) {
    for (const field of ['instanceId', 'nodeId', 'matchNo', 'slotIndex']) {
      if (!/^\d+$/.test(String(locator?.[field] || ''))) throw new GameAPIError('Invalid Cube PvP slot locator', 'INVALID_CUBE_PVP_SLOT');
    }
    const resp = await this.http.post(`${BASE_URL}/pvp_style_action.php`, {
      source: 'cube', action: 'pick_slot', instance_id: locator.instanceId,
      node_id: locator.nodeId, match_no: locator.matchNo, slot_index: locator.slotIndex,
    }, { retries: 1 });
    if (!resp.ok) throw new GameAPIError(`Cube PvP join failed: HTTP ${resp.status}`, 'CUBE_PVP_JOIN_FAILED');
    let result;
    try { result = JSON.parse(resp.text); } catch { throw new GameAPIError('Cube PvP join returned invalid JSON', 'CUBE_PVP_JOIN_PARSE_FAILED'); }
    return { success: result.ok === true, message: String(result.message || ''), result };
  }

  async getCubePvpState(locator, sinceLogId = 0) {
    const url = `${BASE_URL}/pvp_style_state.php?source=cube&since_log_id=${encodeURIComponent(Math.max(0, Number(sinceLogId) || 0))}&instance_id=${encodeURIComponent(locator.instanceId)}&node_id=${encodeURIComponent(locator.nodeId)}&match_no=${encodeURIComponent(locator.matchNo)}`;
    const resp = await this.http.get(url);
    if (!resp.ok) throw new GameAPIError(`Cube PvP state failed: HTTP ${resp.status}`, 'CUBE_PVP_STATE_FETCH_FAILED');
    const parsed = parseCubePvpState(resp.text);
    if (!parsed.recognized) throw new GameAPIError('Cube PvP state response was not recognized', 'CUBE_PVP_STATE_PARSE_FAILED');
    return parsed;
  }

  async getMonsterPhasePvpState(activeId, sinceLogId = 0) {
    const normalizedId = this._requireNumericId(activeId, 'Monster phase active ID');
    const url = `${BASE_URL}/pvp_style_state.php?source=monster_phase&since_log_id=${encodeURIComponent(Math.max(0, Number(sinceLogId) || 0))}&active_id=${encodeURIComponent(normalizedId)}`;
    const resp = await this.http.get(url);
    if (!resp.ok) throw new GameAPIError(`Monster phase PvP state failed: HTTP ${resp.status}`, 'MONSTER_PHASE_PVP_STATE_FETCH_FAILED');
    const parsed = parseCubePvpState(resp.text);
    if (!parsed.recognized) throw new GameAPIError('Monster phase PvP state response was not recognized', 'MONSTER_PHASE_PVP_STATE_PARSE_FAILED');
    return parsed;
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

    const locations = [];
    for (const location of instance.locations) {
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
      locations.push(parsed);
    }
    return { dungeon, instance, locations };
  }

  async getDungeonSnapshot(dungeonName, { includePrevious = false, directoryInstances = null } = {}) {
    const wanted = String(dungeonName || '').trim().toLowerCase();
    if (!wanted) throw new GameAPIError('Dungeon name is required', 'INVALID_DUNGEON_NAME');
    const directory = Array.isArray(directoryInstances)
      ? directoryInstances
      : await this.getDungeonInstances();
    const available = directory
      .filter(entry => entry.name.trim().toLowerCase() === wanted);
    const selected = includePrevious
      ? available.filter(entry => entry.active === true
        || (entry.status === 'ended' && entry.guildLootState === 'pending')
        || entry.status === 'failed')
      : available.filter(entry => entry.active).slice(0, 1);
    if (selected.length === 0) {
      return { sourceAvailable: true, dungeon: null, locations: [], monsters: [], resources: {}, message: `${dungeonName} is not currently open.` };
    }

    const snapshots = [];
    const errors = [];
    // Historical instances and their locations may contain large pages. Read
    // them in order so one stale instance cannot fan out dozens of retained
    // response bodies or starve the shared discovery queue.
    for (const dungeon of selected) {
      try {
        snapshots.push(await this._getDungeonInstanceSnapshot(dungeon));
      } catch (error) {
        errors.push({ instanceId: dungeon.instanceId, message: error?.message || String(error) });
      }
    }
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
    const battle = parseBattlePage(resp.text);
    const stats = battle.monsterStats;
    if (!stats) {
      throw new GameAPIError('Battle page loaded but Monster Stats were missing', 'MONSTER_STATS_PARSE_FAILED');
    }
    return { ...stats, possibleLoot: battle.possibleLoot || [] };
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

  async useManaPotion(inventoryId, quantity = 1) {
    const result = await this._useConsumable(inventoryId, 'Mana', quantity);
    const restoredMatch = result.detail.match(/([\d,]+)\s+mana\b/i);
    const { detail, ...publicResult } = result;
    return {
      ...publicResult,
      manaRestored: restoredMatch ? Number(restoredMatch[1].replace(/,/g, '')) : null,
    };
  }

  async _useConsumable(inventoryId, resourceName = 'Consumable', quantity = 1) {
    const normalizedInventoryId = String(inventoryId ?? '').trim();
    if (!/^\d{1,30}$/.test(normalizedInventoryId)) {
      throw new GameAPIError(`Invalid ${resourceName} inventory ID`, 'INVALID_INVENTORY_ID');
    }
    const normalizedQuantity = Math.min(10, Math.max(1, Math.trunc(Number(quantity) || 1)));
    const body = new URLSearchParams({ inv_id: normalizedInventoryId });
    if (normalizedQuantity > 1) body.set('qty', String(normalizedQuantity));
    const url = `${BASE_URL}/use_item.php`;
    Logger.logApi(this.accountName, 'POST', url, null,
      `Using ${normalizedQuantity} discovered ${resourceName} potion${normalizedQuantity === 1 ? '' : 's'}`);
    const resp = await this.http.post(url, body);
    const message = String(resp.text || '').trim();
    const successMatch = message.match(/^Item consumed successfully!\s*\(([^()]{1,180});\s*used\s+(\d{1,2})x\)\s*$/i);
    const usedQuantity = successMatch ? Number(successMatch[2]) : 0;
    const result = {
      success: Boolean(successMatch),
      message: message.slice(0, 240),
      usedQuantity,
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

  async fetchAutoFarmState(area = {}) {
    const isEvent = Number.isInteger(Number(area.eventId)) && Number(area.eventId) > 0;
    const routeKey = isEvent ? 'event' : 'gate';
    const routeId = isEvent ? Number(area.eventId) : Number(area.gateId);
    const wave = Number(area.wave);
    if (!Number.isInteger(routeId) || routeId < 1 || !Number.isInteger(wave) || wave < 1) {
      throw new GameAPIError('A verified Gate or Event wave is required to read Auto Farm', 'INVALID_AUTO_FARM_AREA');
    }
    const url = `${BASE_URL}/active_wave.php?${routeKey}=${routeId}&wave=${wave}`;
    const resp = await this.http.get(url);
    if (!resp.ok) {
      throw new GameAPIError(`Failed to fetch Auto Farm: HTTP ${resp.status}`, 'AUTO_FARM_FETCH_FAILED');
    }
    const state = parseAutoFarmPanel(resp.text);
    if (!state.recognized) {
      throw new GameAPIError('Auto Farm wave page loaded but the verified panel was missing', 'AUTO_FARM_PARSE_FAILED');
    }
    return state;
  }

  async _autoFarmAction(action, fields = {}) {
    const allowedActions = new Set(['toggle', 'save_settings', 'add_target', 'update_target', 'remove_target']);
    if (!allowedActions.has(action)) throw new GameAPIError('Invalid Auto Farm action', 'INVALID_AUTO_FARM_ACTION');
    const body = new URLSearchParams({ action });
    for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
    const url = `${BASE_URL}/auto_farm_actions.php`;
    Logger.logApi(this.accountName, 'POST', url, null, `Auto Farm: ${action}`);
    const resp = await this.http.post(url, body, { retries: 1 });
    const data = this._parseJsonSafe(resp.text);
    const success = data?.ok === true;
    Logger.logApi(this.accountName, 'POST', url, resp.status, success ? data.msg || action : 'Auto Farm action failed');
    return { success, message: data?.msg || 'Invalid Auto Farm response' };
  }

  toggleAutoFarm(enabled) {
    return this._autoFarmAction('toggle', { enabled: enabled ? 1 : 0 });
  }

  saveAutoFarmSettings(settings = {}) {
    return this._autoFarmAction('save_settings', {
      TOTAL_MONSTERS_TO_KILL: settings.totalMonsters,
      HP_POTIONS_MAX_TO_USE: settings.hpPotionLimit,
      STAM_POT_SMALL_ITEM_MAX_TO_USE: settings.staminaPotionLimits?.small,
      STAM_POT_HALF_ITEM_ID_MAX_TO_USE: settings.staminaPotionLimits?.large,
      STAM_POT_FULL_ITEM_ID_MAX_TO_USE: settings.staminaPotionLimits?.full,
      STAM_POT_ADV_ITEM_MAX_TO_USE: settings.staminaPotionLimits?.adventure,
      STAM_POT_PRIORITY_ITEM_ID: settings.priorityItemId,
      AUTO_LOOT_TO_LEVEL: settings.autoLootToLevel ? 1 : 0,
      PRC_EXP_LEFT: settings.expLeftPercent,
    });
  }

  addAutoFarmTarget(target = {}) {
    return this._autoFarmAction('add_target', {
      MONSTER_ID: this._requireNumericId(target.monsterId, 'Auto Farm monster ID'),
      DAMAGE_OR_CAP: target.damageMode === 0 ? 0 : 1,
      MIN_DAMAGE: Math.max(0, Math.trunc(Number(target.minDamage) || 0)),
      IS_ENABLED: target.enabled === true ? 1 : 0,
      MAX_STACK_PER_HIT: Math.min(250, Math.max(1, Math.trunc(Number(target.maxStack) || 1))),
    });
  }

  updateAutoFarmTarget(target = {}) {
    return this._autoFarmAction('update_target', {
      TARGET_ID: this._requireNumericId(target.targetId, 'Auto Farm target ID'),
      MONSTER_ID: this._requireNumericId(target.monsterId, 'Auto Farm monster ID'),
      IS_ENABLED: target.enabled === true ? 1 : 0,
      DAMAGE_OR_CAP: target.damageMode === 0 ? 0 : 1,
      MIN_DAMAGE: Math.max(0, Math.trunc(Number(target.minDamage) || 0)),
      MAX_STACK_PER_HIT: Math.min(250, Math.max(1, Math.trunc(Number(target.maxStack) || 1))),
    });
  }

  removeAutoFarmTarget(targetId) {
    return this._autoFarmAction('remove_target', {
      TARGET_ID: this._requireNumericId(targetId, 'Auto Farm target ID'),
    });
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
  constructor(message, code, status = null) {
    super(message);
    this.name = 'GameAPIError';
    this.code = code;
    if (status !== null && status !== undefined) this.status = Number(status);
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

module.exports = { GameAPI, GameAPIError, isNoGuildResponse, isWaveAccessDenied };
