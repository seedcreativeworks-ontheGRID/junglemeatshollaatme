/**
 * Last-resort global error safety net.
 *
 * Every per-layer lifecycle call already has its own try/catch deep in
 * src/data/manager.js, surfaced through each layer's own DEGRADED/UNAVAILABLE
 * chip state — this module is NOT for that. It exists only to catch whatever
 * slips past every other try/catch in the app: a stray uncaught throw from a
 * UI click handler, a keyboard shortcut, a voice-tool callback, or an
 * unhandled promise rejection anywhere. Those would otherwise either do
 * nothing visible (a silently dead click handler) or, worse, take down
 * whatever shared state the failing call was mutating.
 *
 * This handler NEVER rethrows and NEVER interrupts execution — it only logs
 * clearly to the console and, rate-limited, surfaces one subtle toast so a
 * genuinely fatal top-level error doesn't read as total silence. It must stay
 * additive and minimal: it is a net, not a rewrite of error handling.
 */

const TOAST_COOLDOWN_MS = 8000;
const TOAST_VISIBLE_MS = 2500;
const TOAST_MESSAGE = "Something went wrong, but God's Eye View is still running.";

let lastToastAt = 0;
let toastHideTimer = null;

/** Best-effort human-readable description of any thrown/rejected value. */
function describeReason(reason) {
  if (!reason) return 'Unknown error';
  if (reason instanceof Error) return reason.stack || reason.message || reason.name || 'Unknown error';
  if (typeof reason === 'string') return reason;
  try {
    const serialized = JSON.stringify(reason);
    if (serialized && serialized !== '{}') return serialized;
  } catch {
    // Non-serializable — fall through to String().
  }
  return String(reason);
}

/**
 * Surfaces a subtle, rate-limited toast through the same static #toast
 * element StyleManager's own `_showToast` uses (see src/ui.js), without
 * depending on StyleManager having initialized yet — this net must work even
 * if init() itself is what threw. Silently no-ops if the DOM isn't ready or
 * the element is missing; console logging (the caller's job) is the real
 * safety net regardless.
 */
function notify(now = Date.now()) {
  if (now - lastToastAt < TOAST_COOLDOWN_MS) return;
  lastToastAt = now;
  try {
    const toast = document?.getElementById?.('toast');
    if (!toast) return;
    toast.textContent = TOAST_MESSAGE;
    toast.classList.add('visible');
    clearTimeout(toastHideTimer);
    toastHideTimer = setTimeout(() => toast.classList.remove('visible'), TOAST_VISIBLE_MS);
  } catch {
    // Toast is best-effort only — never let notifying about an error throw one.
  }
}

/**
 * Installs the window-level 'error' and 'unhandledrejection' listeners. Safe
 * to call more than once; each call adds its own listeners (harmless — both
 * handlers are idempotent side effects: log + rate-limited toast), but
 * callers should only call this once, early in main.js before init() runs.
 * @returns {void}
 */
export function installGlobalErrorBoundary() {
  window.addEventListener('error', (event) => {
    // A ResourceError (failed <img>/<script> load) also fires 'error' but
    // carries no `.error` — not a JS exception, so don't log it as one.
    if (!event?.error && event?.target && event.target !== window) return;
    console.error('[GEV] Uncaught error:', describeReason(event?.error ?? event?.message));
    notify();
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[GEV] Unhandled promise rejection:', describeReason(event?.reason));
    notify();
  });
}

/** Test-only: resets the toast rate-limit so tests don't leak state across cases. */
export function _resetErrorBoundaryForTest() {
  lastToastAt = 0;
  clearTimeout(toastHideTimer);
  toastHideTimer = null;
}
