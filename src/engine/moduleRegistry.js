const { getMonsterArea } = require('./monsterCatalog');

const BUILTIN_MODULES = Object.freeze({
  idle: { id: 'idle', label: 'Idle', status: 'ready', mapTypes: [] },
  gates: { id: 'gates', label: 'Gates', status: 'ready', mapTypes: ['gate'] },
  dungeons: { id: 'dungeons', label: 'Dungeons', status: 'ready', mapTypes: ['dungeon'] },
  gates_dungeons: { id: 'gates_dungeons', label: 'Dungeons → Gates', status: 'partial', mapTypes: ['gate', 'dungeon'] },
  event: { id: 'event', label: 'Event', status: 'ready', mapTypes: ['event'] },
  pvp: { id: 'pvp', label: 'PvP', status: 'deferred', mapTypes: [] },
});

class ModuleRegistry {
  constructor(definitions = BUILTIN_MODULES) {
    this.modules = new Map(Object.values(definitions).map(definition => [definition.id, { ...definition }]));
  }

  get(moduleId) {
    const moduleDefinition = this.modules.get(moduleId);
    return moduleDefinition ? { ...moduleDefinition, mapTypes: [...moduleDefinition.mapTypes] } : null;
  }

  list() {
    return [...this.modules.values()].map(definition => ({ ...definition, mapTypes: [...definition.mapTypes] }));
  }

  resolveGateScan(general = {}) {
    const scan = this.resolveScan(general);
    return scan && scan.kind !== 'dungeon' ? scan : null;
  }

  resolveArea(areaKey) {
    const area = getMonsterArea(areaKey);
    if (!area || area.key === 'polyhedral_crucible') return null;
    if (area.type === 'gate') return { gateId: area.gateId, wave: area.wave, areaKey: area.key };
    if (area.type === 'event') return { kind: 'event', eventId: area.eventId, wave: area.wave, areaKey: area.key };
    if (area.type === 'dungeon') return { kind: 'dungeon', areaKey: area.key };
    return null;
  }

  resolveScan(general = {}) {
    const definition = this.modules.get(general.module || 'idle');
    if (definition?.id === 'gates_dungeons') {
      const dungeon = getMonsterArea(general.dungeonMap);
      const gate = getMonsterArea(general.gateMap);
      const fallback = gate?.type === 'gate'
        ? { gateId: gate.gateId, wave: gate.wave, areaKey: gate.key }
        : null;
      if (dungeon?.type === 'dungeon' && dungeon.key !== 'polyhedral_crucible') {
        return { kind: 'dungeon', areaKey: dungeon.key, fallback };
      }
      return fallback;
    }
    if (definition?.id === 'event') {
      const eventArea = getMonsterArea(general.eventMap || general.map);
      if (eventArea?.type === 'event' && Number.isInteger(eventArea.eventId)) {
        return { kind: 'event', eventId: eventArea.eventId, wave: eventArea.wave, areaKey: eventArea.key };
      }
      return null;
    }
    const area = getMonsterArea(general.map);
    if (!definition || !area || !definition.mapTypes.includes(area.type)) return null;
    if (area.type === 'gate' && !area.eventId) {
      return { gateId: area.gateId, wave: area.wave, areaKey: area.key };
    }
    if (area.type === 'dungeon' && area.key !== 'polyhedral_crucible') {
      return { kind: 'dungeon', areaKey: area.key };
    }
    return null;
  }

  describe(general = {}) {
    const definition = this.modules.get(general.module || 'idle') || BUILTIN_MODULES.idle;
    const area = getMonsterArea(definition.id === 'event' ? (general.eventMap || general.map) : general.map);
    return {
      id: definition.id,
      label: definition.label,
      status: definition.status,
      mapKey: area?.key || null,
      mapLabel: area?.label || null,
      displayName: definition.id === 'gates_dungeons'
        ? `${definition.label} · ${getMonsterArea(general.dungeonMap)?.label || 'No Dungeon'} · ${getMonsterArea(general.gateMap)?.label || 'No Gate'}`
        : area ? `${definition.label} · ${area.label}` : definition.label,
    };
  }
}

module.exports = { ModuleRegistry, BUILTIN_MODULES };
