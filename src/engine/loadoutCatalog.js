const crypto = require('crypto');

const LOADOUT_SCHEMA_VERSION = 1;

function canonicalNameKey(value, prefix = '') {
  const key = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return key ? `${prefix ? `${prefix}:` : ''}${key}` : '';
}

function normalizeEffectText(value = '') {
  return String(value)
    .replace(/^\s*⚡\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRecognizedEffects(value = '') {
  const raw = normalizeEffectText(value);
  const effects = [];
  const patterns = [
    {
      regex: /([\d.]+)%\s*Extra Damage To Monsters/gi,
      create: percent => ({ type: 'damage_percent', target: 'monsters', percent }),
    },
    {
      regex: /(?:Another\s+)?([\d.]+)%\s*Against Dragons/gi,
      create: percent => ({ type: 'damage_percent', target: 'dragons', percent }),
    },
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.regex.exec(raw)) !== null) {
      const percent = Number(match[1]);
      if (Number.isFinite(percent)) effects.push(pattern.create(percent));
    }
  }
  return effects.sort((left, right) => {
    const leftKey = `${left.type}:${left.target}:${left.percent}`;
    const rightKey = `${right.type}:${right.target}:${right.percent}`;
    return leftKey.localeCompare(rightKey);
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    }
    return result;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function normalizedEquippedEntry(entry, kind) {
  const common = {
    definitionKey: String(entry.definitionKey || ''),
    name: String(entry.name || '').trim(),
    inventoryRef: entry.inventoryRef === null || entry.inventoryRef === undefined ? null : String(entry.inventoryRef),
    slot: String(entry.slot || '').trim().toLowerCase(),
    slotIndex: Number.isFinite(Number(entry.slotIndex)) ? Number(entry.slotIndex) : null,
    attack: Number(entry.attack) || 0,
    defense: Number(entry.defense) || 0,
    level: Number(entry.level) || 0,
    rarity: String(entry.rarity || 'unknown').toLowerCase(),
    element: String(entry.element || 'NONE').toUpperCase(),
    elementRatePercent: Number(entry.elementRatePercent) || 0,
    rawEffect: normalizeEffectText(entry.rawEffect),
    effects: Array.isArray(entry.effects) ? entry.effects : [],
  };
  if (kind === 'gear') {
    common.itemReference = entry.itemReference === null || entry.itemReference === undefined
      ? null
      : String(entry.itemReference);
  } else {
    common.stars = Number(entry.stars) || 0;
    common.race = String(entry.race || '').trim();
    common.sigils = Array.isArray(entry.sigils) ? entry.sigils : [];
  }
  return common;
}

function sortEquipped(entries, kind) {
  return (Array.isArray(entries) ? entries : [])
    .map(entry => normalizedEquippedEntry(entry, kind))
    .sort((left, right) => {
      const leftSlot = left.slotIndex ?? Number.MAX_SAFE_INTEGER;
      const rightSlot = right.slotIndex ?? Number.MAX_SAFE_INTEGER;
      return leftSlot - rightSlot
        || left.slot.localeCompare(right.slot)
        || left.definitionKey.localeCompare(right.definitionKey)
        || String(left.inventoryRef || '').localeCompare(String(right.inventoryRef || ''));
    });
}

function totals(entries) {
  return entries.reduce((result, entry) => ({
    attack: result.attack + entry.attack,
    defense: result.defense + entry.defense,
  }), { attack: 0, defense: 0 });
}

function buildLoadoutSnapshot({ gear, pets, accountName = null, observedAt = new Date().toISOString() }) {
  if (!gear?.recognized) throw new Error('Verified Gear inventory markup was not found');
  if (!pets?.recognized) throw new Error('Verified Pet inventory markup was not found');

  const equippedGear = sortEquipped(gear.equipped, 'gear');
  const equippedPets = sortEquipped(pets.equipped, 'pet');
  const hashPayload = {
    schemaVersion: LOADOUT_SCHEMA_VERSION,
    gearContext: gear.context,
    petContext: pets.context,
    gear: equippedGear,
    pets: equippedPets,
  };

  return {
    schemaVersion: LOADOUT_SCHEMA_VERSION,
    accountName,
    observedAt,
    contexts: { gear: gear.context, pets: pets.context },
    hash: {
      algorithm: 'sha256',
      value: hashCanonical(hashPayload),
    },
    totals: {
      gear: totals(equippedGear),
      pets: totals(equippedPets),
      combined: totals([...equippedGear, ...equippedPets]),
    },
    gear: { ...gear, equipped: equippedGear },
    pets: { ...pets, equipped: equippedPets },
  };
}

module.exports = {
  LOADOUT_SCHEMA_VERSION,
  canonicalNameKey,
  normalizeEffectText,
  parseRecognizedEffects,
  canonicalize,
  stableStringify,
  hashCanonical,
  buildLoadoutSnapshot,
};
