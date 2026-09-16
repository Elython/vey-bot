/**
 * Compatibility facade for manual energy farming.
 * Reaction submission is delegated to the verified ChapterFarmer API path.
 */
class EnergyFarmEngine {
  constructor(chapterFarmer) {
    this.chapterFarmer = chapterFarmer;
  }

  async farmChapter(accountName, targetManga, chapterNum = 1, reactionType = 'random') {
    const slug = String(targetManga || '')
      .replace(/^https?:\/\/[^/]+\/(?:manga|title)\//i, '')
      .split(/[/?#]/)[0];
    const result = await this.chapterFarmer.farmSingleChapter(
      accountName,
      slug,
      chapterNum,
      reactionType
    );
    return {
      ...result,
      energy: result.success ? 2 : 0,
    };
  }

  stop() {
    this.chapterFarmer.stop();
  }
}

module.exports = { EnergyFarmEngine };
