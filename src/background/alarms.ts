/**
 * Alarms belonging to features that have been cut. An alarm outlives the code
 * that created it: it survives updates and keeps waking the service worker to
 * hit a `switch` with no matching case. Cleared by literal name on purpose.
 */
const RETIRED_ALARMS = [
  'daily-brain-dump-midnight',
  'refresh-jobs',
  'task-reminders',
  'sprint-end',
  'gym-reminder',
  'gym-reminder-snooze',
  'calendar-refresh',
  'monitor-evening',
  'monitor-calendar',
  'gmail-triage',
  // v27: papers library (feeds and Pomodoro)
  'refresh-feeds',
  'focus-phase-end',
  'focus-badge-tick',
];

export async function clearRetiredAlarms(): Promise<void> {
  for (const name of RETIRED_ALARMS) await chrome.alarms.clear(name);
  // Automations were one alarm per rule and nudges one per article, named by
  // id: clear the whole family.
  const existing = await chrome.alarms.getAll();
  await Promise.all(
    existing
      .filter((a) => a.name.startsWith('automation|') || a.name.startsWith('nudge|'))
      .map((a) => chrome.alarms.clear(a.name)),
  );
}
