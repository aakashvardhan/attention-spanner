import {
  dayRange,
  EVENT_MAX_MINUTES,
  EVENT_MIN_MINUTES,
  formatEventList,
  parseEventTimes,
} from '../../calendar';
import { sendMessage } from '../../messages';
import type { Connector } from './base';

export const calendarConnector: Connector = {
  id: 'calendar',
  label: 'Google Calendar',
  // Advertised only once the user has connected a calendar — filtered
  // surfaces (getActiveTools) stop offering these to everyone else
  isAvailable: (env) => env.calendarConnected,
  tools: [
    {
      name: 'create_event',
      description:
        'Create a Google Calendar event ("block 2-3pm for deep work", "schedule dentist Friday 10am"). Times are 24h local.',
      params: {
        type: 'object',
        required: ['title', 'startTime'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'Event title', maxLength: 200 },
          startTime: { type: 'string', description: 'Start time as HH:MM, 24-hour local' },
          date: { type: 'string', description: 'Date as YYYY-MM-DD; omit for today' },
          durationMinutes: {
            type: 'number',
            description: 'Length in minutes (default 60)',
            minimum: EVENT_MIN_MINUTES,
            maximum: EVENT_MAX_MINUTES,
          },
        },
      },
      confirm: true,
      palette: {
        label: 'Create calendar event',
        keywords: ['calendar', 'event', 'block', 'meeting', 'schedule'],
      },
      summary: (p) => {
        const when = `${p.date ? `${p.date as string} ` : ''}${p.startTime as string}`;
        return `Create calendar event “${p.title as string}” at ${when} (${(p.durationMinutes as number) ?? 60} min)`;
      },
      run: async (p) => {
        const times = parseEventTimes(
          {
            startTime: p.startTime as string,
            date: p.date as string | undefined,
            durationMinutes: p.durationMinutes as number | undefined,
          },
          new Date(),
        );
        if (!times.ok) throw new Error(`That didn't quite work (${times.error}).`);
        const res = await sendMessage({
          type: 'CAL_CREATE_EVENT',
          title: p.title as string,
          startMs: times.startMs,
          endMs: times.endMs,
        });
        if (!res.ok || !res.event) throw new Error(res.error ?? 'Could not create the event.');
        const start = new Date(res.event.startMs);
        return `Added “${res.event.title}” to your calendar for ${start.toLocaleString('en-US', {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
        })}.`;
      },
    },
    {
      name: 'list_events',
      description:
        "List the events on the user's Google Calendar for a day (\"what's on my calendar tomorrow?\"). Use this for any day other than today, or when the user asks for their agenda/schedule.",
      params: {
        type: 'object',
        required: [],
        additionalProperties: false,
        properties: {
          date: {
            type: 'string',
            description: "'today', 'tomorrow', or a date as YYYY-MM-DD; omit for today",
            maxLength: 20,
          },
        },
      },
      summary: (p) => `List calendar events for ${(p.date as string) || 'today'}`,
      run: async (p) => {
        const range = dayRange(p.date as string | undefined, new Date());
        if (!range) {
          throw new Error(`I can do 'today', 'tomorrow', or a YYYY-MM-DD date — “${p.date as string}” didn't parse.`);
        }
        const res = await sendMessage({ type: 'CAL_LIST_EVENTS', startMs: range.startMs, endMs: range.endMs });
        if (!res.ok || !res.events) throw new Error(res.error ?? 'Could not fetch your calendar.');
        return formatEventList(res.events, range.label);
      },
    },
  ],
};
