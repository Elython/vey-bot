/** Apply a saved draft only after automation stops. Failed Apply never resumes it. */
async function applyPendingConfiguration({ engine, config, getConfig = null, cubeService, validate = () => null }) {
  const error = validate(config);
  if (error) return { success: false, error };
  const wasRunning = engine.isRunning === true;
  const wasPaused = engine.isPaused === true;
  try {
    if (wasRunning && !wasPaused) {
      await engine.stopAndWait();
      await cubeService?.stop();
    }
    // A mutation may finish while Stop waits; do not restore its old journal state.
    config = getConfig ? getConfig() : config;
    const validationError = validate(config);
    if (validationError) throw new Error(validationError);
    engine.replaceConfig(config, { preserveProgressionSnapshot: true });
    const loadouts = config.general?.module === 'pvp'
      ? { success: true, skipped: true } : await engine.applyConfiguredPveLoadouts();
    if (wasRunning && !wasPaused) {
      if (!engine.start({ preserveProgressionSnapshot: true })) throw new Error('The bot could not restart after applying its configuration');
      await cubeService?.start(engine.config);
    }
    return { success: true, restarted: wasRunning && !wasPaused, paused: wasPaused, loadouts };
  } catch (error) {
    if (engine.isRunning) engine.pause('Safety pause: configuration could not be applied');
    else engine.stop('Configuration could not be applied. Check the loadout before restarting.', 'apply_failed');
    return { success: false, error: 'Could not apply configuration: ' + error.message };
  }
}

module.exports = { applyPendingConfiguration };
