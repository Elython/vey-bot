# Veybot

Veybot is a compact Electron client for managing authenticated DemonicScans game sessions and running controlled, API-driven automation. It keeps the game browser available in a hidden companion window, exposes the important account and automation state in one desktop interface, and stores each account's configuration and history separately.

> Veybot is an independent client. Game endpoints and page markup can change, so mutating automation should be enabled only after verifying the current account and configuration. Dry-run mode is enabled by default.

## What Veybot Does

### Accounts and game sessions

- Supports multiple saved accounts with one active account per application process.
- Keeps the authenticated game browser alive when its window is hidden and lets the user reopen it at any time.
- Includes normal browser Back navigation.
- Uses the same persistent Electron session for browser pages and API requests.
- Can save login autocomplete credentials through OS-protected encryption when secure platform storage is available.
- Keeps configuration, monster knowledge, activity history, statistics, and Progression profiles isolated by verified game account ID.
- Supports account-data export/restore, configuration import/export, history clearing, and a guarded account-data purge.

### Automation modules

The Bot Setup workspace currently provides these modules:

- **Gates** — targets configured monsters from a selected Gate.
- **Event** — applies the Gate combat model to configured Event areas.
- **Dungeons** — discovers active, cleared, and failed Guild Dungeons, joins configured monsters, and supports Cube PvE rooms.
- **Auto Farm** — configures and starts the game's server-side Auto Farm, including target management and server progress. Normal PvE attacks are suspended while Auto Farm is active. The game exposes this feature only to eligible accounts and it supports Gates/Events rather than Dungeons.
- **Battle Pass** — reads the active daily objectives and automates the supported Stamina-spend and configured monster target/loot objectives. Optional safe-check behavior confirms that relevant counters advance. Season reward claiming is not automated.
- **Adv Quests** — reads the Adventurer Guild board, accepts enabled quests, abandons a conflicting active quest when required, routes supported work through the existing combat/loot engine, and turns in a quest only when the board proves it complete.
- **Idle** — keeps the authenticated client available without running an automation module.

### Targets, combat, and loadouts

- Separate Gate, Event, Dungeon, and Cube target discovery with account-access awareness.
- Per-monster target enablement, target damage, reached-count goal, priority, minimum HP, Gear/Pet Quick Sets, ability permission, and Stamina-potion preference.
- Unlimited target goals and fair rotation between targets with equal priority.
- **Fixed** attacks using a selected x1/x10/x50/x100/x200/x1000 hit.
- **Adaptive** attacks based on observed non-critical damage, maximum hit size, overshoot allowance, optional x1 fail-safe, target-Stamina requirement, and an optional finishing nuke.
- Exact server `totaldmgdealt` remains the final authority for target completion.
- Class abilities can be classified as Attack, Buff, Debuff, or Passive, with individual enablement, use limits, reuse spacing, first-use timing, and minimum next-attack cost.
- Gear and Pet Quick Set 1–10 inspection and application. Active loadouts receive deterministic hashes so learned damage can be reused after switching back to a known setup.
- Phase bosses can be recognized as distinct configured targets even when phases reuse a numeric monster ID.
- Verified Phase 3 boss duels open in a hidden authenticated watcher and use the game's Server AI before normal PvE attacks resume.

### Cube PvP

- Discovers Cube PvP nodes and their OPEN, LIVE, and CLEARED matches.
- Lets the user enable nodes and prioritize individual matches.
- Joins an available formation slot and keeps the authenticated match alive while the game Server AI chooses attacks.
- Tracks commitments and the two-hour cooldown independently for each Cube instance and node.
- Releases completed watchers, follows new Cube instances/nodes, and reports waiting or blocked reasons in Overview.

### Resources and Progression

- Live Stamina, HP, Mana, Gold, Gems, Level/EXP, and farmed-chapter energy display.
- Configurable Stamina range and hard stop threshold.
- Potion-first healing, HP threshold/sleep behavior, death limits, verified HP-potion use, and bounded HP-potion purchases.
- Mana ranges aligned to 20 Mana, multi-use Small Mana potions (`qty` 1–10), per-type limits, priorities, and bounded Mana-potion purchases.
- Stamina-potion policies for Small, Large, Full, and Adventure potions, including priority, limits, drain-before-use behavior, inventory counts, and per-run usage.
- Progression can bank eligible monster loot until it is sufficient to level, drain Stamina before the refill, claim a locked verified loot batch, and then recalculate.
- Optional Chapter fallback and Stamina-potion fallback when loot alone cannot produce a level.
- Gate, Event, and Dungeon loot sources can be enabled independently.
- Multiple account-scoped **Progression configs** can be created, renamed, selected, and deleted. Each new config starts from safe defaults; the immutable Default config preserves migrated behavior.
- Manual and Automatic chapter-reaction farming, configurable manga lists, batch counts, delays, progress, authentication handling, and post-success Stamina synchronization.
- XP Boost detection is included when estimating server loot EXP.

### Loot, catalogs, history, and statistics

