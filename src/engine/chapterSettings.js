function bounded(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, Math.trunc(number))) : fallback;
}

function normalizeChapterSettings(settings = {}) {
  settings = settings && typeof settings === 'object' ? settings : {};
  const delay = String(settings.delay || '1.0s');
  return {
    configMode: settings.configMode === 'independent' ? 'independent' : 'scheduler',
    delay: ['0.5s', '1.0s', '2.0s', '5.0s'].includes(delay) ? delay : '1.0s',
    stopMaxStamina: settings.stopMaxStamina !== false,
    maxStaminaFarm: bounded(settings.maxStaminaFarm, 1000, 0, 1000000),
    stopHourlyMin: bounded(settings.stopHourlyMin, 10, 0, 720),
    manualChapterCount: bounded(settings.manualChapterCount, 1, 1, 1000000),
    lastWorkingManga: String(settings.lastWorkingManga || '-').slice(0, 300),
  };
}

function projectChapterSettings(config) {
  const farming = config.energyFarming || {};
  return { ...normalizeChapterSettings(farming.chapterSettings),
    module: farming.enabled === true ? 'automatic' : 'manual', reactionType: farming.reactionType || 'random' };
}

module.exports = { normalizeChapterSettings, projectChapterSettings };
