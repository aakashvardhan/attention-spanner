import { getLocal, getSettings } from '../storage';
import type { Connector, ConnectorEnv, Tool } from './connectors/base';
import { bookmarksConnector } from './connectors/bookmarks';
import { calendarConnector } from './connectors/calendar';
import { feedsConnector } from './connectors/feeds';
import { flashcardsConnector } from './connectors/flashcards';
import { focusConnector } from './connectors/focus';
import { gymConnector } from './connectors/gym';
import { memoryConnector } from './connectors/memory';
import { pagesConnector } from './connectors/pages';
import { tasksConnector } from './connectors/tasks';

export type { Connector, ConnectorEnv } from './connectors/base';

/**
 * All connectors, in router-prompt order. New integrations (WhatsApp status,
 * Notion, automations) register here — nothing else needs to change.
 */
export const CONNECTORS: readonly Connector[] = [
  tasksConnector,
  focusConnector,
  gymConnector,
  memoryConnector,
  bookmarksConnector,
  flashcardsConnector,
  calendarConnector,
  feedsConnector,
  pagesConnector,
];

/** Tools whose connector is available in this environment */
export function activeTools(env: ConnectorEnv): Tool[] {
  return CONNECTORS.filter((c) => c.isAvailable(env)).flatMap((c) => [...c.tools]);
}

/** Gather the env and filter — for surfaces that can afford the storage read */
export async function getActiveTools(): Promise<Tool[]> {
  const [settings, { calendar }] = await Promise.all([getSettings(), getLocal('calendar')]);
  return activeTools({ settings, calendarConnected: calendar.connected });
}
