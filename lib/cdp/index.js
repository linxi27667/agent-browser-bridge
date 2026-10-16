module.exports = {
  apiVersion: 1,
  version: require('../../package.json').version,
  ...require('./config'),
  identity: require('./identity'),
  ...require('./client'),
  ...require('./targets'),
  ...require('./page'),
  ...require('./window'),
  ...require('./interaction'),
  ...require('./scroll')
};
