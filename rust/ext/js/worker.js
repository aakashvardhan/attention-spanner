// The service worker. Chrome only delivers an event that wakes the worker to
// listeners registered in its first turn, and loading wasm is asynchronous, so
// every listener is registered here, synchronously, and forwards to Rust once
// the module is ready. All logic is in rust/ext/src/worker.
import init, * as wasm from './wasm/reader_ext.js';

const ready = init();
const run = (fn, ...args) => ready.then(() => fn(...args)).catch((e) => console.error('[worker]', e));

chrome.runtime.onInstalled.addListener(() => run(wasm.on_installed));
chrome.runtime.onStartup.addListener(() => run(wasm.on_startup));
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ready
    .then(() => wasm.on_message(msg, sender))
    .then(sendResponse, (e) => {
      console.error('[worker] message', e);
      sendResponse({ ok: false });
    });
  return true; // the reply is asynchronous
});
chrome.alarms.onAlarm.addListener((alarm) => run(wasm.on_alarm, alarm.name));
chrome.action.onClicked.addListener(() => run(wasm.on_action_clicked));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    run(wasm.on_settings_changed, changes.settings.oldValue ?? null, changes.settings.newValue ?? null);
  }
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) run(wasm.on_tab_url, tabId, info.url);
});
chrome.tabs.onRemoved.addListener((tabId) => run(wasm.on_tab_removed, tabId));

run(wasm.on_worker_start);
