# Motion: Apple-style springs across the extension

Date: 2026-10-03 · Branch: `pixel-walk` · Status: approved in brainstorming, awaiting spec review

## Intent

Bring the feel of the "Opus 5.5 Motion Graphics" reel into the extension, using
Apple-style physical springs (SwiftUI `response` / `dampingFraction`), on real UI
that already exists. Motion stays calm: this is an ADHD reader, so bounce is
reserved for things appearing, durations are short, and Reduce Motion turns it
all off.

Three groups of effects from the reel ship in this pass:

| Reel example | Lands on |
| --- | --- |
| 05 Chart morph, 07 Spring stack | the new-tab entrance and the reading meters |
| 02 Search → results, 04 Tabs → panels | Papers recall search, the Options section index |
| 09 Masked type, 10 Elastic type | the masthead's edition name |

Out of scope: Card → reader (see "Dropped"), the other ten examples (no natural home here), a JS animation
library, velocity-preserving interruption.

## Constraints

- **No new dependencies.** CSS `linear()` springs (Chrome 113+) cover everything.
- **Design-system lint** (`src/shared/designSystem.test.ts`) must stay green. It
  does not check easing, so spring tokens live in `theme.css` like `--ease-out`.
- **Display face is `ui-serif`** (New York on macOS, Georgia elsewhere). New York
  has a variable weight axis and no width axis, so "elastic type" is a weight
  wave; on Georgia it degrades to a plain hover.
- **Reduce Motion** disables every new animation and the view transition.

## 1. Spring tokens

`src/shared/theme.css` gains, beside `--ease-out` / `--ease-spring`:

| Token | response | dampingFraction | Use |
| --- | --- | --- | --- |
| `--spring-smooth` + `--dur-smooth` | 0.35 | 1.0 | things that move or resize; never overshoots |
| `--spring-snappy` + `--dur-snappy` | 0.30 | 0.85 | indicators, rows arriving |
| `--spring-bouncy` + `--dur-bouncy` | 0.40 | 0.70 | things appearing only (meters filling) |

Each easing is a `linear()` curve. Each duration is the time the spring takes to
settle within 0.1% of its target.

`src/shared/springs.test.ts` solves the damped harmonic oscillator for each
(response, dampingFraction) pair, samples 33 points into a `linear()` curve, and
asserts the tokens in `theme.css` equal its output. To retune a spring, change
its row in the test and paste the expected value from the failure. It also
asserts `smooth` never exceeds 1 and `bouncy` visibly does.

## 2. Spring stack + chart (new tab)

`src/pages/newtab/newtab.css`:

- `edition-rise` keeps its 8px rise, adds `scale(0.98)` at the start, and runs
  on `--spring-snappy` / `--dur-snappy`. The 0 / 60 / 120 ms stagger stays.
- `.relay-row-meter > span` fills (`edition-grow`) on `--spring-bouncy`: it
  overshoots slightly and settles. The existing 360 ms delay stays.
- `.nw-meter > span` width transition moves to `--spring-smooth`.

## 3. Masthead type

`src/pages/newtab/Hero.tsx` + `newtab.css`:

- **Masked rise.** `.edition-name` is wrapped in a line with `overflow: clip`;
  the text animates from `translateY(100%)` to 0 on `--spring-smooth`, so it
  rises through the mask on load.
- **Weight wave on hover.** The name renders one `aria-hidden` span per letter,
  each with `--i`; the `h1` carries `aria-label` with the full name, so screen
  readers read it as one word. On hover, letters move to a heavier weight with
  a `calc(var(--i) * 20ms)` stagger, on `--spring-snappy`. Weight 900 is outside
  the lint's 400/700 rule, so that one line carries `ds-exempt:` (2 of 12 used).
  Under Reduce Motion, no transition and no rise.

## 4. Tabs → panels (Options index)

`src/pages/options/SectionIndex.tsx` + `options.css`:

- One indicator bar inside `.colophon-index`. The existing scroll effect, after
  computing `active`, writes the active link's `offsetTop` and `offsetHeight`
  into `--indicator-y` and `--indicator-h` on the nav.
- The bar uses `transform: translateY(var(--indicator-y))` and
  `height: var(--indicator-h)`, transitioned on `--spring-snappy`.

## 5. Search → results (Papers recall)

`src/pages/papers/components/RecallSearch.tsx` + `papers.css`:

- Each result `li` gets `style={{ '--i': index }}` and animates in (fade + 8px
  rise) with `calc(var(--i) * 30ms)` delay on `--spring-snappy`.
- Keys carry the search's id, so a second search re-animates its rows.
- No panel-height animation: `interpolate-size` only animates between a length
  and `auto`, and content growing under `height: auto` never changes the
  computed value, so nothing would transition.

## Dropped: Card → reader

Cut after spec review. Every story opens somewhere the morph cannot reach: Continue
articles resume on the original site, arXiv papers go to alphaXiv, and sidebar
feed items open as the original page (`TriageCard.tsx` sends `readerView: false,
original: true`). Only non-arXiv PDFs and Alt-clicks land in the extension reader,
too few to justify changing every story to open in place. Opening behavior is
unchanged.

## Reduced motion

`newtab.css` and `options.css` extend their `@media (prefers-reduced-motion:
reduce)` blocks with every selector this spec animates; `papers.css` gets one.

## Testing

- `scripts/springs.test.ts`: curve endpoints and overshoot (section 1).
- `designSystem.test.ts` stays green.
- `/verify`: screenshot each surface mid-animation and at rest, with Reduce
  Motion off and on.

## Risks

- Chrome may render `ui-serif` as a static New York, in which case the weight
  wave snaps instead of easing. Checked in `/verify`; fallback is a 4px
  `translateY` wave with no weight change.
- `linear()` springs restart rather than carry velocity when interrupted;
  invisible at these durations, noticeable only on rapid re-hovers of the
  masthead.
