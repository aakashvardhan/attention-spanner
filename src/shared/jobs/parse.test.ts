import { describe, expect, it } from 'vitest';
import {
  jobId,
  jobKindFromTitle,
  parseCitizenship,
  parseMinYears,
  parseSponsorship,
  requirementsFromText,
  stripHtml,
  unescapeHtml,
} from './parse';

describe('unescapeHtml', () => {
  it('decodes the entities job payloads actually carry', () => {
    expect(unescapeHtml('R&amp;D &quot;team&quot; &lt;here&gt;')).toBe('R&D "team" <here>');
    expect(unescapeHtml('caf&#233;')).toBe('café');
  });

  it('decodes &amp; last so a double-escaped entity survives', () => {
    // "&amp;lt;" is an escaped "&lt;" — one pass must yield "&lt;", not "<".
    expect(unescapeHtml('&amp;lt;')).toBe('&lt;');
  });
});

describe('stripHtml', () => {
  it('turns block tags into breaks and drops script bodies', () => {
    const html = '<div><h2>Role</h2><p>Build things.</p><script>evil()</script><ul><li>Ship</li></ul></div>';
    expect(stripHtml(html)).toBe('Role\nBuild things.\nShip');
  });

  it('decodes markup that arrived entity-escaped (the Greenhouse shape)', () => {
    expect(stripHtml('&lt;p&gt;Build things.&lt;/p&gt;')).toBe('Build things.');
  });

  it('does not decode escaped angle brackets inside live HTML', () => {
    // Decoding first would turn "a &lt; b then c &gt; d" into a span the tag
    // stripper eats, silently deleting a line of the description.
    expect(stripHtml('<p>Loop while a &lt; b then c &gt; d</p>')).toBe('Loop while a < b then c > d');
  });
});

describe('parseMinYears', () => {
  it('reads a stated requirement', () => {
    expect(parseMinYears('5+ years of experience with Go')).toBe(5);
    expect(parseMinYears('At least 3 years building distributed systems')).toBe(3);
    expect(parseMinYears('Minimum of 2 years professional experience')).toBe(2);
    expect(parseMinYears('3-5 years of relevant experience')).toBe(3);
    expect(parseMinYears('7 or more years of industry experience')).toBe(7);
  });

  it('ignores years that are not a requirement', () => {
    // The near-misses that would otherwise grey out a perfectly open job.
    expect(parseMinYears('We were founded 5 years ago')).toBeNull();
    expect(parseMinYears('Our runway is 3 years')).toBeNull();
    expect(parseMinYears('Over the past 10 years the team has shipped')).toBeNull();
  });

  it('reads the lowest bar when a posting states several', () => {
    // Reading this at 8 would block a role that is genuinely open to juniors.
    expect(
      parseMinYears('2+ years of experience in backend. 8+ years of experience leading teams.'),
    ).toBe(2);
  });

  it('returns null when the posting says nothing', () => {
    expect(parseMinYears('We are hiring a software engineer.')).toBeNull();
  });
});

describe('parseSponsorship', () => {
  it('detects a refusal before it detects the word sponsor', () => {
    expect(parseSponsorship('We will not provide visa sponsorship')).toBe(false);
    expect(parseSponsorship('Unable to sponsor at this time')).toBe(false);
    expect(parseSponsorship('No visa sponsorship is available')).toBe(false);
  });

  it('detects an offer', () => {
    expect(parseSponsorship('We will sponsor qualified candidates')).toBe(true);
    expect(parseSponsorship('Visa sponsorship available')).toBe(true);
  });

  it('is null when the posting is silent', () => {
    expect(parseSponsorship('Great team, hard problems.')).toBeNull();
  });
});

describe('parseCitizenship', () => {
  it('detects a real demand', () => {
    expect(parseCitizenship('Must be a US citizen')).toBe(true);
    expect(parseCitizenship('Active security clearance required')).toBe(true);
  });

  it('does not fire on an explicit disclaimer', () => {
    // YC ships exactly this string as a *good* signal.
    expect(parseCitizenship('US citizenship/visa not required')).toBe(false);
    expect(parseCitizenship('Citizenship is not required for this role')).toBe(false);
  });
});

describe('jobKindFromTitle', () => {
  it('buckets by title', () => {
    expect(jobKindFromTitle('Software Engineer, New Grad')).toBe('new-grad');
    expect(jobKindFromTitle('Summer 2027 Software Engineering Intern')).toBe('internship');
    expect(jobKindFromTitle('Senior Staff Engineer')).toBe('other');
  });

  it('prefers research over intern', () => {
    // A research internship is the research pipeline, which is the filter
    // that actually matters here.
    expect(jobKindFromTitle('Applied Deep Learning PhD Research Intern')).toBe('research');
  });
});

describe('jobId', () => {
  it('is stable across refetches of the same posting', () => {
    const a = jobId('Anthropic', 'Research Engineer', 'https://x.test/job/1');
    const b = jobId('Anthropic', 'Research Engineer', 'https://x.test/job/1');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('separates postings that differ in any field', () => {
    const ids = new Set([
      jobId('A', 'Engineer', 'https://x.test/1'),
      jobId('A', 'Engineer', 'https://x.test/2'),
      jobId('B', 'Engineer', 'https://x.test/1'),
      jobId('A', 'Scientist', 'https://x.test/1'),
    ]);
    expect(ids.size).toBe(4);
  });

  it('does not collide when the same words split differently across fields', () => {
    // The separator bug generateItemId documents: ("ab","c") vs ("a","bc").
    expect(jobId('Acme Labs', 'Engineer', 'https://x.test/1')).not.toBe(
      jobId('Acme', 'Labs Engineer', 'https://x.test/1'),
    );
  });
});

describe('requirementsFromText', () => {
  it('folds the individual parsers into one record', () => {
    const req = requirementsFromText(
      'We need 4+ years of experience. We will not sponsor visas. Must be a US citizen.',
    );
    expect(req).toEqual({
      skills: [],
      minYears: 4,
      sponsors: false,
      requiresCitizenship: true,
      mustHaves: [],
    });
  });
});
