const { elementBlocks, stripTags, decodeHtml } = require('./gameParsers');

function formIntent(source, formId) {
  const escapedId = String(formId).replace(/[^a-zA-Z0-9_-]/g, '');
  const body = source.match(new RegExp(`<form\\b(?=[^>]*id=["']${escapedId}["'])[^>]*>([\\s\\S]*?)<\\/form>`, 'i'))?.[1] || '';
  return body.match(/name=["']crystal_intent["'][^>]*value=["']([a-f0-9]{64})["']/i)?.[1]
    || body.match(/value=["']([a-f0-9]{64})["'][^>]*name=["']crystal_intent["']/i)?.[1]
    || null;
}

function parsePowerCrystalsPage(html) {
  const source = String(html || '');
  const recognized = /id=["']equipCrystalForm["']/.test(source)
    && /id=["']unequipCrystalForm["']/.test(source);

  const equipment = elementBlocks(source, 'div', 'equipment-card').map(block => ({
    inventoryRef: block.html.match(/openPickerModal\((\d+)\)/)?.[1] || null,
    crystalIds: [...block.html.matchAll(/openConfirmUnequip\((\d+)\)/g)].map(match => match[1]),
    slotCount: [...block.html.matchAll(/class=["'][^"']*\bslot-btn\b[^"']*["']/g)].length,
  }));

  const crystals = elementBlocks(source, 'div', 'crystal-card').flatMap(block => {
    const id = block.html.match(/openUpgradeModal\(["']level["'],\s*(\d+)\)/)?.[1];
    if (!id) return [];

    const linkedEquipment = equipment.find(item => item.crystalIds.includes(id));
    const name = decodeHtml(block.html.match(/openInfoFromData\(this,\s*'([^']+)'\)/)?.[1] || 'Crystal');
    const text = stripTags(block.html);
    return [{
      id,
      name,
      level: Number(text.match(/Lv\.\s*(\d+)/)?.[1]) || 0,
      linked: /\bLinked\b/.test(text),
      equipmentRef: linkedEquipment?.inventoryRef || null,
    }];
  });

  return {
    recognized,
    crystals,
    equipment,
    intents: {
      equip: formIntent(source, 'equipCrystalForm'),
      unequip: formIntent(source, 'unequipCrystalForm'),
    },
  };
}

module.exports = { parsePowerCrystalsPage };
