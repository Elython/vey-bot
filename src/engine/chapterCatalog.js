const { decodeHtml, stripTags } = require('./gameParsers');

const GAME_ORIGIN = 'https://demonicscans.org';

function normalizeMangaInput(input) {
  const clean = String(input || '').trim();
  if (!clean) return null;
  let url;
  if (/^https?:\/\//i.test(clean)) {
    try {
      url = new URL(clean);
    } catch {
      return null;
    }
    if (!/(^|\.)demonicscans\.org$/i.test(url.hostname)) return null;
  } else {
    const slug = clean.replace(/\s+/g, '-');
    if (!/^[A-Za-z0-9_-]+$/.test(slug)) return null;
    url = new URL(`/manga/${encodeURIComponent(slug)}`, GAME_ORIGIN);
  }
  const match = url.pathname.match(/^\/(?:manga|title)\/([^/?#]+)/i);
  let slug = match ? match[1] : '';
  try {
    for (let i = 0; i < 6 && /%[0-9a-f]{2}/i.test(slug); i += 1) slug = decodeURIComponent(slug);
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) return null;
  url.protocol = 'https:';
  url.hostname = 'demonicscans.org';
  url.port = '';
  url.hash = '';
  return { slug, url: url.toString() };
}

function chapterNumberFromUrl(url) {
  const pathMatch = url.pathname.match(/\/chapter\/(\d+(?:\.\d+)?)(?:\/|$)/i);
  if (pathMatch) return Number(pathMatch[1]);
  const queryValue = url.searchParams.get('chapter');
  return /^\d+(?:\.\d+)?$/.test(queryValue || '') ? Number(queryValue) : null;
}

function parseChapterCatalog(html, pageUrl, fallback = {}) {
  const source = String(html || '');
  const normalized = normalizeMangaInput(pageUrl || fallback.url || fallback.slug);
  if (!normalized) return { recognized: false, ...fallback, chapterEntries: [] };
  const candidates = [];
  for (const match of source.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    let url;
    try {
      url = new URL(decodeHtml(match[1]), normalized.url);
    } catch {
      continue;
    }
    if (!/(^|\.)demonicscans\.org$/i.test(url.hostname)) continue;
    const chapter = chapterNumberFromUrl(url);
    if (!Number.isFinite(chapter) || chapter <= 0) continue;
    url.protocol = 'https:';
    url.hostname = 'demonicscans.org';
    url.port = '';
    url.hash = '';
    candidates.push({ number: chapter, url: url.toString() });
  }
  const byChapter = new Map();
  for (const candidate of candidates) {
    if (!byChapter.has(candidate.number)) byChapter.set(candidate.number, candidate);
  }
  const chapterEntries = [...byChapter.values()].sort((left, right) => left.number - right.number);
  const countMatch = stripTags(source).match(/([\d,]+)\s+Chapters?\s+Available/i);
  const declaredCount = countMatch ? Number(countMatch[1].replace(/,/g, '')) : 0;
  const heading = source.match(/<h1[^>]*class=["'][^"']*big-fat-titles[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i)
    || source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const fallbackTitle = normalized.slug.replace(/-/g, ' ');
  return {
    recognized: chapterEntries.length > 0 || declaredCount > 0 || /Chapters?\s+Available/i.test(source),
    slug: normalized.slug,
    url: normalized.url,
    title: heading ? stripTags(heading[1]).trim() : (fallback.title || fallbackTitle),
    chapters: Math.max(declaredCount, chapterEntries.length, Number(fallback.chapters) || 0),
    chapterEntries,
  };
}

function nextUnfarmedChapter(manga) {
  const completed = new Set((manga?.farmedChapterNumbers || Array.from({ length: Math.max(0, Number(manga?.farmedCount) || 0) }, (_, index) => index + 1)).map(Number));
  const entries = Array.isArray(manga?.chapterEntries) ? manga.chapterEntries : [];
  const explicit = entries.find(entry => Number.isFinite(Number(entry.number)) && Number(entry.number) > 0 && !completed.has(Number(entry.number)));
  if (explicit) return { number: Number(explicit.number), url: explicit.url || null };
  if (entries.length > 0) return null;
  const count = Math.max(0, Number(manga?.chapters) || 0);
  for (let chapter = 1; chapter <= count; chapter += 1) {
    if (!completed.has(chapter)) return { number: chapter, url: null };
  }
  return null;
}

module.exports = {
  GAME_ORIGIN,
  normalizeMangaInput,
  parseChapterCatalog,
  nextUnfarmedChapter,
};
