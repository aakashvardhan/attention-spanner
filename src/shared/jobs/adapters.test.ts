import { describe, expect, it } from 'vitest';
import {
  extractDataPage,
  fromAshby,
  fromGreenhouse,
  fromLever,
  fromWorkdayDetail,
  fromWorkdayList,
  fromRss,
  fromSimplify,
  fromYc,
  parseBoardToken,
  parseWorkdayUrl,
  simplifyPrefilter,
  simplifySponsorship,
  toSimplifyEntries,
  ycMinYears,
  ycSponsors,
} from './adapters';

const NOW = Date.UTC(2026, 7, 12);

/**
 * Real postings, pulled from ycombinator.com/jobs/role/software-engineer and
 * trimmed to the fields the adapter reads. The three `visa` values and the
 * new-grads-ok flag are the ones the scorer's blockers hang off, so they are
 * pinned against actual payloads rather than invented ones.
 */
const YC_PAYLOAD = {
  props: {
    jobPostings: [
      {
        id: 103568,
        title: 'Staff Software Engineer, Product Innovation',
        url: '/companies/lineleap/jobs/rfQYh55-staff-software-engineer-product-innovation',
        applyUrl: 'https://account.ycombinator.com/authenticate?continue=x',
        location: 'San Francisco, CA, US / New York, NY, US',
        type: 'Full-time',
        salaryRange: '$200K - $400K',
        minExperience: 'Any (new grads ok)',
        minSchoolYear: null,
        visa: 'US citizen/visa only',
        skills: [],
        companyName: 'LineLeap',
        companyBatchName: 'S19',
        companyOneLiner: 'LineLeap gets customers to the fun, faster.',
      },
      {
        id: 53317,
        title: 'Senior Software Engineer',
        url: '/companies/banner/jobs/LyBeOy6-senior-software-engineer',
        applyUrl: 'https://account.ycombinator.com/authenticate?continue=y',
        location: 'US / Remote (US)',
        type: 'Full-time',
        minExperience: '6+ years',
        visa: 'US citizenship/visa not required',
        skills: ['MongoDB'],
        companyName: 'Banner',
        companyBatchName: 'S19',
        companyOneLiner: 'Banner makes software for CRE owners',
      },
    ],
  },
};

describe('extractDataPage', () => {
  it('reads the entity-escaped page props out of the attribute', () => {
    const html = `<div id="app" data-page="{&quot;props&quot;:{&quot;jobPostings&quot;:[]}}"></div>`;
    expect(extractDataPage(html)).toEqual({ props: { jobPostings: [] } });
  });

  it('returns null rather than throwing when the page changes shape', () => {
    // YC redesigns are the expected failure here; a run must survive one.
    expect(extractDataPage('<html><body>no inertia here</body></html>')).toBeNull();
    expect(extractDataPage('<div data-page="{not json}"></div>')).toBeNull();
  });
});

describe('ycMinYears', () => {
  it('reads new-grads-ok as an explicit zero, not an absent value', () => {
    // It has to clear the years blocker, not merely fail to trip it.
    expect(ycMinYears('Any (new grads ok)')).toBe(0);
  });

  it('reads a stated bar', () => {
    expect(ycMinYears('6+ years')).toBe(6);
    expect(ycMinYears('1+ years')).toBe(1);
  });
});

describe('ycSponsors', () => {
  it('maps the three verified values', () => {
    expect(ycSponsors('Will sponsor')).toBe(true);
    expect(ycSponsors('US citizen/visa only')).toBe(false);
    expect(ycSponsors('US citizenship/visa not required')).toBeNull();
  });
});

describe('fromYc', () => {
  it('normalizes a real payload', () => {
    const [staff, senior] = fromYc(YC_PAYLOAD, NOW);
    expect(staff.company).toBe('LineLeap');
    expect(staff.url).toBe(
      'https://www.ycombinator.com/companies/lineleap/jobs/rfQYh55-staff-software-engineer-product-innovation',
    );
    expect(staff.locations).toEqual(['San Francisco, CA, US', 'New York, NY, US']);
    expect(senior.locations).toEqual(['US', 'Remote (US)']);
    expect(senior.remote).toBe(true);
    expect(senior.requirements?.skills).toEqual(['MongoDB']);
  });

  it('trusts the title over the eligibility flag for role stage', () => {
    // LineLeap tags a Staff role "Any (new grads ok)". Believing that field
    // would file a staff opening under new-grad.
    const [staff] = fromYc(YC_PAYLOAD, NOW);
    expect(staff.kind).toBe('other');
    expect(staff.requirements?.minYears).toBe(0);
  });

  it('does promote a neutral title that is open to new grads', () => {
    const payload = {
      props: {
        jobPostings: [
          { ...YC_PAYLOAD.props.jobPostings[0], title: 'Software Engineer', companyName: 'Acme' },
        ],
      },
    };
    expect(fromYc(payload, NOW)[0].kind).toBe('new-grad');
  });

  it('leaves postedAt null rather than inventing one from "3 days"', () => {
    expect(fromYc(YC_PAYLOAD, NOW).every((j) => j.postedAt === null)).toBe(true);
  });

  it('gives the same posting the same id across two pulls', () => {
    // What makes YC's rotating sample accumulate instead of pile up.
    const first = fromYc(YC_PAYLOAD, NOW).map((j) => j.id);
    const second = fromYc(YC_PAYLOAD, NOW + 86_400_000).map((j) => j.id);
    expect(second).toEqual(first);
  });

  it('drops a malformed posting instead of throwing', () => {
    const payload = { props: { jobPostings: [{ title: 'No company or url' }, null, 42] } };
    expect(fromYc(payload, NOW)).toEqual([]);
  });
});

