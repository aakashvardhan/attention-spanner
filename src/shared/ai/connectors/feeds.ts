import { sendMessage } from '../../messages';
import { NO_PARAMS, type Connector } from './base';

export const feedsConnector: Connector = {
  id: 'feeds',
  label: 'RSS feeds',
  isAvailable: () => true,
  tools: [
    {
      name: 'mark_all_read',
      description: 'Mark every RSS feed item as read.',
      params: NO_PARAMS,
      confirm: true,
      palette: { label: 'Mark all feeds read', keywords: ['feeds', 'read', 'clear'] },
      summary: () => 'Mark all feed items as read',
      run: async () => {
        const res = await sendMessage({ type: 'MARK_ALL_READ' });
        return `Marked ${res.count} items as read.`;
      },
    },
    {
      name: 'refresh_feeds',
      description: 'Refresh the RSS feeds now.',
      params: NO_PARAMS,
      palette: { label: 'Refresh feeds', keywords: ['rss', 'refresh', 'reload'] },
      summary: () => 'Refresh the feeds',
      run: async () => {
        const res = await sendMessage({ type: 'REFRESH_FEEDS' });
        return res.ok ? `Feeds refreshed — ${res.itemCount} items.` : 'Feed refresh failed.';
      },
    },
  ],
};
