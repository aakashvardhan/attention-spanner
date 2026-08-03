import {
  NEWTAB_PAGE_PATH,
  PAPERS_PAGE_PATH,
} from '../../constants';
import type { Connector } from './base';

export const pagesConnector: Connector = {
  id: 'pages',
  label: 'Extension pages',
  isAvailable: () => true,
  tools: [
    {
      name: 'open_page',
      // Navigation: spawns a tab. The one non-confirm capability an injected
      // page could aim, so the loop never fires it unattended.
      loop: 'stage',
      description:
        'Open one of the extension pages: dashboard, papers, or settings.',
      params: {
        type: 'object',
        required: ['page'],
        additionalProperties: false,
        properties: {
          page: {
            type: 'string',
            description: 'Which page to open',
            enum: ['dashboard', 'papers', 'settings'],
          },
        },
      },
      palette: {
        label: 'Open page…',
        keywords: ['open', 'go', 'papers', 'settings'],
      },
      summary: (p) => `Open the ${p.page as string} page`,
      run: async (p) => {
        const page = p.page as string;
        if (page === 'settings') {
          await chrome.runtime.openOptionsPage();
        } else {
          const path = page === 'papers' ? PAPERS_PAGE_PATH : NEWTAB_PAGE_PATH;
          await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
        }
        return `Opened ${page}.`;
      },
    },
  ],
};
