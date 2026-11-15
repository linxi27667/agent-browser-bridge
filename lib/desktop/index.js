const { invokeNamedButton } = require('./invokeNamedButton');
const { focusNamedWindow, sendKeysToNamedWindow, captureNamedWindow } = require('./namedWindow');
const agentDesktop = require('./agentDesktop');

module.exports = {
  invokeNamedButton,
  focusNamedWindow,
  sendKeysToNamedWindow,
  captureNamedWindow,
  ...agentDesktop
};
