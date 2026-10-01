/**
 * Authenticated GET-only discovery check.
 * This script never calls HttpClient.post and never starts BotEngine.
 */

const { app, session } = require('electron');
const { SessionManager } = require('../src/main/sessionManager');
const { ConfigManager } = require('../src/engine/configManager');
const { TimingEngine } = require('../src/scheduler/timingEngine');
const { HttpClient } = require('../src/engine/httpClient');
const { GameAPI } = require('../src/engine/gameAPI');
const { parseStatsPage } = require('../src/engine/gameParsers');

app.disableHardwareAcceleration();

async function run() {
  const sessionManager = new SessionManager();
  const accountName = process.argv[2] || sessionManager.getLastActiveAccount();
  if (!accountName || !sessionManager.listAccounts().some(account => account.name === accountName)) {
    throw new Error('No saved account is available for dry-run discovery');
  }

  const partition = session.fromPartition(`persist:veyra_${encodeURIComponent(accountName)}`);
  await sessionManager.restoreAccountSession(partition, accountName);
  const webContentsAdapter = { session: partition, isDestroyed: () => false };
  const config = new ConfigManager().getConfig();
  const timing = new TimingEngine(config.scheduler);
  const http = new HttpClient(webContentsAdapter, 'DryRun', timing);
  http.post = async () => {
    throw new Error('Safety violation: live dry-run attempted a POST request');
  };
  const api = new GameAPI(http, 'DryRun');

  const statsResponse = await http.get('https://demonicscans.org/stats.php');
  let dashboardResponse = null;
  let dashboardError = null;
  try {
    dashboardResponse = await http.get('https://demonicscans.org/game_dash.php');
  } catch (error) {
    dashboardError = { code: error.code || 'ERROR', message: error.message };
  }
  const stats = parseStatsPage(statsResponse.text);
  const statsPage = {
    status: statsResponse.status,
    bytes: Buffer.byteLength(statsResponse.text),
    title: statsResponse.text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim().slice(0, 100) || null,
    hasAuthenticatedName: /class=["'][^"']*\bsmall-name\b/i.test(statsResponse.text),
    hasPasswordForm: /type=["']password["']/i.test(statsResponse.text),
    hasChallengeMarker: /Just a moment|challenge-stage|cf-turnstile|challenges\.cloudflare\.com/i.test(statsResponse.text),
    hasStatsIds: /id=["']v-attack["']/i.test(statsResponse.text) && /id=["']v-defense["']/i.test(statsResponse.text),
    shortBodySignal: /not\s+(?:logged|signed)\s+in/i.test(statsResponse.text) ? 'NOT_SIGNED_IN'
      : /login\s+required/i.test(statsResponse.text) ? 'LOGIN_REQUIRED'
        : /unauthorized|not\s+authorized/i.test(statsResponse.text) ? 'UNAUTHORIZED'
          : /access\s+denied/i.test(statsResponse.text) ? 'ACCESS_DENIED'
            : 'UNKNOWN',
  };
  const linkedPaths = [...(dashboardResponse?.text || '').matchAll(/href=["']([^"']+)["']/gi)]
    .map(match => {
      try {
        const url = new URL(match[1], 'https://demonicscans.org/game_dash.php');
        return url.origin === 'https://demonicscans.org' ? url.pathname : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const discoveryPaths = [...new Set(linkedPaths.filter(value => /gate|wave|battle/i.test(value)))];

  let gates = [];
  let monsters = [];
  let battle = null;
  let wavePage = null;
  let discoveryError = null;
  try {
    gates = await api.getGates();
    const resolvedWave = await api.resolveWave(config.gates.targetGate, config.gates.targetWave);
    const waveUrl = `https://demonicscans.org/active_wave.php?gate=${config.gates.targetGate}&wave=${resolvedWave}`;
    const waveResponse = await http.get(waveUrl);
    const waveHtml = waveResponse.text;
    const relevantClasses = [...waveHtml.matchAll(/class=["']([^"']+)["']/gi)]
      .flatMap(match => match[1].split(/\s+/))
      .filter(value => /monster|boss|enemy|wave|battle|raid/i.test(value));
    wavePage = {
      resolvedWave,
      status: waveResponse.status,
      bytes: Buffer.byteLength(waveHtml),
      title: waveHtml.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim().slice(0, 100) || null,
      battleLinks: [...waveHtml.matchAll(/href=["'][^"']*battle\.php\?id=/gi)].length,
      relevantClasses: [...new Set(relevantClasses)].slice(0, 30),
      hasNoMonsterMessage: /no\s+(?:active\s+)?monsters?|no\s+enemies|wave\s+(?:is\s+)?empty/i.test(waveHtml),
    };
    monsters = api._parseMonsterCards(waveHtml);
    const candidate = monsters.find(monster => !monster.dead && monster.hp !== 0);
    battle = candidate ? await api.getBattleConfig(candidate.battleId || candidate.id) : null;
  } catch (error) {
    discoveryError = { code: error.code || 'ERROR', message: error.message };
  }

  const report = {
    safety: 'GET_ONLY_NO_POST',
    stats: {
      level: stats.level,
      stamina: stats.stamina,
      maxStamina: stats.maxStamina,
      attack: stats.attack,
      defense: stats.defense,
      goldParsed: stats.gold !== undefined,
      gemsParsed: stats.gems !== undefined,
      page: statsPage,
      dashboardError,
    },
    discovery: {
      gates: gates.length,
      activeGates: gates.filter(gate => gate.active).length,
      gateLinks: gates.map(gate => ({ name: gate.name, active: gate.active, url: gate.url })),
      waveMonsters: monsters.length,
      viableMonsters: monsters.filter(monster => !monster.dead && monster.hp !== 0).length,
      wavePage,
      dashboardPaths: discoveryPaths,
      error: discoveryError,
    },
    battle: battle ? {
      configParsed: Boolean(battle.battleCfg?.id),
      skills: battle.skills.length,
      monsterHpParsed: battle.monsterHp !== null,
      playerHpParsed: battle.playerHp !== null,
      joinStatusParsed: typeof battle.isJoined === 'boolean',
    } : null,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (discoveryError) process.exitCode = 2;
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch(error => {
    process.stderr.write(`Live dry-run failed: ${error.code || 'ERROR'}: ${error.message}\n`);
    app.exit(1);
  });
