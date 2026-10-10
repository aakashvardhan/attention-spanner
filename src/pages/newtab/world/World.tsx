import { useEffect, useMemo, useRef, useState } from 'react';
import type { ResumableItem } from '../../../shared/attention';
import { Brackets } from '../../../shared/components/Brackets';
import type { useFocusSession } from '../../../shared/hooks/useFocusSession';
import { useAmbient } from '../../../shared/hooks/useAmbient';
import type { useNowWatching } from '../../../shared/hooks/useNowWatching';
import type { Pick } from '../../../shared/llm/triage';
import { paceLabel, paceMinutesLeft } from '../../../shared/progress';
import type { Paper, Settings } from '../../../shared/types';
import { ActivityHeatmap } from '../ActivityHeatmap';
import { BrainDump } from '../BrainDump';
import { ContinueRow, kickerFor } from '../ContinueRow';
import { EditionIndex } from '../EditionIndex';
import { Hero } from '../Hero';
import { NowWatching } from '../NowWatching';
import { TriageRow, useTriage } from '../TriageCard';
import { CAMERA, cameraFor, isBehind, sceneTransform } from './camera';
import { placeStories, placeTransform, SIGN_OFFSET, WATCHING } from './layout';
import { Sky } from './Sky';
import { tokenMs } from './view';

/** Stands a place's foot (bottom centre) on its spot, label above the panel. */
const stand = (p: { x: number; z: number; yaw: number }) => ({ transform: `${placeTransform(p)} translate(-50%, -100%)` });

export interface WorldProps {
  status: string;
  resumable: ResumableItem[];
  now: number;
  watching: ReturnType<typeof useNowWatching>;
  papers: Paper[];
  focus: ReturnType<typeof useFocusSession>;
  settings: Settings;
  quote: string;
  stepping: boolean;
  onOpen: (item: ResumableItem, alt: boolean, newTab: boolean) => void;
  onOpenPick: (pick: Pick, newTab: boolean) => void;
}

/**
 * The new tab as a place you stand in. Things you read stand in the scene;
 * tools you use (the brain dump, favorites, focus) stay in the frame, which
 * never moves. The camera follows keyboard focus and nothing else.
 */
