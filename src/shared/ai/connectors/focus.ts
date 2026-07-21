import { sendMessage } from '../../messages';
import { getSettings } from '../../storage';
import { NO_PARAMS, type Connector } from './base';

export const focusConnector: Connector = {
  id: 'focus',
  label: 'Focus & sprints',
  isAvailable: () => true,
  tools: [
    {
      name: 'start_focus',
      description:
        'Start a focus session that blocks distracting sites. Optional length in minutes; pomodoro=true for repeating focus/break cycles.',
      params: {
        type: 'object',
        required: [],
        additionalProperties: false,
        properties: {
          minutes: { type: 'number', description: 'Focus length in minutes', minimum: 5, maximum: 240 },
          pomodoro: { type: 'boolean', description: 'true for pomodoro focus/break cycles' },
        },
      },
      confirm: true,
      palette: { label: 'Start focus session', keywords: ['focus', 'block', 'pomodoro'] },
      summary: (p) =>
        p.pomodoro
          ? 'Start a pomodoro focus session'
          : `Start a ${p.minutes ? `${p.minutes as number}-minute ` : ''}focus session`,
      run: async (p) => {
        const settings = await getSettings();
        const pomodoro = p.pomodoro === true;
        const focusMinutes = (p.minutes as number) ?? settings.focusMinutes;
        await sendMessage({
          type: 'START_FOCUS',
          mode: pomodoro ? 'pomodoro' : 'oneshot',
          focusMinutes,
          breakMinutes: pomodoro ? settings.focusBreakMinutes : 0,
        });
        return pomodoro
          ? `Pomodoro started — ${focusMinutes} min focus / ${settings.focusBreakMinutes} min break. Sites blocked.`
          : `Focus started for ${focusMinutes} minutes — ${settings.focusBlocklist.length} sites blocked.`;
      },
    },
    {
      name: 'stop_focus',
      description: 'End the current focus session early.',
      params: NO_PARAMS,
      confirm: true,
      palette: { label: 'End focus session', keywords: ['stop', 'focus', 'end'] },
      summary: () => 'End the focus session early',
      run: async () => {
        await sendMessage({ type: 'STOP_FOCUS', early: true });
        return 'Focus session ended.';
      },
    },
    {
      name: 'start_sprint',
      description: 'Start a short committed reading sprint (counts toward the reading streak).',
      params: NO_PARAMS,
      confirm: true,
      palette: { label: 'Start reading sprint', keywords: ['sprint', 'read'] },
      summary: () => 'Start a reading sprint',
      run: async () => {
        await sendMessage({ type: 'START_SPRINT' });
        return 'Reading sprint started.';
      },
    },
  ],
};
