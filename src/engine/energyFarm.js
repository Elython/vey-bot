/**
 * Compatibility facade for manual energy farming.
 * Reaction submission is delegated to the verified ChapterFarmer API path.
 */
class EnergyFarmEngine {
  constructor(chapterFarmer) {
    this.chapterFarmer = chapterFarmer;
  }

  async farmChapter(accountName, targetManga, chapterNum = 1, reactionType = 'random', chapterUrl = null, options = {}) {
    const slug = String(targetManga || '')
      .replace(/^https?:\/\/[^/]+\/(?:manga|title)\//i, '')
      .split(/[/?#]/)[0];
    const result = await this.chapterFarmer.farmSingleChapter(
      accountName,
      slug,
      chapterNum,
      reactionType,
      null,
      { chapterUrl, delayMs: options.delayMs },
    );
    return {
      ...result,
      energy: result.success ? Math.max(0, Number(result.energy) || 0) : 0,
    };
  }

  stop() {
    this.chapterFarmer.stop();
  }
}

module.exports = { EnergyFarmEngine };
