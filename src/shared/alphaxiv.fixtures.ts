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

/** get_hot_feed { limit: 3 } */
export const HOT_FEED = '{"papers":[{"universal_paper_id":"2610.39302"},{"universal_paper_id":"2610.40564"},{"universal_paper_id":"2610.40636"}]}';

/** get_for_you_feed { limit: 3 } */
export const FOR_YOU_FEED = '{"papers":[{"universal_paper_id":"2610.37381"},{"universal_paper_id":"2610.28480"},{"universal_paper_id":"2609.24972"}]}';

/** The authorization server's metadata (/.well-known/oauth-authorization-server/auth), trimmed to what we use. */
export const AUTH_METADATA = {
  issuer: 'https://api.alphaxiv.org/auth',
  authorization_endpoint: 'https://api.alphaxiv.org/auth/oauth2/authorize',
  token_endpoint: 'https://api.alphaxiv.org/auth/oauth2/token',
  registration_endpoint: 'https://api.alphaxiv.org/auth/oauth2/register',
  userinfo_endpoint: 'https://api.alphaxiv.org/auth/oauth2/userinfo',
  revocation_endpoint: 'https://api.alphaxiv.org/auth/oauth2/revoke',
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
  scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
};

/** POST /auth/oauth2/register for a chromiumapp.org redirect (client id changed). */
export const REGISTER_REPLY = {
  client_id: 'e2eClientIdAAAAAAAAAAAAAAAAAAAAA',
  scope: 'openid profile email offline_access',
  client_name: 'ADHD Reader',
  redirect_uris: ['https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/alphaxiv'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  public: true,
  disabled: false,
};
