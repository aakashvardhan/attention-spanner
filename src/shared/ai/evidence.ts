import { calendarContextLines, todayEvents } from '../calendar';
import { localDate } from '../format';
import { dueCounts, newIntroducedToday, totalDue } from '../srs';
import { getLocal, getSettings } from '../storage';
import type { LocalSchema } from '../storage';
import type { AssistantFact, Settings } from '../types';
import { countInWeek, weekKey } from '../week';
import { hash32 } from './cache';
import { gatherLibrary, hitToSource } from './connectors/library';
import { searchLibrary, tokenize, type LibraryHit } from './library';
import type { SourceRef } from './tools';

export type EvidenceDomain =
  | 'tasks'
  | 'streak'
  | 'gym'
  | 'flashcards'
  | 'calendar'
  | 'memory'
  | 'library'
  | 'reading'
  | 'journal'
  | 'feeds'
  | 'time';

export interface EvidenceItem {
  source: SourceRef;
  text: string;
}

export interface EvidenceBundle {
  query: string;
  domains: EvidenceDomain[];
  items: EvidenceItem[];
  /** Prompt-ready evidence. Every line starts with its real source id. */
  context: string;
  sources: SourceRef[];
  /** Changes whenever any included evidence changes. */
  versionHash: string;
  complete: boolean;
  /** Exact local answers bypass generation entirely. */
  exactAnswer?: string;
}

export interface EvidenceData {
  tasks: LocalSchema['tasks'];
  streaks: LocalSchema['streaks'];
  gym: LocalSchema['gym'];
  flashCards: LocalSchema['flashCards'];
  srsDaily: LocalSchema['srsDaily'];
  calendar: LocalSchema['calendar'];
  assistantMemory: LocalSchema['assistantMemory'];
  assistantProfile: LocalSchema['assistantProfile'];
  papers: LocalSchema['papers'];
  readingProgress: LocalSchema['readingProgress'];
  assistantJournal: LocalSchema['assistantJournal'];
  cachedItems: LocalSchema['cachedItems'];
  readItems: LocalSchema['readItems'];
  siteTime: LocalSchema['siteTime'];
  settings: Settings;
  libraryHits?: LibraryHit[];
}

const DOMAIN_RULES: Array<[EvidenceDomain, RegExp]> = [
  ['tasks', /\b(task|tasks|todo|to-do|priority|priorities|need to do|open item)/i],
  ['streak', /\b(streak|read today|reading today|minutes read|sprint)/i],
  ['gym', /\b(gym|workout|lift|training|exercise)/i],
  ['flashcards', /\b(flash ?cards?|anki|review cards?|cards? due|srs)/i],
  ['calendar', /\b(calendar|agenda|schedule|meeting|event|free time|busy|available)/i],
  ['memory', /\b(remember|know about me|about me|preference|advisor|supervisor)/i],
  ['library', /\b(highlight|note|wrote|written|read about|saved|marked|annotat|quote|lecture|recording)/i],
  ['reading', /\b(paper|article|reading|watching|left off|library|research)/i],
  ['journal', /\b(yesterday|plan|planned|journal|brain dump|reflection)/i],
  ['feeds', /\b(feed|unread article|inbox article|rss)/i],
  ['time', /\b(screen time|site time|time on|spent.*(?:site|youtube|web))/i],
];

const QUERY_ALIASES: Record<string, string[]> = {
  advisor: ['supervisor', 'mentor'],
  supervisor: ['advisor', 'mentor'],
  gym: ['workout', 'lift', 'training'],
  workout: ['gym', 'lift', 'training'],
  task: ['todo', 'priority'],
  todo: ['task', 'priority'],
  paper: ['article', 'research', 'reading'],
  article: ['paper', 'reading'],
  remember: ['memory', 'preference'],
};

export function evidenceDomains(query: string): EvidenceDomain[] {
  return DOMAIN_RULES.filter(([, re]) => re.test(query)).map(([domain]) => domain);
}

export function expandEvidenceQuery(query: string): string {
  const words = tokenize(query);
  const expanded = new Set(words);
  for (const word of words) for (const alias of QUERY_ALIASES[word] ?? []) expanded.add(alias);
  return [...expanded].join(' ');
}