describe('fromGreenhouse', () => {
  it('normalizes the verified shape and strips the HTML body', () => {
    const payload = {
      jobs: [
        {
          title: 'Research Engineer, New Grad',
          absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
          location: { name: 'San Francisco' },
          first_published: '2026-08-01T00:00:00Z',
          content: '&lt;p&gt;We need 6+ years of experience.&lt;/p&gt;',
        },
      ],
    };
    const [job] = fromGreenhouse(payload, 'Acme', NOW);
    expect(job.description).toBe('We need 6+ years of experience.');
    expect(job.postedAt).toBe(Date.parse('2026-08-01T00:00:00Z'));
    // Greenhouse ships prose only, so requirements come from the regex pass.
    expect(job.requirements?.minYears).toBe(6);
    expect(job.kind).toBe('research');
  });
});

describe('fromLever', () => {
  it('normalizes the verified array shape', () => {
    const payload = [
      {
        text: 'Software Engineer Intern',
        hostedUrl: 'https://jobs.lever.co/acme/1',
        applyUrl: 'https://jobs.lever.co/acme/1/apply',
        categories: { location: 'London', commitment: 'Intern' },
        workplaceType: 'remote',
        createdAt: 1_760_000_000_000,
        descriptionPlain: 'Join us.',
      },
    ];
    const [job] = fromLever(payload, 'Acme', NOW);
    expect(job.kind).toBe('internship');
    expect(job.remote).toBe(true);
    expect(job.postedAt).toBe(1_760_000_000_000);
    expect(job.applyUrl).toBe('https://jobs.lever.co/acme/1/apply');
  });
});

describe('fromAshby', () => {
  /** Field names verified against api.ashbyhq.com/posting-api/job-board/linear. */
  const posting = {
    title: 'Research Engineer, New Grad',
    jobUrl: 'https://jobs.ashbyhq.com/linear/d3bc1ced',
    applyUrl: 'https://jobs.ashbyhq.com/linear/d3bc1ced/application',
    location: 'Europe',
    isRemote: true,
    isListed: true,
    employmentType: 'FullTime',
    publishedAt: '2021-04-27T20:13:45.158+00:00',
    descriptionPlain: 'Build things.',
  };

  it('normalizes the verified shape', () => {
    const [job] = fromAshby({ jobs: [posting] }, 'Linear', NOW);
    expect(job.title).toBe('Research Engineer, New Grad');
    expect(job.remote).toBe(true);
    expect(job.applyUrl).toBe('https://jobs.ashbyhq.com/linear/d3bc1ced/application');
    expect(job.postedAt).toBe(Date.parse('2021-04-27T20:13:45.158+00:00'));
    expect(job.kind).toBe('research');
  });

  it('drops unlisted postings, which ship in the same array but are not open', () => {
    expect(fromAshby({ jobs: [{ ...posting, isListed: false }] }, 'Linear', NOW)).toEqual([]);
  });
});

describe('fromRss', () => {
  const item = {
    title: 'Postdoctoral Research Associate, Machine Learning',
    link: 'https://jobs.uni.test/12345',
    pubDate: '2026-08-01T00:00:00Z',
    snippet: 'The lab seeks a postdoc. Remote considered.',
    source: 'University Careers',
  };

  it('normalizes a feed entry', () => {
    const [job] = fromRss([item], 'Stanford', NOW);
    expect(job.company).toBe('Stanford');
    expect(job.kind).toBe('research');
    expect(job.remote).toBe(true);
    expect(job.postedAt).toBe(Date.parse('2026-08-01T00:00:00Z'));
  });

  it('falls back to the feed title when the source has no label', () => {
    expect(fromRss([item], '', NOW)[0].company).toBe('University Careers');
  });

  it('leaves requirements null rather than guessing from a snippet', () => {
    // A blocker inferred from two sentences of summary copy is a blocker
    // built on nothing — better to score the job than to grey it out wrongly.
    const guessy = { ...item, snippet: 'Requires 10+ years of experience.' };
    expect(fromRss([guessy], 'Stanford', NOW)[0].requirements).toBeNull();
  });

  it('drops an entry with no link', () => {
    expect(fromRss([{ ...item, link: '' }], 'Stanford', NOW)).toEqual([]);
  });
});

