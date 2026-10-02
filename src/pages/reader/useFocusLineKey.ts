import { useEffect } from 'react';
import { useSettings } from '../../shared/hooks/useSettings';
import { isTypingTarget } from '../../shared/keys';
import { patchSettings } from '../../shared/storage';

/** The focus line setting, toggled with F anywhere in the reader except text fields. */
export function useFocusLineKey(): boolean {
  const [settings] = useSettings();
  const on = settings.readerFocusLine;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      e.preventDefault();
      void patchSettings({ readerFocusLine: !on });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [on]);
  return on;
}