function relevantFacts(facts: readonly AssistantFact[], query: string, limit = 8): AssistantFact[] {
  if (
    /\b(?:what|everything)\s+do\s+you\s+(?:remember|know)\s+about\s+me\b|\babout me\b/i.test(
      query,
    )
  ) {
    return [...facts].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }
  const specificQuery = tokenize(query)
    .filter((term) => !['remember', 'memory', 'know', 'preference', 'fact'].includes(term))
    .join(' ');
  const terms = tokenize(expandEvidenceQuery(specificQuery));
  return facts
    .map((fact) => {
      const haystack = new Set(tokenize(fact.text));
      const matches = terms.filter((term) => haystack.has(term)).length;
      return { fact, score: matches / Math.max(1, terms.length) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.fact.updatedAt - a.fact.updatedAt)
    .slice(0, limit)
    .map(({ fact }) => fact);
}

function version(value: unknown): string {
  return hash32(JSON.stringify(value));
}

export function buildEvidenceBundle(
  query: string,
  data: EvidenceData,
  now = new Date(),
): EvidenceBundle {
  const domains = evidenceDomains(query);
  const items: EvidenceItem[] = [];
  const push = (
    source: Omit<SourceRef, 'id' | 'version'> & { version?: string },
    text: string,
  ) => {
    const id = `S${items.length + 1}`;
    items.push({
      source: { ...source, id, version: source.version ?? version(text) },
      text: text.replace(/\s+/g, ' ').trim(),
    });
  };

  const profile = data.assistantProfile.text.trim();
  if (profile) {
    push(
      {
        kind: 'profile',
        title: 'About the user',
        url: '',
        snippet: profile,
        updatedAt: data.assistantProfile.updatedAt,
      },
      profile,
    );
  }

  if (domains.includes('tasks')) {
    const open = data.tasks.filter((task) => task.completedAt === null);
    const terms = tokenize(query);
    const ranked = [...open].sort((a, b) => {
      const score = (task: typeof a) =>
        terms.filter((term) => tokenize(task.text).includes(term)).length;
      return score(b) - score(a) || (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt);
    });
    const shown = ranked.slice(0, 10);
    const text =
      shown.length === 0
        ? 'Open tasks: none.'
        : `Open tasks (${open.length}): ${shown.map((task) => task.text).join('; ')}`;
    push(
      {
        kind: 'task',
        title: 'Open tasks',
        url: '',
        snippet: text,
        updatedAt: Math.max(0, ...open.map((task) => task.updatedAt ?? task.createdAt)),
        version: version(open),
      },
      text,
    );
  }

  if (domains.includes('streak')) {
    const today = data.streaks.daily[localDate(now)];
    const text =
      `Reading streak: ${data.streaks.currentStreak} days; longest ${data.streaks.longestStreak}. ` +
      `Today: ${Math.round(today?.minutes ?? 0)} minutes, ${today?.sprints ?? 0} sprints.`;
    push({ kind: 'metric', title: 'Reading activity', url: '', snippet: text }, text);
  }

  if (domains.includes('gym')) {
    const sessions = countInWeek(data.gym.checkins, weekKey(now));
    const text =
      `Gym: ${sessions}/${data.settings.gymWeeklyTarget} sessions this week; ` +
      `week streak ${data.gym.currentWeekStreak}; longest ${data.gym.longestWeekStreak}.`;
    push({ kind: 'metric', title: 'Gym activity', url: '', snippet: text }, text);
  }

  if (domains.includes('flashcards')) {
    const today = localDate(now);
    const due = totalDue(
      dueCounts(
        data.flashCards,
        now.getTime(),
        newIntroducedToday(data.srsDaily, today),
      ),
    );
    const text = `Flashcards due now: ${due}.`;
    push({ kind: 'metric', title: 'Flashcard queue', url: '', snippet: text }, text);
  }

  if (domains.includes('calendar')) {
    const lines = data.calendar.connected
      ? calendarContextLines(data.calendar.events, now)
      : ['Calendar is not connected.'];
    if (data.calendar.connected && data.calendar.fetchedAt > 0) {
      lines.push(`Calendar last refreshed ${new Date(data.calendar.fetchedAt).toISOString()}.`);
    }
    const events = todayEvents(data.calendar.events, now);
    push(
      {
        kind: 'event',
        title: 'Calendar today',
        url: events.find((event) => event.htmlLink)?.htmlLink ?? '',
        snippet: lines.join(' '),
        updatedAt: data.calendar.fetchedAt,
        version: version({ fetchedAt: data.calendar.fetchedAt, events }),
      },
      lines.join(' '),
    );
  }

  if (domains.includes('memory')) {
    const facts = relevantFacts(data.assistantMemory, query);
    if (facts.length > 0) {
      for (const fact of facts) {
        const dated = `Remembered ${new Date(fact.updatedAt).toISOString().slice(0, 10)}: ${fact.text}`;
        push(
          {
            kind: 'memory',
            title: 'Remembered fact',
            url: '',
            snippet: fact.text,
            updatedAt: fact.updatedAt,
          },
          dated,
        );
      }
    }
  }

  if (domains.includes('library')) {
    for (const hit of data.libraryHits ?? []) {
      const source = hitToSource(hit);
      push(
        {
          ...source,
          updatedAt: hit.at,
          version: version({ id: hit.id, at: hit.at, text: hit.text }),
        },
        `${hit.kind} “${hit.title}”: ${hit.text.slice(0, 360)}`,
      );
    }
  }

  if (domains.includes('reading')) {
    const reading = data.papers.filter((paper) => paper.status === 'reading').slice(0, 5);
    const text =
      reading.length === 0
        ? 'No papers are currently marked reading.'
        : `Currently reading: ${reading
            .map((paper) => `${paper.title} (${paper.progressPercent}%)`)
            .join('; ')}`;
    push({ kind: 'paper', title: 'Reading list', url: reading[0]?.url ?? '', snippet: text }, text);
  }

  if (domains.includes('journal')) {
    const days = Object.values(data.assistantJournal)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 3);
    for (const day of days) {
      const priorities = day.plan?.priorities.map((item) => item.text).join('; ') || 'No saved priorities';
      push(
        {
          kind: 'journal',
          title: `Journal ${day.date}`,
          url: '',
          snippet: priorities,
          updatedAt: day.plan?.reviewedAt || day.plan?.generatedAt || 0,
        },
        `${day.date}: ${priorities}`,
      );
    }
  }

  if (domains.includes('feeds')) {
    const unread = data.cachedItems.filter((item) => !data.readItems.includes(item.id));
    const text =
      unread.length === 0
        ? 'Unread articles: none.'
        : `Unread articles (${unread.length}): ${unread.slice(0, 5).map((item) => item.title).join('; ')}`;
    push({ kind: 'metric', title: 'Unread articles', url: unread[0]?.link ?? '', snippet: text }, text);
  }

  if (domains.includes('time')) {
    const hosts =
      data.siteTime.date === localDate(now)
        ? Object.entries(data.siteTime.hosts).sort(([, a], [, b]) => b - a).slice(0, 8)
        : [];
    const text =
      hosts.length === 0
        ? 'No tracked site time today.'
        : `Tracked site time today: ${hosts
            .map(([host, seconds]) => `${host} ${Math.round(seconds / 60)} minutes`)
            .join('; ')}`;
    push({ kind: 'metric', title: 'Tracked site time', url: '', snippet: text }, text);
  }

  let exactAnswer: string | undefined;
  if (domains.length === 1) {
    const domain = domains[0];
    const evidence = items.filter((item) => item.source.kind !== 'profile');
    if (domain === 'tasks' && /\b(how many|count)\b/i.test(query)) {
      const count = data.tasks.filter((task) => task.completedAt === null).length;
      exactAnswer = `You have ${count} open task${count === 1 ? '' : 's'}.`;
    } else if (domain === 'tasks' && /\b(what|list|show).*\b(tasks?|todo|priorit)/i.test(query)) {
      const open = data.tasks.filter((task) => task.completedAt === null);
      exactAnswer =
        open.length === 0
          ? 'You have no open tasks.'
          : open.slice(0, 10).map((task) => `- ${task.text}`).join('\n');
    } else if (domain === 'streak') {
      exactAnswer = evidence[0]?.text;
    } else if (domain === 'gym') {
      exactAnswer = evidence[0]?.text;
    } else if (domain === 'flashcards') {
      exactAnswer = evidence[0]?.text;
    } else if (domain === 'calendar' && /\b(today|agenda|calendar)\b/i.test(query)) {
      exactAnswer = evidence[0]?.text;
    } else if (
      domain === 'memory' &&
      /\b(?:what|everything)\s+do\s+you\s+(?:remember|know)\s+about\s+me\b/i.test(query)
    ) {
      const facts = relevantFacts(data.assistantMemory, query);
      exactAnswer =
        facts.length === 0
          ? "I don't have any remembered facts about you yet."
          : facts.map((fact) => `- ${fact.text}`).join('\n');
    }
  }

  const context = items.map((item) => `[${item.source.id}] ${item.text}`).join('\n');
  const versionHash = hash32(
    JSON.stringify(items.map(({ source, text }) => [source.id, source.version, text])),
  );
  return {
    query,
    domains,
    items,
    context,
    sources: items.map((item) => item.source),
    versionHash,
    complete: domains.length > 0 && items.some((item) => item.source.kind !== 'profile'),
    ...(exactAnswer ? { exactAnswer } : {}),
  };
}

export async function gatherEvidence(query: string, now = new Date()): Promise<EvidenceBundle> {
  const domains = evidenceDomains(query);
  const [stored, settings, libraryHits] = await Promise.all([
    getLocal(
      'tasks',
      'streaks',
      'gym',
      'flashCards',
      'srsDaily',
      'calendar',
      'assistantMemory',
      'assistantProfile',
      'papers',
      'readingProgress',
      'assistantJournal',
      'cachedItems',
      'readItems',
      'siteTime',
    ),
    getSettings(),
    domains.includes('library')
      ? gatherLibrary().then((docs) => searchLibrary(docs, expandEvidenceQuery(query), 5))
      : Promise.resolve([]),
  ]);
  return buildEvidenceBundle(query, { ...stored, settings, libraryHits }, now);
}