describe('simplify', () => {
  /** A real row from SimplifyJobs/New-Grad-Positions listings.json. */
  const row = {
    source: 'Simplify',
    category: 'AI/ML/Data',
    company_name: 'iSoftStone',
    id: '4282b7bc',
    title: 'Associate AI/ML Developer',
    active: true,
    is_visible: true,
    date_posted: 1781474824,
    url: 'https://jobs.jobvite.com/isoftstone/job/oXrkAfw2',
    locations: ['Seattle, WA', 'Dallas, TX'],
    sponsorship: 'Other',
    degrees: ["Bachelor's", "Master's"],
  };
  const profile = { roleFamilies: [] as string[], kinds: ['new-grad'] };

  it('reads date_posted as seconds, not milliseconds', () => {
    // Left raw this lands in January 1970 and every posting scores zero on
    // freshness — the single most damaging way to get this feed wrong.
    const [job] = fromSimplify(toSimplifyEntries([row]), 'new-grad', NOW);
    expect(job.postedAt).toBe(1781474824 * 1000);
    expect(new Date(job.postedAt!).getUTCFullYear()).toBe(2026);
  });

  it('treats these boards as zero-experience by construction', () => {
    const [job] = fromSimplify(toSimplifyEntries([row]), 'new-grad', NOW);
    expect(job.requirements?.minYears).toBe(0);
    expect(job.kind).toBe('new-grad');
  });

  it('lets a PhD posting in the new-grad feed be research', () => {
    const phd = { ...row, title: 'Data Scientist', degrees: ['PhD'] };
    expect(fromSimplify(toSimplifyEntries([phd]), 'new-grad', NOW)[0].kind).toBe('research');
  });

  it('drops closed and hidden rows — 15k of the 18k are closed', () => {
    const rows = toSimplifyEntries([
      row,
      { ...row, title: 'Closed', active: false },
      { ...row, title: 'Hidden', is_visible: false },
    ]);
    const kept = simplifyPrefilter(rows, profile, NOW, 60, 150);
    expect(kept.map((entry) => entry.title)).toEqual(['Associate AI/ML Developer']);
  });

  it('drops stale rows and caps the rest, newest first', () => {
    const day = 86_400;
    const now = row.date_posted * 1000 + 1000;
    const rows = toSimplifyEntries([
      { ...row, title: 'newest', date_posted: row.date_posted },
      { ...row, title: 'older', date_posted: row.date_posted - 10 * day },
      { ...row, title: 'ancient', date_posted: row.date_posted - 400 * day },
    ]);
    expect(simplifyPrefilter(rows, profile, now, 60, 150).map((e) => e.title)).toEqual([
      'newest',
      'older',
    ]);
    expect(simplifyPrefilter(rows, profile, now, 60, 1).map((e) => e.title)).toEqual(['newest']);
  });

  it('keeps the feed from evicting every other source', () => {
    // ~2,000 rows survive active+recent on the real file; MAX_JOBS is 1,000.
    const rows = toSimplifyEntries(
      Array.from({ length: 2000 }, (_, i) => ({ ...row, title: `Role ${i}`, url: `${row.url}/${i}` })),
    );
    expect(simplifyPrefilter(rows, profile, NOW, 60, 150)).toHaveLength(150);
  });

  it('narrows to the profile role families when set', () => {
    const rows = toSimplifyEntries([row, { ...row, title: 'Backend Engineer', category: 'Software' }]);
    const narrowed = simplifyPrefilter(rows, { roleFamilies: ['ai/ml'], kinds: [] }, NOW, 60, 150);
    expect(narrowed.map((e) => e.title)).toEqual(['Associate AI/ML Developer']);
  });

  it('reads only the sponsorship values that carry signal', () => {
    // 1,971 of 1,972 recent rows say "Other"; reading that as either a yes or
    // a no would invent a blocker out of a placeholder.
    expect(simplifySponsorship('Other')).toEqual({ sponsors: null, requiresCitizenship: false });
    expect(simplifySponsorship('Does Not Offer Sponsorship')).toEqual({
      sponsors: false,
      requiresCitizenship: false,
    });
    expect(simplifySponsorship('U.S. Citizenship is Required')).toEqual({
      sponsors: false,
      requiresCitizenship: true,
    });
  });
});

