import { sendMessage } from '../../messages';
import { normalizeUrl, type Connector } from './base';

export const bookmarksConnector: Connector = {
  id: 'bookmarks',
  label: 'Bookmarks',
  isAvailable: () => true,
  tools: [
    {
      name: 'add_bookmark',
      description: 'Save a link/bookmark to the dashboard links panel.',
      params: {
        type: 'object',
        required: ['url'],
        additionalProperties: false,
        properties: {
          url: { type: 'string', description: 'The URL to save', maxLength: 2000 },
          title: { type: 'string', description: 'Short display name for the link', maxLength: 100 },
        },
      },
      confirm: true,
      summary: (p) => `Save bookmark ${p.url as string}`,
      run: async (p) => {
        const url = normalizeUrl(p.url as string);
        const res = await sendMessage({
          type: 'ADD_BOOKMARK',
          url,
          title: (p.title as string) ?? '',
          groupId: null,
        });
        return `Saved “${res.bookmark.title || url}” to your links.`;
      },
    },
  ],
};
