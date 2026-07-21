import { sendMessage } from '../../messages';
import { NO_PARAMS, type Connector } from './base';

export const gymConnector: Connector = {
  id: 'gym',
  label: 'Gym',
  isAvailable: () => true,
  tools: [
    {
      name: 'gym_checkin',
      description: 'Log a gym check-in for today (one per day, counts toward the weekly gym streak).',
      params: NO_PARAMS,
      confirm: true,
      palette: { label: 'Gym check-in', keywords: ['gym', 'workout', 'exercise'] },
      summary: () => 'Log a gym check-in for today',
      run: async () => {
        await sendMessage({ type: 'GYM_CHECKIN' });
        return 'Gym check-in logged.';
      },
    },
  ],
};
