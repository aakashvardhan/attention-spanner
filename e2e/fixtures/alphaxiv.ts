/**
 * alphaXiv MCP replies, recorded from a real account on 2026-11-01 and kept
 * byte-for-byte in shape. Ids and titles are swapped for public stand-ins so
 * no one's reading list ships in the repo. If alphaXiv changes a reply, record
 * it again and these contract tests show what broke.
 */

/** list_library { include_papers: true } */
export const LIST_LIBRARY = JSON.stringify({
  folders: [
    {
      folder_id: '01985f0e-9788-7673-a495-000000000001',
      name: 'Want to read',
      type: 'default-to-read',
      parent_id: null,
      sharing_status: 'not_shared',
      paper_count: 3,
      papers: [
        { universal_paper_id: '2406.09246', title: 'OpenVLA: An Open-Source Vision-Language-Action Model', type: 'public', publication_date: '2024-09-04' },
        { universal_paper_id: '2410.24164', title: '$π_0$: A Vision-Language-Action Flow Model for General Robot Control', type: 'public', publication_date: '2024-10-31' },
        { universal_paper_id: '2506.01844', title: 'SmolVLA: A Vision-Language-Action Model for Affordable and Efficient  Robotics', type: 'public', publication_date: '2025-06-02' },
      ],
      papers_truncated: false,
    },
    {
      folder_id: '01985f0e-9788-7c5f-9cff-000000000002',
      name: 'Reading',
      type: 'default-reading',
      parent_id: null,
      sharing_status: 'not_shared',
      paper_count: 2,
      papers: [
        { universal_paper_id: '1706.03762', title: 'Attention Is All You Need', type: 'public', publication_date: '2017-06-12' },
        { universal_paper_id: '2110.14168', title: 'Training Verifiers to Solve Math Word Problems', type: 'public', publication_date: '2021-10-27' },
      ],
      papers_truncated: false,
    },
    {
      folder_id: '01985f0e-9788-7924-8401-000000000003',
      name: 'Completed',
      type: 'default-completed',
      parent_id: null,
      sharing_status: 'not_shared',
      paper_count: 0,
      papers: [],
      papers_truncated: false,
    },
    {
      folder_id: '01985f0e-9788-7581-aa0c-000000000004',
      name: 'My publications',
      type: 'default-publications',
      parent_id: null,
      sharing_status: 'not_shared',
      paper_count: 0,
      papers: [],
      papers_truncated: false,
    },
  ],
});
