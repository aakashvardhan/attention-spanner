import { appendTurn, newTurn } from '../shared/ai/assistantTypes';
import { nextUpcoming, type CalendarEvent } from '../shared/calendar';
import {
  MONITOR_CARDS_DUE_MIN,
  MONITOR_EVENT_WINDOW_MIN,
  NOTIFICATION_IDS,
} from '../shared/constants';
import { localDate } from '../shared/format';
import { dueCounts, newIntroducedToday, totalDue } from '../shared/srs';
import { getLocal, getSession, getSettings, setSession } from '../shared/storage';
import type { FlashCard, Settings, SrsDayStats, Streaks } from '../shared/types';
import { inQuietHours } from '../shared/week';

/**
 * Proactive Jarvis monitor — wall-clock/data-driven nudges, unlike the
 * per-article tab-switch machinery in nudges.ts. Two alarms: a daily evening
 * check (streak at risk / cards piling up) and a 5-minute calendar tick
 * (event starting soon). All text is templated — no LLM ever runs in the
 * worker (the Nano rule); the notification doubles as a chat turn so Jarvis
 * "said" it when the dashboard next opens.
 */

export interface EveningNudgeData {
  streaks: Streaks;
  flashCards: FlashCard[];
  srsDaily: Record<string, SrsDayStats>;
}

/** Pure: what (if anything) the evening check should say */
export function buildEveningNudge(
  data: EveningNudgeData,
  now: Date,
): { title: string; message: string } | null {
  const parts: string[] = [];

  const todayStats = data.streaks.daily[localDate(now)];
  const activeToday = (todayStats?.minutes ?? 0) > 0 || (todayStats?.sprints ?? 0) > 0;
  if (data.streaks.currentStreak > 0 && !activeToday) {
    parts.push(
      `Your ${data.streaks.currentStreak}-day reading streak ends tonight without a sprint — 5 minutes keeps it.`,
    );
  }

  const due = totalDue(
    dueCounts(data.flashCards, now.getTime(), newIntroducedToday(data.srsDaily, localDate(now))),
  );
  if (due >= MONITOR_CARDS_DUE_MIN) {
    parts.push(`${due} flashcards are due — a quick review stops the pile growing.`);
  }

  if (parts.length === 0) return null;
  return { title: 'Jarvis: evening check-in', message: parts.join(' ') };
}

/** Pure: next timed event starting within the reminder window, minus already-notified */
export function pickEventToNotify(
  events: CalendarEvent[],
  notifiedIds: string[],
  now: Date,
): { event: CalendarEvent; minutesUntil: number } | null {
  const next = nextUpcoming(events, now);
  if (!next) return null;
  if (next.minutesUntil < 1 || next.minutesUntil > MONITOR_EVENT_WINDOW_MIN) return null;
  if (notifiedIds.includes(next.event.id)) return null;
  return next;
}

function monitorGatesOpen(settings: Settings, now: Date): boolean {
  return (
    settings.notificationsEnabled &&
    settings.assistantMonitorEnabled &&
    !inQuietHours(settings.monitorQuietStart, settings.monitorQuietEnd, now)
  );
}

/** Leave the nudge in the assistant chat so it's there on the next dashboard open */
async function appendMonitorTurn(text: string): Promise<void> {
  const { assistantThread } = await getSession('assistantThread');
  await setSession({
    assistantThread: appendTurn(assistantThread, newTurn('assistant', text, { source: 'local' })),
  });
}

export async function fireEveningCheck(now = new Date()): Promise<void> {
  const settings = await getSettings();
  if (!monitorGatesOpen(settings, now)) return;

  const data = await getLocal('streaks', 'flashCards', 'srsDaily');
  const nudge = buildEveningNudge(data, now);
  if (!nudge) return;

  chrome.notifications.create(NOTIFICATION_IDS.monitorEvening, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: nudge.title,
    message: nudge.message,
    priority: 0,
  });
  await appendMonitorTurn(nudge.message);
}

export async function fireCalendarCheck(now = new Date()): Promise<void> {
  const { calendar } = await getLocal('calendar');
  if (!calendar.connected) return;

  const settings = await getSettings();
  if (!monitorGatesOpen(settings, now)) return;

  const { monitorNotifiedEventIds } = await getSession('monitorNotifiedEventIds');
  const hit = pickEventToNotify(calendar.events, monitorNotifiedEventIds, now);
  if (!hit) return;

  await setSession({ monitorNotifiedEventIds: [...monitorNotifiedEventIds, hit.event.id] });
  const message = `${hit.event.title} starts in ${hit.minutesUntil} min${
    hit.event.location ? ` (${hit.event.location})` : ''
  }.`;
  chrome.notifications.create(NOTIFICATION_IDS.monitorEventPrefix + hit.event.id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
    title: 'Coming up',
    message,
    priority: 1,
  });
  await appendMonitorTurn(message);
}

export function isMonitorNotification(id: string): boolean {
  return id === NOTIFICATION_IDS.monitorEvening || id.startsWith(NOTIFICATION_IDS.monitorEventPrefix);
}