- Shared discovery of claimable Gate, Event, Dungeon, and stacked Auto Farm loot.
- Per-monster loot enablement, priority, limits, and manual one-shot Loot action.
- Progression and Looting consume the same cached semantic loot observation instead of scanning the same source independently.
- Loot history records server time, EXP, Gold, damage contribution, items, and the original monster page.
- Attack history records individual hits immediately and groups activity by area, monster type, and exact monster instance.
- Monster Stats and Possible Loot catalogs include ATK/DEF/HP, EXP-per-damage, reward level, item names, required damage, and drop chance when exposed by the game page.
- Settings includes an explicit catalog refresh that walks visible known areas and applies detected Stats/Loot changes. There is no hidden catalog-wide background crawler.
- Account-scoped statistics cover attacks, reached targets, Stamina, loot claims, EXP, Gold, items, potions, chapters, healing, PvP results, areas, monsters, and recent trends.
- Overview shows the current operation, module, resource state, per-run counters, potion inventory, Cube/Phase PvP state, and a filterable live console.

## Safety and Request Handling

- **Dry-run is enabled by default.** Reads remain available, while Join, Attack, Heal, Loot, Reaction, purchase, item-use, and other mutations are blocked.
- Mutating POST requests are not blindly retried. When a response may have been lost, Veybot performs an authoritative follow-up read and either confirms the result or fails closed.
- Stop/Pause cancels queued waits and prevents stale work from continuing under a previous run owner.
- Gate/Event availability is account-scoped. Locked waves are treated as unavailable rather than repeated engine errors.
- Accounts outside a Guild receive an empty Dungeon directory instead of repeated Guild/Dungeon failures.
- Cloudflare/Turnstile challenges remain human-assisted; Veybot does not attempt to bypass them.
- Passwords are never stored as plaintext. Linux's insecure `basic_text` encryption fallback is rejected.

Before disabling dry-run, verify the selected account, module, area, targets, damage goals, resource limits, Quick Sets, and potion permissions in the companion browser.

## Interface

The current workspaces are:

- **Overview** — live account stats, operation state, PvP status, per-run totals, potion inventory, and logs.
- **Bot Setup** — active module, area, Progression config, resource policy, and advanced pacing/safety settings.
- **Auto Farm** — server Auto Farm settings, progress, current targets, and addable targets.
- **Combat** — Fixed/Adaptive strategy, Gear/Pet sets, ability policy, and PvP controls.
- **Progression** — named strategies, loot-leveling sources, Chapter fallback, potion policy, chapter farming, and loot history.
- **Battle Pass** — current objective counters and BP target policies.
- **Adv Quests** — current quest-board state and per-quest automation policy.
- **Targets** — current monsters, combat policy, Auto Farm policy, Cube matches, and attack history.
- **Looting** — loot policy and current claimable monsters.
- **Statistics** — local account activity summaries and history.
- **Logs** — developer-facing logs when Developer mode is enabled.

The header Save button indicates unapplied configuration changes. Applying changes updates the active runtime without requiring the application to restart.

## Local Data

Veybot stores account-owned configuration and history locally. Durable records use the verified numeric game account identity rather than the display name. Temporary battle IDs, active phase-duel state, in-flight mutations, and Cube watchers remain runtime-only.

Portable account exports include account-owned configuration, history, and remembered monster knowledge. They intentionally exclude credentials, cookies, active runtime state, and unattributed legacy/global monster caches.

## Requirements

- Node.js 22 or newer for development.
- npm.
- A manually authenticated DemonicScans account.
- Guild membership for Guild Dungeon and Cube features.

## Install and Run

```bash
npm ci
npm start
```

The first login may require completing the site's challenge or closing a site popup in the companion browser. Once the authenticated Dashboard is verified, Veybot keeps that session available in the background.

## Development and Tests

```bash
npm run build:renderer
npm run check:renderer
npm test
npm run dry-run:live
```

The renderer is split into `src/renderer/views/` and `src/renderer/app/`. Edit those source files and `src/renderer/index.template.html`, then run `npm run build:renderer` to regenerate the committed `index.html` and `app.js` entry files.

`npm test` covers parsers, account isolation, shared reads, configuration migration, combat planning, resource policies, objectives, Auto Farm, Cube, Progression, mutation reconciliation, renderer security, and lifecycle cancellation.

## Architecture

```text
Renderer
  └─ Preload IPC
      └─ Electron Main / account composition
          ├─ Session + companion browser
          ├─ AccountDatabase + configuration/history repositories
          ├─ ReadCoordinator + WorldStateService
          │   ├─ Stats collector
          │   ├─ Target and area-directory collectors
          │   ├─ Loot collector
          │   ├─ Objective collectors
          │   ├─ Loadout collector
          │   ├─ Auto Farm collector
          │   └─ Cube collector
          └─ BotEngine
              ├─ ModuleRegistry + StrategyEngine
              ├─ ProgressionEngine + ResourcePolicyEngine
              ├─ AttackPlanner + DamageObservationStore
              └─ ActionExecutor
                  └─ BattleManager / GameController / GameAPI / HttpClient
```

Raw server observations have one production read owner per domain. UI workspaces and automation derive their views and decisions from the same account-scoped snapshots. User policy stays in configuration; temporary server facts stay in World State; confirmed history and learned account knowledge stay in the account database.

Important source locations:

- `src/main/` — application lifecycle, windows, sessions, IPC, account composition, and logs.
- `src/engine/` — shared observations, persistence, configuration, parsers, API adapters, strategy, resources, objectives, battle, and bot lifecycle.
- `src/scheduler/` — cancellable timing and action queue utilities.
- `src/renderer/` — the local control interface and generated entry files.
- `test/fixtures/` — redacted captured response/page contracts.
- `test/` and `src/test/` — functional, architecture, and regression coverage.

## Development Rule

Do not guess selectors, endpoints, request fields, or response shapes. Capture and redact the real contract, add a failing fixture-backed test, and only then update the parser or endpoint adapter.