export function World(props: WorldProps) {
  const { resumable, settings, focus, stepping } = props;
  const triage = useTriage();
  const ambient = useAmbient();
  const picks = triage.picks ?? [];

  const { placed, overflow } = useMemo(
    () =>
      placeStories(
        [
          ...resumable.map((i) => ({ key: i.key, lane: 'path' as const, updatedAt: i.updatedAt })),
          ...picks.map((p) => ({ key: `feed:${p.item.id}`, lane: 'feed' as const, updatedAt: Date.parse(p.item.pubDate) || props.now })),
        ],
        props.now,
      ),
    [resumable, picks, props.now],
  );
  const byKey = new Map(placed.map((p) => [p.key, p]));

  const [target, setTarget] = useState<string | null>(null);
  const lockedKey = target && byKey.has(target) ? target : (placed[0]?.key ?? null);
  const lockedPlace = lockedKey ? (byKey.get(lockedKey) ?? null) : null;
  const camera = cameraFor(lockedPlace);

  // The vignette is on only while the camera glides (Meta's comfort guidance).
  const [moving, setMoving] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (settings.comfort !== 'recommended') return;
    setMoving(true);
    const ms = tokenMs('--dur-smooth') || 520;
    const timer = setTimeout(() => setMoving(false), ms);
    return () => clearTimeout(timer);
  }, [lockedKey, settings.comfort]);

  const lastPath = [...placed].reverse().find((p) => p.lane === 'path');
  const signZ = (lastPath?.z ?? 0) - SIGN_OFFSET;

  return (
    <main
      className="world"
      data-comfort={settings.comfort}
      data-focus={focus.active || undefined}
      data-moving={moving || undefined}
      data-stepping={stepping || undefined}
    >
      <div className="world-frame world-frame--top">
        <Hero status={props.status} />
      </div>

      <div className="world-view">
        <Sky location={settings.weatherLocation} />
        <div
          className="world-scene"
          style={{ transform: sceneTransform(camera, stepping ? CAMERA.stepDepth : CAMERA.viewDepth) }}
          onFocusCapture={(e) => {
            const key = (e.target as HTMLElement).closest<HTMLElement>('[data-place]')?.dataset.place;
            if (key) setTarget(key);
          }}
        >
          <div className="world-ground" aria-hidden="true" />
          <div className="world-path" aria-hidden="true" />

          {props.watching.active && (
            <div className="world-place" style={stand(WATCHING)}>
              <div className="world-panel world-panel--watching">
                <NowWatching watching={props.watching} />
              </div>
            </div>
          )}

          <ul className="world-stories" aria-label="Unfinished, and from your feeds">
            {resumable.map((item) => {
              const p = byKey.get(item.key);
              if (!p) return null;
              const locked = p.key === lockedKey;
              const pace = item.progress ? paceLabel(paceMinutesLeft(item.progress)) : '';
              return (
                <li key={item.key} className="world-place" data-place={p.key} data-locked={locked || undefined} data-behind={isBehind(p, lockedPlace) || undefined} style={stand(p)}>
                  {locked && (
                    <p className="world-lock-label" aria-hidden="true">
                      {[kickerFor(item).replace(/^Continue \w+ · /, '').toUpperCase(), pace].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  <ul className="world-panel world-panel--path">
                    <ContinueRow
                      lead={item === resumable[0]}
                      item={item}
                      now={props.now}
                      onOpen={(alt, newTab) => props.onOpen(item, alt, newTab)}
                    />
                  </ul>
                </li>
              );
            })}
            {picks.map((pick) => {
              const p = byKey.get(`feed:${pick.item.id}`);
              if (!p) return null;
              const locked = p.key === lockedKey;
              return (
                <li key={p.key} className="world-place" data-place={p.key} data-locked={locked || undefined} data-behind={isBehind(p, lockedPlace) || undefined} style={stand(p)}>
                  {locked && (
                    <p className="world-lock-label" aria-hidden="true">
                      {pick.because ? `FEED · BECAUSE YOU READ ${pick.because.toUpperCase()}` : `FEED · ${pick.item.source.toUpperCase()}`}
                    </p>
                  )}
                  <div className="world-panel world-panel--feed">
                    <TriageRow pick={pick} onOpen={props.onOpenPick} />
                  </div>
                </li>
              );
            })}
          </ul>

          {(placed.length === 0 || overflow > 0) && (
            <p className="world-place world-sign" style={stand({ x: 0, z: placed.length ? signZ : 0, yaw: 0 })}>
              {placed.length === 0
                ? 'Nothing open. Press ⌘/Ctrl+Shift+E on any page to read it here.'
                : `+${overflow} more · V for the flat view`}
            </p>
          )}

          <div className="world-terrain">
            <ActivityHeatmap papers={props.papers} terrain />
          </div>
          <p className="world-quote">{props.quote}</p>
        </div>
        <div className="world-fog" aria-hidden="true" />
        <div className="world-vignette" aria-hidden="true" />
        {settings.comfort === 'comfortable' && <div key={lockedKey ?? ''} className="world-cut" aria-hidden="true" />}
        <Brackets />
      </div>

      <div className="world-frame world-frame--bottom">
        <aside className="world-dock world-dock--left" aria-label="Brain dump">
          <BrainDump />
        </aside>
        <div className="world-telemetry">
          <p>{[props.status, focus.active ? `focus ${focus.countdown}` : null, 'J/K walk · Enter step in · V flat'].filter(Boolean).join(' · ')}</p>
          <button type="button" className="world-ambient-toggle edition-link" onClick={ambient.toggle}>
            {ambient.enabled ? 'Pause ambient motion' : 'Resume ambient motion'}
          </button>
        </div>
        <div className="world-dock world-dock--right">
          <EditionIndex />
        </div>
      </div>
    </main>
  );
}

