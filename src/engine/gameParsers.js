/**
 * Pure parsers for verified DemonicScans HTML contracts.
 * These functions deliberately have no Electron, network, logging, or global state dependencies.
 */

const { canonicalNameKey, normalizeEffectText, parseRecognizedEffects } = require('./loadoutCatalog');

function decodeHtml(value = '') {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(value = '') {
  return decodeHtml(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).replace(/,/g, '').trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function parseAttributes(source = '') {
  const attributes = {};
  const regex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (name === '<' || name.startsWith('<')) continue;
    attributes[name] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function hasClass(attributes, className) {
  return String(attributes.class || '').split(/\s+/).includes(className);
}

function elementBlocks(html, tagName, className) {
  const blocks = [];
  const openRegex = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  const openings = [];
  let match;
  while ((match = openRegex.exec(html)) !== null) {
    const attributes = parseAttributes(match[1]);
    if (hasClass(attributes, className)) {
      openings.push({ index: match.index, end: openRegex.lastIndex, attributes });
    }
  }

  for (let index = 0; index < openings.length; index++) {
    const current = openings[index];
    const nextStart = openings[index + 1]?.index ?? html.length;
    blocks.push({
      attributes: current.attributes,
      html: html.slice(current.end, nextStart),
      start: current.index,
    });
  }
  return blocks;
}

function findClassValue(html, className) {
  const regex = new RegExp(`<[^>]+class=(?:"[^"]*\\b${className}\\b[^"]*"|'[^']*\\b${className}\\b[^']*')[^>]*>([\\s\\S]*?)<\\/[^>]+>`, 'i');
  const match = html.match(regex);
  return match ? stripTags(match[1]) : null;
}

function findTagAttributesByClass(html, tagName, className) {
  const regex = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  let match;
  while ((match = regex.exec(html)) !== null) {
    const attributes = parseAttributes(match[1]);
    if (hasClass(attributes, className)) return attributes;
  }
  return null;
}

function findImageAttributes(html) {
  const match = String(html).match(/<img\b([^>]*)>/i);
  return match ? parseAttributes(match[1]) : null;
}

function rarityFromCard(attributes, html) {
  const classes = String(attributes.class || '').toLowerCase().split(/\s+/);
  const known = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythical'];
  for (const rarity of known) {
    if (classes.includes(rarity) || classes.includes(`pet-card-${rarity}`)) return rarity;
  }
  const badge = String(html).match(/class=["'][^"']*(?:badge|legend-badge)[^"']*["'][^>]*>([\s\S]*?)<\//i);
  return badge ? stripTags(badge[1]).toLowerCase() : 'unknown';
}

function effectTextFromDescription(description = '') {
  const lines = String(description).split(/\r?\n/);
  const line = lines.find(value => /⚡/u.test(value))
    || lines.find(value => /Extra Damage/i.test(value))
    || lines.find(value => /Increase/i.test(value));
  return normalizeEffectText(line || '');
}

function registerDefinition(definitions, warnings, definition) {
  if (!definition.key) return;
  const existing = definitions.get(definition.key);
  if (!existing) {
    definitions.set(definition.key, definition);
    return;
  }
  if (existing.name !== definition.name) {
    warnings.push(`Catalog key collision: ${existing.name} / ${definition.name}`);
  }
}

function parseGearInventoryCard(block) {
  const info = findTagAttributesByClass(block.html, 'button', 'info-btn') || {};
  const image = findImageAttributes(block.html) || {};
  const name = (findClassValue(block.html, 'equipment-item-name') || info['data-name'] || image.alt || '').trim();
  if (!name) return null;
  const description = String(info['data-desc'] || '').trim();
  const rawEffect = effectTextFromDescription(description);
  const itemReferenceMatch = block.html.match(/showEquipModal\(\s*(\d+)/i);
  const quantityMatch = block.html.match(/>\s*x\s*([\d,]+)\s*<\/div>/i);
  const elementMatch = description.match(/Element:\s*([^\r\n]+)/i);
  return {
    definitionKey: canonicalNameKey(name, 'gear'),
    name,
    inventoryRef: block.attributes['data-inv-id'] || null,
    itemReference: itemReferenceMatch?.[1] || null,
    slot: String(block.attributes['data-item-type'] || block.attributes['data-typee'] || '').trim().toLowerCase(),
    attack: parseNumber(block.attributes['data-atk']) || 0,
    defense: parseNumber(block.attributes['data-def']) || 0,
    quantity: quantityMatch ? (parseNumber(quantityMatch[1]) || 0) : 1,
    rarity: rarityFromCard(block.attributes, block.html),
    element: String(elementMatch?.[1] || 'NONE').trim().toUpperCase(),
    elementRatePercent: 0,
    description,
    rawEffect,
    effects: parseRecognizedEffects(rawEffect),
  };
}

function parseEquippedGearCard(block, instancesByKey) {
  const image = findImageAttributes(block.html) || {};
  const name = String(image.alt || '').trim();
  const definitionKey = canonicalNameKey(name, 'gear');
  if (!definitionKey) return null;
  const labelMatch = block.html.match(/<div\b[^>]*class=["'][^"']*\blabel\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  const label = labelMatch?.[1] || '';
  const slot = stripTags(label.split(/<br\b/i)[0] || '').toLowerCase();
  const level = label.match(/Lv\.?\s*([\d,]+)/i);
  const attack = label.match(/([\d,]+)\s*<\/span>\s*ATK/i);
  const defense = label.match(/([\d,]+)\s*<\/span>\s*DEF/i);
  const slotIndex = block.html.match(/unequipItem\(\s*(\d+)\s*\)/i);
  const candidates = instancesByKey.get(definitionKey) || [];
  const matched = candidates.find(candidate =>
    (!slot || !candidate.slot || candidate.slot === slot.replace(/\s+\d+$/, ''))
    && (parseNumber(attack?.[1]) ?? candidate.attack) === candidate.attack
    && (parseNumber(defense?.[1]) ?? candidate.defense) === candidate.defense
  ) || candidates[0] || {};
  return {
    definitionKey,
    name,
    inventoryRef: matched.inventoryRef || null,
    itemReference: matched.itemReference || null,
    slot,
    slotIndex: slotIndex ? parseNumber(slotIndex[1]) : null,
    attack: parseNumber(attack?.[1]) || 0,
    defense: parseNumber(defense?.[1]) || 0,
    level: parseNumber(level?.[1]) || 0,
    rarity: rarityFromCard(block.attributes, block.html) || matched.rarity || 'unknown',
    element: matched.element || 'NONE',
    elementRatePercent: matched.elementRatePercent || 0,
    rawEffect: matched.rawEffect || '',
    effects: matched.effects || [],
  };
}

function parseGearInventoryPage(html) {
  const sections = elementBlocks(String(html || ''), 'div', 'section');
  const equippedSection = sections.find(section => /-(?:equipped|q\d+-quickset)$/i.test(section.attributes['data-section-key'] || ''));
  const inventorySection = sections.find(section => /-equipment$/i.test(section.attributes['data-section-key'] || ''));
  if (!equippedSection || !inventorySection) {
    return { recognized: false, kind: 'gear', context: null, definitions: [], instances: [], equipped: [], warnings: [] };
  }

  const sectionKey = equippedSection.attributes['data-section-key'] || '';
  const sectionMatch = sectionKey.match(/^inv-(.+?)-(?:main-equipped|q(\d+)-quickset)$/i);
  const context = sectionMatch?.[1] || null;
  const quickSetNumber = sectionMatch?.[2] ? parseNumber(sectionMatch[2]) : null;
  const warnings = [];
  const definitions = new Map();
  const instances = elementBlocks(inventorySection.html, 'div', 'slot-box')
    .map(parseGearInventoryCard)
    .filter(Boolean);
  const instancesByKey = new Map();
  for (const instance of instances) {
    if (!instancesByKey.has(instance.definitionKey)) instancesByKey.set(instance.definitionKey, []);
    instancesByKey.get(instance.definitionKey).push(instance);
    registerDefinition(definitions, warnings, {
      key: instance.definitionKey,
      name: instance.name,
      kind: 'gear',
      slot: instance.slot,
      rarity: instance.rarity,
      description: instance.description,
      rawEffect: instance.rawEffect,
      effects: instance.effects,
    });
  }
  const equipped = elementBlocks(equippedSection.html, 'div', 'slot-box')
    .map(block => parseEquippedGearCard(block, instancesByKey))
    .filter(Boolean);
  for (const entry of equipped) {
    registerDefinition(definitions, warnings, {
      key: entry.definitionKey,
      name: entry.name,
      kind: 'gear',
      slot: entry.slot,
      rarity: entry.rarity,
      description: '',
      rawEffect: entry.rawEffect,
      effects: entry.effects,
    });
  }
  return {
    recognized: true,
    kind: 'gear',
    context,
    quickSetNumber,
    definitions: [...definitions.values()].sort((left, right) => left.key.localeCompare(right.key)),
    instances,
    equipped,
    warnings,
  };
}

function parsePetCard(block, equipped = false) {
  const info = findTagAttributesByClass(block.html, 'button', 'info-btn') || {};
  const image = findImageAttributes(block.html) || {};
  const name = String(info['data-name'] || image.alt || '').trim();
  if (!name) return null;
  const rawEffect = normalizeEffectText(findClassValue(block.html, 'pet-power') || effectTextFromDescription(info['data-desc'] || ''));
  const starTitle = block.html.match(/class=["'][^"']*\bpet-stars-overlay\b[^"']*["'][^>]*title=["'](\d+)★/i);
  const slotIndex = equipped ? block.html.match(/unequipPet\(\s*(\d+)\s*\)/i) : null;
  const compactAttack = block.html.match(/(?:🔪|ATK[^\d]*)\s*([\d,]+)\s*ATK/i)
    || block.html.match(/🔪\s*([\d,]+)\s*ATK/i);
  const compactDefense = block.html.match(/(?:🛡️|DEF[^\d]*)\s*([\d,]+)\s*DEF/i)
    || block.html.match(/🛡️\s*([\d,]+)\s*DEF/i);
  const sigils = [];
  const sigilRegex = /<button\b([^>]*)class=["']([^"']*\bpet-sigil-slot\b[^"']*)["']([^>]*)>([\s\S]*?)<\/button>/gi;
  let sigil;
  while ((sigil = sigilRegex.exec(block.html)) !== null) {
    const classes = sigil[2].split(/\s+/);
    sigils.push({
      type: classes.includes('attack') ? 'attack' : (classes.includes('defense') ? 'defense' : 'unknown'),
      filled: classes.includes('filled') && !classes.includes('empty-slot'),
      text: stripTags(sigil[4]),
    });
  }
  return {
    definitionKey: canonicalNameKey(name, 'pet'),
    name,
    inventoryRef: block.attributes['data-pet-inv-id'] || null,
    slot: equipped ? `pet_${slotIndex?.[1] || ''}` : '',
    slotIndex: slotIndex ? parseNumber(slotIndex[1]) : null,
    level: parseNumber(findClassValue(block.html, 'pet-level')) || 0,
    stars: starTitle ? (parseNumber(starTitle[1]) || 0) : 0,
    attack: parseNumber(findClassValue(block.html, 'pet-atk')) || parseNumber(compactAttack?.[1]) || 0,
    defense: parseNumber(findClassValue(block.html, 'pet-def')) || parseNumber(compactDefense?.[1]) || 0,
    rarity: rarityFromCard(block.attributes, block.html),
    race: String(findClassValue(block.html, 'pet-race') || '').replace(/^Race:\s*/i, '').trim(),
    element: String(block.attributes['data-element'] || 'NONE').toUpperCase(),
    elementRatePercent: parseNumber(block.attributes['data-element-rate']) || 0,
    description: String(info['data-desc'] || '').trim(),
    rawEffect,
    effects: parseRecognizedEffects(rawEffect),
    sigils,
  };
}

function parsePetInventoryPage(html) {
  const source = String(html || '');
  const sections = elementBlocks(source, 'div', 'section');
  const titled = sections.map(section => ({ section, title: findClassValue(section.html, 'section-title') || '' }));
  const quickSetEntry = titled.find(entry => /Quick Set\s+\d+.*Saved Pets/i.test(entry.title));
  const equippedSection = quickSetEntry?.section
    || titled.find(entry => /\bTeam\b/i.test(entry.title) && !/Inventory/i.test(entry.title))?.section;
  const inventorySection = titled.find(entry => /Pet Inventory/i.test(entry.title))?.section;
  const context = source.match(/const\s+CURRENT_TEAM\s*=\s*["']([^"']+)["']/)?.[1] || null;
  const quickSetNumber = quickSetEntry
    ? parseNumber(quickSetEntry.title.match(/Quick Set\s+(\d+)/i)?.[1])
    : null;
  if (!equippedSection || !inventorySection || !context) {
    return { recognized: false, kind: 'pets', context, definitions: [], instances: [], equipped: [], warnings: [] };
  }

  const warnings = [];
  const definitions = new Map();
  const equipped = elementBlocks(equippedSection.html, 'div', 'pet-card')
    .map(block => parsePetCard(block, true))
    .filter(Boolean);
  const inventoryCards = elementBlocks(inventorySection.html, 'div', 'pet-card')
    .map(block => parsePetCard(block, false))
    .filter(Boolean);
  const byInventoryRef = new Map();
  for (const instance of [...equipped, ...inventoryCards]) {
    const identity = instance.inventoryRef || `${instance.definitionKey}:${instance.level}:${instance.stars}`;
    if (!byInventoryRef.has(identity) || !byInventoryRef.get(identity).description) byInventoryRef.set(identity, instance);
    registerDefinition(definitions, warnings, {
      key: instance.definitionKey,
      name: instance.name,
      kind: 'pet',
      race: instance.race,
      rarity: instance.rarity,
      description: instance.description,
      rawEffect: instance.rawEffect,
      effects: instance.effects,
    });
  }
  return {
    recognized: true,
    kind: 'pets',
    context,
    quickSetNumber,
    definitions: [...definitions.values()].sort((left, right) => left.key.localeCompare(right.key)),
    instances: [...byInventoryRef.values()],
    equipped,
    warnings,
  };
}

function decodeJavascriptString(value = '') {
  try {
    return JSON.parse(`"${String(value)}"`);
  } catch {
    return String(value);
  }
}

function extractAssignedJsonArray(source, assignmentName) {
  const marker = new RegExp(`${assignmentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*\\[`, 'i').exec(source);
  if (!marker) return null;
  const start = marker.index + marker[0].lastIndexOf('[');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '[') depth += 1;
    if (character === ']') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function parseClassSkillTreePage(html) {
  const source = String(html || '');
  const dataSource = extractAssignedJsonArray(source, 'window.SkillTreeData');
  const classMatch = source.match(/className\s*:\s*"((?:\\.|[^"\\])*)"/i);
  if (!dataSource || !classMatch) {
    return { recognized: false, className: null, classPassive: '', skills: [], unlockedSkills: [] };
  }

  let rawSkills;
  try {
    rawSkills = JSON.parse(dataSource);
  } catch {
    return { recognized: false, className: null, classPassive: '', skills: [], unlockedSkills: [] };
  }
  const passiveMatch = source.match(/classPassive\s*:\s*"((?:\\.|[^"\\])*)"/i);
  const normalizeSkill = skill => {
    const effects = skill?.effects && typeof skill.effects === 'object'
      ? [skill.effects.effect1_desc, skill.effects.effect2_desc]
        .filter(value => typeof value === 'string' && value.trim())
        .map(value => value.trim().slice(0, 1000))
      : [];
    return {
      id: Number.isInteger(Number(skill?.id)) ? Number(skill.id) : null,
      name: String(skill?.name || '').trim().slice(0, 120),
      owned: skill?.owned === true,
      level: Math.max(0, Math.trunc(Number(skill?.level) || 0)),
      maxLevel: Math.max(0, Math.trunc(Number(skill?.max_level) || 0)),
      manaCost: Math.max(0, Math.trunc(Number(skill?.mana_cost) || 0)),
      staminaCost: Math.max(0, Math.trunc(Number(skill?.stamina_cost) || 0)),
      flatStaminaDamage: Math.max(0, Number(skill?.flat_stam_dmg) || 0),
      passive: skill?.is_passive === true || skill?.is_class_passive === true,
      advanced: skill?.is_advanced === true,
      effects,
    };
  };
  const skills = (Array.isArray(rawSkills) ? rawSkills : [])
    .map(normalizeSkill)
    .filter(skill => skill.id !== null && skill.name);
  return {
    recognized: true,
    className: decodeJavascriptString(classMatch[1]).slice(0, 80),
    classPassive: passiveMatch ? decodeJavascriptString(passiveMatch[1]).slice(0, 1000) : '',
    skills,
    unlockedSkills: skills.filter(skill => skill.owned),
  };
}

function parseGuildDungeonDashboard(html) {
  const source = String(html || '');
  const dungeons = [];
  const linkRegex = /<a\b([^>]*)href=["']([^"']*guild_dungeon_enter\.php\?[^"']*\bid=\d+[^"']*)["'][^>]*>/gi;
  let match;
  while ((match = linkRegex.exec(source)) !== null) {
    let url;
    try {
      url = new URL(decodeHtml(match[2]), 'https://demonicscans.org/guild_dash.php');
    } catch {
      continue;
    }
    const instanceId = url.searchParams.get('id');
    if (!/^\d+$/.test(instanceId || '')) continue;
    const prefix = source.slice(Math.max(0, match.index - 1200), match.index);
    const names = [...prefix.matchAll(/<div\b[^>]*font-weight\s*:\s*700[^>]*>([\s\S]*?)<\/div>/gi)];
    const name = stripTags(names.at(-1)?.[1] || '');
    if (!name || dungeons.some(entry => entry.instanceId === instanceId)) continue;
    const instanceText = prefix.match(new RegExp(`Instance\\s*#${instanceId}\\b([^<]*)`, 'i'));
    const opened = instanceText?.[1]?.match(/Opened\s+([^<•]+)/i)?.[1]?.trim() || null;
    dungeons.push({
      name,
      instanceId,
      opened,
      url: `${url.pathname}${url.search}`,
    });
  }
  return { recognized: /Open Dungeons/i.test(source) || dungeons.length > 0, dungeons };
}

function parseGuildDungeonIndex(html) {
  const source = String(html || '');
  const activeMarker = source.search(/Active Dungeon Templates/i);
  const clearMarker = source.search(/Previous Instances\s*\(Clears\)/i);
  const failedMarker = source.search(/Previous Instances\s*\(Failed\)/i);
  if (activeMarker < 0) return { recognized: false, instances: [] };
  const endMarker = source.indexOf('async function openDungeon', activeMarker);
  const catalog = source.slice(activeMarker, endMarker > activeMarker ? endMarker : source.length);
  const relativeClearMarker = clearMarker >= activeMarker ? clearMarker - activeMarker : Number.POSITIVE_INFINITY;
  const relativeFailedMarker = failedMarker >= activeMarker ? failedMarker - activeMarker : Number.POSITIVE_INFINITY;
  const instances = [];

  for (const card of elementBlocks(catalog, 'div', 'card')) {
    const name = findClassValue(card.html, 'h');
    const link = card.html.match(/href=["']([^"']*guild_dungeon_enter\.php\?[^"']*\bid=\d+[^"']*)["']/i);
    if (!name || !link) continue;
    let url;
    try {
      url = new URL(decodeHtml(link[1]), 'https://demonicscans.org/guild_dungeon.php');
    } catch {
      continue;
    }
    const instanceId = url.searchParams.get('id');
    if (!/^\d+$/.test(instanceId || '') || instances.some(entry => entry.instanceId === instanceId)) continue;
    const text = stripTags(card.html);
    const inActiveSection = card.start < relativeClearMarker;
    const inFailedSection = card.start >= relativeFailedMarker;
    const status = inActiveSection
      ? 'active'
      : (text.match(/Status:\s*(ended|failed)/i)?.[1] || (inFailedSection ? 'failed' : 'ended')).toLowerCase();
    const guildLootState = /\bNo loot\b/i.test(text)
      ? 'none'
      : /\bNot looted\b/i.test(text)
        ? 'pending'
        : /\bLooted\b/i.test(text)
          ? 'claimed'
          : 'unknown';
    instances.push({
      name,
      instanceId,
      status,
      active: status === 'active',
      guildLootState,
      url: `${url.pathname}${url.search}`,
    });
  }

  return {
    recognized: /Guild Dungeons/i.test(source) && activeMarker >= 0,
    instances,
  };
}

function parseDungeonInstancePage(html) {
  const source = String(html || '');
  const title = stripTags(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const titleMatch = title.match(/^(.+?)\s*(?:—|-)\s*Instance\s*#(\d+)\s*$/i);
  const locationRegex = /<a\b([^>]*)href=["']([^"']*guild_dungeon_location\.php\?[^"']+)["']([^>]*)>/gi;
  const locations = [];
  let match;
  while ((match = locationRegex.exec(source)) !== null) {
    let url;
    try {
      url = new URL(decodeHtml(match[2]), 'https://demonicscans.org/');
    } catch {
      continue;
    }
    const instanceId = url.searchParams.get('instance_id');
    const locationId = url.searchParams.get('location_id');
    if (!/^\d+$/.test(instanceId || '') || !/^\d+$/.test(locationId || '')) continue;
    if (locations.some(location => location.locationId === locationId)) continue;
    const attributes = parseAttributes(`${match[1]} ${match[3]}`);
    const name = String(attributes.title || `Location ${locationId}`).replace(/\s*\(Boss\)\s*$/i, '').trim();
    locations.push({
      instanceId,
      locationId,
      name,
      boss: /boss/i.test(attributes.title || ''),
      url: `${url.pathname}${url.search}`,
    });
  }
  return {
    recognized: Boolean(titleMatch && locations.length > 0),
    dungeonName: titleMatch?.[1]?.trim() || null,
    instanceId: titleMatch?.[2] || locations[0]?.instanceId || null,
    active: /Status:\s*<b>\s*Active\s*<\/b>/i.test(source),
    locations,
  };
}

function parseDungeonLocationPage(html, context = {}) {
  const source = String(html || '');
  const title = stripTags(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const titleParts = title.split(/\s*(?:—|-)\s*/);
  const dungeonName = String(context.dungeonName || titleParts[0] || '').trim();
  const locationName = String(context.locationName || titleParts.slice(1).join(' — ') || '').trim();
  const playerBlock = elementBlocks(source, 'div', 'playerhp')[0]?.html || '';
  const playerHpMatch = stripTags(playerBlock).match(/([\d,]+)\s*\/\s*([\d,]+)/);
  const locationLocked = /Boss is locked until other locations are cleared|<span\b[^>]*class=["'][^"']*\bpill\b[^"']*["'][^>]*>\s*locked\s*<\/span>/i.test(source);
  const monsters = [];

  for (const block of elementBlocks(source, 'div', 'mon')) {
    const hrefMatch = block.html.match(/href=["']([^"']*battle\.php\?[^"']*\bdgmid=\d+[^"']*)["']/i);
    if (!hrefMatch) continue;
    let url;
    try {
      url = new URL(decodeHtml(hrefMatch[1]), 'https://demonicscans.org/');
    } catch {
      continue;
    }
    const dgmid = url.searchParams.get('dgmid');
    const instanceId = url.searchParams.get('instance_id') || String(context.instanceId || '');
    if (!/^\d+$/.test(dgmid || '') || !/^\d+$/.test(instanceId || '')) continue;

    const headingStart = block.html.search(/<div\b[^>]*font-weight\s*:\s*700/i);
    const headingMarkers = headingStart >= 0
      ? [
        block.html.indexOf('<div class="bar"', headingStart),
        block.html.slice(headingStart).search(/<div\b[^>]*class=["'][^"']*\bmuted\b/i) + headingStart,
      ].filter(index => index > headingStart)
      : [];
    const headingEnd = headingMarkers.length > 0 ? Math.min(...headingMarkers) : -1;
    const heading = headingStart >= 0
      ? block.html.slice(headingStart, headingEnd >= 0 ? headingEnd : Math.min(block.html.length, headingStart + 1200))
      : '';
    const headingInner = heading
      .replace(/^<div\b[^>]*>/i, '')
      .replace(/<\/div>\s*$/i, '');
    const directName = headingInner.slice(headingInner.lastIndexOf('</div>') + 6);
    const name = stripTags(directName).replace(/\s+dead\s*$/i, '').trim();
    const hpMatch = block.html.match(/([\d,]+)\s*\/\s*([\d,]+)\s*HP/i);
    const statValue = label => {
      const expression = new RegExp(`<span\\b[^>]*class=["'][^"']*\\bk\\b[^"']*["'][^>]*>\\s*${label}\\s*<\\/span>[\\s\\S]*?<span\\b[^>]*class=["'][^"']*\\bv\\b[^"']*["'][^>]*>([^<]+)<\\/span>`, 'i');
      return parseNumber(stripTags(block.html.match(expression)?.[1] || ''));
    };
    const hp = parseNumber(hpMatch?.[1]);
    const maxHp = parseNumber(hpMatch?.[2]);
    const dead = hasClass(block.attributes, 'dead') || hp === 0;
    const joined = /<span\b[^>]*class=["'][^"']*\bpill\b[^"']*["'][^>]*>\s*joined\s*<\/span>/i.test(block.html);
    const lootable = dead && /<span\b[^>]*class=["'][^"']*\bpill-warn\b[^"']*["'][^>]*>\s*not looted\s*<\/span>/i.test(block.html);
    monsters.push({
      id: dgmid,
      battleId: dgmid,
      dgmid,
      instanceId,
      name,
      dungeonName,
      locationId: String(context.locationId || ''),
      locationName,
      boss: context.boss === true,
      hp,
      maxHp,
      attack: statValue('ATK'),
      defense: statValue('DEF'),
      expPerDamage: statValue('EXP\\s*\/\\s*dmg'),
      joined,
      dead,
      lootable,
      attackable: !dead && !locationLocked,
      battleRef: { isDungeon: true, instanceId, dgmid },
    });
  }

  return {
    recognized: Boolean(dungeonName && locationName),
    dungeonName,
    instanceId: String(context.instanceId || monsters[0]?.instanceId || ''),
    locationId: String(context.locationId || ''),
    locationName,
    boss: context.boss === true,
    locked: locationLocked,
    resources: playerHpMatch ? { hp: { current: parseNumber(playerHpMatch[1]), max: parseNumber(playerHpMatch[2]) } } : {},
    monsters,
  };
}

function parseTopbar(html) {
  const stats = {};
  const staminaMatch = html.match(/id=["']stamina_span["'][^>]*>\s*([\d,]+)\s*<\/span>\s*\/\s*([\d,]+)/i);
  if (staminaMatch) {
    stats.stamina = parseNumber(staminaMatch[1]);
    stats.maxStamina = parseNumber(staminaMatch[2]);
  }

  const levelMatch = html.match(/class=["'][^"']*\bgtb-level\b[^"']*["'][^>]*>\s*LV\s*([\d,]+)/i);
  if (levelMatch) stats.level = parseNumber(levelMatch[1]);

  for (const block of elementBlocks(html, 'div', 'gtb-stat')) {
    const label = findClassValue(block.html, 'gtb-label')?.toLowerCase();
    const value = findClassValue(block.html, 'gtb-value');
    if (label === 'gold' && value) stats.gold = value;
    if ((label === 'gem' || label === 'gems') && value) stats.gems = value;
  }

  const serverTag = html.match(/<[^>]+id=["']server_time["'][^>]*>/i);
  if (serverTag) {
    const attributes = parseAttributes(serverTag[0].replace(/^<[^\s>]+|>$/g, ''));
    const epoch = parseNumber(attributes['data-epoch']);
    const timezone = parseNumber(attributes['data-tzoff']);
    if (epoch !== null) stats.serverEpoch = epoch;
    if (timezone !== null) stats.serverTzOff = timezone;
  }

  const expText = html.match(/class=["'][^"']*\bgtb-exp-top\b[^"']*["'][^>]*>[\s\S]*?([\d,]+)\s*\/\s*([\d,]+)/i);
  if (expText) {
    stats.expCurrent = parseNumber(expText[1]);
    stats.expRequired = parseNumber(expText[2]);
  }
  const expBar = html.match(/class=["'][^"']*\bgtb-exp-fill\b[^"']*["'][^>]*style=["'][^"']*width:\s*([\d.]+)%/i);
  if (expBar) stats.expPercent = parseNumber(expBar[1]);

  const username = findClassValue(html, 'small-name');
  if (username) stats.username = username;
  const buffs = parseActiveBuffs(html);
  if (buffs.recognized) stats.lootXpBoost = buffs.lootXpBoost;
  return stats;
}

function parseActiveBuffs(html) {
  const source = String(html || '');
  const recognized = /class=["'][^"']*\bbuffs-dialog\b/i.test(source)
    && /id=["']buffs_list["']/i.test(source);
  if (!recognized) return { recognized: false, buffs: [], lootXpBoost: null };

  const buffs = elementBlocks(source, 'div', 'buff-row').map((block) => {
    const name = findClassValue(block.html, 'buff-name') || '';
    const description = findClassValue(block.html, 'buff-desc') || '';
    const endsAt = parseNumber(block.attributes['data-ends']);
    const xpMatch = name.match(/\bXP\s*Boost\s*\+\s*([\d.]+)\s*%/i);
    const lootXpPercent = xpMatch && /\bLoot\s+EXP\b/i.test(description)
      ? parseNumber(xpMatch[1])
      : null;
    return { name, description, endsAt, lootXpPercent };
  });
  const xpBuffs = buffs
    .filter(buff => Number.isFinite(Number(buff.lootXpPercent)) && Number(buff.lootXpPercent) > 0)
    .sort((left, right) => Number(right.lootXpPercent) - Number(left.lootXpPercent));
  const xpBuff = xpBuffs[0] || null;
  return {
    recognized: true,
    buffs,
    lootXpBoost: {
      recognized: true,
      name: xpBuff?.name || null,
      percent: xpBuff ? Number(xpBuff.lootXpPercent) : 0,
      endsAt: xpBuff?.endsAt ?? null,
    },
  };
}

function parseStatsPage(html) {
  const source = String(html || '');
  const stats = parseTopbar(source);

  // The attributes page no longer exposes the old v-attack/v-defense/v-stamina
  // ids. It now publishes a small JSON state contract and repeats the values
  // in data-value elements. Only those current contracts are accepted.
  const readNumber = (...values) => {
    for (const value of values) {
      const parsed = parseNumber(value);
      if (parsed !== null) return parsed;
    }
    return null;
  };
  const stateMatch = source.match(/<script\b[^>]*id=["']stats-state["'][^>]*>([\s\S]*?)<\/script>/i);
  if (stateMatch) {
    try {
      const payload = JSON.parse(decodeHtml(stateMatch[1]).trim());
      const user = payload?.user || {};
      const core = payload?.core || {};
      stats.attack = stats.attack ?? readNumber(user.ATTACK, core.attack, core.permanent_attack);
      stats.defense = stats.defense ?? readNumber(user.DEFENSE, core.defense, core.permanent_defense);
      stats.maxStamina = stats.maxStamina ?? readNumber(user.MAX_STAMINA, core.stamina);
    } catch {
      // Fall through to the visible data-value markup below.
    }
  }
  for (const [key, dataValue] of [['attack', 'attack'], ['defense', 'defense'], ['maxStamina', 'stamina']]) {
    if (stats[key] !== undefined && stats[key] !== null) continue;
    const match = source.match(new RegExp(`data-value=["']${dataValue}["'][^>]*>\\s*([\\d,]+)`, 'i'));
    if (match) stats[key] = parseNumber(match[1]);
  }
  return stats;
}

function parseAutoFarmPanel(html) {
  const source = String(html || '');
  if (!/id=["']autoFarmPanel["']/i.test(source)) {
    return { recognized: false, enabled: false, settings: {}, counters: {}, targets: [], monsters: [] };
  }
  const inputNumber = id => {
    const tag = source.match(new RegExp(`<input\\b[^>]*id=["']${id}["'][^>]*>`, 'i'))?.[0] || '';
    return parseNumber(parseAttributes(tag.replace(/^<input\s*|>$/gi, '')).value);
  };
  const selectedValue = (block, className) => {
    const select = elementBlocks(block, 'select', className)[0]?.html || '';
    const selected = select.match(/<option\b([^>]*)selected[^>]*>([\s\S]*?)<\/option>/i);
    if (!selected) return { value: null, label: '' };
    const attributes = parseAttributes(selected[1]);
    return { value: attributes.value ?? null, label: stripTags(selected[2]) };
  };
  const selectById = id => {
    const match = source.match(new RegExp(`<select\\b[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/select>`, 'i'));
    if (!match) return null;
    const selected = match[1].match(/<option\b([^>]*)selected[^>]*>/i) || match[1].match(/<option\b([^>]*)>/i);
    return selected ? parseAttributes(selected[1]).value ?? null : null;
  };
  const textNumber = id => {
    const value = source.match(new RegExp(`id=["']${id}["'][^>]*>([\\s\\S]*?)<`, 'i'))?.[1] || '';
    return parseNumber(stripTags(value));
  };

  const monsters = new Map();
  const availableMonsters = new Map();
  for (const select of source.matchAll(/<select\b[^>]*class=["'][^"']*\bafTMonster\b[^"']*["'][^>]*>([\s\S]*?)<\/select>/gi)) {
    for (const match of select[1].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
      const attributes = parseAttributes(match[1]);
      if (!/^\d+$/.test(String(attributes.value || ''))) continue;
      const name = stripTags(match[2]);
      if (name && !monsters.has(String(attributes.value))) monsters.set(String(attributes.value), name);
    }
  }
  for (const option of source.matchAll(/<label\b[^>]*>[\s\S]*?<input\b([^>]*)class=["'][^"']*\baf-ms-check\b[^"']*["']([^>]*)>[\s\S]*?<span\b[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/label>/gi)) {
    const attributes = parseAttributes(`${option[1]} ${option[2]}`);
    const id = String(attributes.value || '');
    const name = stripTags(option[3]);
    if (/^\d+$/.test(id) && name) {
      availableMonsters.set(id, name);
      if (!monsters.has(id)) monsters.set(id, name);
    }
  }

  const targets = [];
  for (const row of elementBlocks(source, 'div', 'af-row')) {
    const targetId = row.attributes['data-target-id'];
    const monster = selectedValue(row.html, 'afTMonster');
    if (!/^\d+$/.test(String(targetId || '')) || !/^\d+$/.test(String(monster.value || ''))) continue;
    targets.push({
      targetId: String(targetId),
      monsterId: String(monster.value),
      monsterName: monster.label || monsters.get(String(monster.value)) || '',
      enabled: selectedValue(row.html, 'afTEnabled').value === '1',
      damageMode: Number(selectedValue(row.html, 'afTMode').value) === 1 ? 1 : 0,
      minDamage: parseNumber(elementBlocks(row.html, 'input', 'afTMin')[0]?.attributes?.value) || 0,
      maxStack: Math.max(1, parseNumber(elementBlocks(row.html, 'input', 'afTStack')[0]?.attributes?.value) || 1),
    });
  }
  const stateText = stripTags(source.match(/id=["']afStateBadge["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || '');
  return {
    recognized: true,
    enabled: /running|active|started/i.test(stateText) && !/paused|off/i.test(stateText),
    settings: {
      totalMonsters: inputNumber('afTotalToKill') || 0,
      hpPotionLimit: inputNumber('afHpMax') || 0,
      staminaPotionLimits: {
        small: inputNumber('afSt20Max') || 0,
        large: inputNumber('afStHalfMax') || 0,
        full: inputNumber('afStFullMax') || 0,
        adventure: inputNumber('afStAdvMax') || 0,
      },
      priorityItemId: selectById('afStPriority') || '0',
      autoLootToLevel: selectById('afAutoLootToLevel') === '1',
      expLeftPercent: inputNumber('afPrcExpLeft') ?? 100,
    },
    counters: {
      monsters: textNumber('afTotalKilledText') || 0,
      hpPotions: textNumber('afHpUsedText') || 0,
      staminaPotions: {
        small: textNumber('afSt20UsedText') || 0,
        large: textNumber('afStHalfUsedText') || 0,
        full: textNumber('afStFullUsedText') || 0,
        adventure: textNumber('afStAdvUsedText') || 0,
      },
    },
    targets,
    monsters: [...monsters].map(([id, name]) => ({ id, name })),
    availableMonsters: [...(availableMonsters.size > 0 ? availableMonsters : monsters)]
      .map(([id, name]) => ({ id, name })),
  };
}

function parseGates(html) {
  const gates = [];
  const regex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const attributes = parseAttributes(match[1]);
    if (!hasClass(attributes, 'gate-card')) continue;
    const body = match[2];
    const title = findClassValue(body, 'title');
    const recommended = stripTags(body).match(/Recommended\s+Lv\.?\s*([\d,]+)/i);
    gates.push({
      name: attributes['aria-label'] || title || 'Unknown Gate',
      url: attributes.href || '',
      active: /\bACTIVE\b/i.test(stripTags(body)),
      recommendedLevel: recommended ? parseNumber(recommended[1]) : 0,
    });
  }
  return gates;
}

function parseWaveMonsters(html) {
  return elementBlocks(html, 'div', 'monster-card').map((block) => {
    const attrs = block.attributes;
    const hpMatch = block.html.match(/class=["'][^"']*\bstat-value\b[^"']*["'][^>]*>\s*([\d,]+)\s*\/\s*([\d,]+)/i);
    const linkMatch = block.html.match(/href=["'][^"']*battle\.php\?id=(\d+)[^"']*["']/i);
    const headingMatch = block.html.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i);
    const imageMatch = block.html.match(/<img\b[^>]*class=["'][^"']*\bmonster-img\b[^"']*["'][^>]*src=["']([^"']+)["']/i)
      || block.html.match(/<img\b[^>]*src=["']([^"']+)["'][^>]*class=["'][^"']*\bmonster-img\b[^"']*["']/i);
    const actionButtons = [...block.html.matchAll(/<button\b[^>]*class=["'][^"']*\bjoin-btn\b[^"']*["'][^>]*>([\s\S]*?)<\/button>/gi)];
    const hasLootAction = actionButtons.some(match => /\bLoot\b/i.test(stripTags(match[1])));
    const stackLabel = findClassValue(block.html, 'stack-badge') || '';
    const stackMatch = stackLabel.match(/\bStack\s*x\s*([\d,]+)/i);
    const stackSize = Math.max(1, stackMatch ? (parseNumber(stackMatch[1]) || 1) : 1);
    const dead = attrs['data-dead'] === '1';
    const eligible = attrs['data-eligible'] === '1';
    const name = headingMatch ? stripTags(headingMatch[1]) : (attrs['data-name'] || 'Unknown');
    const imageUrl = imageMatch ? decodeHtml(imageMatch[1]) : '';
    // The captured Olympus Phase-3 cards are deliberately not marked as
    // bosses by the server. Both joined and unjoined variants identify the
    // duel phase through a PvP image asset and a Duelist display name. Keep
    // this fixture-backed presentation marker separate from battle-page
    // phaseDuel, which remains the authority for entering the watcher.
    const phase = /pvp/i.test(imageUrl) && /\bduelist\b/i.test(name) ? 3 : null;
    return {
      id: attrs['data-monster-id'] || null,
      dead,
      boss: attrs['data-boss'] === '1',
      name,
      imageUrl,
      phase,
      joined: attrs['data-joined'] === '1',
      unjoined: attrs['data-unjoined'] === '1',
      userDmg: parseNumber(attrs['data-userdmg']) || 0,
      eligible,
      lootable: dead && eligible && hasLootAction,
      stackSize,
      expire: parseNumber(attrs['data-expire']) || 0,
      rewardCap: attrs['data-rewardcap'] === '1',
      rewardCapReached: attrs['data-rewardcap'] === '1',
      capNotReached: attrs['data-capnotreached'] !== '0',
      hp: hpMatch ? parseNumber(hpMatch[1]) : null,
      maxHp: hpMatch ? parseNumber(hpMatch[2]) : null,
      battleId: linkMatch?.[1] || attrs['data-monster-id'] || null,
      battleRef: linkMatch?.[1] || attrs['data-monster-id'] || null,
    };
  });
}

function parseAutoSummonMonsterNames(html) {
  const names = [];
  for (const block of elementBlocks(String(html || ''), 'div', 'auto-summon-card')) {
    const name = String(findClassValue(block.html, 'auto-summon-name') || '').trim();
    if (name && !names.some(existing => existing.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return names;
}

function parseWaveLootSummary(html) {
  const source = String(html || '');
  const monsters = parseWaveMonsters(source);
  const unclaimed = elementBlocks(source, 'div', 'unclaimed-pill')[0];
  const reportedUnclaimed = unclaimed ? parseNumber(findClassValue(unclaimed.html, 'count')) : null;
  const lootableMonsters = monsters.filter(monster => monster.lootable);
  const title = stripTags(source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const hasWaveShell = /\bWave\s+\d+\b/i.test(title)
    && (
      elementBlocks(source, 'div', 'monster-container').length > 0
      || elementBlocks(source, 'div', 'player-resources').length > 0
      || /<a\b[^>]*class=["'][^"']*\bwave-chip\b[^"']*\bactive\b/i.test(source)
    );
  // Event waves use an event title instead of "Wave N". The authenticated
  // Auto Farm panel is part of the same active-wave contract and remains
  // present when the Event currently has no live/dead monster cards.
  const hasPlayerResources = elementBlocks(source, 'div', 'player-resources').length > 0;
  const hasActiveWaveNavigation = /<a\b[^>]*class=["'][^"']*\bwave-chip\b[^"']*\bactive\b/i.test(source);
  const hasAutoFarmPanel = /<div\b[^>]*id=["']autoFarmPanel["'][^>]*>/i.test(source);
  const hasAutoFarmGrid = /<div\b[^>]*id=["']afMultiGrid["'][^>]*>/i.test(source);
  const hasAuthenticatedEventShell = !/\b(?:sign\s*in|log\s*in)\b/i.test(title)
    && ((hasPlayerResources && (hasAutoFarmPanel || hasActiveWaveNavigation))
      || (hasAutoFarmPanel && hasAutoFarmGrid));
  return {
    recognized: Boolean(unclaimed || monsters.length > 0 || hasWaveShell || hasAuthenticatedEventShell),
    reportedUnclaimed,
    visibleLootable: lootableMonsters.reduce((total, monster) => total + monster.stackSize, 0),
    visibleLootActions: lootableMonsters.length,
    lootableMonsters,
  };
}

function parseWaveDeadPageNumbers(html) {
  const pages = new Set();
  const source = String(html || '');
  for (const match of source.matchAll(/(?:[?&]|&amp;)dead_page=(\d+)/gi)) {
    const page = Number(match[1]);
    if (Number.isSafeInteger(page) && page > 1 && page <= 1000) pages.add(page);
  }
  return [...pages].sort((left, right) => left - right);
}

function parseWavePlayerResources(html) {
  const resources = {};
  for (const block of elementBlocks(html, 'div', 'res-row')) {
    const label = findClassValue(block.html, 'res-label') || '';
    const value = findClassValue(block.html, 'res-meta') || '';
    const pair = value.match(/([\d,]+)\s*\/\s*([\d,]+)/);
    if (!pair) continue;
    const parsed = { current: parseNumber(pair[1]), max: parseNumber(pair[2]) };
    if (/\bhp\b/i.test(label)) resources.hp = parsed;
    if (/\bmana\b/i.test(label)) resources.mp = parsed;
  }
  return resources;
}

function parseMonsterStatsModal(html) {
  const start = String(html || '').search(/<div\b[^>]*id=["']monsterStatsModal["'][^>]*>/i);
  if (start < 0) return null;
  const tail = html.slice(start);
  const end = tail.search(/<div\b[^>]*id=["']lootModal["'][^>]*>/i);
  const modal = end > 0 ? tail.slice(0, end) : tail;
  const heading = modal.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i);
  const name = heading ? stripTags(heading[1]).replace(/\s+Stats\s*$/i, '').trim() : '';
  const values = {};
  for (const block of elementBlocks(modal, 'div', 'monster-stat-cell')) {
    const label = findClassValue(block.html, 'label');
    const value = block.html.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i);
    if (label && value) values[label.toLowerCase()] = stripTags(value[1]);
  }
  if (!name || !values.attack || !values.defense) return null;
  const number = label => {
    const match = String(values[label] || '').match(/-?[\d,]+(?:\.\d+)?/);
    return match ? parseNumber(match[0]) : null;
  };
  return {
    name,
    attack: number('attack'),
    defense: number('defense'),
    petDefense: number('pet defense'),
    equipmentDefense: number('equipment defense'),
    element: values.element || 'Unknown',
    elementRatePercent: number('element rate'),
    rewardsUpToLevel: number('rewards up to'),
    resistances: {
      critRatePercent: number('crit rate resistance'),
      critDamagePercent: number('crit damage resistance'),
      finalDamagePercent: number('final damage resistance'),
      passiveDamagePercent: number('passive damage resistance'),
    },
  };
}

function extractBalancedObject(source, assignmentPattern) {
  const assignment = assignmentPattern.exec(source);
  if (!assignment) return null;
  const start = source.indexOf('{', assignment.index + assignment[0].length);
  if (start < 0) return null;
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

class LiteralParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  parse() {
    const value = this.value();
    this.space();
    if (this.index !== this.source.length) throw new Error('Unexpected content after object literal');
    return value;
  }

  space() {
    while (/\s/.test(this.source[this.index] || '')) this.index++;
  }

  value() {
    this.space();
    const char = this.source[this.index];
    if (char === '{') return this.object();
    if (char === '[') return this.array();
    if (char === '"' || char === "'") return this.string();
    if (char === '-' || /\d/.test(char || '')) return this.number();
    const identifier = this.identifier();
    if (identifier === 'true') return true;
    if (identifier === 'false') return false;
    if (identifier === 'null') return null;
    throw new Error(`Unsupported literal value: ${identifier || char}`);
  }

  object() {
    const result = {};
    this.index++;
    while (true) {
      this.space();
      if (this.source[this.index] === '}') { this.index++; return result; }
      const key = ['"', "'"].includes(this.source[this.index]) ? this.string() : this.identifier();
      if (!key) throw new Error('Object key expected');
      this.space();
      if (this.source[this.index++] !== ':') throw new Error(`Missing colon after ${key}`);
      result[key] = this.value();
      this.space();
      if (this.source[this.index] === ',') { this.index++; continue; }
      if (this.source[this.index] === '}') { this.index++; return result; }
      throw new Error('Expected comma or closing brace');
    }
  }

  array() {
    const result = [];
    this.index++;
    while (true) {
      this.space();
      if (this.source[this.index] === ']') { this.index++; return result; }
      result.push(this.value());
      this.space();
      if (this.source[this.index] === ',') { this.index++; continue; }
      if (this.source[this.index] === ']') { this.index++; return result; }
      throw new Error('Expected comma or closing bracket');
    }
  }

  string() {
    const quote = this.source[this.index++];
    let result = '';
    while (this.index < this.source.length) {
      const char = this.source[this.index++];
      if (char === quote) return result;
      if (char === '\\') {
        const escaped = this.source[this.index++];
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
        result += escapes[escaped] ?? escaped;
      } else {
        result += char;
      }
    }
    throw new Error('Unterminated string literal');
  }

  number() {
    const match = this.source.slice(this.index).match(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i);
    if (!match) throw new Error('Invalid numeric literal');
    this.index += match[0].length;
    return Number(match[0]);
  }

  identifier() {
    this.space();
    const match = this.source.slice(this.index).match(/^[A-Za-z_$][\w$]*/);
    if (!match) return '';
    this.index += match[0].length;
    return match[0];
  }
}

function parseObjectLiteral(source) {
  return new LiteralParser(source).parse();
}

function classifyBattleConsumable(name, itemId, description = '') {
  const normalizedName = String(name || '').trim().toLowerCase();
  const normalizedDescription = String(description || '').trim().toLowerCase();
  const numericItemId = Number(itemId);
  if (/adventur(?:e|er).*stamina/.test(normalizedName) || numericItemId === 359) {
    return { category: 'stamina', type: 'adventure' };
  }
  if (/full.*stamina/.test(normalizedName) || numericItemId === 35) {
    return { category: 'stamina', type: 'full' };
  }
  if (/large.*stamina/.test(normalizedName) || numericItemId === 251) {
    return { category: 'stamina', type: 'large' };
  }
  if (/small.*stamina/.test(normalizedName) || numericItemId === 30) {
    return { category: 'stamina', type: 'small' };
  }
  if (/large.*mana|mana.*(?:large|\bl\b)/.test(normalizedName) || /(?:refills?|restores?)\s+200\s+mana/.test(normalizedDescription)) {
    return { category: 'mana', type: 'large' };
  }
  if (/mana/.test(normalizedName) || numericItemId === 162) {
    return { category: 'mana', type: 'small' };
  }
  if (/\bhp\b|health/.test(normalizedName) || numericItemId === 108) {
    return { category: 'health', type: 'full' };
  }
  return { category: 'unknown', type: null };
}

function parseBattleConsumables(html) {
  const source = String(html || '');
  const recognized = /<aside\b[^>]*id=["']battleDrawer["'][^>]*>/i.test(source);
  if (!recognized) return { recognized: false, items: [] };

  const items = elementBlocks(source, 'div', 'potion-card').map(block => {
    const buttons = [...block.html.matchAll(/<button\b([^>]*)>/gi)]
      .map(match => parseAttributes(match[1]))
      .filter(attributes => hasClass(attributes, 'potion-use-btn'));
    const button = buttons[0] || {};
    const inventoryId = String(block.attributes['data-inv-id'] || button['data-inv'] || '').trim();
    const itemId = parseNumber(block.attributes['data-item-id'] || button['data-item']);
    const name = String(button['data-name'] || block.html.match(/<img\b[^>]*alt=["']([^"']+)["']/i)?.[1] || '').trim();
    const quantityText = findClassValue(block.html, 'potion-qty-left');
    const visibleQuantity = parseNumber(quantityText);
    const buttonQuantity = parseNumber(button['data-max']);
    // The battle drawer visually shortens large inventory totals (for example
    // 11,366 may be rendered as 366), while data-max retains the full verified
    // quantity used by the server-side item control. Prefer the larger value so
    // Overview and policy counters never report the clipped presentation text.
    const quantity = Math.max(
      Number.isFinite(visibleQuantity) ? visibleQuantity : 0,
      Number.isFinite(buttonQuantity) ? buttonQuantity : 0,
    );
    const description = findClassValue(block.html, 'potion-desc') || '';
    const classification = classifyBattleConsumable(name, itemId, description);
    const restoredMatch = description.match(/(?:refills?|restores?)\s+([\d,]+)\s+(?:stamina|mana)/i);
    return {
      inventoryId: /^\d{1,30}$/.test(inventoryId) ? inventoryId : null,
      itemId,
      name,
      quantity: Math.max(0, quantity),
      description,
      restoreAmount: restoredMatch ? parseNumber(restoredMatch[1]) : null,
      ...classification,
    };
  }).filter(item => item.inventoryId && item.name);

  return { recognized: true, items };
}

function parsePossibleLoot(html) {
  const source = String(html || '');
  const rewards = [];
  for (const block of elementBlocks(source, 'div', 'loot-card')) {
    const name = String(findClassValue(block.html, 'loot-name') || '').trim();
    if (!name) continue;
    const chips = elementBlocks(block.html, 'span', 'chip').map(chip => stripTags(chip.html));
    const dropText = chips.find(value => /^Drop:/i.test(value)) || '';
    const damageText = chips.find(value => /^DMG req:/i.test(value)) || '';
    const phaseText = chips.find(value => /^Phase\s+\d+/i.test(value)) || '';
    const parentPrefix = source.slice(Math.max(0, block.start - 500), block.start);
    const heading = [...parentPrefix.matchAll(/class=["'][^"']*phase-loot-head[^"']*["'][^>]*>([\s\S]*?)<\/h4>/gi)].at(-1);
    const phaseMatch = (phaseText || stripTags(heading?.[1] || '')).match(/Phase\s+(\d+)/i);
    rewards.push({
      itemId: parseNumber(block.attributes['data-item-id'] || block.attributes['data-item'] || block.attributes['data-id']),
      name,
      damageRequired: parseNumber(damageText.match(/DMG req:\s*([\d,]+)/i)?.[1]),
      dropChance: parseNumber(dropText.match(/Drop:\s*([\d,.]+)/i)?.[1]),
      phase: phaseMatch ? Number(phaseMatch[1]) : null,
    });
  }
  return rewards;
}

function parseCubeHomePage(html) {
  const objectSource = extractBalancedObject(String(html || ''), /(?:const|let|var)\s+STATE\s*=/);
  if (!objectSource) return { recognized: false, instanceId: null, faces: [], nodes: [] };
  let state;
  try {
    state = parseObjectLiteral(objectSource);
  } catch {
    return { recognized: false, instanceId: null, faces: [], nodes: [] };
  }
  const instanceMatch = String(html || '').match(/[?&]instance_id=(\d+)/i)
    || String(html || '').match(/\bINSTANCE_ID\s*=\s*(\d+)/i);
  const allowedStatuses = new Set(['hidden', 'available', 'in_progress', 'cleared']);
  const faces = (Array.isArray(state.faces) ? state.faces : []).map(face => ({
    id: Number(face.ID ?? face.id) || null,
    key: String(face.FACE_KEY ?? face.face_key ?? ''),
    name: String(face.DISPLAY_NAME ?? face.display_name ?? ''),
    order: Number(face.DISPLAY_ORDER ?? face.display_order) || 0,
  }));
  const nodes = (Array.isArray(state.nodes) ? state.nodes : []).map(node => ({
    id: Number(node.id) || null,
    faceKey: String(node.face_key || ''),
    key: String(node.key || ''),
    name: String(node.name || ''),
    type: String(node.type || '').toLowerCase(),
    status: allowedStatuses.has(String(node.status || '').toLowerCase()) ? String(node.status).toLowerCase() : 'hidden',
    linkedLocationId: Number(node.linked_location_id) || null,
    pvpEncounterId: Number(node.pvp_encounter_id) || null,
    monstersTotal: Number(node.monsters_total) || 0,
    monstersLeft: Number(node.monsters_left) || 0,
    stateMeta: node.state_meta && typeof node.state_meta === 'object' && !Array.isArray(node.state_meta) ? node.state_meta : {},
  })).filter(node => node.id && node.name);
  return {
    recognized: Array.isArray(state.nodes),
    instanceId: instanceMatch ? Number(instanceMatch[1]) : null,
    selectedNodeId: Number(state.selected_node_id) || null,
    currentFaceKey: String(state.current_face_key || ''),
    faces,
    nodes,
  };
}

function parseCubePvpNodePage(html, context = {}) {
  const source = String(html || '');
  const commitmentMatch = stripTags(source).match(/currently committed to match\s*#(\d+)\s*for about\s*(\d+):(\d{2}):(\d{2})\s*more/i);
  let committedMatchNo = commitmentMatch ? Number(commitmentMatch[1]) : null;
  const cooldownRemainingMs = commitmentMatch
    ? ((Number(commitmentMatch[2]) * 60 * 60) + (Number(commitmentMatch[3]) * 60) + Number(commitmentMatch[4])) * 1000
    : null;
  const matches = elementBlocks(source, 'div', 'match').map((block, index) => {
    const meta = elementBlocks(block.html, 'div', 'meta')[0]?.html || '';
    const metaText = stripTags(meta);
    const countMatch = metaText.match(/Match\s*#(\d+)\s*\/\s*Slots\s*(\d+)\s*\/\s*(\d+)/i);
    const linkMatch = block.html.match(/href=["']([^"']*pvp_style_battle\.php[^"']*)["']/i);
    if (!countMatch || !linkMatch) return null;
    // The site also styles the descriptive "Elite Team" badge with the
    // `live` class.  Class names therefore cannot be the match-state
    // contract: doing so leaves an already-cleared Elite room permanently
    // "live".  Only the exact visible state badge is authoritative.
    const badgeTexts = [...block.html.matchAll(/<[^>]+class=["'][^"']*\bbadge\b[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/gi)]
      .map(match => stripTags(match[1]).trim().toLowerCase());
    const status = badgeTexts.includes('cleared') ? 'cleared'
      : badgeTexts.includes('live') ? 'live'
        : badgeTexts.includes('open') ? 'open' : 'unknown';
    const slotBlocks = elementBlocks(block.html, 'div', 'slot');
    const emptySlots = [];
    let userSlot = null;
    slotBlocks.forEach((slot, slotIndex) => {
      if (/\bEmpty\b/i.test(stripTags(slot.html))) emptySlots.push(slotIndex + 1);
      if (/\bselfMark\b/i.test(slot.html) || /\bYOUR SLOT\b/i.test(stripTags(slot.html))) userSlot = slotIndex + 1;
    });
    const rewards = elementBlocks(block.html, 'div', 'rewardItem').map(item => ({
      name: String(findClassValue(item.html, 'rewardName') || '').trim(),
      quantity: parseNumber(findClassValue(item.html, 'rewardQty')) || 0,
    })).filter(item => item.name);
    const decodedUrl = decodeHtml(linkMatch[1]);
    return {
      index,
      matchNo: Number(countMatch[1]),
      title: String(findClassValue(block.html, 'matchTitle') || `Match #${countMatch[1]}`).trim(),
      status,
      occupiedSlots: Number(countMatch[2]),
      maximumSlots: Number(countMatch[3]),
      emptySlots,
      userSlot,
      joined: committedMatchNo === Number(countMatch[1]),
      rewards,
      url: decodedUrl.startsWith('http') ? decodedUrl : `https://demonicscans.org/${decodedUrl.replace(/^\//, '')}`,
    };
  }).filter(Boolean);
  if (!committedMatchNo) committedMatchNo = matches.find(match => match.userSlot && match.status !== 'cleared')?.matchNo || null;
  for (const match of matches) match.joined = match.matchNo === committedMatchNo;
  const openCandidates = matches.filter(match => match.status === 'open' && match.emptySlots.length > 0)
    .sort((left, right) => right.occupiedSlots - left.occupiedSlots || left.index - right.index || left.matchNo - right.matchNo);
  return {
    recognized: matches.length > 0,
    instanceId: Number(context.instanceId) || null,
    nodeId: Number(context.nodeId) || null,
    matches,
    candidate: openCandidates[0] || null,
    commitment: committedMatchNo ? {
      matchNo: committedMatchNo,
      slotIndex: matches.find(match => match.matchNo === committedMatchNo)?.userSlot || null,
      cooldownRemainingMs,
    } : null,
  };
}

function parseCubePvpState(payload) {
  let source = payload;
  if (typeof payload === 'string') {
    try { source = JSON.parse(payload); } catch { return { recognized: false }; }
  }
  if (!source || typeof source !== 'object' || source.ok !== true) return { recognized: false };
  return {
    recognized: true,
    ended: source.match?.ended === true,
    winnerSide: source.match?.winner_side == null ? null : String(source.match.winner_side),
    roomJoined: source.room_joined === true,
    roomSlot: Number(source.room_slot) || null,
    roomStatus: String(source.room_status || '').toLowerCase(),
    matchNo: Number(source.match_no) || null,
    lastLogId: Number(source.last_log_id) || 0,
    inMatch: source.me?.in_match === true,
  };
}

function parseBattlePage(html) {
  const objectSource = extractBalancedObject(html, /window\.BATTLE_CFG\s*=/);
  let battleCfg = null;
  let battleConfigError = null;
  if (objectSource) {
    try {
      battleCfg = parseObjectLiteral(objectSource);
    } catch (error) {
      battleConfigError = error.message;
    }
  } else {
    battleConfigError = 'BATTLE_CFG assignment was not found';
  }

  const constant = (name) => {
    const match = html.match(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(\\d+)`));
    return match ? parseNumber(match[1]) : 0;
  };

  const skills = [];
  const buttonRegex = /<button\b([^>]*)>/gi;
  let button;
  while ((button = buttonRegex.exec(html)) !== null) {
    const attrs = parseAttributes(button[1]);
    if (!hasClass(attrs, 'attack-btn')) continue;
    const id = parseNumber(attrs['data-skill-id']);
    const declaredCost = parseNumber(attrs['data-stam-cost']);
    if (id === null || declaredCost === null) continue;
    const fixedCosts = { '-1': 10, '-2': 50, '-3': 100, '-4': 200, '-5': 1000, '0': 1 };
    skills.push({
      id,
      name: attrs['data-skill-name'] || stripTags(button[0]) || `Skill ${id}`,
      stamCost: fixedCosts[String(id)] ?? declaredCost,
    });
  }

  const statPair = (id, suffix) => {
    const match = html.match(new RegExp(`id=["']${id}["'][^>]*>[\\s\\S]*?([\\d,]+)\\s*\\/\\s*([\\d,]+)\\s*${suffix}`, 'i'));
    return match ? { current: parseNumber(match[1]), max: parseNumber(match[2]) } : null;
  };
  const monsterHp = statPair('hpText', 'HP');
  const playerHp = statPair('pHpText', 'HP');
  const playerMana = statPair('pManaText', 'MP');
  const hasLootButton = /id=["']loot-button["']/i.test(html);
  const hasJoinButton = /class=["'][^"']*\bjoin-btn\b[^"']*["']|id=["']join-battle["']/i.test(html);
  const userDamageMatch = String(html || '').match(/id=["']yourDamageValue["'][^>]*>\s*([\d,]+)/i);
  const userStatsTag = String(html || '').match(/<[^>]+id=["']yourStats["'][^>]*>/i);
  const userStats = userStatsTag
    ? parseAttributes(userStatsTag[0].replace(/^<[^\s>]+|>$/g, ''))
    : {};
  const rewardValues = {};
  for (const block of elementBlocks(String(html || ''), 'div', 'stat-block')) {
    const label = String(findClassValue(block.html, 'label') || '').trim().toLowerCase();
    const value = block.html.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i);
    if (label && value) rewardValues[label] = stripTags(value[1]);
  }
  const rewardNumber = label => {
    const match = String(rewardValues[label] || '').match(/-?[\d,]+(?:\.\d+)?/);
    return match ? parseNumber(match[0]) : null;
  };
  const capMaxHp = parseNumber(userStats['data-maxhp']) ?? monsterHp?.max ?? null;
  const capFraction = Number(userStats['data-capfraction']);
  const expCapPercent = Number.isFinite(Number(userStats['data-capperc']))
    ? Number(userStats['data-capperc'])
    : rewardNumber('exp cap');
  const expCapDamage = Number.isFinite(capFraction) && capFraction >= 0 && capMaxHp !== null
    ? Math.floor(capMaxHp * capFraction)
    : (expCapPercent !== null && capMaxHp !== null ? Math.floor(capMaxHp * expCapPercent / 100) : null);
  const expPerDamage = rewardNumber('exp / dmg');
  const monsterStats = parseMonsterStatsModal(html);
  const consumables = parseBattleConsumables(html);
  const topbar = parseTopbar(html);
  let phaseDuel = null;
  const phaseDuelHref = String(html || '').match(/href=["']([^"']*pvp_style_battle\.php\?[^"']*\bsource=(?:monster_phase|monster%5[Ff]phase)[^"']*)["']/i)?.[1];
  if (phaseDuelHref) {
    try {
      const url = new URL(decodeHtml(phaseDuelHref), 'https://demonicscans.org/');
      const activeId = url.searchParams.get('active_id');
      if (url.origin === 'https://demonicscans.org' && url.pathname === '/pvp_style_battle.php'
        && url.searchParams.get('source') === 'monster_phase' && /^\d{1,30}$/.test(String(activeId || ''))) {
        phaseDuel = {
          activeId: Number(activeId),
          url: `https://demonicscans.org/pvp_style_battle.php?source=monster_phase&active_id=${encodeURIComponent(activeId)}`,
        };
      }
    } catch {}
  }
  if (monsterStats) {
    if (expPerDamage !== null) monsterStats.expPerDamage = expPerDamage;
    if (expCapPercent !== null) monsterStats.expCapPercent = expCapPercent;
    if (expCapDamage !== null) monsterStats.expCapDamage = expCapDamage;
    const minimumLevel = rewardNumber('level req');
    if (minimumLevel !== null) monsterStats.minimumLevel = minimumLevel;
  }

  return {
    battleCfg,
    battleConfigError,
    playerMaxHp: constant('PLAYER_MAX_HP') || playerHp?.max || 0,
    playerMaxMana: constant('PLAYER_MAX_MANA') || playerMana?.max || 0,
    userId: constant('USER_ID'),
    skills,
    monsterHp: monsterHp?.current ?? null,
    monsterMaxHp: monsterHp?.max ?? null,
    playerHp: playerHp?.current ?? null,
    playerMana: playerMana?.current ?? null,
    stamina: topbar.stamina ?? null,
    maxStamina: topbar.maxStamina ?? null,
    consumables,
    phaseDuel,
    isDead: monsterHp?.current === 0 || hasLootButton,
    isJoined: !hasJoinButton && (skills.length > 0 || hasLootButton),
    hasLootButton,
    hasJoinButton,
    userDamage: userDamageMatch ? parseNumber(userDamageMatch[1]) : null,
    rewardInfo: {
      recognized: expPerDamage !== null,
      expPerDamage,
      expCapPercent,
      expCapDamage,
      minimumLevel: rewardNumber('level req'),
      rewardsUpToLevel: monsterStats?.rewardsUpToLevel ?? null,
    },
    monsterStats,
    possibleLoot: parsePossibleLoot(html),
  };
}

function parseAdventurerQuests(html) {
  const source = String(html || '');
  const recognized = /Adventurer(?:'|&#39;|’)?s Guild/i.test(source)
    && /class=["'][^"']*quest-list\b/i.test(source);
  if (!recognized) return { recognized: false, quests: [], activeQuestId: null, refreshAt: null };
  const quests = elementBlocks(source, 'div', 'quest-row').map(block => {
    const actionId = action => {
      const match = block.html.match(new RegExp(`${action}\\s*\\(\\s*['\"]?(\\d+)['\"]?`, 'i'));
      return match ? Number(match[1]) : null;
    };
    const acceptQuestId = actionId('acceptQuest');
    const finishQuestId = actionId('finishQuest');
    const giveUpQuestId = actionId('giveUpQuest');
    const title = findClassValue(block.html, 'quest-main-title') || 'Untitled quest';
    const description = findClassValue(block.html, 'quest-main-desc') || '';
    const objective = findClassValue(block.html, 'quest-req-text') || '';
    const reward = findClassValue(block.html, 'quest-reward') || '';
    const cooldown = block.html.match(/data-cooldown-ts=["'](\d+)["']/i);
    const cooldownText = findClassValue(block.html, 'quest-cooldown-timer') || '';
    const progressText = stripTags(block.html.match(/<div\b[^>]*class=["'][^"']*\bquest-progress\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '');
    const progressMatch = progressText.match(/(?:progress\s*:?)?\s*(\d[\d,]*)\s*\/\s*(\d[\d,]*)/i);
    const current = progressMatch ? Number(progressMatch[1].replace(/,/g, '')) : null;
    const required = progressMatch ? Number(progressMatch[2].replace(/,/g, '')) : null;
    const finishButton = block.html.match(/<button\b([^>]*)class=["'][^"']*\bquest-finish-btn\b[^"']*["']([^>]*)>/i);
    const finishAttributes = finishButton ? `${finishButton[1]} ${finishButton[2]}` : '';
    const hasFinishAction = finishQuestId !== null || Boolean(finishButton);
    const finishDisabled = /\bdisabled(?:\s*=|\s|$)/i.test(finishAttributes)
      || /\baria-disabled\s*=\s*["']?true\b/i.test(finishAttributes);
    const progressComplete = current !== null && required !== null && current >= required;
    let status = 'unknown';
    // The live board may render its Finish control before the objective has
    // reached its requirement. A visible control is therefore authoritative
    // only when it is enabled and the board either proves completion or omits
    // a progress counter entirely. This prevents premature turn-in POSTs.
    if (hasFinishAction && !finishDisabled && (progressMatch === null || progressComplete)) status = 'claimable';
    else if (hasFinishAction || giveUpQuestId !== null || /quest-progress/i.test(block.html)) status = 'active';
    else if (acceptQuestId !== null || /quest-accept-btn/i.test(block.html)) status = 'available';
    else if (cooldown) status = 'cooldown';
    const id = status === 'available' ? acceptQuestId
      : status === 'claimable' ? (finishQuestId ?? giveUpQuestId)
        : status === 'active' ? (giveUpQuestId ?? finishQuestId)
          : (acceptQuestId ?? finishQuestId ?? giveUpQuestId);
    return {
      id,
      acceptQuestId,
      finishQuestId,
      giveUpQuestId,
      title,
      description,
      objective,
      reward,
      status,
      current,
      required,
      cooldownUntil: cooldown ? Number(cooldown[1]) : null,
      cooldownText,
    };
  });
  const refreshAt = source.match(/id=["']questRefreshCountdown["'][^>]*data-unlock-ts=["'](\d+)["']/i);
  return {
    recognized: true,
    quests,
    activeQuestId: quests.find(quest => ['active', 'claimable'].includes(quest.status))?.id || null,
    refreshAt: refreshAt ? Number(refreshAt[1]) : null,
  };
}

function parseBattlePass(html) {
  const source = String(html || '');
  const recognized = /Battle Pass/i.test(source) && /Daily Quests/i.test(source);
  if (!recognized) return { recognized: false, active: false, seasonId: null, title: '', endsText: '', level: null, completed: false, objectives: [] };
  const heading = source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const season = source.match(/name=["']season_id["'][^>]*value=["'](\d+)["']/i);
  const ends = stripTags(source).match(/Ends in\s+([^•]+)/i);
  const plainText = stripTags(source);
  const passLevel = plainText.match(/(?:Battle\s+Pass|Pass)\s+Level\s*:?\s*(\d[\d,]*)/i);
  const completed = /(?:Battle\s+Pass|Season)\s+(?:is\s+)?(?:Complete|Completed)|All\s+Battle\s+Pass\s+rewards\s+(?:were\s+)?claimed/i.test(plainText);
  const objectives = elementBlocks(source, 'div', 'quest').map((block, index) => {
    const text = stripTags(block.html);
    const nameMatch = block.html.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i);
    const progressMatches = [...text.matchAll(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/g)];
    const progress = progressMatches.at(-1);
    const type = /SPEND\s+STAMINA/i.test(text) ? 'spend_stamina'
      : /MUST\s+BE\s+LOOTED|MONSTERS?\s+HUNT/i.test(text) ? 'monster_hunt'
        : `unknown_${index + 1}`;
    const damage = text.match(/Damage\s+Min\s*:\s*([\d,]+)/i);
    const target = text.match(/Target:\s*(?:Stamina|Count)\s*:\s*([\d,]+)/i);
    const current = progress ? Number(progress[1].replace(/,/g, '')) : 0;
    const required = progress ? Number(progress[2].replace(/,/g, ''))
      : target ? Number(target[1].replace(/,/g, '')) : 0;
    return {
      type,
      name: nameMatch ? stripTags(nameMatch[1]) : text.slice(0, 120),
      current,
      required,
      completed: /Completed/i.test(text) || (required > 0 && current >= required),
      minimumDamage: damage ? Number(damage[1].replace(/,/g, '')) : 0,
    };
  });
  return {
    recognized: true,
    active: objectives.length > 0 && !completed,
    level: passLevel ? Number(passLevel[1].replace(/,/g, '')) : null,
    completed,
    seasonId: season ? Number(season[1]) : null,
    title: heading ? stripTags(heading[1]) : 'Battle Pass',
    endsText: ends ? ends[1].trim() : '',
    objectives,
  };
}

module.exports = {
  decodeHtml,
  stripTags,
  parseNumber,
  parseAttributes,
  parseActiveBuffs,
  parseTopbar,
  parseStatsPage,
  parseAutoFarmPanel,
  parseGates,
  parseWaveMonsters,
  parseAutoSummonMonsterNames,
  parseWaveLootSummary,
  parseWaveDeadPageNumbers,
  parseWavePlayerResources,
  parseMonsterStatsModal,
  parseBattleConsumables,
  parsePossibleLoot,
  parseCubeHomePage,
  parseCubePvpNodePage,
  parseCubePvpState,
  parseGearInventoryPage,
  parsePetInventoryPage,
  parseClassSkillTreePage,
  parseGuildDungeonDashboard,
  parseGuildDungeonIndex,
  parseDungeonInstancePage,
  parseDungeonLocationPage,
  parseObjectLiteral,
  parseBattlePage,
  parseAdventurerQuests,
  parseBattlePass,
};
