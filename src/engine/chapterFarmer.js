const { Logger } = require('../main/logger');
const crypto = require('crypto');

class ChapterFarmer {
  constructor(httpClient, timingEngine) {
    this.http = httpClient;
    this.timing = timingEngine;
    this.reactedChapters = new Set();
  }

  setHttpClient(httpClient) {
    this.http = httpClient;
  }

  static extractChapterId(html) {
    if (!html || typeof html !== 'string') return null;
    const patterns = [
      /formData\.append\(['"]chapterid['"],\s*['"](\d+)['"]\)/i,
      /reacted_chap_(\d+)/i,
      /submitcomment\(\d+,\s*(\d+)/i,
      /data-chapter-id=['"](\d+)['"]/i,
      /name=['"]chapterid['"]\s+value=['"](\d+)['"]/i,
      /id=['"]chapter_?(\d+)['"]/i,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return match[1];
    }
    return null;
  }

  static resolveReactionType(reaction) {
    if (String(reaction || '').toLowerCase() === 'random' || !reaction) {
      return Math.floor(Math.random() * 5) + 1;
    }
    const number = Number.parseInt(reaction, 10);
    return number >= 1 && number <= 5 ? number : 1;
  }

  static hasUserUidContract(html) {
    return /function\s+getOrCreateUserUID\s*\(/.test(html || '') &&
      /document\.cookie\s*=\s*`useruid=\$\{uid\}/.test(html || '') &&
      /formData\.append\(['"]useruid['"],\s*userUID\)/.test(html || '');
  }

  static generateUserUid(now = Date.now()) {
    let random = '';
    while (random.length < 16) {
      random += BigInt(`0x${crypto.randomBytes(8).toString('hex')}`).toString(36);
    }
    return `uid-${random.slice(0, 16)}${Math.trunc(now)}`;
  }

  async _getOrCreateUserUid(chapterHtml) {
    const cookies = await this.http.getCookies();
    const existing = cookies.find(cookie => cookie.name === 'useruid')?.value;
    if (existing) return existing;
    if (!ChapterFarmer.hasUserUidContract(chapterHtml)) {
      throw new Error('Chapter page did not expose the verified useruid reaction contract.');
    }
    const userId = ChapterFarmer.generateUserUid();
    await this.http.setCookie({
      url: 'https://demonicscans.org/',
      name: 'useruid',
      value: userId,
      path: '/',
      expirationDate: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60),
      secure: true,
      sameSite: 'lax',
    });
    return userId;
  }

  async farmSingleChapter(accountName, slug, chapterNum, reactionType = '1', signal = null) {
    if (!this.http) return { success: false, message: 'Game browser session unavailable.' };
    const safeSlug = String(slug || '').trim();
    const safeChapter = Number.parseInt(chapterNum, 10);
    if (!/^[A-Za-z0-9_-]+$/.test(safeSlug) || !Number.isInteger(safeChapter) || safeChapter < 1) {
      return { success: false, message: 'Invalid manga slug or chapter number.' };
    }

    const chapterKey = `${safeSlug.toLowerCase()}:${safeChapter}`;
    if (this.reactedChapters.has(chapterKey)) {
      return { success: false, duplicate: true, message: 'Chapter was already processed in this session.' };
    }

    const chapterUrl = `https://demonicscans.org/title/${encodeURIComponent(safeSlug)}/chapter/${safeChapter}/1`;
    try {
      const response = await this.http.get(chapterUrl, { retries: 1 });
      if (!response.ok) {
        return { success: false, status: response.status, message: `Failed to load chapter page (HTTP ${response.status}).` };
      }
      const chapterId = ChapterFarmer.extractChapterId(response.text);
      if (!chapterId) {
        Logger.logApi(accountName, 'PARSE', chapterUrl, 200, 'Could not locate numeric chapter ID');
        return { success: false, message: `Could not find chapter ID for Chapter ${safeChapter}.` };
      }

      const userId = await this._getOrCreateUserUid(response.text);
      const reactionCode = ChapterFarmer.resolveReactionType(reactionType);
      await this.timing.waitForAction(signal);
      const postResponse = await this.http.postMultipart('https://demonicscans.org/postreaction.php', {
        chapterid: chapterId,
        reaction: reactionCode,
        useruid: userId,
      }, { retries: 1 });

      if (!postResponse.ok) {
        Logger.logApi(accountName, 'POST', 'https://demonicscans.org/postreaction.php', postResponse.status, 'Reaction failed');
        return { success: false, status: postResponse.status, message: postResponse.text.slice(0, 200) };
      }

      const updated = /updated/i.test(postResponse.text);
      if (!updated) {
        Logger.logApi(accountName, 'POST', 'https://demonicscans.org/postreaction.php', postResponse.status, 'Reaction response did not confirm an update');
        return { success: false, status: postResponse.status, message: postResponse.text.slice(0, 200) || 'Reaction was not confirmed by the server.' };
      }

      this.reactedChapters.add(chapterKey);
      Logger.logApi(accountName, 'POST', 'https://demonicscans.org/postreaction.php', postResponse.status, `Reaction success (${reactionCode})`);
      return { success: true, chapterId, reactionCode, message: postResponse.text.trim().slice(0, 200), status: postResponse.status };
    } catch (error) {
      const isCloudflare = error.code === 'CLOUDFLARE';
      Logger.logApi(accountName, 'FARM', chapterUrl, error.status || 0, `Error: ${error.message}`);
      return { success: false, isCloudflare, code: error.code, message: error.message };
    }
  }

  resetCycle() {
    this.reactedChapters.clear();
  }

  stop() {
    this.timing?.cancelAll();
  }
}

module.exports = { ChapterFarmer };
