import { connectedAccounts } from '../gmail';
import { getLocal, getSettings } from '../storage';
import type { Connector, ConnectorEnv, Tool } from './connectors/base';
import { alphaxivConnector } from './connectors/alphaxiv';
import { bookmarksConnector } from './connectors/bookmarks';
import { calendarConnector } from './connectors/calendar';
import { feedsConnector } from './connectors/feeds';
import { gmailConnector } from './connectors/gmail';
import { flashcardsConnector } from './connectors/flashcards';
import { focusConnector } from './connectors/focus';
import { graphConnector } from './connectors/graph';
import { libraryConnector } from './connectors/library';
import { memoryConnector } from './connectors/memory';
import { pagesConnector } from './connectors/pages';
import { liveConnector } from './connectors/live';
import { papersConnector } from './connectors/papers';
import { planningConnector } from './connectors/planning';
import { tasksConnector } from './connectors/tasks';

export type { Connector, ConnectorEnv } from './connectors/base';

/**
 * All connectors, in router-prompt order. New integrations (WhatsApp status,
 * automations) register here — nothing else needs to change.
 */
export const CONNECTORS: readonly Connector[] = [
  tasksConnector,
  planningConnector,
  focusConnector,
  memoryConnector,
  bookmarksConnector,
  flashcardsConnector,
  papersConnector,
  libraryConnector,
  alphaxivConnector,
  calendarConnector,
  gmailConnector,
  feedsConnector,
  pagesConnector,
  graphConnector,
  liveConnector,
];

/** Tools whose connector is available in this environment */
export function activeTools(env: ConnectorEnv): Tool[] {
  return CONNECTORS.filter((c) => c.isAvailable(env)).flatMap((c) => [...c.tools]);
}

let cachedActiveTools: Tool[] | null = null;
let activeToolsRead: Promise<Tool[]> | null = null;

export function invalidateActiveTools(): void {
  cachedActiveTools = null;
  activeToolsRead = null;
}

// Connector availability changes only with these local records. In extension
// contexts, invalidate exactly when one changes; vitest has no chrome global.
if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (
      area === 'local' &&
      (changes.settings || changes.calendar || changes.alphaxiv || changes.gmail)
    ) {
      invalidateActiveTools();
    }
  });
}

/** Gather the env and filter — for surfaces that can afford the storage read */
export async function getActiveTools(): Promise<Tool[]> {
  if (cachedActiveTools) return cachedActiveTools;
  if (activeToolsRead) return activeToolsRead;
  activeToolsRead = Promise.all([getSettings(), getLocal('calendar', 'alphaxiv', 'gmail')])
    .then(([settings, { calendar, alphaxiv, gmail }]) => {
      const tools = activeTools({
        settings,
        calendarConnected: calendar.connected,
        alphaxivConnected: alphaxiv.connected,
        gmailConnected: connectedAccounts(gmail).length > 0,
      });
      cachedActiveTools = tools;
      activeToolsRead = null;
      return tools;
    })
    .catch((error) => {
      activeToolsRead = null;
      throw error;
    });
  return activeToolsRead;
}