describe('parseBoardToken', () => {
  it('pulls the token out of a pasted board URL', () => {
    // Verified live: each of these tokens returns a real board.
    expect(parseBoardToken('greenhouse', 'https://job-boards.greenhouse.io/anthropic')).toBe('anthropic');
    expect(parseBoardToken('greenhouse', 'https://boards.greenhouse.io/databricks/jobs/123')).toBe('databricks');
    expect(parseBoardToken('lever', 'https://jobs.lever.co/palantir')).toBe('palantir');
    expect(parseBoardToken('ashby', 'https://jobs.ashbyhq.com/notion/some-role-id')).toBe('notion');
  });

  it('handles the eu shards and trailing slashes', () => {
    expect(parseBoardToken('greenhouse', 'https://boards.eu.greenhouse.io/acme/')).toBe('acme');
    expect(parseBoardToken('lever', 'https://jobs.eu.lever.co/acme')).toBe('acme');
  });

  it('reads the token off a Greenhouse embed link', () => {
    expect(
      parseBoardToken('greenhouse', 'https://boards.greenhouse.io/embed/job_board?for=stripe'),
    ).toBe('stripe');
  });

  it('passes a bare token through', () => {
    expect(parseBoardToken('greenhouse', 'anthropic')).toBe('anthropic');
    expect(parseBoardToken('lever', ' palantir ')).toBe('palantir');
  });

  it('rejects a URL for a different ATS instead of inventing a token', () => {
    // Pasting a Lever link into the Greenhouse row should say so now, rather
    // than saving a token that 404s on the next run.
    expect(parseBoardToken('greenhouse', 'https://jobs.lever.co/palantir')).toBe('');
    expect(parseBoardToken('lever', 'https://example.com/careers')).toBe('');
  });
});

describe('parseWorkdayUrl', () => {
  it('derives the triple from a real careers URL', () => {
    expect(parseWorkdayUrl('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite')).toEqual({
      tenant: 'nvidia',
      host: 'wd5',
      site: 'NVIDIAExternalCareerSite',
    });
  });

  it('skips the optional locale segment', () => {
    expect(
      parseWorkdayUrl('https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/x'),
    ).toEqual({ tenant: 'nvidia', host: 'wd5', site: 'NVIDIAExternalCareerSite' });
  });

  it('rejects anything that is not a Workday board', () => {
    expect(parseWorkdayUrl('https://boards.greenhouse.io/acme')).toBeNull();
    expect(parseWorkdayUrl('https://nvidia.wd5.myworkdayjobs.com/')).toBeNull();
    expect(parseWorkdayUrl('not a url')).toBeNull();
  });
});

describe('workday', () => {
  const listPayload = {
    total: 907,
    jobPostings: [
      {
        title: 'PhD Software Engineering Intern, Decision Intelligence - Fall 2026',
        externalPath: '/job/US-CA-Santa-Clara/PhD-SWE-Intern_JR2017522',
        locationsText: 'US, CA, Santa Clara',
        postedOn: 'Posted 30+ Days Ago',
      },
    ],
  };

  it('reads the list rows', () => {
    expect(fromWorkdayList(listPayload)).toEqual([
      {
        title: 'PhD Software Engineering Intern, Decision Intelligence - Fall 2026',
        externalPath: '/job/US-CA-Santa-Clara/PhD-SWE-Intern_JR2017522',
        locationsText: 'US, CA, Santa Clara',
      },
    ]);
  });

  it('takes the date from startDate, since postedOn is a relative string', () => {
    const [listing] = fromWorkdayList(listPayload);
    const detail = {
      jobPostingInfo: {
        title: listing.title,
        jobDescription: '<p>Build things. Must be a US citizen.</p>',
        location: 'US, CA, Santa Clara',
        postedOn: 'Posted 30+ Days Ago',
        startDate: '2026-05-22',
        externalUrl: 'https://nvidia.wd5.myworkdayjobs.com/x/job/JR2017522',
      },
    };
    const job = fromWorkdayDetail(detail, listing, 'NVIDIA', 'https://fallback.test', NOW);
    expect(job?.postedAt).toBe(Date.parse('2026-05-22'));
    expect(job?.description).toBe('Build things. Must be a US citizen.');
    expect(job?.requirements?.requiresCitizenship).toBe(true);
    expect(job?.kind).toBe('research');
  });

  it('falls back to the listing when the detail is thin', () => {
    const [listing] = fromWorkdayList(listPayload);
    const job = fromWorkdayDetail({}, listing, 'NVIDIA', 'https://fallback.test', NOW);
    expect(job?.title).toBe(listing.title);
    expect(job?.url).toBe('https://fallback.test');
    expect(job?.postedAt).toBeNull();
  });
});
