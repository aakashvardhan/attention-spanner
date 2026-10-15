/** Local calendar date, YYYY-MM-DD: daily notes and report names follow the user's own day. */
export const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Built by hand, not with toLocaleDateString, so Chrome and Node always agree. */
export const dailyHeading = (d: Date): string => `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
export const dailyPath = (d: Date): string => `daily/${ymd(d)}.md`;
/** A new daily note holds only its date heading (spec, Daily note). */
export const dailyText = (d: Date): string => `# ${dailyHeading(d)}\n`;
