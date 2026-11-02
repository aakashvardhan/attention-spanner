import { sendMessage } from '../messages';
import { useStorageValue } from './useStorageValue';

/** Live reading-session state: blocking is on while a reader tab is open. */
export function useFocusSession() {
  const [session] = useStorageValue('focusSession');
  return {
    session,
    reading: !!session && session.tabIds.length > 0,
    title: session?.title ?? '',
    backToPaper: () => sendMessage({ type: 'FOCUS_READER' }),
  };
}
