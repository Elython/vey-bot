module.exports = {
  ...require('./identity'),
  ...require('./freshnessPolicy'),
  ...require('./contracts'),
  ...require('./collectorRegistry'),
  ...require('./worldStateService'),
  ...require('./readCoordinator'),
};
