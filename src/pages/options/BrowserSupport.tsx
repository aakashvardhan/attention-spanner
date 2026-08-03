import { useEffect, useState } from 'react';
import { getAvailability, type AiAvailability } from '../../shared/ai/brainDump';
import { sttAvailability } from '../../shared/ai/stt';
import { detectCapabilities, type Capabilities } from '../../shared/capabilities';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { DEFAULT_SETTINGS } from '../../shared/storage';

/**
 * What this browser can and cannot do, and what happens instead.
 *
 * Chromium is not one browser. Brave keeps the extension APIs but strips the
 * Google-backed platform features behind them — no Web Speech API, no Gemini
 * Nano — and every one of those gaps used to fail to nothing: a wake word that
 * never armed, a mic button that never rendered, an on-device model that was
 * simply absent. A user cannot fix, or even name, a feature that fails silently.
 * This is where they find out.
 */

type Support = {
  label: string;
  /** true = working as designed, false = degraded or off */
  ok: boolean;
  detail: string;
};

function nanoDetail(nano: AiAvailability, promptApi: boolean, isBrave: boolean): string {
  if (!promptApi) {
    return isBrave
      ? "Brave does not ship Chrome's built-in model. Questions go to your cloud API key instead, so voice and chat need one set above."
      : 'Not present in this browser. Questions go to your cloud API key instead.';
  }
  if (nano === 'available') return 'Ready. Short questions run on-device and stay on your machine.';
  if (nano === 'downloadable' || nano === 'downloading') {
    return 'Supported, but the model still has to download. Ask a question from the dashboard to start it.';
  }
  return 'Present but unavailable — this device may not meet the hardware requirements.';
}

export function BrowserSupport() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [nano, setNano] = useState<AiAvailability>('unavailable');
  const [stored] = useStorageValue('settings');
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  useEffect(() => {
    setCaps(detectCapabilities());
    void getAvailability().then(setNano).catch(() => undefined);
  }, []);

  if (!caps) return null;
  const stt = sttAvailability(settings.geminiApiKey.length > 0);

  const rows: Support[] = [
    {
      label: 'Voice input',
      ok: stt.usable,
      detail: !stt.usable
        ? stt.reason
        : stt.cloud
          ? `No built-in speech recognition${caps.isBrave ? ' in Brave' : ''}, so held-to-talk audio is recorded and transcribed by Gemini instead. It leaves your machine, and it uses your API quota.`
          : "Uses the browser's built-in speech recognition, which sends audio to Google.",
    },
    {
      label: 'On-device model',
      ok: caps.promptApi && nano === 'available',
      detail: nanoDetail(nano, caps.promptApi, caps.isBrave),
    },
    {
      label: 'Spoken replies',
      ok: caps.speechSynthesis,
      detail: caps.speechSynthesis
        ? 'Available — replies can be read aloud by the browser.'
        : 'Unavailable — replies will arrive as text only.',
    },
  ];

  return (
    <>
      <h3 className="cap-heading">This browser{caps.isBrave ? ' (Brave)' : ''}</h3>
      <ul className="cap-list">
        {rows.map((row) => (
          <li key={row.label} className="cap-row">
            <span className={row.ok ? 'cap-dot ok' : 'cap-dot off'} aria-hidden="true" />
            <div>
              <span className="cap-label">{row.label}</span>
              <p className="cap-detail">{row.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
