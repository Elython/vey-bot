const CUBE_PVP_NODES = Object.freeze([
  Object.freeze({ id: 7, key: 'ring_ward', label: 'Ring Ward', maximumMatches: 20 }),
  Object.freeze({ id: 8, key: 'duel_heart', label: 'Duel Heart', maximumMatches: 20 }),
  Object.freeze({ id: 9, key: 'tyrant_conclave', label: 'Tyrant Conclave', maximumMatches: 1 }),
]);

const CUBE_PVE_LOCATION_IDS = Object.freeze([11, 12, 13, 14]);

function cubePvpNodeDefinition(nodeId) {
  return CUBE_PVP_NODES.find(node => node.id === Number(nodeId)) || null;
}

module.exports = { CUBE_PVP_NODES, CUBE_PVE_LOCATION_IDS, cubePvpNodeDefinition };
