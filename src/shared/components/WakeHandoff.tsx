import { useEffect } from 'react';
import { runAssistantTurn } from '../ai/assistant';
import { newTurn } from '../ai/assistantTypes';
import { getActiveTools } from '../ai/connector';
import { geminiProvider } from '../ai/geminiProvider';
import { nanoProvider } from '../ai/nanoProvider';
import { speak } from '../ai/tts';
import { persistOutcome, persistTurn } from '../ai/turnLog';
import { sendMessage } from '../messages';
import { DEFAULT_SETTINGS, getSettings } from '../storage';

/**
 * Headless. Runs a wake-word command the offscreen listener captured but
 * couldn't execute itself (no model reachable there, so it opens the dashboard
 * and hands the raw command over). Renders nothing — the resulting turns land
 * in the shared session thread, where the popup's chat shows them.
 *
 * The command is claimed through the service worker, so mounting this
 * alongside an open AssistantChat can't run the same command twice.
 */
export function WakeHandoff() {
  useEffect(() => {
    void (async () => {
      const { input } = await sendMessage({ type: 'ASSISTANT_CLAIM_PENDING' });
      if (!input) return;

      const settings = await getSettings().catch(() => DEFAULT_SETTINGS);
      if (!settings.assistantEnabled) return;
      const say = (phrase: string) => {
        if (settings.assistantVoiceEnabled) speak(phrase, settings.assistantTtsVoice);
      };

      // Append the user turn and get the prior thread back in one hop
      const { thread } = await sendMessage({
        type: 'ASSISTANT_BEGIN_TURN',
        turn: newTurn('user', input),
      });

      try {
        const outcome = await runAssistantTurn(input, thread, {
          nano: nanoProvider,
          cloud: geminiProvider,
          tools: await getActiveTools(), // only connected integrations
          cache: true,
        });
        await persistOutcome(outcome, say);
      } catch {
        await persistTurn(
          newTurn('assistant', 'Something went wrong running that.', {
            kind: 'error',
            source: 'local',
          }),
        );
      }
    })();
  }, []);

  return null;
}
