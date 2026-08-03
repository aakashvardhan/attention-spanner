import { useEffect, useRef, useState } from 'react';
import { localDate } from '../../shared/format';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import { Button, Panel, ProgressBar, Stat, StatRow } from '../../shared/components/ui';
import { sendMessage } from '../../shared/messages';
import {
  nextTrial,
  scoreSession,
  STROOP_COLORS,
  WARMUP_SECONDS,
  type StroopColor,
  type StroopTrial,
} from '../../shared/stroop';

type Phase = 'idle' | 'countdown' | 'playing' | 'done';

interface DoneResult {
  firstToday: boolean;
  isBest: boolean;
  accuracy: number;
  total: number;
}

/** Pre-work ritual: a 60-second Stroop sprint played inline in the card */
export function WarmupPanel() {
  const [warmup] = useStorageValue('warmup');
  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(3);
  const [trial, setTrial] = useState<StroopTrial | null>(null);
  const [correct, setCorrect] = useState(0);
  const [wrong, setWrong] = useState(0);
  const [remainingMs, setRemainingMs] = useState(WARMUP_SECONDS * 1000);
  const [wrongFlash, setWrongFlash] = useState<StroopColor | null>(null);
  const [result, setResult] = useState<DoneResult | null>(null);

  const endsAtRef = useRef(0);
  // Guards the finish path: the timer effect can re-fire while the
  // WARMUP_COMPLETE message is still awaiting its response
  const finishedRef = useRef(false);
  // Best score at session start — storage updates before the done screen renders
  const prevBestRef = useRef(0);

  const start = () => {
    prevBestRef.current = warmup.bestScore;
    finishedRef.current = false;
    setCorrect(0);
    setWrong(0);
    setWrongFlash(null);
    setResult(null);
    setTrial(null);
    setRemainingMs(WARMUP_SECONDS * 1000);
    setCount(3);
    setPhase('countdown');
  };

  const answer = (color: StroopColor) => {
    if (phase !== 'playing' || !trial || finishedRef.current) return;
    if (color === trial.ink) {
      setCorrect((c) => c + 1);
    } else {
      setWrong((w) => w + 1);
      setWrongFlash(color);
    }
    setTrial((t) => nextTrial(t));
  };

  useEffect(() => {
    if (phase !== 'countdown') return;
    if (count <= 0) {
      endsAtRef.current = Date.now() + WARMUP_SECONDS * 1000;
      setTrial(nextTrial(null));
      setPhase('playing');
      return;
    }
    const id = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [phase, count]);

  // Timestamp-diff timer — immune to interval drift and main-thread stalls
  useEffect(() => {
    if (phase !== 'playing') return;
    const id = setInterval(() => {
      setRemainingMs(Math.max(0, endsAtRef.current - Date.now()));
    }, 100);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'playing' || remainingMs > 0 || finishedRef.current) return;
    finishedRef.current = true;
    const total = correct + wrong;
    const { accuracy } = scoreSession(correct, wrong);
    void (async () => {
      const res = await sendMessage({ type: 'WARMUP_COMPLETE', score: correct, total });
      setResult({
        firstToday: res.firstToday,
        isBest: correct > prevBestRef.current && correct > 0,
        accuracy,
        total,
      });
      setPhase('done');
    })();
  }, [phase, remainingMs, correct, wrong]);

  useEffect(() => {
    if (wrongFlash === null) return;
    const id = setTimeout(() => setWrongFlash(null), 180);
    return () => clearTimeout(id);
  }, [wrongFlash]);

  useEffect(() => {
    if (phase !== 'playing' && phase !== 'countdown') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Abort — nothing recorded, no message sent
        setPhase('idle');
        return;
      }
      const index = ['1', '2', '3', '4'].indexOf(e.key);
      if (index >= 0) {
        e.preventDefault();
        answer(STROOP_COLORS[index]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const todayResult = warmup.days[localDate()];

  return (
    <Panel title="Warm-up">

      {phase === 'idle' && (
        <>
          <StatRow>
            <Stat value={warmup.currentStreak} label="day streak" />
            <Stat value={warmup.longestStreak} label="longest" />
            <Stat value={warmup.bestScore} label="best score" />
          </StatRow>
          {todayResult && (
            <p className="gym-logged">Warmed up today — {todayResult.score} correct</p>
          )}
          <p className="sprint-hint">Tap the ink color, not the word — 60 seconds.</p>
          <Button variant={todayResult ? 'tinted' : 'primary'} block onClick={start}>
            {todayResult ? 'Play again' : 'Start 60-second sprint'}
          </Button>
        </>
      )}

      {phase === 'countdown' && (
        <div className="sprint-live">
          <span className="sprint-countdown">{count}</span>
          <p className="sprint-hint">Tap the ink color, not the word</p>
        </div>
      )}

      {phase === 'playing' && trial && (
        <>
          <div className="stroop-hud">
            <span>{Math.ceil(remainingMs / 1000)}s</span>
            <span>{correct} correct</span>
          </div>
          <ProgressBar percent={(remainingMs / (WARMUP_SECONDS * 1000)) * 100} />
          <div className="stroop-word" style={{ color: `var(--stroop-${trial.ink})` }}>
            {trial.word.toUpperCase()}
          </div>
          <div className="stroop-grid">
            {STROOP_COLORS.map((color, i) => (
              <button
                key={color}
                className={wrongFlash === color ? 'stroop-btn wrong' : 'stroop-btn'}
                onClick={() => answer(color)}
              >
                <span className="stroop-key">{i + 1}</span>
                {color}
              </button>
            ))}
          </div>
        </>
      )}

      {phase === 'done' && result && (
        <>
          <div className="sprint-live">
            <span className="sprint-countdown">{correct}</span>
            <p className="warmup-done-stats">
              {result.accuracy}% accuracy · {result.total} answered
            </p>
            {result.isBest && <p className="warmup-best">New personal best!</p>}
            <p className="sprint-hint">
              {result.firstToday
                ? `Day ${warmup.currentStreak} of your warm-up streak`
                : 'Already counted today — nice reps anyway.'}
            </p>
          </div>
          <Button variant="tinted" block onClick={start}>
            Play again
          </Button>
          <button className="sprint-cancel" onClick={() => setPhase('idle')}>
            done
          </button>
        </>
      )}
    </Panel>
  );
}
