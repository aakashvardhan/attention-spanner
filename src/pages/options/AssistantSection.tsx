import { useEffect, useState } from 'react';
import { testAnthropicKey } from '../../shared/ai/anthropicProvider';
import { testGeminiKey } from '../../shared/ai/geminiProvider';
import { listVoices, speak } from '../../shared/ai/tts';
import { detectCapabilities } from '../../shared/capabilities';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { sendMessage } from '../../shared/messages';
import { PROFILE_MAX_CHARS } from '../../shared/constants';
import { DEFAULT_SETTINGS, patchSettings, setLocal } from '../../shared/storage';
import type { AssistantAutomation, AssistantSkill, AutomationSchedule } from '../../shared/types';
import { BrowserSupport } from './BrowserSupport';

type Test = { state: 'idle' } | { state: 'testing' } | { state: 'ok' } | { state: 'error'; message: string };

type Mic = { state: 'unknown' } | { state: 'granted' } | { state: 'denied' };

const VOICE_SAMPLE = "Good morning. You have three tasks left today, and your focus block starts in ten minutes.";

export function AssistantSection() {
  const [stored] = useStorageValue('settings');
  const [memory] = useStorageValue('assistantMemory');
  const [skills] = useStorageValue('assistantSkills');
  const [automations] = useStorageValue('assistantAutomations');
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  const provider = settings.cloudProvider;
  const providerLabel = provider === 'anthropic' ? 'Claude' : 'Gemini';
  const currentKey = provider === 'anthropic' ? settings.anthropicApiKey : settings.geminiApiKey;
  const hasKey = currentKey.length > 0;
  const [keyInput, setKeyInput] = useState('');
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<Test>({ state: 'idle' });
  const [mic, setMic] = useState<Mic>({ state: 'unknown' });
  const [voices, setVoices] = useState<{ name: string; lang: string }[]>([]);
  // Sync and constant for the life of the page — no state needed
  const caps = detectCapabilities();

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

  const keyToTest = keyInput.trim() || currentKey;

  const chooseProvider = async (next: 'gemini' | 'anthropic') => {
    await patchSettings({ cloudProvider: next });
    setKeyInput('');
    setSaved(false);
    setTest({ state: 'idle' });
  };

  const save = async () => {
    if (!keyInput.trim()) return;
    const key = keyInput.trim();
    await patchSettings(provider === 'anthropic' ? { anthropicApiKey: key } : { geminiApiKey: key });
    setKeyInput('');
    setSaved(true);
    setTest({ state: 'idle' });
  };

  const removeKey = async () => {
    await patchSettings(provider === 'anthropic' ? { anthropicApiKey: '' } : { geminiApiKey: '' });
    setSaved(false);
    setTest({ state: 'idle' });
  };

  const runTest = async () => {
    if (!keyToTest) return;
    setTest({ state: 'testing' });
    const res =
      provider === 'anthropic' ? await testAnthropicKey(keyToTest) : await testGeminiKey(keyToTest);
    setTest(res.ok ? { state: 'ok' } : { state: 'error', message: res.error ?? 'Key test failed.' });
  };

  return (
    <section className="section">
      <h2>Assistant</h2>
      <p className="hint">
        The assistant answers questions about your data and runs actions (add tasks, start focus
        sessions…) from the dashboard. Where the browser provides an on-device model, short
        questions run on it and stay on your machine. With a cloud API key below, harder questions, recorded
        audio, captured frames, and screenshots you ask about are sent to that provider.
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

      <div className="setting-row">
        <label htmlFor="cloud-provider">Preferred cloud model</label>
        <select
          id="cloud-provider"
          value={provider}
          onChange={(e) => void chooseProvider(e.target.value as 'gemini' | 'anthropic')}
        >
          <option value="gemini">Gemini 3.5 Flash</option>
          <option value="anthropic">Claude Haiku 4.5</option>
        </select>
      </div>
      <p className="hint">
        Optional: an API key lets the assistant handle long pages and harder questions in the
        cloud when the on-device model can't. Configure both and each is used where it is
        stronger — Claude for planning and double-checking, Gemini for images and search.{' '}
        {provider === 'anthropic'
          ? 'Get a Claude key at console.anthropic.com.'
          : 'Gemini has a free tier at aistudio.google.com.'}{' '}
        The key is stored locally in this browser only and is never synced.
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
          placeholder={hasKey ? 'Key saved — paste to replace' : `Paste your ${providerLabel} API key`}
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

      {test.state === 'ok' && <p className="feedback success">Key works — cloud fallback is on.</p>}
      {test.state === 'error' && <p className="feedback error">{test.message}</p>}

      <BrowserSupport />

      <p className="hint" style={{ marginTop: 16 }}>
        Voice: hold the mic button in the assistant to talk instead of typing, and have replies
        read aloud. Availability depends on your browser — see above.
      </p>
      <div className="setting-row">
        <label>Microphone for voice input</label>
        {mic.state === 'granted' ? (
          <span className="feedback success" style={{ margin: 0 }}>
            Granted
          </span>
        ) : (
          <button type="button" className="secondary-btn" onClick={() => void grantMic()}>
            {mic.state === 'denied' ? 'Blocked — try again' : 'Enable microphone'}
          </button>
        )}
      </div>
      {mic.state === 'denied' && (
        <p className="feedback error">
          Your browser blocked the microphone for this extension. Click the mic icon in the address
          bar (or Site settings) to allow it, then retry.
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
          Jarvis listens for “hey Jarvis” whenever the browser is running. Detection runs
          on-device, so nothing is sent anywhere until the wake word actually fires — then your
          request is transcribed{caps.webSpeech ? " by the browser's recognizer" : ' by Gemini'},
          the reply is spoken aloud, and it lands in the assistant chat.
        </p>
      )}
      <div className="setting-row">
        <label htmlFor="assistant-react">Look things up before answering</label>
        <input
          id="assistant-react"
          type="checkbox"
          checked={settings.assistantReactEnabled}
          onChange={(e) => void patchSettings({ assistantReactEnabled: e.target.checked })}
        />
      </div>
      <p className="hint">
        Let Jarvis search your library, read your plan, and check your calendar mid-answer, then
        decide what to do next — instead of guessing in one shot. Slower and uses more of your
        cloud quota. Anything that changes your data still waits for your approval. Needs a cloud
        API key; on-device Nano can't do this.
      </p>
      <div className="setting-row">
        <label htmlFor="assistant-vision">Screen understanding</label>
        <input
          id="assistant-vision"
          type="checkbox"
          checked={settings.assistantVisionEnabled}
          onChange={(e) => void patchSettings({ assistantVisionEnabled: e.target.checked })}
        />
      </div>
      <p className="hint">
        Describe slides and shared screens into the notes while a tab is being recorded, and let
        the assistant see the current tab when you ask about it. Captured frames go to Gemini,
        the same as recorded audio.
      </p>
      <div className="setting-row">
        <label htmlFor="assistant-live">Live transcription</label>
        <input
          id="assistant-live"
          type="checkbox"
          checked={settings.assistantLiveEnabled}
          onChange={(e) => void patchSettings({ assistantLiveEnabled: e.target.checked })}
        />
      </div>
      <p className="hint">
        Transcribe a recording as it happens — text arrives within seconds instead of after the
        recording stops, so you can ask about a meeting while you're still in it. This makes many
        more Gemini calls than the usual five-minute batches; stretches of silence are skipped
        rather than sent.
      </p>
      {settings.assistantVoiceEnabled && voices.length > 0 && (
        <>
          <div className="setting-row">
            <label htmlFor="assistant-tts-voice">Voice</label>
            <span className="voice-picker">
              <select
                id="assistant-tts-voice"
                value={settings.assistantTtsVoice}
                onChange={(e) => {
                  void patchSettings({ assistantTtsVoice: e.target.value });
                  speak(VOICE_SAMPLE, e.target.value);
                }}
              >
                <option value="">System default</option>
                {voices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => speak(VOICE_SAMPLE, settings.assistantTtsVoice)}
              >
                Preview
              </button>
            </span>
          </div>
          <p className="hint">
            Chrome only offers what your OS has installed. macOS ships a handful of low-fidelity
            en-GB voices by default; the natural-sounding British ones (Serena, Kate, Stephanie)
            are downloads — System Settings → Accessibility → Spoken Content → System Voice →
            Manage Voices, pick the Premium quality, then reopen this page.
          </p>
        </>
      )}

      <ProfileEditor />

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

/**
 * "About me": the one block of context loaded into every assistant prompt,
 * ahead of the char cap so it can never be truncated away. Deliberately not
 * writable by a tool — remembered facts accumulate and age out, but this is
 * the user's own description of themselves and only they should edit it.
 */
function ProfileEditor() {
  const [profile] = useStorageValue('assistantProfile');
  const stored = profile?.text ?? '';
  const [draft, setDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const text = draft ?? stored;
  const dirty = draft !== null && draft !== stored;

  const save = async () => {
    await setLocal({
      assistantProfile: { text: text.trim().slice(0, PROFILE_MAX_CHARS), updatedAt: Date.now() },
    });
    setDraft(null);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <>
      <h3 style={{ marginTop: 20 }}>About me</h3>
      <p className="hint">
        Who you are, what you’re working on, how you like to work. Loaded into every assistant
        answer, briefing and day plan — unlike memory facts, this is never dropped or aged out.
        Stays on this device.
      </p>
      <textarea
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        rows={6}
        maxLength={PROFILE_MAX_CHARS}
        placeholder={
          'CS masters student at SJSU, thesis on graph neural nets.\n' +
          'Mornings are for deep work; afternoons are meetings and email.\n' +
          'I lose the thread when a task has no obvious first step.'
        }
        style={{ width: '100%', resize: 'vertical' }}
      />
      <div className="hint" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="button" className="secondary-btn" disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
        <span>
          {text.length}/{PROFILE_MAX_CHARS}
        </span>
        {saved && <span>Saved.</span>}
      </div>
    </>
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
