import { useEffect, useState } from 'react';
import { testGeminiKey } from '../../shared/ai/geminiProvider';
import { listVoices } from '../../shared/ai/tts';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';
import { DEFAULT_SETTINGS, patchSettings } from '../../shared/storage';
import type { AssistantAutomation, AssistantSkill, AutomationSchedule } from '../../shared/types';

type Test = { state: 'idle' } | { state: 'testing' } | { state: 'ok' } | { state: 'error'; message: string };

type Mic = { state: 'unknown' } | { state: 'granted' } | { state: 'denied' };

export function AssistantSection() {
  const [stored] = useStorageValue('settings');
  const [memory] = useStorageValue('assistantMemory');
  const [skills] = useStorageValue('assistantSkills');
  const [automations] = useStorageValue('assistantAutomations');
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  const hasKey = settings.geminiApiKey.length > 0;
  const [keyInput, setKeyInput] = useState('');
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<Test>({ state: 'idle' });
  const [mic, setMic] = useState<Mic>({ state: 'unknown' });
  const [voices, setVoices] = useState<{ name: string; lang: string }[]>([]);

  useEffect(() => {
    void navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (status.state === 'granted') setMic({ state: 'granted' });
        else if (status.state === 'denied') setMic({ state: 'denied' });
      })
      .catch(() => undefined);
    void listVoices().then((list) =>
      setVoices(list.map((v) => ({ name: v.name, lang: v.lang }))),
    );
  }, []);

  const grantMic = async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      setMic({ state: 'granted' });
      return true;
    } catch {
      setMic({ state: 'denied' });
      return false;
    }
  };

  const toggleWakeWord = async (on: boolean) => {
    // The offscreen listener is useless without the mic — sort that out first
    if (on && mic.state !== 'granted' && !(await grantMic())) return;
    await patchSettings({ assistantWakeWordEnabled: on });
  };

  const keyToTest = keyInput.trim() || settings.geminiApiKey;

  const save = async () => {
    if (!keyInput.trim()) return;
    await patchSettings({ geminiApiKey: keyInput.trim() });
    setKeyInput('');
    setSaved(true);
    setTest({ state: 'idle' });
  };

  const removeKey = async () => {
    await patchSettings({ geminiApiKey: '' });
    setSaved(false);
    setTest({ state: 'idle' });
  };

  const runTest = async () => {
    if (!keyToTest) return;
    setTest({ state: 'testing' });
    const res = await testGeminiKey(keyToTest);
    setTest(res.ok ? { state: 'ok' } : { state: 'error', message: res.error ?? 'Key test failed.' });
  };

  return (
    <section className="section">
      <h2>Assistant</h2>
      <p className="hint">
        The assistant answers questions about your data and runs actions (add tasks, start focus
        sessions…) from the dashboard. It runs on Chrome's built-in on-device Gemini Nano —
        nothing leaves your machine.
      </p>
      <div className="setting-row">
        <label htmlFor="assistant-enabled">Enable assistant</label>
        <input
          id="assistant-enabled"
          type="checkbox"
          checked={settings.assistantEnabled}
          onChange={(e) => void patchSettings({ assistantEnabled: e.target.checked })}
        />
      </div>

      <p className="hint">
        Optional: a Gemini API key (free tier at aistudio.google.com) lets the assistant handle
        long pages and harder questions in the cloud when the on-device model can't. The key is
        stored locally in this browser only and is never synced.
      </p>
      <form
        className="add-feed-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <input
          type="password"
          value={keyInput}
          onChange={(e) => {
            setKeyInput(e.target.value);
            setSaved(false);
            setTest({ state: 'idle' });
          }}
          placeholder={hasKey ? 'Key saved — paste to replace' : 'Paste your Gemini API key'}
        />
        <button type="submit" disabled={!keyInput.trim()}>
          Save key
        </button>
      </form>

      {saved && <p className="feedback success">API key saved.</p>}

      {(hasKey || keyInput.trim()) && (
        <div className="button-group" style={{ marginTop: 10 }}>
          <button
            type="button"
            className="secondary-btn"
            disabled={!keyToTest || test.state === 'testing'}
            onClick={() => void runTest()}
          >
            {test.state === 'testing' ? 'Testing…' : 'Test key'}
          </button>
          {hasKey && (
            <button type="button" className="secondary-btn" onClick={() => void removeKey()}>
              Remove key
            </button>
          )}
        </div>
      )}

      {test.state === 'ok' && <p className="feedback success">Key works ✔ — cloud fallback is on.</p>}
      {test.state === 'error' && <p className="feedback error">{test.message}</p>}

      <p className="hint" style={{ marginTop: 16 }}>
        Voice: hold the 🎙 button in the assistant to talk instead of typing (uses Chrome's speech
        recognition, which sends audio to Google), and have replies read aloud.
      </p>
      <div className="setting-row">
        <label>Microphone for voice input</label>
        {mic.state === 'granted' ? (
          <span className="feedback success" style={{ margin: 0 }}>
            Granted ✔
          </span>
        ) : (
          <button type="button" className="secondary-btn" onClick={() => void grantMic()}>
            {mic.state === 'denied' ? 'Blocked — try again' : 'Enable microphone'}
          </button>
        )}
      </div>
      {mic.state === 'denied' && (
        <p className="feedback error">
          Chrome blocked the microphone for this extension. Click the mic icon in the address bar
          (or Site settings) to allow it, then retry.
        </p>
      )}
      <div className="setting-row">
        <label htmlFor="assistant-voice">Speak replies aloud</label>
        <input
          id="assistant-voice"
          type="checkbox"
          checked={settings.assistantVoiceEnabled}
          onChange={(e) => void patchSettings({ assistantVoiceEnabled: e.target.checked })}
        />
      </div>
      <div className="setting-row">
        <label htmlFor="assistant-wake">“Hey Jarvis” wake word</label>
        <input
          id="assistant-wake"
          type="checkbox"
          checked={settings.assistantWakeWordEnabled}
          onChange={(e) => void toggleWakeWord(e.target.checked)}
        />
      </div>
      {settings.assistantWakeWordEnabled && (
        <p className="hint">
          Jarvis listens for “hey Jarvis” whenever Chrome is running: the microphone stays open
          and audio streams to Google's speech service while this is on. Say the wake word, then
          your request — the reply is spoken aloud and lands in the assistant chat.
        </p>
      )}
      {settings.assistantVoiceEnabled && voices.length > 0 && (
        <div className="setting-row">
          <label htmlFor="assistant-tts-voice">Voice</label>
          <select
            id="assistant-tts-voice"
            value={settings.assistantTtsVoice}
            onChange={(e) => void patchSettings({ assistantTtsVoice: e.target.value })}
          >
            <option value="">System default</option>
            {voices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </div>
      )}

      <h3 style={{ marginTop: 20 }}>Memory</h3>
      <p className="hint">
        Facts you asked the assistant to remember (“remember I lift Mon/Wed/Fri”). They shape its
        answers and morning briefing, and stay on this device only.
      </p>
      {(memory ?? []).length === 0 ? (
        <p className="empty-message">Nothing remembered yet.</p>
      ) : (
        <>
          <div className="feeds-list">
            {(memory ?? []).map((fact) => (
              <div key={fact.id} className="feed-entry">
                <span className="feed-entry-url" style={{ whiteSpace: 'normal' }}>
                  {fact.text}
                </span>
                <button
                  type="button"
                  className="remove-feed-btn"
                  aria-label={`Forget "${fact.text}"`}
                  onClick={() => void sendMessage({ type: 'MEMORY_DELETE', id: fact.id })}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="secondary-btn"
            style={{ marginTop: 10 }}
            onClick={() =>
              void (async () => {
                // Sequential — parallel deletes would race the worker's read-modify-write
                for (const fact of memory ?? []) {
                  await sendMessage({ type: 'MEMORY_DELETE', id: fact.id });
                }
              })()
            }
          >
            Forget all
          </button>
        </>
      )}

      <SkillsEditor skills={skills ?? []} />

      <AutomationsEditor automations={automations ?? []} />
    </section>
  );
}

/** Scheduled agent runs: discovery/triage on a timer, digest + confirm chips in chat */
function AutomationsEditor({ automations }: { automations: AssistantAutomation[] }) {
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<'daily' | 'every'>('daily');
  const [time, setTime] = useState('08:00');
  const [minutes, setMinutes] = useState(60);
  const [error, setError] = useState('');
  const [runMsg, setRunMsg] = useState('');

  const startEdit = (automation: AssistantAutomation | null) => {
    setEditingId(automation ? automation.id : 'new');
    setName(automation?.name ?? '');
    setPrompt(automation?.prompt ?? '');
    setKind(automation?.schedule.kind ?? 'daily');
    setTime(automation?.schedule.kind === 'daily' ? automation.schedule.time : '08:00');
    setMinutes(automation?.schedule.kind === 'every' ? automation.schedule.minutes : 60);
    setError('');
  };

  const save = async () => {
    const schedule: AutomationSchedule =
      kind === 'daily' ? { kind: 'daily', time } : { kind: 'every', minutes };
    const res =
      editingId === 'new'
        ? await sendMessage({ type: 'AUTOMATION_ADD', name, prompt, schedule })
        : await sendMessage({
            type: 'AUTOMATION_UPDATE',
            id: editingId as string,
            patch: { name, prompt, schedule },
          });
    if (!res.ok) {
      setError(res.error ?? 'Could not save the automation.');
      return;
    }
    setEditingId(null);
  };

  const runNow = async (id: string) => {
    setRunMsg('Running…');
    const res = await sendMessage({ type: 'AUTOMATION_RUN_NOW', id });
    setRunMsg(res.ok ? 'Done — digest is in the assistant chat.' : (res.error ?? 'Run failed.'));
  };

  return (
    <>
      <h3 style={{ marginTop: 20 }}>Automations</h3>
      <p className="hint">
        Scheduled agent runs that do discovery and triage on their own (“each morning, review my
        open tasks and propose which 3 to do”). Results land in the assistant chat; proposed
        actions always wait for your confirmation.
      </p>
      {automations.length === 0 && editingId === null && (
        <p className="empty-message">No automations yet.</p>
      )}
      {automations.length > 0 && (
        <div className="feeds-list">
          {automations.map((automation) => (
            <div key={automation.id} className="feed-entry">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={automation.enabled}
                  onChange={(e) =>
                    void sendMessage({
                      type: 'AUTOMATION_UPDATE',
                      id: automation.id,
                      patch: { enabled: e.target.checked },
                    })
                  }
                />
                <span className="feed-entry-url" style={{ whiteSpace: 'normal' }}>
                  <strong>{automation.name}</strong>
                  <span className="hint">
                    {' '}
                    — {automation.schedule.kind === 'daily'
                      ? `daily at ${automation.schedule.time}`
                      : `every ${automation.schedule.minutes} min`}
                    {automation.lastError && ` · last run failed: ${automation.lastError}`}
                  </span>
                </span>
              </label>
              <button type="button" className="secondary-btn" onClick={() => void runNow(automation.id)}>
                Run now
              </button>
              <button type="button" className="secondary-btn" onClick={() => startEdit(automation)}>
                Edit
              </button>
              <button
                type="button"
                className="remove-feed-btn"
                aria-label={`Delete automation "${automation.name}"`}
                onClick={() => void sendMessage({ type: 'AUTOMATION_DELETE', id: automation.id })}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {runMsg && <p className="hint">{runMsg}</p>}
      {editingId !== null ? (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <input
            type="text"
            placeholder="Automation name (e.g. Morning task triage)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <textarea
            rows={3}
            placeholder="What should the agent do each run? (e.g. review my open tasks and propose which 3 to do today)"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={kind} onChange={(e) => setKind(e.target.value as 'daily' | 'every')}>
              <option value="daily">Daily at</option>
              <option value="every">Every N minutes</option>
            </select>
            {kind === 'daily' ? (
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            ) : (
              <input
                type="number"
                min={15}
                max={1440}
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
              />
            )}
          </div>
          {error && <p className="feedback error">{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="primary-btn" onClick={() => void save()}>
              Save automation
            </button>
            <button type="button" className="secondary-btn" onClick={() => setEditingId(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="secondary-btn"
          style={{ marginTop: 10 }}
          onClick={() => startEdit(null)}
        >
          Add automation
        </button>
      )}
    </>
  );
}

/** Skills: written-down knowledge the assistant consults instead of guessing */
function SkillsEditor({ skills }: { skills: AssistantSkill[] }) {
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [keywords, setKeywords] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');

  const startEdit = (skill: AssistantSkill | null) => {
    setEditingId(skill ? skill.id : 'new');
    setName(skill?.name ?? '');
    setKeywords(skill?.keywords.join(', ') ?? '');
    setBody(skill?.body ?? '');
    setError('');
  };

  const saveSkill = async () => {
    const keywordList = keywords.split(',').map((k) => k.trim()).filter(Boolean);
    const res =
      editingId === 'new'
        ? await sendMessage({ type: 'SKILL_ADD', name, keywords: keywordList, body })
        : await sendMessage({
            type: 'SKILL_UPDATE',
            id: editingId as string,
            patch: { name, keywords: keywordList, body },
          });
    if (!res.ok) {
      setError(res.error ?? 'Could not save the skill.');
      return;
    }
    setEditingId(null);
  };

  return (
    <>
      <h3 style={{ marginTop: 20 }}>Skills</h3>
      <p className="hint">
        Written-down instructions the assistant follows instead of guessing (“grocery items go in
        the Errands deck”, “tasks are phrased as verbs”). Matched to what you say by keywords;
        stays on this device only.
      </p>
      {skills.length === 0 && editingId === null && (
        <p className="empty-message">No skills yet.</p>
      )}
      {skills.length > 0 && (
        <div className="feeds-list">
          {skills.map((skill) => (
            <div key={skill.id} className="feed-entry">
              <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  onChange={(e) =>
                    void sendMessage({
                      type: 'SKILL_UPDATE',
                      id: skill.id,
                      patch: { enabled: e.target.checked },
                    })
                  }
                />
                <span className="feed-entry-url" style={{ whiteSpace: 'normal' }}>
                  <strong>{skill.name}</strong>
                  {skill.keywords.length > 0 && (
                    <span className="hint"> — {skill.keywords.join(', ')}</span>
                  )}
                </span>
              </label>
              <button type="button" className="secondary-btn" onClick={() => startEdit(skill)}>
                Edit
              </button>
              <button
                type="button"
                className="remove-feed-btn"
                aria-label={`Delete skill "${skill.name}"`}
                onClick={() => void sendMessage({ type: 'SKILL_DELETE', id: skill.id })}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {editingId !== null ? (
        <div style={{ marginTop: 10, display: 'grid', gap: 8 }}>
          <input
            type="text"
            placeholder="Skill name (e.g. Task phrasing)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="text"
            placeholder="Keywords, comma-separated (e.g. task, grocery, errand)"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
          />
          <textarea
            rows={5}
            placeholder="Instructions the assistant should follow when this skill applies"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          {error && <p className="feedback error">{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="primary-btn" onClick={() => void saveSkill()}>
              Save skill
            </button>
            <button type="button" className="secondary-btn" onClick={() => setEditingId(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="secondary-btn"
          style={{ marginTop: 10 }}
          onClick={() => startEdit(null)}
        >
          Add skill
        </button>
      )}
    </>
  );
}
