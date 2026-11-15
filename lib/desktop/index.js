const { invokeNamedButton: rawInvokeNamedButton } = require('./invokeNamedButton');
const {
  focusNamedWindow: rawFocusNamedWindow,
  sendKeysToNamedWindow: rawSendKeysToNamedWindow,
  captureNamedWindow: rawCaptureNamedWindow,
} = require('./namedWindow');
const agentDesktop = require('./agentDesktop');

function legacyDesktopAllowed() {
  if (process.env.BROWSER_BRIDGE_FORCE_BLOCK_LEGACY_DESKTOP === '1') return false;
  return Boolean(
    process.env.BROWSER_BRIDGE_ALLOW_LEGACY_DESKTOP === '1'
    || process.env.BROWSER_BRIDGE_GUI_TESTS === '1'
    || process.env.NODE_TEST_CONTEXT,
  );
}

function guardLegacyDesktop(name, fn, replacement) {
  return function guardedLegacyDesktopHelper(...args) {
    if (!legacyDesktopAllowed()) {
      const error = new Error(
        `Legacy PowerShell desktop helper "${name}" is disabled by default to prevent policy bypass and slow per-call spawns; use ${replacement} via "node cli/agent.cjs desktop ..." or createAutomation().desktop`,
      );
      error.code = 'LEGACY_INTERFACE_DISABLED';
      throw error;
    }
    return fn(...args);
  };
}

module.exports = {
  invokeNamedButton: guardLegacyDesktop('invokeNamedButton', rawInvokeNamedButton, 'adClick / adBatch'),
  focusNamedWindow: guardLegacyDesktop('focusNamedWindow', rawFocusNamedWindow, 'ensureWindowReady / adFocusWindow'),
  sendKeysToNamedWindow: guardLegacyDesktop('sendKeysToNamedWindow', rawSendKeysToNamedWindow, 'deliverMessagesVerified / adSetValue / adBatch'),
  captureNamedWindow: guardLegacyDesktop('captureNamedWindow', rawCaptureNamedWindow, 'adScreenshot'),
  ...agentDesktop,
};
