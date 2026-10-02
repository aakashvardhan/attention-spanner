import { localDate } from '../../shared/format';

/**
 * One line a day, bundled rather than fetched. An API would be a network round
 * trip, a failure state and a dependency for forty strings that never change.
 *
 * Chosen to be useful at the moment a new tab opens — mostly about starting,
 * finishing, and the gap between them. Nothing that scolds.
 */
export const QUOTES: readonly string[] = [
  'Start where you are. Use what you have. Do what you can.',
  'The work is the only thing that makes the work less frightening.',
  'You do not have to see the whole staircase. Just the first step.',
  'Done is a decision, not a feeling.',
  'Amateurs sit and wait for inspiration. The rest of us just get up and go to work.',
  'A finished draft beats a perfect plan.',
  'The secret of getting ahead is getting started.',
  'Small daily improvements are what stack into staggering results.',
  'You can do anything, but not everything.',
  'Action is the antidote to anxiety.',
  'Focus is saying no to a hundred other good ideas.',
  'It always seems impossible until it is done.',
  'Order your thoughts by writing them down. The page is patient.',
  'One thing at a time. Most things, not at all.',
  'The best time to plant a tree was twenty years ago. The second best time is now.',
  'Motivation follows action far more reliably than it precedes it.',
  'Progress, not perfection.',
  'What you do every day matters more than what you do once in a while.',
  'A problem well stated is a problem half solved.',
  'Slow is smooth, and smooth is fast.',
  'Do the hard thing first, while the day is still on your side.',
  'You are not behind. You are just here.',
  'Attention is the rarest form of generosity.',
  'Simplicity is the ultimate sophistication.',
  'Begin badly. Edit later.',
  'The obstacle is the way.',
  'Twenty minutes of the real work beats a morning of arranging it.',
  'You will never find time for anything. You must make it.',
  'Stopping at a good place is how tomorrow starts easily.',
  'Clarity comes from engagement, not thought.',
  'Whatever you can do, or dream you can, begin it.',
  'Rest is part of the work, not a reward for it.',
  'Consistency compounds. Intensity does not.',
  'The scariest moment is always just before you start.',
  'Do not confuse motion with progress.',
  'Nothing is particularly hard if you divide it into small jobs.',
  'A bad day for your ego is a good day for your soul.',
  'Close the tabs you are not reading.',
  'Finish something today, even if it is small.',
  'Tomorrow you will wish you had started today.',
];

/**
 * The day's quote, derived rather than stored — the same local date always maps
 * to the same line, so it holds steady across every new tab you open until
 * midnight and costs nothing to persist.
 */
export function quoteOfDay(date = localDate()): string {
  // Parsed as UTC rather than local midnight so the index cannot repeat or skip
  // a day when the clocks change — a 25-hour local day would otherwise share a
  // quote with its neighbour.
  const parsed = Date.parse(`${date}T00:00:00Z`);
  // An unparseable date yields NaN, and NaN survives both the modulo and the
  // array index to come back as undefined — a blank line on the new tab. Day
  // zero is an arbitrary but valid answer, which is the point.
  const days = Number.isFinite(parsed) ? Math.floor(parsed / 86_400_000) : 0;
  // The double modulo keeps the index positive for pre-1970 dates.
  return QUOTES[((days % QUOTES.length) + QUOTES.length) % QUOTES.length];
}
