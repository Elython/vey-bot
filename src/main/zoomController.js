const DEFAULT_ZOOM_FACTOR = 1;
const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 2;
const ZOOM_STEP = 0.1;

function resolveZoomShortcut(input = {}) {
  if (input.type && input.type !== 'keyDown') return null;
  if (input.alt === true || (input.control !== true && input.meta !== true)) return null;
  const key = String(input.key || '').toLowerCase();
  const code = String(input.code || '');
  if (['+', '='].includes(key) || ['Equal', 'NumpadAdd'].includes(code)) return 'in';
  if (['-', '_'].includes(key) || ['Minus', 'NumpadSubtract'].includes(code)) return 'out';
  if (key === '0' || ['Digit0', 'Numpad0'].includes(code)) return 'reset';
  return null;
}

function nextZoomFactor(current, action) {
  if (action === 'reset') return DEFAULT_ZOOM_FACTOR;
  const normalized = Number.isFinite(Number(current)) ? Number(current) : DEFAULT_ZOOM_FACTOR;
  const change = action === 'in' ? ZOOM_STEP : action === 'out' ? -ZOOM_STEP : 0;
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, Math.round((normalized + change) * 10) / 10));
}

function installZoomShortcuts(webContents, { resetOnLoad = true } = {}) {
  if (!webContents?.on || !webContents?.setZoomFactor || !webContents?.getZoomFactor) return () => {};
  const reset = () => webContents.setZoomFactor(DEFAULT_ZOOM_FACTOR);
  const handleInput = (event, input) => {
    const action = resolveZoomShortcut(input);
    if (!action) return;
    event.preventDefault();
    webContents.setZoomFactor(nextZoomFactor(webContents.getZoomFactor(), action));
  };
  webContents.on('before-input-event', handleInput);
  if (resetOnLoad) webContents.on('did-finish-load', reset);
  reset();
  return () => {
    webContents.removeListener?.('before-input-event', handleInput);
    if (resetOnLoad) webContents.removeListener?.('did-finish-load', reset);
  };
}

module.exports = {
  DEFAULT_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  MAX_ZOOM_FACTOR,
  ZOOM_STEP,
  resolveZoomShortcut,
  nextZoomFactor,
  installZoomShortcuts,
};
