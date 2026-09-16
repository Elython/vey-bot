# Veybot

Veybot is a compact Electron client for managing authenticated game sessions and running the API-driven automation engine.

## Windows (recommended)

Download the `Veybot-<version>-portable.exe` release and double-click it. The portable build includes Electron, Node.js, and Chromium; no Java, Node.js, npm, or installer is required.

On first launch:

1. Add an account and complete login in the game window.
2. Keep **Dry Run** enabled while checking the account, area, targets, and resource policies.
3. Configure Bot Setup, Combat, Progression, Targets, and Looting.
4. Disable Dry Run only when you intentionally want Veybot to send game actions.
5. Start the bot from the top-right control. Use Pause or Stop before changing a running strategy.

The companion game window can remain hidden. Use **Open in Browser** when you need to inspect it; its Back button uses normal browser history.

## Data and privacy

Sessions, encrypted login autocomplete, configuration, learned observations, catalog cache, and logs are stored in the operating system's Veybot data directory. Do not share that directory or a copied executable together with it. Never put cookies, credentials, or account exports into a release archive.

## Build from source

For development, install Node.js 22 or newer and run:

```bash
npm install
npm start
```

To create the Windows portable executable locally:

```bash
npm run dist:win
```

The artifact is written to `release/`. A Windows build runner is recommended for release builds. Unsigned builds may show an “Unknown publisher” SmartScreen warning; code signing removes that warning.

## Safety

- Dry Run defaults to enabled and blocks mutating requests.
- Mutating requests are sent once; ambiguous results are reconciled before the bot continues, and unresolved results pause the bot.
- Cloudflare/Turnstile challenges remain human-assisted.
