// The service worker. Chrome only delivers an event that wakes the worker to
// listeners registered in its first turn, and loading wasm is asynchronous, so
// every listener is registered here, synchronously, and forwards to Rust once
// the module is ready. All logic is in rust/ext/src/worker.
import init, * as wasm from './wasm/reader_ext.js';

// The wasm is named by its hash (scripts/publish-ext.mjs). A worker Chrome kept
// from an older build asks for a file the rebuild replaced, and fetching it
// fails: reload once so Chrome starts the build on disk. At most once a minute,
// so a file that is really missing logs its error instead of looping.
const ready = init().catch(async (e) => {
  const { wasmReloadAt = 0 } = await chrome.storage.local.get('wasmReloadAt');
  if (Date.now() - wasmReloadAt > 60_000) {
    await chrome.storage.local.set({ wasmReloadAt: Date.now() });
    chrome.runtime.reload();
  }
  throw e;
});
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
// The toolbar icon opens the side panel (src/pages/sidebar) on its tab only:
// switching tabs hides it, coming back shows it again. Off everywhere else.
const panelError = (e) => console.error('[worker] side panel', e);
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(panelError);
chrome.sidePanel.setOptions({ enabled: false }).catch(panelError);
// Tabs whose panel is open, so a click knows at once whether to close it
// (open() must run inside the click: no await to ask first). Rebuilt when the
// worker starts, since it may have slept with panels open; Chrome's onClosed
// drops a panel closed with its own X.
// ponytail: a click in the instant after the worker wakes, before getContexts
// answers, sees an open panel as closed; that click is a no-op, the next closes.
const panelTabs = new Set();
chrome.runtime
  .getContexts({ contextTypes: ['SIDE_PANEL'] })
  .then((cs) => cs.forEach((c) => panelTabs.add(Number(new URL(c.documentUrl).searchParams.get('tab')))))
  .catch(panelError);
chrome.sidePanel.onClosed?.addListener((info) => panelTabs.delete(info.tabId));
// The icon toggles this tab's panel. Global so the e2e suite can click it.
globalThis.togglePanel = (tab) => {
  if (panelTabs.delete(tab.id)) {
    chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false }).catch(panelError);
    return;
  }
  panelTabs.add(tab.id);
  chrome.sidePanel.setOptions({ tabId: tab.id, path: `src/pages/sidebar/index.html?tab=${tab.id}`, enabled: true }).catch(panelError);
  chrome.sidePanel.open({ tabId: tab.id }).catch(panelError);
};
chrome.action.onClicked.addListener((tab) => globalThis.togglePanel(tab));
// Keyboard commands (manifest `commands`); the icon's own shortcut arrives as a click above.
chrome.commands.onCommand.addListener((command) => run(wasm.on_command, command));
// `r <words>` in the address bar: papers on the shelf.
chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  ready.then(() => wasm.omnibox_suggest(text)).then(suggest, (e) => console.error('[worker] omnibox', e));
});
chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  ready
    .then(() => wasm.omnibox_url(text))
    .then((url) =>
      disposition === 'currentTab'
        ? chrome.tabs.update({ url })
        : chrome.tabs.create({ url, active: disposition === 'newForegroundTab' }),
    )
    .catch((e) => console.error('[worker] omnibox', e));
});
// The page menu opens the panel here, inside the click; the rest is Rust's.
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'panel') return run(wasm.on_menu, info, tab ?? null);
  if (tab && !panelTabs.has(tab.id)) globalThis.togglePanel(tab);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) {
    run(wasm.on_settings_changed, changes.settings.oldValue ?? null, changes.settings.newValue ?? null);
  }
  if (area === 'local' && changes.todos) run(wasm.on_todos_changed);
  if (area === 'local' && changes.pomodoro) run(wasm.on_pomodoro_changed);
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) run(wasm.on_tab_url, tabId, info.url);
});
chrome.tabs.onRemoved.addListener((tabId) => run(wasm.on_tab_removed, tabId));

run(wasm.on_worker_start);
