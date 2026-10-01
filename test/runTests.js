/**
 * Automated Unit Tests for Bot Modules
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { TimingEngine } = require('../src/scheduler/timingEngine');
const { ActionQueue, Priority } = require('../src/scheduler/actionQueue');
const { BotFSM, BotState } = require('../src/engine/fsm');
const { SessionManager } = require('../src/main/sessionManager');
const { CredentialManager } = require('../src/main/credentialManager');
const { ConfigManager, validateConfig, deepMerge } = require('../src/engine/configManager');
const {
  parseStatsPage,
  parseGates,
  parseWaveMonsters,
  parseWaveLootSummary,
  parseWavePlayerResources,
  parseMonsterStatsModal,
  parseBattlePage,
  parseGearInventoryPage,
  parsePetInventoryPage,
  parseClassSkillTreePage,
} = require('../src/engine/gameParsers');
const { canonicalNameKey, buildLoadoutSnapshot } = require('../src/engine/loadoutCatalog');
const { LoadoutService } = require('../src/engine/loadoutService');
const { AttackPlanner } = require('../src/engine/attackPlanner');
const { DamageObservationStore, createCombatContext, classifyAttackResult } = require('../src/engine/damageObservationStore');
const { listMonsterAreas, monsterTypeKey, selectGateMonster } = require('../src/engine/monsterCatalog');
const { StrategyEngine } = require('../src/engine/strategyEngine');
const { GameController } = require('../src/engine/gameController');
const { BattleManager } = require('../src/engine/battleManager');
const { BotEngine } = require('../src/engine/botEngine');
const { ActionExecutor } = require('../src/engine/actionExecutor');
const { ModuleRegistry } = require('../src/engine/moduleRegistry');
const { TargetLedger } = require('../src/engine/targetLedger');
const { ResourcePolicyEngine } = require('../src/engine/resourcePolicyEngine');
const { MonsterCatalogService } = require('../src/engine/monsterCatalogService');
const { HttpClient } = require('../src/engine/httpClient');
const { GameAPI } = require('../src/engine/gameAPI');
const { GameReader } = require('../src/engine/gameReader');
const { stateStore } = require('../src/engine/stateStore');

async function testTimingEngine() {
  console.log(' Testing TimingEngine...');
  const timing = new TimingEngine({ minDelay: 400, maxDelay: 800 });

  // Check bounds over 100 iterations
  for (let i = 0; i < 100; i++) {
    const delay = timing.getRandomDelay();
    assert(delay >= 400 && delay <= 800, `Delay ${delay} should be between 400 and 800`);
  }

  // Check micro delays
  for (let i = 0; i < 50; i++) {
    const micro = timing.getMicroDelay(30, 90);
    assert(micro >= 30 && micro <= 90, `Micro delay ${micro} should be between 30 and 90`);
  }

  // Check click offsets
  const offset = timing.getRandomClickOffset(200, 100);
  assert(offset.x >= 0 && offset.x <= 200, `Offset X ${offset.x} within bounds`);
  assert(offset.y >= 0 && offset.y <= 100, `Offset Y ${offset.y} within bounds`);

  const pacing = new TimingEngine({ minDelay: 10, maxDelay: 10 });
  const startedAt = Date.now();
  await Promise.all([pacing.waitForAction(), pacing.waitForAction()]);
  assert(Date.now() - startedAt >= 8, 'Concurrent actions must be serialized by the global pacing gate');

  console.log('   TimingEngine passed all checks.');
}

async function testActionQueue() {
  console.log(' Testing ActionQueue...');
  const timing = new TimingEngine({ minDelay: 10, maxDelay: 20 });
  const queue = new ActionQueue(timing);

  const executedOrder = [];

  queue.enqueue({
    type: 'LOOT',
    priority: Priority.LOOTING,
    execute: async () => { executedOrder.push('LOOT'); },
  });

  queue.enqueue({
    type: 'EMERGENCY_HEAL',
    priority: Priority.EMERGENCY,
    execute: async () => { executedOrder.push('EMERGENCY_HEAL'); },
  });

  queue.enqueue({
    type: 'ATTACK',
    priority: Priority.COMBAT,
    execute: async () => { executedOrder.push('ATTACK'); },
  });

  assert.strictEqual(queue.size, 3, 'Queue should have 3 items');

  // Process all items in priority order
  await queue.processNext();
  await queue.processNext();
  await queue.processNext();

  assert.deepStrictEqual(
    executedOrder,
    ['EMERGENCY_HEAL', 'ATTACK', 'LOOT'],
    'Actions must execute in priority order'
  );

  console.log('   ActionQueue passed priority test.');
}

async function testFSM() {
  console.log(' Testing BotFSM...');
  const fsm = new BotFSM(BotState.STOPPED);
  assert.strictEqual(fsm.state, BotState.STOPPED);

  const transitions = [];
  fsm.onTransition((next, prev, reason) => {
    transitions.push({ next, prev, reason });
  });

  fsm.transition(BotState.IDLE, 'Start');
  assert.strictEqual(fsm.state, BotState.IDLE);

  fsm.transition(BotState.SCANNING_GATES, 'Scan');
  fsm.transition(BotState.JOINING_BATTLE, 'Encounter');
  fsm.transition(BotState.ATTACKING, 'Joined');
  assert.strictEqual(fsm.state, BotState.ATTACKING);

  fsm.transition(BotState.CHALLENGE_WAIT, 'Captcha');
  assert.strictEqual(fsm.state, BotState.CHALLENGE_WAIT);

  assert.strictEqual(transitions.length, 5);
  assert.strictEqual(transitions[0].next, BotState.IDLE);
  assert.strictEqual(transitions[1].next, BotState.SCANNING_GATES);
  assert.strictEqual(transitions[3].next, BotState.ATTACKING);
  assert.strictEqual(transitions[4].next, BotState.CHALLENGE_WAIT);

  // Assert invalid state throws error
  assert.throws(() => {
    fsm.transition('INVALID_STATE');
  }, /Invalid bot state/);

  const stopped = new BotFSM();
  assert.throws(() => stopped.transition(BotState.ATTACKING), /Invalid bot transition/);

  console.log('   BotFSM passed state transitions test.');
}

async function testSessionManager() {
  console.log(' Testing SessionManager...');
  const testPath = path.join(__dirname, 'test_session.json');
  const sessionMgr = new SessionManager(testPath);

  if (fs.existsSync(testPath)) fs.unlinkSync(testPath);

  assert.strictEqual(sessionMgr.hasSavedSession(), false);

  // Create dummy session file with multi-account structure
  fs.writeFileSync(testPath, JSON.stringify({
    accounts: {
      'Hero1': {
        savedAt: new Date().toISOString(),
        cookies: [
          { name: 'test_token', value: 'stored-old', domain: 'demonicscans.org', path: '/' },
          { name: 'fresh_token', value: 'restore-me', domain: 'demonicscans.org', path: '/', hostOnly: true },
          { name: 'expired_token', value: 'skip-me', domain: 'demonicscans.org', path: '/', expirationDate: 1 },
        ]
      }
    }
  }));
  assert.strictEqual(sessionMgr.hasSavedSession(), true);

  const accounts = sessionMgr.listAccounts();
  assert.strictEqual(accounts.length, 1);
  assert.strictEqual(accounts[0].name, 'Hero1');

  const restored = [];
  const fakeSession = {
    cookies: {
      async get() {
        return [{ name: 'test_token', value: 'live-new', domain: 'demonicscans.org', path: '/' }];
      },
      async set(cookie) { restored.push(cookie); },
    },
  };
  const restoreResult = await sessionMgr.restoreAccountSession(fakeSession, 'Hero1');
  assert.strictEqual(restoreResult.preservedCount, 1, 'Newer persistent cookies must be preserved');
  assert.strictEqual(restoreResult.skippedExpired, 1, 'Expired stored cookies must not be restored');
  assert.deepStrictEqual(restored.map(cookie => cookie.name), ['fresh_token']);
  assert.strictEqual(Object.hasOwn(restored[0], 'domain'), false, 'Host-only cookies must not be restored as domain cookies');

  sessionMgr.deleteAccount('Hero1');
  assert.strictEqual(sessionMgr.hasSavedSession(), false);

  sessionMgr.clearSession();
  assert.strictEqual(sessionMgr.hasSavedSession(), false);

  console.log('   SessionManager passed persistence & multi-account test.');
}

async function testCredentialManager() {
  console.log(' Testing encrypted credential persistence...');
  const testPath = path.join(__dirname, 'test_credentials.json');
  if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`sealed:${value}`, 'utf8'),
    decryptString: value => value.toString('utf8').slice('sealed:'.length),
  };
  const manager = new CredentialManager(fakeSafeStorage, testPath);
  assert.strictEqual(manager.save('Hero1', 'hero@example.test', 'not-written-in-plaintext'), true);
  const disk = fs.readFileSync(testPath, 'utf8');
  assert(!disk.includes('hero@example.test'));
  assert(!disk.includes('not-written-in-plaintext'));
  assert.deepStrictEqual(manager.get('Hero1'), {
    accountName: 'Hero1',
    email: 'hero@example.test',
    password: 'not-written-in-plaintext',
  });
  assert.strictEqual(manager.delete('Hero1'), true);
  assert.strictEqual(manager.get('Hero1'), null);
  const insecureManager = new CredentialManager({
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'basic_text',
  }, testPath);
  assert.strictEqual(insecureManager.save('Hero1', 'hero@example.test', 'secret'), false);
  if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
  console.log('   CredentialManager stores only encrypted credential blobs.');
}

async function testLiveStaminaRelay() {
  console.log(' Testing live stamina relay...');
  stateStore.setAccount('LiveStateUser');
  stateStore.update({ stamina: { current: 400, max: 654 }, totalStamina: 654 });
  const reader = new GameReader({
    isDestroyed: () => false,
    async executeJavaScript() {
      return {
        isConnected: true,
        url: 'https://demonicscans.org/game_dash.php',
        title: 'Dashboard',
        hasCloudflare: false,
        isLoginPage: false,
        stamina: { current: 321, max: 654 },
        hp: { current: 15000, max: 20000 },
        mp: { current: 100, max: 200 },
        monsterHp: null,
        monsterHpPercent: null,
        battleId: null,
      };
    },
  }, null, null, 'LiveStateUser');
  const backgroundState = await reader.readState();
  assert.deepStrictEqual(
    backgroundState.player.stamina,
    { current: 400, max: 654, text: '400 / 654' },
    'A stale hidden-page value must not replace authoritative Stats during a background read'
  );
  const state = await reader.readState({ syncStamina: true });
  assert.deepStrictEqual(state.player.stamina, { current: 321, max: 654, text: '321 / 654' });
  assert.strictEqual(state.player.totalStamina, 654);
  assert.deepStrictEqual(state.player.hp, { current: 15000, max: 20000 });
  assert.deepStrictEqual(state.player.mp, { current: 100, max: 200 });

  const serverReader = new GameReader(null, {
    async fetchStats() { return { level: 10, attack: 20, defense: 30, stamina: 40, maxStamina: 50 }; },
    async fetchDashboard() { return { gold: '60', gems: '70' }; },
    async fetchPlayerResources() { return { hp: { current: 800, max: 1000 }, mp: { current: 90, max: 120 } }; },
  }, null, 'LiveStateUser');
  const serverState = await serverReader.fetchStatsNow();
  assert.deepStrictEqual(serverState.hp, { current: 800, max: 1000 });
  assert.deepStrictEqual(serverState.mp, { current: 90, max: 120 });
  console.log('   Verified only explicit DOM mutation reads replace authoritative stamina.');
}

async function testLogger() {
  console.log(' Testing Logger (Client Logs & API Logging)...');
  const { Logger } = require('../src/main/logger');
  
  Logger.logUser('TestUser', 'Clicked Start');
  Logger.logClient('TestUser', 'Starting bot client');
  Logger.logApi('TestUser', 'GET', 'https://demonicscans.org/stats.php', 200, 'OK');
  Logger.logClient('TestUser', 'csrf_token=super-secret-value');

  // Allow async file write
  await new Promise(r => setTimeout(r, 100));

  const userLogs = Logger.getUserLogs('TestUser');
  assert(userLogs.includes('[USER] Clicked Start'), 'User logs should contain user action');

  const clientLogs = Logger.getClientLogs('TestUser');
  assert(clientLogs.includes('[CLIENT] Starting bot client'), 'Client logs should contain client action');
  assert(clientLogs.includes('[API] GET https://demonicscans.org/stats.php [Status: 200] - OK'), 'Client logs should contain API log');
  assert(!clientLogs.includes('super-secret-value'), 'Client logs must redact sensitive tokens');

  console.log('   Logger passed User & Client API logging tests.');
}

async function testMangaManager() {
  console.log(' Testing MangaManager...');
  const { MangaManager } = require('../src/main/mangaManager');
  const testDir = path.join(__dirname, 'test_manga_data');
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const mm = new MangaManager(testDir);
  assert.deepStrictEqual(mm.getList(), [], 'List should initially be empty');

  const norm1 = mm.normalizeInput('The-Investor-Who-Sees-The-Future');
  assert.strictEqual(norm1.slug, 'The-Investor-Who-Sees-The-Future');
  assert.strictEqual(norm1.url, 'https://demonicscans.org/manga/The-Investor-Who-Sees-The-Future');

  const norm2 = mm.normalizeInput('https://demonicscans.org/manga/Solo-Leveling');
  assert.strictEqual(norm2.slug, 'Solo-Leveling');
  assert.strictEqual(norm2.url, 'https://demonicscans.org/manga/Solo-Leveling');

  // Test manual save & delete
  mm.saveList([
    { slug: 'test-manga-1', title: 'Test Manga 1', url: 'http://test1', chapters: 10 },
    { slug: 'test-manga-2', title: 'Test Manga 2', url: 'http://test2', chapters: 20 },
  ]);
  assert.strictEqual(mm.getList().length, 2);

  // Per-account farmed count
  mm.incrementFarmedCount('User1', 'test-manga-1');
  mm.incrementFarmedCount('User1', 'test-manga-1');
  const user1List = mm.getAccountMangaList('User1');
  assert.strictEqual(user1List[0].farmedCount, 2, 'User1 farmedCount should be 2');

  const user2List = mm.getAccountMangaList('User2');
  assert.strictEqual(user2List[0].farmedCount, 0, 'User2 farmedCount should be 0');

  // Per-account delete (hiddenSlugs)
  mm.deleteManga('test-manga-1', 'User1');
  const user1ListAfterDelete = mm.getAccountMangaList('User1');
  assert.strictEqual(user1ListAfterDelete.length, 1, 'User1 should now see only 1 manga');
  assert.strictEqual(user1ListAfterDelete[0].slug, 'test-manga-2');

  const user2ListAfterDelete = mm.getAccountMangaList('User2');
  assert.strictEqual(user2ListAfterDelete.length, 2, 'User2 should still see both manga');

  // Farm Settings persistence
  mm.saveAccountFarmSettings('User1', { maxStamina: 800, stopHourly: 15 });
  const settings = mm.getAccountFarmSettings('User1');
  assert.strictEqual(settings.maxStamina, 800);
  assert.strictEqual(settings.stopHourly, 15);

  // Clean up
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('   MangaManager passed all normalization, per-account, settings, and list tests.');
}

async function testStaminaFormula() {
  console.log(' Testing Stamina Formula Calculations...');
  // Level: 225, Attack: 240, Defense: 10, Total Stamina: 925
  const level = 225;
  const attack = 240;
  const defense = 10;
  const totalStamina = 925;

  // Hourly: [40 + (level / 50) + ((ATTACK + DEFENSE) / 100)]
  // 40 + (225 / 50 = 4.5) + (250 / 100 = 2.5) = 47
  const baseHourly = 40 + (level / 50) + ((attack + defense) / 100);
  const hourly = Math.floor(baseHourly);
  assert.strictEqual(hourly, 47, `Hourly stamina for lv225, 240 atk, 10 def should be 47, got ${hourly}`);

  // 12-hour: [40 + (level / 50) + ((ATTACK + DEFENSE) / 100)] + (TOTAL STAMINA / 2)
  // 47 + (925 / 2 = 462.5) = 509.5 -> floor = 509
  const twelveHour = Math.floor(baseHourly + (totalStamina / 2));
  assert.strictEqual(twelveHour, 509, `12h stamina for 925 total stamina should be 509, got ${twelveHour}`);

  console.log('   Stamina formulas verified successfully with game values.');
}

async function testChapterFarmer() {
  console.log(' Testing ChapterFarmer (Regex extraction & Reaction types)...');
  const { ChapterFarmer } = require('../src/engine/chapterFarmer');

  // Test Chapter ID extraction from sample demonicscans HTML/JS snippets
  const sample1 = `formData.append('chapterid', '83878');`;
  assert.strictEqual(ChapterFarmer.extractChapterId(sample1), '83878', 'Should extract from formData.append');

  const sample2 = `<div id="comment_box" onclick="submitcomment(1234, 99482, 'user')"></div>`;
  assert.strictEqual(ChapterFarmer.extractChapterId(sample2), '99482', 'Should extract from submitcomment');

  const sample3 = `<div data-chapter-id="44912">Chapter 44</div>`;
  assert.strictEqual(ChapterFarmer.extractChapterId(sample3), '44912', 'Should extract from data-chapter-id');

  const sample4 = `cookie: reacted_chap_1468=1; reacted_chap_344694=1;`;
  assert.strictEqual(ChapterFarmer.extractChapterId(sample4), '1468', 'Should extract from reacted_chap');

  // Test reaction type resolution
  assert.strictEqual(ChapterFarmer.resolveReactionType('1'), 1);
  assert.strictEqual(ChapterFarmer.resolveReactionType('2'), 2);
  assert.strictEqual(ChapterFarmer.resolveReactionType('3'), 3);
  assert.strictEqual(ChapterFarmer.resolveReactionType('4'), 4);
  assert.strictEqual(ChapterFarmer.resolveReactionType('5'), 5);
  const randomReaction = ChapterFarmer.resolveReactionType('random');
  assert(randomReaction >= 1 && randomReaction <= 5, 'Random reaction should be between 1 and 5');

  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'chapter_reaction.html'), 'utf8');
  assert.strictEqual(ChapterFarmer.hasUserUidContract(fixture), true, 'Saved chapter fixture should expose the useruid contract');
  const generatedUserId = ChapterFarmer.generateUserUid(1787000000000);
  assert(/^uid-[a-z0-9]{16}1787000000000$/.test(generatedUserId), 'Generated useruid must match the verified page format');

  const posted = [];
  const createdCookies = [];
  const farmer = new ChapterFarmer({
    async get() { return { ok: true, status: 200, text: fixture }; },
    async getCookies() { return []; },
    async setCookie(cookie) { createdCookies.push(cookie); },
    async postMultipart(url, body) { posted.push({ url, body }); return { ok: true, status: 200, text: 'Reaction updated' }; },
  }, { async waitForAction() {} });
  const farmResult = await farmer.farmSingleChapter('User', 'Test-Manga', 1, '1');
  assert.strictEqual(farmResult.success, true);
  assert.strictEqual(createdCookies[0].name, 'useruid');
  assert(posted[0].body.useruid.startsWith('uid-'), 'Reaction payload must include the created useruid');

  console.log('   ChapterFarmer passed extraction and resolution tests.');
}

async function testFarmedEnergyExtraction() {
  console.log(' Testing Farmed Energy Extraction regex and parsing...');
  const sampleHtml = `
    <div class="stamina-wrap">
      <div class="stamina-pill"><span class="val">500 / 925</span></div>
      <div class="stamina-pill"><span class="val">400 / 1,000</span></div>
    </div>
  `;
  const pillMatch = sampleHtml.match(/class=["']?val["']?[^>]*>([0-9,]+)\s*\/\s*1,?000/i);
  assert(pillMatch, 'Should match stamina pill with 1000 limit');
  assert.strictEqual(parseInt(pillMatch[1].replace(/,/g, ''), 10), 400, 'Parsed energy should be 400');
  console.log('   Farmed Energy Extraction test passed.');
}

async function testConfiguration() {
  console.log(' Testing canonical bot configuration...');
  const merged = deepMerge({ nested: { left: 1, right: 2 } }, { nested: { right: 3 } });
  assert.deepStrictEqual(merged, { nested: { left: 1, right: 3 } });

  const validated = validateConfig({
    general: { module: 'gates', map: 'grakthar_3' },
    combat: { staminaReserve: -10, attackDelayMs: { min: 100, max: 50 } },
    healing: { hpThresholdPercent: 500 },
    looting: {
      module: 'unknown',
      maps: {
        grakthar_1: {
          goblin_skirmisher: { name: 'Goblin Skirmisher', priority: 3, maxLooting: 25, enabled: true },
        },
        invented_area: { monster: { name: 'Rejected', priority: 1 } },
      },
    },
    equipment: {
      gear: { pve: 'quick_set_10', pvpAttack: 'quick_set_99' },
      pets: { pvpDefense: 'quick_set_4' },
    },
    monsters: {
      maps: {
        grakthar_1: {
          goblin_skirmisher: { name: 'Goblin Skirmisher', targetDamage: 3000000, killCount: 100, priority: 7, minimumHp: 500000, completedCount: 2, completedInstanceIds: ['123', '123', 'bad'], gearSet: 'quick_set_3', petSet: 'quick_set_11', staminaPotion: 'large', enabled: false },
          '__proto__': { name: 'Rejected' },
        },
        invented_area: { monster: { name: 'Rejected' } },
      },
    },
    resources: {
      stamina: { spendInRed: true, redGate: 'grakthar_3', redMonster: 'Goblin Skirmisher', redTargetDamage: 9000, keepMin: 50, keepMax: 20, stopBelow: 10, allowPotions: true, potionLimits: { small: 3, large: 2, full: 1, adventure: -4 } },
      health: { keepMin: 100, keepMax: 500, sleepBelow: 80, maxDeaths: 2, usePotions: true, maxPotions: 4, buyPotionIfNeeded: true, maxSpendGold: 150000, spentGold: 60000, purchasedCount: 2 },
      mana: { allowAbilities: true, potion: 'large', potionLimits: { small: 3, large: 2 }, keepMin: 20, keepMax: 200, stopBelow: 15, buyPotionIfNeeded: true, maxSpendGold: 240000, spentGold: 60000, purchasedCount: 1 },
    },
    safety: { dryRun: false },
  });
  assert.strictEqual(validated.combat.staminaReserve, 0);
  assert.strictEqual(validated.combat.attackDelayMs.min, 500);
  assert(validated.combat.attackDelayMs.max >= validated.combat.attackDelayMs.min);
  assert.deepStrictEqual(validated.combat.attackStrategy, {
    mode: 'fixed', fixedMultiplier: 1, maxMultiplier: 200, overshootPercent: 10,
    failSafeEnabled: false, failSafePercent: 80, requireTargetStamina: false,
    nukeEnabled: false, nukeAttack: 'auto', nukeAllowAbilities: false,
  });
  assert.strictEqual(validated.combat.allowAbilities, false);
  assert.strictEqual(validated.combat.abilityUsage, undefined);
  const adaptiveConfig = validateConfig({
    combat: { abilityUsage: 'adaptive', allowedAbilityIds: [6, '6', 9, -1, 'bad'], attackStrategy: { mode: 'adaptive', fixedMultiplier: 1000, maxMultiplier: 50, overshootPercent: 999 } },
  });
  assert.deepStrictEqual(adaptiveConfig.combat.attackStrategy, {
    mode: 'adaptive', fixedMultiplier: 1000, maxMultiplier: 50, overshootPercent: 500,
    failSafeEnabled: false, failSafePercent: 80, requireTargetStamina: false,
    nukeEnabled: false, nukeAttack: 'auto', nukeAllowAbilities: false,
  });
  assert.strictEqual(adaptiveConfig.combat.allowAbilities, true);
  assert.deepStrictEqual(adaptiveConfig.combat.allowedAbilityIds, [6, 9]);
  assert.strictEqual(adaptiveConfig.combat.abilityUsage, undefined);
  assert.strictEqual(validated.healing.hpThresholdPercent, 100);
  assert.strictEqual(validated.looting.module, 'none');
  assert.deepStrictEqual(validated.looting.maps.grakthar_1.goblin_skirmisher, {
    name: 'Goblin Skirmisher',
    priority: 3,
    maxLooting: 25,
    unlimited: false,
    lootedCount: 0,
    lootedInstanceIds: [],
    enabled: true,
  });
  assert.strictEqual(validated.looting.maps.invented_area, undefined);
  assert.deepStrictEqual(validated.general, {
    module: 'gates',
    map: 'grakthar_3',
    primaryGateMap: 'grakthar_3',
    gateMap: 'grakthar_3',
    dungeonMap: 'shadowbridge_warrens',
    eventMap: 'event_black_crown_ascends',
  });
  assert.strictEqual(validated.equipment.gear.pve, 'quick_set_10');
  assert.strictEqual(validated.equipment.gear.pvpAttack, 'default');
  assert.strictEqual(validated.equipment.pets.pvpDefense, 'quick_set_4');
  assert.deepStrictEqual(validated.monsters.maps.grakthar_1.goblin_skirmisher, {
    name: 'Goblin Skirmisher',
    targetDamage: 3000000,
    killCount: 100,
    unlimited: false,
    priority: 7,
    minimumHp: 500000,
    completedCount: 2,
    completedInstanceIds: ['123'],
    gearSet: 'quick_set_3',
    petSet: 'default',
    allowAbilities: false,
    staminaPotion: 'large',
    enabled: false,
  });
  assert.strictEqual(validated.monsters.maps.invented_area, undefined);
  assert.strictEqual(validated.resources.stamina.redGate, undefined);
  assert.strictEqual(validated.resources.stamina.redMonster, undefined);
  assert.deepStrictEqual(validated.resources.stamina.potionLimits, { small: 3, large: 2, full: 1, adventure: 0 });
  assert.strictEqual(validated.resources.stamina.keepMax, 50, 'Stamina range maximum must not fall below minimum');
  assert.strictEqual(validated.resources.health.keepMax, undefined);
  assert.strictEqual(validated.resources.mana.keepMax, 200);
  assert.strictEqual(validated.resources.health.buyPotionIfNeeded, true);
  assert.strictEqual(validated.resources.health.maxPurchases, 5, 'Legacy Health gold caps must migrate to purchase counts');
  assert.strictEqual(validated.resources.health.purchasedCount, 2);
  assert.strictEqual(validated.resources.health.maxSpendGold, undefined);
  assert.strictEqual(validated.resources.health.spentGold, undefined);
  assert.strictEqual(validated.resources.mana.allowPotions, true, 'Legacy Mana potion selection must enable potion use');
  assert.deepStrictEqual(validated.resources.mana.potionLimits, { small: 3, large: 2 });
  assert.strictEqual(validated.resources.mana.maxPurchases, 4, 'Legacy Mana gold caps must migrate to purchase counts');
  assert.strictEqual(validated.resources.mana.potion, undefined);
  assert.strictEqual(validated.safety.dryRun, false);
  assert(validated.scheduler.minActionsPerSecond > 0);
  assert(validated.scheduler.maxActionsPerSecond >= validated.scheduler.minActionsPerSecond);

  const configPath = path.join(__dirname, 'test_bot_config.json');
  if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  const manager = new ConfigManager(configPath);
  manager.update({
    gates: { targetGate: 7 },
    looting: { module: 'gates' },
    equipment: { gear: { pve: 'quick_set_3' } },
    monsters: { maps: { olympus_zeus: { thunder_guard: { name: 'Thunder Guard', killCount: 20 } } } },
    safety: { dryRun: true },
  });
  const reloaded = new ConfigManager(configPath).getConfig();
  assert.strictEqual(reloaded.gates.targetGate, 7);
  assert.strictEqual(reloaded.combat.preferredSkill, 'slash');
  assert.strictEqual(reloaded.looting.module, 'gates');
  assert.strictEqual(reloaded.equipment.gear.pve, 'quick_set_3');
  assert.strictEqual(reloaded.equipment.pets.pve, 'default');
  assert.strictEqual(reloaded.monsters.maps.olympus_zeus.thunder_guard.killCount, 20);
  assert.strictEqual(reloaded.monsters.maps.olympus_zeus.thunder_guard.priority, 0);
  assert.strictEqual(reloaded.monsters.maps.olympus_zeus.thunder_guard.minimumHp, 0);
  assert.strictEqual(reloaded.monsters.maps.olympus_zeus.thunder_guard.completedCount, 0);
  assert.strictEqual(reloaded.monsters.maps.olympus_zeus.thunder_guard.enabled, false);
  assert.strictEqual(reloaded.safety.dryRun, true);
  fs.unlinkSync(configPath);
  console.log('   Canonical configuration passed validation and persistence tests.');
}

async function testResourcePolicyEngine() {
  console.log(' Testing resource policy quantity limits...');
  const policy = new ResourcePolicyEngine({
    resources: {
      stamina: { allowPotions: true, potionLimits: { small: 2, large: 1, full: 0, adventure: 3 } },
      health: { buyPotionIfNeeded: true, maxPurchases: 2, purchasedCount: 1 },
      mana: { allowPotions: true, potionLimits: { small: 2, large: 1 }, buyPotionIfNeeded: true, maxPurchases: 1, purchasedCount: 1 },
    },
  });
  const health = policy.canPurchase('health', { gold: 30000 });
  assert.strictEqual(health.allowed, true);
  assert.deepStrictEqual({ offer: health.offer, qty: health.qty, unitCost: health.unitCost }, { offer: 'hp_potion', qty: 1, unitCost: 30000 });
  assert.strictEqual(policy.canPurchase('health', { gold: 29999 }).allowed, false);
  assert.strictEqual(policy.canPurchase('mana', { gold: 999999 }).reason, 'Purchase limit reached');
  assert.strictEqual(policy.canUseStaminaPotion('small', 1).allowed, true);
  assert.strictEqual(policy.canUseStaminaPotion('small', 2).reason, 'Potion limit reached');
  assert.strictEqual(policy.canUseStaminaPotion('full', 0).reason, 'Potion limit is zero');
  assert.strictEqual(policy.canUseStaminaPotion('invented', 0).allowed, false);
  assert.strictEqual(policy.canUseManaPotion('small', 1).allowed, true);
  assert.strictEqual(policy.canUseManaPotion('large', 1).reason, 'Potion limit reached');
  assert.strictEqual(policy.canUseManaPotion('invented', 0).allowed, false);
  console.log('   Resource policy caps passed.');
}

async function testGameParsers() {
  console.log(' Testing verified game HTML parsers...');
  const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const stats = parseStatsPage(fixture('stats.html'));
  assert.deepStrictEqual(
    { stamina: stats.stamina, maxStamina: stats.maxStamina, attack: stats.attack, defense: stats.defense },
    { stamina: 424, maxStamina: 1005, attack: 240, defense: 85 }
  );
  assert.strictEqual(stats.gold, '755.229K');
  assert.strictEqual(stats.gems, '2.287K');

  const gates = parseGates(fixture('gates.html'));
  assert.strictEqual(gates.length, 2);
  assert.strictEqual(gates[0].url, 'active_wave.php?gate=3&wave=8');
  assert.strictEqual(gates[0].active, true);
  assert.strictEqual(gates[0].recommendedLevel, 200);

  const monsters = parseWaveMonsters(fixture('wave.html'));
  assert.strictEqual(monsters.length, 2);
  assert.strictEqual(monsters[0].id, '540971170');
  assert.strictEqual(monsters[0].hp, 145770);
  assert.strictEqual(monsters[0].joined, true);
  assert.strictEqual(monsters[1].dead, true);

  const waveResourcesFixture = fixture('wave_resources.html');
  const resources = parseWavePlayerResources(waveResourcesFixture);
  assert.deepStrictEqual(resources, { hp: { current: 15000, max: 20000 }, mp: { current: 100, max: 200 } });
  const namedMonsters = parseWaveMonsters(waveResourcesFixture);
  assert.strictEqual(namedMonsters[0].name, 'Goblin Skirmisher', 'Visible monster heading should preserve display capitalization');
  assert.strictEqual(monsterTypeKey(namedMonsters[0].name), 'goblin_skirmisher');

  const lootSummary = parseWaveLootSummary(fixture('lootable_wave.html'));
  assert.strictEqual(lootSummary.recognized, true);
  assert.strictEqual(lootSummary.reportedUnclaimed, 22);
  assert.strictEqual(lootSummary.visibleLootable, 22);
  assert.strictEqual(lootSummary.visibleLootActions, 3);
  assert.deepStrictEqual(lootSummary.lootableMonsters.map(monster => monster.stackSize), [20, 1, 1]);
  assert.deepStrictEqual(
    lootSummary.lootableMonsters.map(monster => monster.name),
    ['Lizardman Bloodpriest', 'Lizardman Bloodpriest', 'Lizardman Warmage'],
    'Only dead, eligible monsters with an explicit Loot action may be counted',
  );

  const monsterStats = parseMonsterStatsModal(fixture('monster_stats_modal.html'));
  assert.deepStrictEqual(monsterStats, {
    name: 'Lizardman Vanguard',
    attack: 300,
    defense: 300,
    petDefense: 150,
    equipmentDefense: 150,
    element: 'None',
    elementRatePercent: 0,
    rewardsUpToLevel: 4500,
    resistances: {
      critRatePercent: 0,
      critDamagePercent: 0,
      finalDamagePercent: 0,
      passiveDamagePercent: 0,
    },
  });

  const monsterAreas = listMonsterAreas();
  assert.strictEqual(monsterAreas.length, 16);
  assert.deepStrictEqual(monsterAreas.find(area => area.key === 'grakthar_2'), {
    key: 'grakthar_2', label: 'Grakthar 2', type: 'gate', gateId: 3, wave: 5,
  });
  assert.deepStrictEqual(
    monsterAreas.filter(area => area.type === 'gate').map(area => [area.label, area.gateId, area.wave]),
    [
      ['Grakthar 1', 3, 3], ['Grakthar 2', 3, 5], ['Grakthar 3', 3, 8],
      ['Olympus 1', 5, 9], ['Olympus Hermes', 5, 10], ['Olympus Artemis', 5, 11],
      ['Olympus Poseidon', 5, 12], ['Olympus Ares', 5, 13], ['Olympus Apollo', 5, 14],
      ['Olympus Athena', 5, 15], ['Olympus Hera', 5, 16], ['Olympus Zeus', 5, 17],
    ],
  );
  assert.strictEqual(monsterAreas.filter(area => area.type === 'dungeon').length, 3);

  const targetConfig = {
    alpha: { name: 'Alpha', enabled: true, targetDamage: 1000, killCount: 2, completedCount: 0, priority: 1, minimumHp: 100 },
    beta: { name: 'Beta', enabled: true, targetDamage: 1000, killCount: 2, completedCount: 0, priority: 0, minimumHp: 100 },
    disabled: { name: 'Disabled', enabled: false, targetDamage: 1000, killCount: 2, completedCount: 0, priority: 0, minimumHp: 0 },
  };
  const selected = selectGateMonster([
    { id: 1, name: 'Alpha', hp: 500, userDmg: 0 },
    { id: 2, name: 'Beta', hp: 500, userDmg: 0 },
    { id: 3, name: 'Disabled', hp: 500, userDmg: 0 },
  ], targetConfig, 1);
  assert.strictEqual(selected.name, 'Beta', 'Lower numeric priority must be selected first');
  assert.strictEqual(selectGateMonster([{ id: 4, name: 'Beta', hp: 99, userDmg: 0 }], targetConfig, 1), null, 'Minimum HP must filter low-current-HP instances');
  assert.strictEqual(selectGateMonster([{ id: 5, name: 'Beta', hp: 500, userDmg: 1000 }], targetConfig, 1), null, 'Reached damage targets must not be attacked again');

  const battle = parseBattlePage(fixture('battle.html'));
  assert.strictEqual(battle.battleCfg.id, 540970643);
  assert.strictEqual(battle.battleCfg.endpoints.ATTACK, 'damage.php');
  assert.strictEqual(battle.userId, 32448);
  assert.strictEqual(battle.monsterHp, 502473);
  assert.strictEqual(battle.playerHp, 15530);
  assert.deepStrictEqual(battle.skills.map(skill => skill.id), [-1, 0]);
  const skillTree = parseClassSkillTreePage(fixture('class_skill_tree_hunter.html'));
  assert.strictEqual(skillTree.recognized, true);
  assert.strictEqual(skillTree.className, 'Hunter');
  assert.strictEqual(skillTree.classPassive, '-30% Defense + 20% crit damage');
  assert.deepStrictEqual(skillTree.unlockedSkills.map(skill => [skill.id, skill.name, skill.manaCost, skill.staminaCost]), [
    [6, 'Back Stab', 20, 200],
  ]);
  console.log('   Verified game HTML parsers passed fixture tests.');
}

async function testLoadoutCatalog() {
  console.log(' Testing Gear/Pet catalog parsing and deterministic loadout hashing...');
  const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const gear = parseGearInventoryPage(fixture('gear_inventory.html'));
  const pets = parsePetInventoryPage(fixture('pet_inventory.html'));

  assert.strictEqual(gear.recognized, true);
  assert.strictEqual(gear.context, 'attack');
  assert.strictEqual(gear.definitions.length, 3);
  assert.strictEqual(gear.instances.length, 3);
  assert.strictEqual(gear.equipped.length, 2);
  const weapon = gear.equipped.find(item => item.name === 'Scalescourge');
  assert.strictEqual(weapon.definitionKey, 'gear:scalescourge');
  assert.strictEqual(weapon.inventoryRef, 'owned-weapon');
  assert.strictEqual(weapon.itemReference, '49');
  assert.strictEqual(weapon.level, 3);
  assert.deepStrictEqual(weapon.effects, [
    { type: 'damage_percent', target: 'dragons', percent: 14 },
    { type: 'damage_percent', target: 'monsters', percent: 14 },
  ]);
  assert.strictEqual(gear.instances.find(item => item.name === 'Ember Stained Band').quantity, 2);

  assert.strictEqual(pets.recognized, true);
  assert.strictEqual(pets.context, 'attack');
  assert.strictEqual(pets.definitions.length, 2);
  assert.strictEqual(pets.instances.length, 2, 'Equipped and inventory copies must be deduplicated by owned reference');
  assert.strictEqual(pets.equipped.length, 1);
  assert.strictEqual(pets.equipped[0].definitionKey, 'pet:moon_panda');
  assert.deepStrictEqual(pets.equipped[0].effects, [
    { type: 'damage_percent', target: 'monsters', percent: 20.67 },
  ]);
  const owl = pets.instances.find(item => item.name === 'Glaukon The Aegis Owl');
  assert.deepStrictEqual(owl.effects, [], 'Unmodeled abilities must remain raw, not be guessed');
  assert.deepStrictEqual(owl.sigils.find(sigil => sigil.type === 'attack'), {
    type: 'attack', filled: true, text: 'Attack Sigil +5 ATK',
  });
  assert.strictEqual(canonicalNameKey("Ophion's Crown", 'gear'), 'gear:ophions_crown');

  const first = buildLoadoutSnapshot({ gear, pets, accountName: 'Account A', observedAt: '2026-01-01T00:00:00.000Z' });
  assert.deepStrictEqual(first.totals, {
    gear: { attack: 260, defense: 60 },
    pets: { attack: 426, defense: 0 },
    combined: { attack: 686, defense: 60 },
  });
  assert.match(first.hash.value, /^[a-f0-9]{64}$/);
  const reordered = buildLoadoutSnapshot({
    gear: { ...gear, equipped: [...gear.equipped].reverse() },
    pets: { ...pets, equipped: [...pets.equipped].reverse() },
    accountName: 'Account B',
    observedAt: '2027-02-02T00:00:00.000Z',
  });
  assert.strictEqual(reordered.hash.value, first.hash.value, 'Hash must ignore read time, account label, and source order');
  const changed = buildLoadoutSnapshot({
    gear: { ...gear, equipped: gear.equipped.map((item, index) => index === 0 ? { ...item, attack: item.attack + 1 } : item) },
    pets,
  });
  assert.notStrictEqual(changed.hash.value, first.hash.value, 'A resolved stat change must produce another hash');

  let gearReads = 0;
  let petReads = 0;
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const service = new LoadoutService({
    async getGearInventory(context) { gearReads++; assert.strictEqual(context, 'attack'); return gear; },
    async getPetInventory(context) { petReads++; assert.strictEqual(context, 'attack'); return pets; },
  }, 'Account A', { mode: 'legacy', cacheMaxAgeMs: 1000, now: () => now });
  const [resolvedA, resolvedB] = await Promise.all([service.getActiveLoadout(), service.getActiveLoadout()]);
  assert.strictEqual(resolvedA.hash.value, resolvedB.hash.value);
  assert.strictEqual(gearReads, 1, 'Concurrent reads must be coalesced');
  assert.strictEqual(petReads, 1, 'Concurrent reads must be coalesced');
  resolvedA.gear.equipped[0].attack = -1;
  assert.notStrictEqual((await service.getActiveLoadout()).gear.equipped[0].attack, -1, 'Cached snapshots must be cloned');
  now += 1001;
  const refreshed = await service.getActiveLoadout();
  assert.strictEqual(gearReads, 2, 'Expired cache must be refreshed');
  assert.strictEqual(service.getSnapshot(refreshed.hash.value).hash.value, refreshed.hash.value);
  await service.getActiveLoadout({ force: true });
  assert.strictEqual(gearReads, 3, 'Forced refresh must bypass a fresh cache');
  await assert.rejects(() => service.getActiveLoadout({ gearContext: 'invented' }), /Unknown loadout context/);

  console.log('   Gear/Pet catalogs preserve raw effects and resolve stable SHA-256 loadout identities.');
}

async function testDamageObservationsAndAttackPlanner() {
  console.log(' Testing damage observations and conservative attack planning...');
  const directory = path.join(__dirname, 'test_damage_observations');
  const storePath = path.join(directory, 'observations.json');
  if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
  let now = Date.parse('2026-09-14T10:00:00.000Z');
  const store = new DamageObservationStore(storePath, { now: () => now });
  const context = createCombatContext({
    accountName: 'TestUser',
    target: { areaKey: 'grakthar_3', monsterKey: 'lizardman_vanguard' },
    player: { level: 1000, attack: 300, defense: 200 },
    loadoutHash: 'a'.repeat(64),
  });
  assert.match(context.hash, /^[a-f0-9]{64}$/);
  assert.strictEqual(createCombatContext({ accountName: 'TestUser', target: {}, player: {}, loadoutHash: '' }), null);
  assert.notStrictEqual(createCombatContext({
    accountName: 'TestUser',
    target: { areaKey: 'grakthar_3', monsterKey: 'lizardman_vanguard' },
    player: { level: 1000, attack: 300, defense: 200 },
    loadoutHash: 'b'.repeat(64),
  }).hash, context.hash, 'Switching loadouts must select another observation context');

  const criticalFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'attack_success.json'), 'utf8'));
  const criticalResult = {
    success: true,
    damage: 126659,
    logs: criticalFixture.logs,
    retaliation: criticalFixture.retaliation,
  };
  assert.deepStrictEqual(classifyAttackResult(criticalResult, { id: 0, stamCost: 1 }), {
    damage: 126659,
    multiplier: 1,
    baseDamage: 126659,
    critical: true,
    criticalMultiplier: 1.92,
    extraInfo: 'Critical hit (x1.92 damage).',
  });
  const criticalStored = store.recordAttack({ context, result: criticalResult, skill: { id: 0 }, playerHpBefore: 586 });
  assert.strictEqual(criticalStored.classification, 'critical');
  assert.strictEqual(criticalStored.estimate, null, 'Critical hits must not become the learned base estimate');
  const criticalPlanningEstimate = store.getPlanningEstimate(context);
  assert.deepStrictEqual(criticalPlanningEstimate, {
    contextHash: context.hash,
    conservativeBaseDamage: 65968,
    medianBaseDamage: 65968,
    sampleCount: 1,
    confidence: 'provisional',
    source: 'critical-adjusted',
    updatedAt: '2026-09-14T10:00:00.000Z',
  }, 'A labeled critical may provide a provisional estimate so Adaptive does not calibrate forever');

  now += 1000;
  const normalResult = {
    success: true,
    damage: 558170,
    logs: [{ SKILL_NAME: 'Slash', DAMAGE: 558170, EXTRA_INFO: 'NONE' }],
    retaliation: { user_hp_after: 550 },
  };
  const normalStored = store.recordAttack({ context, result: normalResult, skill: { id: -1 }, playerHpBefore: 559 });
  assert.strictEqual(normalStored.classification, 'non-critical');
  assert.deepStrictEqual(normalStored.estimate, {
    contextHash: context.hash,
    conservativeBaseDamage: 55817,
    medianBaseDamage: 55817,
    sampleCount: 1,
    confidence: 'low',
    updatedAt: '2026-09-14T10:00:01.000Z',
  });
  assert.strictEqual(store.getSummary({ accountName: 'TestUser', loadoutHash: 'a'.repeat(64) }).criticalSamples, 1);
  assert.strictEqual(new DamageObservationStore(storePath).getEstimate(context).conservativeBaseDamage, 55817, 'Observations must survive restart');

  const fixedPlanner = new AttackPlanner(validateConfig({
    combat: { staminaReserve: 10, attackStrategy: { mode: 'fixed', fixedMultiplier: 100, maxMultiplier: 200 } },
  }));
  assert.strictEqual(fixedPlanner.plan({ stamina: 80 }).multiplier, 50, 'Fixed mode must fall back to an affordable verified multiplier');
  assert.strictEqual(fixedPlanner.plan({ stamina: 10 }), null, 'The stamina reserve must remain untouched');

  const adaptivePlanner = new AttackPlanner(validateConfig({
    combat: { staminaReserve: 10, attackStrategy: { mode: 'adaptive', maxMultiplier: 1000, overshootPercent: 10 } },
  }));
  assert.strictEqual(adaptivePlanner.plan({ stamina: 1000, remainingTargetDamage: 3000000 }).multiplier, 1, 'Unknown contexts must calibrate with x1');
  assert.strictEqual(adaptivePlanner.plan({
    stamina: 1000,
    remainingTargetDamage: 3000000,
    damageEstimate: criticalPlanningEstimate,
  }).multiplier, 50, 'A labeled first-hit critical must not trap Adaptive in repeated x1 calibration');
  const adaptive = adaptivePlanner.plan({
    stamina: 1000,
    remainingTargetDamage: 3000000,
    damageEstimate: normalStored.estimate,
  });
  assert.strictEqual(adaptive.multiplier, 50);
  assert.strictEqual(adaptive.id, -2);
  assert.strictEqual(adaptive.planning.estimatedDamage, 2790850);
  assert.strictEqual(adaptivePlanner.plan({
    stamina: 1000,
    remainingTargetDamage: 50000,
    damageEstimate: normalStored.estimate,
  }).multiplier, 1, 'x1 is the unavoidable minimum near the target');

  const guardedPlanner = new AttackPlanner(validateConfig({
    combat: { staminaReserve: 10, attackStrategy: { mode: 'adaptive', maxMultiplier: 1000, requireTargetStamina: true } },
  }));
  const blocked = guardedPlanner.plan({
    stamina: 50,
    remainingTargetDamage: 3000000,
    damageEstimate: normalStored.estimate,
  });
  assert.strictEqual(blocked.blocked, true);
  assert.strictEqual(blocked.planning.source, 'insufficient-target-stamina');
  assert.strictEqual(blocked.planning.requiredStamina, 54);

  const abilityConfig = validateConfig({
    combat: {
      allowAbilities: true,
      allowedAbilityIds: [6],
      attackStrategy: { mode: 'adaptive', maxMultiplier: 1, overshootPercent: 10 },
    },
    resources: { mana: { allowAbilities: true, keepMin: 20, stopBelow: 10 } },
  });
  const abilityPlanner = new AttackPlanner(abilityConfig);
  const abilityState = {
    stamina: 500,
    mana: 100,
    maxMana: 200,
    remainingTargetDamage: 13000000,
    damageEstimate: { conservativeBaseDamage: 50000, sampleCount: 1, confidence: 'low' },
    abilities: [{ id: 6, name: 'Back Stab', owned: true, passive: false, manaCost: 20, staminaCost: 200, flatStaminaDamage: 13500 }],
  };
  const ability = abilityPlanner.plan(abilityState);
  assert.strictEqual(ability.kind, 'class-ability', 'A selected ability is independent of the normal x1 maximum');
  assert.strictEqual(ability.id, 6);
  assert.strictEqual(ability.stamCost, 200);
  assert.strictEqual(ability.requestStamCost, 1);
  assert.strictEqual(ability.planning.estimatedDamage, 12700000);
  const fixedAbilityPlanner = new AttackPlanner(validateConfig({
    ...abilityConfig,
    combat: { ...abilityConfig.combat, attackStrategy: { ...abilityConfig.combat.attackStrategy, mode: 'fixed', fixedMultiplier: 1 } },
  }));
  assert.strictEqual(fixedAbilityPlanner.plan(abilityState).kind, 'class-ability', 'Selected abilities may be candidates in Fixed mode too');
  assert.notStrictEqual(abilityPlanner.plan({ ...abilityState, mana: 30 })?.kind, 'class-ability', 'Mana reserve must exclude an otherwise selected ability');

  const failSafePlanner = new AttackPlanner(validateConfig({
    combat: {
      staminaReserve: 10,
      attackStrategy: { mode: 'adaptive', maxMultiplier: 1000, overshootPercent: 10, failSafeEnabled: true, failSafePercent: 80 },
    },
  }));
  const failSafe = failSafePlanner.plan({
    stamina: 1000,
    targetDamage: 4000000,
    remainingTargetDamage: 800000,
    damageEstimate: normalStored.estimate,
  });
  assert.strictEqual(failSafe.multiplier, 1, 'Adaptive fail-safe must force x1 at the configured target progress');
  assert.strictEqual(failSafe.planning.source, 'fail-safe');

  fs.rmSync(directory, { recursive: true, force: true });
  console.log('   Adaptive uses verified non-critical damage and only provisional labeled-critical calibration.');
}

async function testMonsterCatalogService() {
  console.log(' Testing Monster Catalog service...');
  const testDirectory = path.join(__dirname, 'test_monster_catalog');
  const basePath = path.join(testDirectory, 'base.json');
  const cachePath = path.join(testDirectory, 'cache.json');
  if (fs.existsSync(testDirectory)) fs.rmSync(testDirectory, { recursive: true, force: true });
  const stats = parseMonsterStatsModal(fs.readFileSync(path.join(__dirname, 'fixtures', 'monster_stats_modal.html'), 'utf8'));
  let statsReads = 0;
  let statsMonsterId = null;
  let liveStats = stats;
  const service = new MonsterCatalogService({
    async getWaveSnapshot() {
      return {
        resources: { hp: { current: 50, max: 100 } },
        monsters: [
          { id: '545643707', battleId: '545643707', name: 'Lizardman Vanguard', boss: false },
          { id: '545643708', battleId: '545643708', name: 'Lizardman Vanguard', boss: false },
        ],
        loot: {
          recognized: true,
          reportedUnclaimed: 0,
          visibleLootable: 0,
          visibleLootActions: 0,
          monsters: [],
        },
      };
    },
    async getLootableWaveSnapshot() {
      return {
        resources: { hp: { current: 50, max: 100 } },
        monsters: [],
        loot: {
          recognized: true,
          reportedUnclaimed: 21,
          visibleLootable: 21,
          visibleLootActions: 2,
          monsters: [
            { id: '545643701', battleId: '545643701', name: 'Lizardman Warmage', boss: true, dead: true, stackSize: 20 },
            { id: '545643702', battleId: '545643702', name: 'Lizardman Warmage', boss: true, dead: true, stackSize: 1 },
          ],
        },
      };
    },
    async getMonsterStats(monsterId) { statsReads += 1; statsMonsterId = String(monsterId); return liveStats; },
  }, { basePath, cachePath });
  const area = await service.listArea('grakthar_3');
  assert.strictEqual(area.monsters.length, 1);
  assert.strictEqual(area.monsters[0].instances, 2);
  assert.strictEqual(area.monsters[0].lootableCount, 0);
  const lootArea = await service.listLootableArea('grakthar_3');
  assert.strictEqual(lootArea.monsters.length, 2, 'Loot configuration must merge alive and currently lootable types');
  assert.strictEqual(lootArea.monsters.find(monster => monster.key === 'lizardman_vanguard').lootableCount, 0);
  assert.strictEqual(lootArea.monsters.find(monster => monster.key === 'lizardman_warmage').lootableCount, 21);
  assert.deepStrictEqual(lootArea.loot, { recognized: true, reportedUnclaimed: 21, visibleLootable: 21, visibleLootActions: 2 });
  const restartedService = new MonsterCatalogService({
    async getWaveSnapshot() {
      return { resources: {}, monsters: [], loot: { recognized: true, reportedUnclaimed: 0, visibleLootable: 0, monsters: [] } };
    },
    async getLootableWaveSnapshot() {
      return { resources: {}, monsters: [], loot: { recognized: true, reportedUnclaimed: 0, visibleLootable: 0, monsters: [] } };
    },
  }, { basePath, cachePath });
  const rememberedArea = await restartedService.listLootableArea('grakthar_3');
  const rememberedBoss = rememberedArea.monsters.find(monster => monster.key === 'lizardman_warmage');
  assert(rememberedBoss, 'A previously discovered boss type must survive while it is waiting to respawn');
  assert.strictEqual(rememberedBoss.boss, true);
  assert.strictEqual(rememberedBoss.instances, 0);
  assert.strictEqual(rememberedBoss.lootableCount, 0);
  assert.strictEqual(rememberedBoss.remembered, true);
  assert.strictEqual(Object.hasOwn(area.monsters[0], 'monsterId'), false, 'Temporary instance IDs must stay inside the service');
  const loaded = await service.getMonsterStats('grakthar_3', 'lizardman_vanguard');
  assert.strictEqual(loaded.record.stats.rewardsUpToLevel, 4500);
  assert.strictEqual(loaded.cached, false);
  assert.strictEqual(statsReads, 1);
  assert.strictEqual(statsMonsterId, '545643707', 'Loot discovery must not replace the representative live target ID');
  assert.strictEqual(fs.existsSync(cachePath), true);
  const cacheAfterStats = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert(cacheAfterStats.monsters.grakthar_3.lizardman_vanguard.discovery, 'Collecting Stats must preserve type-discovery memory');
  const collection = await service.collectAreaStats('grakthar_3');
  assert.strictEqual(collection.collected, 1);
  assert.strictEqual(collection.errors.length, 0);
  assert.strictEqual(statsReads, 2);
  liveStats = { ...stats, attack: 301 };
  const conflict = await service.getMonsterStats('grakthar_3', 'lizardman_vanguard', { refresh: true });
  assert.strictEqual(conflict.conflict, true);
  assert.strictEqual(conflict.record.stats.attack, 300, 'A conflicting observation must not replace verified stats');
  assert.strictEqual(conflict.record.conflict.observedStats.attack, 301);
  const reloaded = new MonsterCatalogService(null, { basePath, cachePath });
  const cached = await reloaded.getMonsterStats('grakthar_3', 'lizardman_vanguard');
  assert.strictEqual(cached.cached, true);
  assert.strictEqual(cached.record.provenance.schemaVersion, 1);
  fs.rmSync(testDirectory, { recursive: true, force: true });
  console.log('   Monster Catalog separates stable types, live instances, and cached stats.');
}

async function testStrategyEngine() {
  console.log(' Testing StrategyEngine decision priority...');
  const config = validateConfig({
    general: { module: 'gates', map: 'grakthar_3' },
    resources: { health: { sleepBelow: 20 } },
    energyFarming: { enabled: true, farmWhenStaminaBelow: 100 },
    progression: { allowChapterFallback: true },
  });
  const strategy = new StrategyEngine(config, 'TestUser');
  const base = {
    stamina: 500,
    maxStamina: 1000,
    playerHp: 100,
    playerMaxHp: 100,
    currentBattle: null,
    monsterDead: false,
    isJoined: false,
    farmedEnergy: 0,
    farmedEnergyLimit: 1000,
  };
  const scanDecision = strategy.decideNextAction(base);
  assert.strictEqual(scanDecision.action, 'SCAN');
  assert.deepStrictEqual(scanDecision.params, { gateId: 3, wave: 8, areaKey: 'grakthar_3' });
  assert.strictEqual(strategy.decideNextAction({ ...base, stamina: 80 }).action, 'FARM');

  const battle = { userId: 12, skills: [{ id: 0, name: 'Slash', stamCost: 1 }] };
  assert.strictEqual(strategy.decideNextAction({ ...base, currentBattle: battle }).action, 'JOIN');
  assert.strictEqual(strategy.decideNextAction({ ...base, currentBattle: battle, isJoined: true }).action, 'ATTACK');
  assert.strictEqual(strategy.decideNextAction({ ...base, currentBattle: battle, isJoined: true, targetReached: true }).action, 'SCAN');
  assert.strictEqual(strategy.decideNextAction({ ...base, currentBattle: battle, isJoined: true, monsterDead: true, currentLootAllowed: true }).action, 'LOOT');
  assert.strictEqual(strategy.decideNextAction({ ...base, currentBattle: battle, isJoined: true, playerHp: 10 }).action, 'HEAL');
  strategy.updateConfig(validateConfig({
    general: { module: 'gates', map: 'grakthar_3' },
    combat: { staminaReserve: 0, attackStrategy: { mode: 'adaptive', maxMultiplier: 200, overshootPercent: 10 } },
  }));
  const plannedAttack = strategy.decideNextAction({
    ...base,
    currentBattle: battle,
    isJoined: true,
    remainingTargetDamage: 3000000,
    damageEstimate: { conservativeBaseDamage: 55817, sampleCount: 5, confidence: 'high' },
  });
  assert.strictEqual(plannedAttack.params.skill.multiplier, 50, 'StrategyEngine must delegate normal attack sizing to AttackPlanner');
  assert(plannedAttack.reason.includes('estimate 2,790,850'));
  strategy.updateConfig(validateConfig({
    general: { module: 'gates', map: 'grakthar_3' },
    combat: { staminaReserve: 0, attackStrategy: { mode: 'adaptive', maxMultiplier: 200, requireTargetStamina: true } },
  }));
  const targetStaminaWait = strategy.decideNextAction({
    ...base,
    stamina: 10,
    currentBattle: battle,
    isJoined: true,
    remainingTargetDamage: 3000000,
    damageEstimate: { conservativeBaseDamage: 55817, sampleCount: 1, confidence: 'low' },
  });
  assert.strictEqual(targetStaminaWait.action, 'WAIT');
  assert(targetStaminaWait.reason.includes('requires about 54 stamina'));
  strategy.updateConfig(validateConfig({ general: { module: 'idle' } }));
  assert.strictEqual(strategy.decideNextAction(base).action, 'WAIT');
  console.log('   StrategyEngine passed decision-priority tests.');
}

async function testPlanningBoundaries() {
  console.log(' Testing module, target-ledger, and action-executor boundaries...');
  const modules = new ModuleRegistry();
  assert.deepStrictEqual(modules.resolveGateScan({ module: 'gates', map: 'grakthar_3' }), {
    gateId: 3, wave: 8, areaKey: 'grakthar_3',
  });
  assert.strictEqual(modules.resolveGateScan({ module: 'idle', map: 'grakthar_3' }), null);
  assert.strictEqual(modules.resolveGateScan({ module: 'gates_dungeons', map: 'grakthar_3' }), null);
  assert.strictEqual(modules.describe({ module: 'gates', map: 'grakthar_3' }).displayName, 'Gates · Grakthar 3');

  const ledgerConfig = validateConfig({
    general: { module: 'gates', map: 'grakthar_3' },
    monsters: { maps: { grakthar_3: {
      warmage: { name: 'Warmage', enabled: true, priority: 0, minimumHp: 100, targetDamage: 1000, killCount: 2 },
    } } },
  });
  const ledger = new TargetLedger(ledgerConfig);
  const selected = ledger.selectGateTarget('grakthar_3', [{ id: 901, name: 'Warmage', hp: 500, userDmg: 200 }], 1);
  assert.strictEqual(selected.id, 901);
  const completion = ledger.recordCompleted({ id: 901, areaKey: 'grakthar_3', monsterKey: 'warmage' });
  assert.strictEqual(completion.completedCount, 1);
  assert.strictEqual(ledger.recordCompleted({ id: 901, areaKey: 'grakthar_3', monsterKey: 'warmage' }).duplicate, true);

  let mutations = 0;
  const executor = new ActionExecutor({ ATTACK: async () => { mutations++; return { success: true }; } });
  const attackDecision = { action: 'ATTACK', params: { skill: { id: 0, stamCost: 1 } } };
  const dryRun = await executor.execute(attackDecision, { dryRun: true });
  assert.strictEqual(dryRun.dryRun, true);
  assert.strictEqual(mutations, 0);
  assert.strictEqual((await executor.execute(attackDecision, { dryRun: false })).success, true);
  assert.strictEqual(mutations, 1);
  await assert.rejects(() => executor.execute({ action: 'ATTACK', params: {} }), /missing required parameters/);
  await assert.rejects(() => executor.execute({ action: 'UNKNOWN', params: {} }), /Unsupported strategy action/);
  console.log('   Planning boundaries preserve module resolution, progress, and dry-run authority.');
}

async function testApiActionLayer() {
  console.log(' Testing API-only controller and battle state updates...');
  const calls = [];
  const api = {
    setAccount() {},
    async getBattleConfig() {
      return {
        battleCfg: { id: 77, isDungeon: false, privateBoss: { enabled: false } },
        userId: 12,
        isJoined: false,
        isDead: false,
        playerHp: 100,
        playerMaxHp: 100,
        skills: [{ id: 0, name: 'Slash', stamCost: 1 }],
      };
    },
    async joinBattle(battleCfg, userId) { calls.push(['join', battleCfg, userId]); return { success: true, message: 'ok' }; },
    async attack(args) {
      calls.push(['attack', args]);
      return { success: true, hp: { value: 0, max: 100 }, stamina: 50, damage: null, totalDmgDealt: 100, retaliation: { user_hp_after: 90 } };
    },
    async loot(battleCfg, userId) { calls.push(['loot', battleCfg, userId]); return { success: true, items: [] }; },
    async healPotion(userId) { calls.push(['potion', userId]); return { success: false, message: 'none' }; },
    async heal(userId) { calls.push(['heal', userId]); return { success: true, message: 'ok' }; },
  };
  const timing = { async sleepRandom() { return 0; }, async waitForAction() { return 0; } };
  const controller = new GameController(api, timing);
  const manager = new BattleManager(api, controller, 'TestUser');
  await manager.loadBattle(77);
  await manager.joinCurrentBattle();
  const attack = await manager.attackOnce({ id: 0, name: 'Slash', stamCost: 1 }, { min: 500, max: 600 });
  assert.strictEqual(attack.success, true);
  assert.strictEqual(attack.damage, 100, 'Attack damage should be derived from cumulative totaldmgdealt when omitted');
  assert.strictEqual(manager.getCurrentBattle().userDamage, 100);
  assert.strictEqual(manager.getCurrentBattle().isDead, true);
  assert.strictEqual(manager.lastStamina, 50);
  assert.strictEqual(calls[0][0], 'join');
  assert.strictEqual(calls[0][1].id, 77);
  assert.strictEqual(calls[0][2], 12);
  assert.strictEqual(calls[1][0], 'attack');
  await controller.attack(
    { id: 700001, isDungeon: true, instanceId: 800001, dgmid: 700001 },
    { id: 6, name: 'Back Stab', kind: 'class-ability', stamCost: 200, requestStamCost: 1 },
  );
  assert.strictEqual(calls.at(-1)[1].skillId, 6);
  assert.strictEqual(calls.at(-1)[1].stamCost, 1, 'Class abilities must retain their real planning cost while posting the verified compatibility value');
  await manager.lootCurrent({ min: 300, max: 400 });
  assert.strictEqual(manager.getCurrentBattle(), null);

  const dungeonLoadRefs = [];
  const dungeonLocator = { isDungeon: true, instanceId: '800001', dgmid: '700001', monsterId: null };
  const dungeonApi = {
    setAccount() {},
    async getBattleConfig(ref) {
      dungeonLoadRefs.push(ref);
      return {
        battleCfg: { id: 700001, isDungeon: true, instanceId: 800001, dgmid: 700001 },
        battleLocator: dungeonLocator,
        userId: 12,
        isJoined: true,
        isDead: false,
      };
    },
  };
  const dungeonManager = new BattleManager(dungeonApi, controller, 'TestUser');
  await dungeonManager.loadBattle({ isDungeon: true, instanceId: 800001, dgmid: 700001 });
  await dungeonManager.refresh();
  assert.deepStrictEqual(dungeonLoadRefs[1], dungeonLocator, 'Dungeon refresh must preserve instance_id and dgmid');
  console.log('   API-only action layer passed coordination tests.');
}

async function testBotEngineDryRun() {
  console.log(' Testing BotEngine dry-run lifecycle...');
  let mutations = 0;
  let statsReads = 0;
  const timing = {
    updateConfig() {},
    getRandomDelay() { return 1; },
    cancelAll() {},
    sleepRandom(min, max, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
          return;
        }
        const timer = setTimeout(() => resolve(1), 1);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('cancelled');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  };
  const battle = {
    lastStamina: 500,
    getCurrentBattle: () => ({
      battleCfg: { id: 77 }, userId: 12, isJoined: false, isDead: false,
      playerHp: 100, playerMaxHp: 100, skills: [{ id: 0, name: 'Slash', stamCost: 1 }],
    }),
    clear() {},
  };
  const engine = new BotEngine({
    accountName: 'DryRunUser',
    config: validateConfig({ safety: { dryRun: true } }),
    timingEngine: timing,
    httpClient: { cancelAll() {}, setWebContents() {} },
    gameAPI: {},
    gameController: { joinBattle: async () => { mutations++; } },
    gameReader: {
      async fetchStatsNow() {
        statsReads++;
        await new Promise(resolve => setTimeout(resolve, 2));
        return {};
      },
      async readState() { return { isConnected: true, hasCloudflare: false, isLoginPage: false }; },
      setWebContents() {},
    },
    battleManager: battle,
    strategyEngine: {
      updateConfig() {},
      decideNextAction() { return { action: 'JOIN', params: {}, reason: 'test dry run' }; },
    },
    chapterFarmer: { resetCycle() {} },
  });
  const messages = [];
  engine.on('log', entry => messages.push(entry.message));
  await Promise.all([engine.refreshStats(), engine.refreshStats(), engine.refreshStats()]);
  assert.strictEqual(statsReads, 1, 'Concurrent Stats refreshes must share one request');
  assert.strictEqual(engine.start(), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.strictEqual(engine.stop(), true);
  await engine.loopPromise;
  assert.strictEqual(mutations, 0);
  assert(messages.some(message => message.includes('[DRY RUN]')));
  assert.strictEqual(engine.fsm.state, BotState.STOPPED);
  console.log('   BotEngine dry-run blocked mutations and stopped cleanly.');
}

async function testAutomaticFarmAuthenticationFailure() {
  console.log(' Testing automatic-farm authentication stop signal...');
  const timing = { updateConfig() {}, cancelAll() {} };
  const engine = new BotEngine({
    accountName: 'FarmAuthUser',
    config: validateConfig({
      safety: { dryRun: false },
      energyFarming: { enabled: true },
      progression: { allowChapterFallback: true },
    }),
    timingEngine: timing,
    httpClient: { cancelAll() {}, setWebContents() {} },
    gameAPI: {},
    gameController: {},
    gameReader: { async fetchFarmedEnergy() { return null; }, setWebContents() {} },
    battleManager: { clear() {}, getCurrentBattle() { return null; } },
    strategyEngine: { updateConfig() {} },
    chapterFarmer: {
      async farmSingleChapter() {
        return { success: false, code: 'AUTH_REQUIRED', message: 'Game session is not authenticated' };
      },
    },
    getMangaTargets: () => [{ slug: 'Verified-Manga', chapters: 2, farmedCount: 0 }],
  });
  engine.fsm.transition(BotState.IDLE, 'test');
  await assert.rejects(
    () => engine._farm({ reactionType: '1' }, null),
    error => error.code === 'AUTH_REQUIRED',
    'Automatic farming must surface authentication loss so the main loop stops instead of retrying'
  );
  console.log('   Automatic farming surfaces authentication loss.');
}

async function testHttpAndGameAPI() {
  console.log(' Testing HTTP retry safety and GameAPI contracts...');
  const webContents = {
    isDestroyed: () => false,
    session: {
      cookies: { get: async () => [{ name: 'session', value: 'redacted' }] },
      getUserAgent: () => 'Test Agent',
    },
  };
  const timing = { async sleepRandom() { return 0; } };
  const response = (text, status = 200) => ({ status, ok: status >= 200 && status < 300, text: async () => text, headers: {} });

  let sessionFetchOptions = null;
  const partitionWebContents = {
    isDestroyed: () => false,
    session: {
      cookies: { get: async () => [{ name: 'partition_cookie', value: 'redacted' }] },
      getUserAgent: () => 'Partition Agent',
      async fetch(url, options) {
        sessionFetchOptions = { url, options };
        return response('partition ok');
      },
    },
  };
  const partitionClient = new HttpClient(partitionWebContents, 'PartitionUser', timing);
  assert.strictEqual((await partitionClient.get('https://demonicscans.org/stats.php')).text, 'partition ok');
  assert.strictEqual(sessionFetchOptions.options.credentials, 'include');
  assert.strictEqual(sessionFetchOptions.options.session, undefined, 'Session must not be passed as an ignored fetch option');
  assert.strictEqual(sessionFetchOptions.options.headers.Cookie, undefined, 'Production Session.fetch must own cookie attachment');

  let scopedFetchOptions = null;
  const scopedClient = new HttpClient(webContents, 'TestUser', timing, async (url, options) => {
    scopedFetchOptions = { url, options };
    return response('scoped ok');
  });
  await scopedClient.getWithCookieOverrides('https://demonicscans.org/active_wave.php?gate=3&wave=8', {
    hide_dead_monsters: '0',
    show_dead_bosses_only: '0',
  });
  assert.strictEqual(scopedFetchOptions.options.credentials, 'omit', 'Scoped cookie reads must not merge the session jar a second time');
  assert.strictEqual(
    scopedFetchOptions.options.headers.Cookie,
    'session=redacted; hide_dead_monsters=0; show_dead_bosses_only=0',
    'Scoped GET must preserve authentication cookies while replacing only requested preferences',
  );

  let getAttempts = 0;
  const getClient = new HttpClient(webContents, 'TestUser', timing, async () => {
    getAttempts++;
    if (getAttempts === 1) throw new Error('temporary');
    return response('ok');
  });
  const getResult = await getClient.get('https://demonicscans.org/stats.php');
  assert.strictEqual(getResult.ok, true);
  assert.strictEqual(getAttempts, 2, 'GET should retry a transient failure');

  let deniedAttempts = 0;
  const deniedClient = new HttpClient(webContents, 'TestUser', timing, async () => {
    deniedAttempts++;
    return response('Access denied.');
  });
  await assert.rejects(
    () => deniedClient.get('https://demonicscans.org/stats.php'),
    error => error.code === 'AUTH_REQUIRED',
    'The verified short Stats denial must be classified as expired authentication'
  );
  assert.strictEqual(deniedAttempts, 1, 'Expired authentication must fail immediately without retries');

  let postAttempts = 0;
  const postClient = new HttpClient(webContents, 'TestUser', timing, async () => {
    postAttempts++;
    throw new Error('ambiguous post failure');
  });
  await assert.rejects(() => postClient.post('https://demonicscans.org/damage.php', { monster_id: 1 }), /ambiguous post failure/);
  assert.strictEqual(postAttempts, 1, 'POST must not retry automatically');

  let multipartOptions = null;
  const multipartClient = new HttpClient(webContents, 'TestUser', timing, async (url, options) => {
    multipartOptions = { url, options };
    return response('ok');
  });
  await multipartClient.postMultipart('https://demonicscans.org/postreaction.php', {
    chapterid: 100,
    reaction: 1,
    useruid: 'redacted-useruid',
  }, { headers: { 'Content-Type': 'multipart/form-data; boundary=wrong', 'X-Test': 'preserved' } });
  assert(multipartOptions.options.body instanceof FormData, 'Multipart POST must send a FormData body');
  assert.strictEqual(multipartOptions.options.headers['Content-Type'], undefined, 'Fetch must generate the multipart boundary header');
  assert.strictEqual(multipartOptions.options.headers['X-Test'], 'preserved');
  assert.strictEqual(multipartOptions.options.body.get('chapterid'), '100');

  const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const requests = [];
  const fakeHttp = {
    setAccount() {},
    async getCookies() { return [{ name: 'demon', value: '100001' }]; },
    async get(url) {
      requests.push(['GET', url]);
      if (url.includes('gates.php')) return { ok: true, status: 200, text: fixture('gates.html') };
      if (url.includes('active_wave') && url.includes('wave=5')) return { ok: true, status: 200, text: fixture('wave_resources.html') };
      if (url.includes('active_wave')) return { ok: true, status: 200, text: fixture('wave.html') };
      if (url.includes('battle.php?id=999999')) return { ok: true, status: 200, text: fixture('monster_stats_modal.html') };
      if (url.includes('battle.php?dgmid=')) return { ok: true, status: 200, text: fixture('dungeon_battle.html') };
      if (url.includes('battle.php')) return { ok: true, status: 200, text: fixture('battle.html') };
      if (url.includes('inventory.php')) return { ok: true, status: 200, text: fixture('gear_inventory.html') };
      if (url.includes('pets.php')) return { ok: true, status: 200, text: fixture('pet_inventory.html') };
      if (url.includes('class_skill_tree.php')) return { ok: true, status: 200, text: fixture('class_skill_tree_hunter.html') };
      if (url.includes('stats.php')) return { ok: true, status: 200, text: fixture('stats.html') };
      return { ok: true, status: 200, text: fixture('stats.html') };
    },
    async post(url, body) {
      requests.push(['POST', url, body.toString()]);
      if (url.includes('damage.php')) return { ok: true, status: 200, text: fixture('attack_success.json') };
      if (url.includes('dungeon_loot.php')) return { ok: true, status: 200, text: fixture('dungeon_loot_success.json') };
      if (url.includes('loot.php')) return { ok: true, status: 200, text: JSON.stringify({ status: 'success', items: ['coin'] }) };
      if (url.includes('user_heal_potion.php')) return { ok: true, status: 200, text: fixture('heal_potion_success.json') };
      if (url.includes('user_heal.php')) return { ok: true, status: 200, text: fixture('heal_cooldown.json') };
      if (url.includes('dungeon_join_battle.php')) return { ok: true, status: 200, text: fixture('dungeon_join_success.txt') };
      return { ok: true, status: 200, text: '' };
    },
    async postMultipart(url, fields) {
      requests.push(['MULTIPART', url, { ...fields }]);
      return { ok: true, status: 200, text: 'You have successfully joined this battle.' };
    },
  };
  const api = new GameAPI(fakeHttp, 'TestUser');
  assert.strictEqual((await api.getGates()).length, 2);
  assert.strictEqual(await api.resolveWave(3, 'latest'), 8);
  assert.strictEqual((await api.getWaveMonsters(3, 'latest'))[0].id, '540971170');
  assert.strictEqual((await api.getBattleConfig(540970643)).userId, 100001, 'demon cookie must override the page constant');
  assert.strictEqual((await api.getMonsterStats(999999)).rewardsUpToLevel, 4500);
  assert.strictEqual((await api.getGearInventory('attack')).equipped.length, 2);
  assert.strictEqual((await api.getPetInventory('attack')).equipped[0].name, 'Moon Panda');
  assert.strictEqual((await api.getClassSkillTree()).unlockedSkills[0].id, 6);
  await assert.rejects(() => api.getGearInventory('invented'), error => error.code === 'INVALID_LOADOUT_CONTEXT');
  assert.strictEqual((await api.fetchStats()).gems, '2.287K');
  assert.deepStrictEqual(await api.fetchPlayerResources(3, 5), {
    hp: { current: 15000, max: 20000 },
    mp: { current: 100, max: 200 },
  });

  const waveCookieOverrides = [];
  const lootApi = new GameAPI({
    async getWithCookieOverrides(url, overrides) {
      assert(url.endsWith('/active_wave.php?gate=3&wave=8'));
      waveCookieOverrides.push(overrides);
      return { ok: true, status: 200, text: fixture('lootable_wave.html') };
    },
    async get() { throw new Error('Loot discovery must use the request-scoped transport'); },
  }, 'TestUser');
  const lootSnapshot = await lootApi.getLootableWaveSnapshot(3, 8);
  assert.strictEqual(lootSnapshot.loot.visibleLootable, 22);
  assert.strictEqual(lootSnapshot.loot.visibleLootActions, 3);
  assert.deepStrictEqual(waveCookieOverrides[0], {
    hide_dead_monsters: '0',
    show_dead_bosses_only: '0',
  });
  await lootApi.getWaveSnapshot(3, 8);
  assert.deepStrictEqual(waveCookieOverrides[1], {
    hide_dead_monsters: '1',
    show_dead_bosses_only: '0',
  }, 'Target discovery must request the alive view independently of the browser filter');
  assert.strictEqual((await api.joinBattle(1, 2)).success, true);
  const attackResult = await api.attack({ monsterId: 1, skillId: 0, stamCost: 1 });
  assert.strictEqual(attackResult.success, true);
  assert.strictEqual(attackResult.totalDmgDealt, 126659);
  assert.strictEqual(attackResult.retaliation.user_hp_after, 559);
  assert.strictEqual((await api.loot(1, 2)).success, true);
  assert.strictEqual((await api.heal(2)).success, false);
  assert.strictEqual((await api.healPotion(2)).success, true);

  const dungeon = await api.getBattleConfig({ isDungeon: true, instanceId: 800001, dgmid: 700001 });
  assert.strictEqual(dungeon.battleLocator.isDungeon, true);
  assert.strictEqual(dungeon.userId, 100001);
  assert.strictEqual((await api.joinBattle(dungeon.battleCfg, dungeon.userId)).success, true);
  assert.strictEqual((await api.attack({
    monsterId: dungeon.battleCfg.id,
    skillId: 6,
    stamCost: 1,
    isDungeon: true,
    instanceId: dungeon.battleCfg.instanceId,
    dgmid: dungeon.battleCfg.dgmid,
  })).success, true);
  const dungeonLoot = await api.loot(dungeon.battleCfg, dungeon.userId);
  assert.strictEqual(dungeonLoot.success, true);
  assert.strictEqual(dungeonLoot.rewards.exp, 4213);
  assert.strictEqual(dungeonLoot.items[0].NAME, 'Full Stamina Potion');

  const normalJoin = requests.find(entry => entry[0] === 'MULTIPART' && entry[1].endsWith('/user_join_battle.php'));
  assert(normalJoin, 'Normal join must use multipart form data');
  assert.deepStrictEqual(normalJoin[2], { monster_id: '1', user_id: 100001 });
  const dungeonJoin = requests.find(entry => entry[1].endsWith('/dungeon_join_battle.php'));
  assert.strictEqual(dungeonJoin[2], 'instance_id=800001&dgmid=700001&user_id=100001');
  const dungeonLootRequest = requests.find(entry => entry[1].endsWith('/dungeon_loot.php'));
  assert.strictEqual(dungeonLootRequest[2], 'instance_id=800001&dgmid=700001&user_id=100001');
  const dungeonAttack = requests.filter(entry => entry[1].endsWith('/damage.php')).at(-1);
  assert.strictEqual(dungeonAttack[2], 'instance_id=800001&dgmid=700001&skill_id=6&stamina_cost=1');
  assert(!dungeonAttack[2].includes('csrf_token') && !dungeonAttack[2].includes('request_token'));
  const healRequest = requests.find(entry => entry[1].endsWith('/user_heal.php'));
  const potionRequest = requests.find(entry => entry[1].endsWith('/user_heal_potion.php'));
  assert.strictEqual(healRequest[2], 'user_id=100001');
  assert.strictEqual(potionRequest[2], 'user_id=100001');
  assert(requests.some(entry => entry[0] === 'POST' && entry[1].endsWith('/damage.php')));

  let dungeonLootErrorFixture = 'dungeon_loot_already_claimed.json';
  let attackErrorFixture = 'attack_not_enough_mana.json';
  const errorApi = new GameAPI({
    async getCookies() { return [{ name: 'demon', value: '100001' }]; },
    async post(url) {
      if (url.endsWith('/dungeon_loot.php')) return { ok: true, status: 200, text: fixture(dungeonLootErrorFixture) };
      if (url.endsWith('/user_heal.php')) return { ok: true, status: 200, text: fixture('heal_full_hp.json') };
      if (url.endsWith('/user_heal_potion.php')) return { ok: true, status: 200, text: fixture('heal_potion_missing.json') };
      if (url.endsWith('/damage.php')) return { ok: true, status: 200, text: fixture(attackErrorFixture) };
      return { ok: true, status: 200, text: fixture('dungeon_join_invalid.txt') };
    },
  }, 'TestUser');
  const dungeonRef = { isDungeon: true, instanceId: 800001, dgmid: 700001 };
  const alreadyLooted = await errorApi.loot(dungeonRef);
  assert.strictEqual(alreadyLooted.success, false);
  assert.strictEqual(alreadyLooted.message, 'You already claimed your loot.');
  assert.strictEqual(alreadyLooted.requestId, 'redacted-request-id');
  dungeonLootErrorFixture = 'dungeon_loot_monster_missing.json';
  assert.strictEqual((await errorApi.loot(dungeonRef)).message, 'Monster not found.');
  assert.strictEqual((await errorApi.heal()).message, 'You are already at full HP.');
  assert.strictEqual((await errorApi.healPotion()).message, 'You do not have a healing potion (ID 108).');
  const abilityRequest = { monsterId: 700001, skillId: 6, stamCost: 1, isDungeon: true, instanceId: 800001, dgmid: 700001 };
  assert.strictEqual((await errorApi.attack(abilityRequest)).message, 'Not enough mana.');
  attackErrorFixture = 'attack_not_enough_stamina.json';
  assert.strictEqual((await errorApi.attack(abilityRequest)).message, 'Not enough stamina.');

  const invalidJoinApi = new GameAPI({
    async getCookies() { return [{ name: 'demon', value: '100001' }]; },
    async post() { return { ok: true, status: 200, text: fixture('dungeon_join_invalid.txt') }; },
  }, 'TestUser');
  assert.strictEqual((await invalidJoinApi.joinBattle(dungeonRef)).success, false);
  console.log('   HTTP retry safety and GameAPI contracts passed.');
}

async function testRendererSecurityContract() {
  console.log(' Testing renderer security contract...');
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  const monsterStatsViewSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'monsterStatsView.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
  const windowManagerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'windowManager.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'index.js'), 'utf8');
  const ids = [...appSource.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
  const missing = [...new Set(ids)].filter(id => !new RegExp(`id=["']${id}["']`).test(html));
  assert.deepStrictEqual(missing, [], `Renderer IDs missing from HTML: ${missing.join(', ')}`);
  assert(!/\son\w+=/i.test(html), 'Inline event handlers must not be used');
  assert(!/<script[^>]+https?:/i.test(html), 'Renderer must not load remote scripts');
  assert(/Content-Security-Policy/i.test(html), 'Renderer must declare a Content Security Policy');
  assert(!/id=["']tabSchedulerBtn["']/.test(html), 'Scheduler must not remain a top-level tab');
  assert(/id=["']tabNPCConfigBtn["']/.test(html), 'NPC Config tab must exist');
  assert(/id=["']tabLootConfigBtn["']/.test(html), 'Loot Config tab must exist');
  assert(/id=["']tabNPCConfigBtn["'][^>]*>Targets<\/button>/.test(html), 'NPC Config must be labeled Targets');
  assert(/id=["']tabLootConfigBtn["'][^>]*>Looting<\/button>/.test(html), 'Loot Config must be labeled Looting');
  assert(/id=["']statHealth["']/.test(html) && /id=["']statMana["']/.test(html), 'Health and Mana stat cards must exist');
  assert(html.indexOf('id="statStamina"') < html.indexOf('id="statHealth"'));
  assert(!/id=["']statAttack["']/.test(html) && !/id=["']statDefense["']/.test(html), 'Overview must not duplicate combat ATK/DEF');
  assert(/id=["']statsScrollRow["']/.test(html), 'Overview stats must scroll independently from the refresh control');
  assert(/\.stats-scroll-row\s*\{[^}]*padding:[^;}]*38px/s.test(styles), 'Overview stats need end padding for the fixed refresh control');
  assert(/id=["']targetAreaSelect["']/.test(html) && /id=["']monsterAreaContent["']/.test(html), 'Targets workspace must contain an area dropdown and content');
  assert(/id=["']lootAreaSelect["']/.test(html) && /id=["']lootAreaContent["']/.test(html), 'Looting workspace must contain an area dropdown and content');
  assert(preloadSource.includes("ipcRenderer.invoke('monsters:get-catalog'"));
  assert(preloadSource.includes("ipcRenderer.invoke('monsters:list-area'"));
  assert(preloadSource.includes("ipcRenderer.invoke('monsters:list-lootable-area'"));
  assert(appSource.includes('listLootableMonstersForArea'), 'Looting must use dedicated dead-monster discovery');
  assert(appSource.includes('const lootAreaCache = new Map()'), 'Looting must not reuse the Targets discovery cache');
  assert(windowManagerSource.includes('_normalizeWavePreferenceCookies'), 'Login must repair duplicate legacy wave-filter cookies');
  assert(/id=["']rowManualFarmControls["']/.test(html), 'Manual chapter-count controls must exist');
  assert(!/id=["']subtabHomeLootBtn["']/.test(html), 'Loot must not remain a Home subtab');
  assert(/id=["']selectGeneralModule["']/.test(html), 'Module select must exist in Bot Setup');
  assert(/<title>Veybot<\/title>/.test(html), 'The user-facing application name must be Veybot');
  assert(/id=["']tabBotSetupBtn["']/.test(html), 'Sidebar must contain a separate Bot Setup view');
  assert(!/id=["']headerProfileControls["']/.test(html), 'Module and Map must not remain in the top bar');
  assert(html.indexOf('id="subviewHomeGeneral"') < html.indexOf('id="selectGeneralModule"'), 'Module and Map must live in Bot Setup');
  assert(/id=["']overviewCurrentPanel["']/.test(html), 'Overview must expose a compact current-operation panel');
  assert(appSource.includes('saveGeneralSelection'), 'Home Module and Map must persist to canonical configuration');
  assert(appSource.includes("['grakthar_3', 'Grakthar 3']"), 'Grakthar 3 must map to its canonical area key');
  assert(appSource.includes("'Minimum HP'"), 'Monster rows must expose Minimum HP');
  assert(appSource.includes('monster-progress-reset'), 'Monster progress must expose a Reset control');
  assert(appSource.includes('createStaminaPotionSelect'), 'Target rows must expose a stamina-potion selector');
  assert(appSource.includes("['Potions', 'Stamina potion selection']"), 'Target potion column must be labeled Potions');
  assert(appSource.includes("['Stats', 'Monster stats']"), 'Target rows must expose a dedicated Stats column');
  assert(appSource.includes('row.append(name, availability, statsButton'), 'Monster stats control must occupy its own table column');
  assert(appSource.includes("['adventure', 'Adventure Pot"), 'Stamina-potion choices must include the Adventure Pot value');
  assert(appSource.includes('saveLootRow'), 'Looting rows must persist per-monster rules');
  assert(/id=["']btnModuleInfo["']/.test(html) && /id=["']modalModuleInfo["']/.test(html), 'Module selector must expose an information dialog');
  assert(/data-home-tab=["']general["']>General<\/button>/.test(html), 'Bot Setup resource tab must be labeled General');
  assert(/sectionGeneralStamina/.test(html) && /sectionGeneralHealth/.test(html) && /sectionGeneralMana/.test(html), 'Resource policy sections must be ordered as Stamina, Health, and Mana');
  assert(html.indexOf('sectionGeneralStamina') < html.indexOf('sectionGeneralHealth'));
  assert(html.indexOf('sectionGeneralHealth') < html.indexOf('sectionGeneralMana'));
  assert(/id=["']chkBuyHealthPotion["']/.test(html) && /id=["']chkBuyManaPotion["']/.test(html), 'Health and Mana purchase-intent controls must exist');
  assert(!/id=["']selectRedStaminaMob["']/.test(html) && !/id=["']inputRedStaminaMob["']/.test(html), 'Red-stamina mob controls must not exist in UI');
  for (const id of ['inputSmallStaminaPotLimit', 'inputLargeStaminaPotLimit', 'inputFullStaminaPotLimit', 'inputAdventureStaminaPotLimit']) {
    assert(new RegExp(`id=["']${id}["']`).test(html), `${id} must exist`);
  }
  assert(/id=["']inputMaxHealthPotionPurchases["']/.test(html) && /id=["']healthPotsPurchasedCount["']/.test(html));
  assert(/id=["']inputMaxManaPotionPurchases["']/.test(html) && /id=["']manaPotsPurchasedCount["']/.test(html));
  assert(/id=["']chkAllowManaPotions["']/.test(html) && !/id=["']selectManaPotion["']/.test(html));
  assert(/id=["']inputSmallManaPotLimit["']/.test(html) && /id=["']inputLargeManaPotLimit["']/.test(html));
  assert(appSource.includes('enhanceNumberInputs'), 'Number controls must use themed steppers');
  assert(styles.includes('*::-webkit-scrollbar-thumb'), 'Scrollable panels must use the dark themed scrollbar');
  assert(styles.includes('.number-stepper:focus-within .number-stepper-btn'), 'Number steppers must appear only while their input is focused');
  assert(appSource.includes('function percentageInputValue') && appSource.includes('Math.min(100'), 'Typed percentage values must be clamped in the renderer as well as configuration');
  for (const id of ['inputKeepStaminaMin', 'inputKeepStaminaMax', 'inputStopStaminaBelow', 'inputSleepHealthBelow']) {
    assert(new RegExp(`id=["']${id}["'][^>]*max=["']100["']`).test(html), `${id} must be constrained to 0–100%`);
  }
  assert(/id=["']btnCollectMonsterStats["']/.test(html), 'Targets must expose per-area Monster Stats collection');
  assert(/id=["']modalMonsterStats["']/.test(html) && html.includes('monsterStatsView.js'), 'Targets must expose the shared Monster Stats dialog');
  assert(!monsterStatsViewSource.includes('Loot eligibility remains available above that level'), 'Monster Stats dialog must not add a Rewards Up To explanation');
  assert(preloadSource.includes("ipcRenderer.invoke('monsters:get-stats'"));
  assert(preloadSource.includes("ipcRenderer.invoke('monsters:collect-area-stats'"));
  assert(preloadSource.includes("ipcRenderer.invoke('loadouts:get-active'"), 'Preload must expose the read-only active-loadout API');
  assert(preloadSource.includes("ipcRenderer.invoke('combat:get-strategy-status'"), 'Preload must expose Attack Strategy observation status');
  assert(preloadSource.includes("ipcRenderer.invoke('combat:get-class-skills'"), 'Preload must expose authenticated class skills');
  assert(/data-tab=["']combat["']>Combat<\/button>/.test(html), 'Combat tab must exist in top-level navigation');
  for (const id of [
    'selectAttackMode', 'selectFixedAttack', 'selectMaxAttack', 'inputAttackOvershoot', 'btnRefreshAttackStrategy',
    'btnAttackModuleInfo', 'combatPlayerAttack', 'combatPlayerDefense', 'combatGearAttack', 'combatGearDefense',
    'combatPetAttack', 'combatPetDefense', 'chkAllowClassAbilities', 'chkAdaptiveFailSafe', 'inputAdaptiveFailSafePercent',
    'rowAdaptiveRequireTargetStamina', 'chkAdaptiveRequireTargetStamina',
    'btnGearSetInfo', 'btnPetSetInfo', 'modalLoadoutInfo', 'combatUnlockedAbilities',
  ]) {
    assert(new RegExp(`id=["']${id}["']`).test(html), `${id} must exist in Attack Strategy`);
  }
  assert(!/id=["']attackLoadoutHash["']/.test(html) && !/id=["']attackLearnedDamage["']/.test(html) && !/id=["']attackObservationConfidence["']/.test(html));
  assert(!html.includes('<div class="panel-header">Loadouts</div>') && !html.includes('<div class="panel-header">Attack Strategy</div>'), 'Combat must use General-style rows instead of boxed sections');
  assert(!html.includes('Gear names') && !html.includes('Pet names'), 'Long set names must live in the set information dialog');
  assert(!/id=["']selectAbilityUsage["']/.test(html), 'Combat must use an explicit ability permission instead of an unimplemented timing selector');
  assert(!html.includes('Read X active Gear items') && !/id=["']attackStrategyStatus["']/.test(html), 'Combat must not show the old loadout status sentence');
  assert(/\.combat-summary-card\s*\{[^}]*flex-direction:\s*row/s.test(styles), 'Combat summary labels and values must remain on one line');
  assert(appSource.includes('function refreshAttackStrategyStatus') && appSource.includes('function saveAttackStrategy'), 'Attack Strategy must save policy and observe the active loadout');
  assert(appSource.includes("checkbox.setAttribute('aria-label', `Allow ${skill.name}`)"), 'Each unlocked active ability must have an explicit selection checkbox');
  assert(appSource.includes('if (skill.passive)'), 'Owned passive skills must remain display-only');
  assert(appSource.includes('String(skill.staminaCost || 0)'));
  assert(/\.combat-unlocked-abilities\s*\{[^}]*width:\s*100%/s.test(styles), 'Unlocked abilities container must use full width');
  assert(appSource.includes("['Monster', 'Lootable', 'Priority', 'Max looting', '∞', 'Done', 'Loot']"), 'Looting must show a per-monster lootable count column');
  assert(appSource.includes("lootable.className = 'lootable-count'"));
  assert(/\.lootable-count\s*\{/.test(styles), 'Lootable counts must use the compact count badge');
  for (const [id, label] of [['btnRefreshMonsterArea', 'Target'], ['btnRefreshLootArea', 'Looting']]) {
    assert(
      new RegExp(`id=["']${id}["'][^>]*workspace-icon-btn[^>]*><i data-lucide=["']rotate-cw["']><\\/i><\\/button>`).test(html),
      `${label} refresh must use the square local rotate icon without text`,
    );
  }
  assert(/id=["']btnRefreshAttackStrategy["'][^>]*class=["'][^"']*btn btn-primary btn-sm workspace-icon-btn/.test(html), 'Combat refresh must use the same themed primary button treatment');
  assert(/\.workspace-icon-btn\s*\{[^}]*width:\s*26px;[^}]*height:\s*26px;/s.test(styles), 'Workspace refresh controls must be square');
  for (const equipmentId of ['selectGearPve', 'selectPetsPve']) {
    assert(new RegExp(`id=["']${equipmentId}["']`).test(html), `${equipmentId} must exist`);
  }
  for (const hiddenEquipmentId of ['selectGearPvpAttack', 'selectGearPvpDefense', 'selectPetsPvpAttack', 'selectPetsPvpDefense']) {
    assert(!new RegExp(`id=["']${hiddenEquipmentId}["']`).test(html), `${hiddenEquipmentId} must not clutter Combat`);
  }
  assert(appSource.includes('setNumber <= 10'), 'Equipment selectors must expose ten Quick Sets');
  assert(windowManagerSource.includes("button.id = '__veyraBrowserBack'"), 'Companion browser Back control must be injected');
  assert(windowManagerSource.includes('window.history.back()'), 'Companion browser Back control must use browser history');
  assert(windowManagerSource.includes("right: '12px'"), 'Companion browser Back control must be placed at top-right');
  console.log('   Renderer security contract passed.');
}

async function runAll() {
  console.log('====================================');
  console.log(' Running Veybot Test Suite');
  console.log('====================================');

  try {
    await testTimingEngine();
    await testActionQueue();
    await testFSM();
    await testSessionManager();
    await testCredentialManager();
    await testLiveStaminaRelay();
    await testLogger();
    await testChapterFarmer();
    await testFarmedEnergyExtraction();
    await testMangaManager();
    await testStaminaFormula();
    await testConfiguration();
    await testResourcePolicyEngine();
    await testGameParsers();
    await testLoadoutCatalog();
    await testDamageObservationsAndAttackPlanner();
    await testMonsterCatalogService();
    await testStrategyEngine();
    await testPlanningBoundaries();
    await testApiActionLayer();
    await testBotEngineDryRun();
    await testAutomaticFarmAuthenticationFailure();
    await testHttpAndGameAPI();
    await testRendererSecurityContract();
    console.log('====================================');
    console.log(' ALL UNIT TESTS PASSED SUCCESSFULLY');
    console.log('====================================');
  } catch (err) {
    console.error(' Test failed:', err);
    process.exit(1);
  }
}

runAll();
