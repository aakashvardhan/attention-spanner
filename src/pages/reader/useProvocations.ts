import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MIN_PAGE_CHARS } from '../../shared/constants';
import { useAi, type AiView } from '../../shared/hooks/useAi';
import { useStorageValue } from '../../shared/hooks/useStorageValue';
import type { AiSource } from '../../shared/llm/route';
import {
  breakdownRequest,
  counterpointRequest,
  equationRequest,
  FALLBACK,
  lockRequest,
  parseBreakdown,
  parseCounterpoint,
} from '../../shared/llm/provoke';
import { sendMessage } from '../../shared/messages';
import { sectionIndexAt, topLevel, type FlatOutlineItem } from '../../shared/pdfOutline';
import { TAG_COLOR } from '../../shared/thinking';
import type { Annotation, HighlightTag, Paper, ProvocationDraft, ReadingPass } from '../../shared/types';
import { justifiedPages, mathBlock, pageToLock } from './passGate';
import { TAGS } from './components/ProvocationCard';

/** A page has to hold still this long before it counts as the page you are on. */
const SETTLE_MS = 1200;

export interface MarginCard {
  id: string;
  /** open = an Open question raised again from the toolbar */
  kind: 'highlight' | 'equation' | 'open';
  kicker: string;
  /** '' while the AI is still writing it (the card waits) */
  question: string;
  page: number;
  annotationId?: string;
  /** The highlight's tag chosen in the selection menu; null = "Question this" */
  tag?: HighlightTag | null;
  /** The text the card is about: the highlight, or the math block */
  passage: string;
  /** The stored record this card answers (re-raised open questions) */
  recordId?: string;
  /** The reader's committed answer; set once they've answered */
  answer: string | null;
  breakdown: string[] | null;
  /** "Break it down" is on offer (an AI is there and it hasn't run) */
  canBreakDown: boolean;
  counterpoint: { question: string; gap: string } | null;
}

type Card = Omit<MarginCard, 'breakdown' | 'canBreakDown' | 'counterpoint'> & { breakdownAsked: boolean };

const settledText = (v: AiView) => (v.status === 'done' ? v.text.trim() : '');
/** No route, an error or a cloud prompt: use the fixed question rather than wait. */
const failed = (v: AiView) => v.status === 'unavailable' || v.status === 'error' || v.status === 'confirm';
const labelOf = (tag: HighlightTag) => TAGS.find((t) => t.tag === tag)!.label;

/**
 * Which question the PDF reader asks, and when, by reading pass: margin cards
 * (highlight reasons, equations, Open questions raised again), the capsule's
 * one-line prompt (page one-liners, the verdict), and pass 3's lock.
 */
export function useProvocations({
  docKey,
  paperId,
  pass,
  page,
  pageCount,
  pageTexts,
  outline,
  source,
  annotations,
  paper,
  restored,
  jump,
}: {
  docKey: string;
  paperId: string | null;
  pass: ReadingPass;
  page: number;
  pageCount: number;
  pageTexts: string[] | null;
  outline: FlatOutlineItem[];
  source: AiSource;
  annotations: readonly Annotation[];
  paper: Paper | null;
  /** The viewport has applied the saved position (nothing is judged before) */
  restored: boolean;
  /** Scroll to a page (Open questions jump there) */
  jump: (page: number) => void;
}) {
  const [all] = useStorageValue('provocations');
  const open = useMemo(
    () => all.filter((p) => p.docKey === docKey && p.status !== 'answered').sort((a, b) => a.page - b.page),
    [all, docKey],
  );

  const add = useCallback(
    (d: Omit<ProvocationDraft, 'docKey' | 'paperId' | 'annotationId'> & Partial<ProvocationDraft>) =>
      sendMessage({ type: 'PROV_ADD', draft: { docKey, paperId, annotationId: null, ...d } }),
    [docKey, paperId],
  );

  // ---- Margin card -------------------------------------------------------
  const eqAi = useAi();
  const bdAi = useAi();
  const cpAi = useAi();
  const [card, setCard] = useState<Card | null>(null);

  const eqQuestion = settledText(eqAi.view) || (failed(eqAi.view) ? FALLBACK.equation : '');
  const cpParsed = useMemo(
    () => (cpAi.view.status === 'done' ? parseCounterpoint(cpAi.view.text) : null),
    [cpAi.view],
  );

  const margin: MarginCard | null = useMemo(() => {
    if (!card) return null;
    const { breakdownAsked, ...rest } = card;
    const fresh = card.kind === 'equation' && !card.recordId;
    return {
      ...rest,
      question: fresh ? eqQuestion : card.question,
      breakdown: !breakdownAsked
        ? null
        : settledText(bdAi.view)
          ? parseBreakdown(bdAi.view.text).length
            ? parseBreakdown(bdAi.view.text)
            : [...FALLBACK.breakdown]
          : failed(bdAi.view)
            ? [...FALLBACK.breakdown]
            : null,
      canBreakDown: card.kind === 'equation' && card.answer !== null && !breakdownAsked && eqAi.view.status !== 'unavailable',
      counterpoint: card.kind === 'highlight' && card.answer !== null ? cpParsed : null,
    };
  }, [card, eqQuestion, bdAi.view, eqAi.view.status, cpParsed]);

  // A committed reason with no counterpoint (NONE, no AI, an error) has nothing left to show.
  const cpStatus = cpAi.view.status;
  useEffect(() => {
    if (card?.kind !== 'highlight' || card.answer === null) return;
    if ((cpStatus === 'done' && !cpParsed) || failed(cpAi.view)) setCard(null);
  }, [card, cpStatus, cpParsed, cpAi.view]);

  const raiseForSelection = useCallback(
    (o: { annotationId: string; page: number; text: string; tag: HighlightTag | null }) => {
      cpAi.dismiss();
      const label = o.tag ? labelOf(o.tag) : null;
      setCard({
        id: `hl:${o.annotationId}`,
        kind: 'highlight',
        kicker: label ? `${label} · p. ${o.page}` : `Question this · p. ${o.page}`,
        question: label ? `Why is this ${o.tag === 'evidence' ? '' : 'a '}${label.toLowerCase()}, in one line?` : 'What do you want to ask of this, in one line?',
        page: o.page,
        annotationId: o.annotationId,
        tag: o.tag,
        passage: o.text,
        answer: null,
        breakdownAsked: false,
      });
    },
    [cpAi],
  );

  const commit = useCallback(
    (answer: string, chipTag?: HighlightTag) => {
      if (!card) return;
      if (card.kind === 'highlight') {
        const tag = chipTag ?? card.tag ?? undefined;
        void sendMessage({
          type: 'ANNOT_UPDATE',
          id: card.annotationId!,
          patch: tag ? { tag, color: TAG_COLOR[tag], note: answer } : { note: answer },
        });
        void cpAi.start(counterpointRequest({ key: docKey, passage: card.passage, reasoning: answer, source }));
        setCard({ ...card, tag: tag ?? null, answer });
        return;
      }
      if (card.recordId) {
        void sendMessage({ type: 'PROV_UPDATE', id: card.recordId, patch: { answer, status: 'answered' } });
        setCard(null);
        return;
      }
      void add({ kind: 'equation', page: card.page, question: eqQuestion, answer, status: 'answered' });
      setCard({ ...card, answer });
    },
    [card, cpAi, docKey, source, add, eqQuestion],
  );

  const skip = useCallback(() => {
    if (!card) return;
    if (card.kind === 'highlight' && card.tag) {
      void sendMessage({ type: 'ANNOT_UPDATE', id: card.annotationId!, patch: { tag: card.tag, color: TAG_COLOR[card.tag] } });
    }
    // An explicit Skip files the question; a raised Open question already is one.
    if (card.kind === 'equation' && !card.recordId && eqQuestion) {
      void add({ kind: 'equation', page: card.page, question: eqQuestion, answer: '', status: 'open' });
    }
    setCard(null);
  }, [card, add, eqQuestion]);

  const breakDown = useCallback(() => {
    if (card?.kind !== 'equation' || card.answer === null) return;
    void bdAi.start(breakdownRequest({ key: docKey, page: card.page, block: card.passage, guess: card.answer, source }));
    setCard({ ...card, breakdownAsked: true });
  }, [card, bdAi, docKey, source]);

  const respond = useCallback(
    (response: 'defended' | 'revised', text: string, citedPage?: number) => {
      if (!card || !cpParsed) return;
      void add({
        kind: 'counterpoint',
        page: card.page,
        question: cpParsed.question,
        answer: text,
        status: 'answered',
        annotationId: card.annotationId ?? null,
        response,
        ...(citedPage != null ? { citedPage } : {}),
      });
    },
    [card, cpParsed, add],
  );

  const close = useCallback(() => setCard(null), []);

  // Leaving the paper with an equation question shown and unanswered files it.
  const leaving = useRef({ card, eqQuestion, add });
  leaving.current = { card, eqQuestion, add };
  useEffect(() => {
    const onPageHide = () => {
      const { card: c, eqQuestion: q, add: file } = leaving.current;
      if (c?.kind === 'equation' && !c.recordId && c.answer === null && q) {
        void file({ kind: 'equation', page: c.page, question: q, answer: '', status: 'open' });
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, []);

  // ---- Pass 3 lock state (evaluated when a page is settled past) ----------
  const lockAi = useAi();
  const { start: startLock, dismiss: dismissLock } = lockAi;
  /** The page being justified, and the open record on it that the answer resolves */
  const [locked, setLocked] = useState<{ page: number; recordId: string | null } | null>(null);
  const lockedSections = useRef(new Set<number>());
  const unlocked = useRef(new Set<number>());
  const justified = useMemo(() => justifiedPages(all, docKey), [all, docKey]);
  const sections = useMemo(() => topLevel(outline), [outline]);
  const doubts = useMemo(
    () => annotations.filter((a) => a.tag === 'doubt').map((a) => a.note || a.text),
    [annotations],
  );
  const lockLive = useRef({ locked, open, justified, sections, doubts });
  lockLive.current = { locked, open, justified, sections, doubts };

  // A pass change drops any question still being written for the old pass.
  const { dismiss: dismissEq } = eqAi;
  useEffect(() => {
    dismissLock();
    dismissEq();
    setCard((c) => (c?.kind === 'equation' && !c.recordId && c.answer === null ? null : c));
    // Leaving pass 3 lifts the lock without filing anything.
    if (pass !== 3) setLocked(null);
  }, [pass, dismissLock, dismissEq]);

  // ---- Settling on a page --------------------------------------------------
  // Carried over from the old page recap: a page you settle on counts, scrolling
  // past fast does not; only moving forward asks, and each page is asked once.
  // Nothing counts until the saved position is restored, so the page you open
  // on is never mistaken for one you scrolled past.
  const [ask, setAsk] = useState<number | null>(null);
  const settled = useRef<number | null>(null);
  const asked = useRef(new Set<number>());
  const equated = useRef(new Set<number>());
  const cardRef = useRef(card);
  cardRef.current = card;
  const passRef = useRef(pass);
  passRef.current = pass;
  const { start: startEq } = eqAi;
  useEffect(() => {
    if (!pageTexts || !restored) return;
    const timer = setTimeout(() => {
      const left = settled.current;
      settled.current = page;
      if (passRef.current === 3) {
        const l = lockLive.current;
        if (l.locked !== null) return;
        const sectionOf = (p: number) => (l.sections.length ? Math.max(0, sectionIndexAt(l.sections, p)) : 0);
        const n = pageToLock({
          left,
          page,
          pass: 3,
          pageTexts,
          sectionOf,
          lockedSections: new Set([...lockedSections.current, ...[...l.justified].map(sectionOf)]),
          justified: new Set([...unlocked.current, ...l.justified]),
          openPages: new Set(l.open.map((p) => p.page)),
        });
        if (n === null) return;
        lockedSections.current.add(sectionOf(n));
        dismissLock();
        dismissEq();
        setLocked({ page: n, recordId: l.open.find((p) => p.page === n)?.id ?? null });
        void startLock(lockRequest({ key: docKey, page: n, pageText: pageTexts[n - 1] ?? '', doubts: l.doubts, source }));
        return;
      }
      if (passRef.current !== 2) return;
      const block = equated.current.has(page) ? '' : mathBlock(pageTexts[page - 1] ?? '');
      const c = cardRef.current;
      // One automatic card per page, and never over a highlight or an answered card.
      if (block && (!c || (c.kind === 'equation' && !c.recordId && c.answer === null))) {
        equated.current.add(page);
        setCard({
          id: `eq:${page}`,
          kind: 'equation',
          kicker: `Equation · p. ${page}`,
          question: '',
          page,
          passage: block,
          answer: null,
          breakdownAsked: false,
        });
        dismissEq();
        void startEq(equationRequest({ key: docKey, page, block, source }));
      }
      if (left === null || page <= left || asked.current.has(left)) return;
      asked.current.add(left);
      setAsk((pageTexts[left - 1] ?? '').trim().length < MIN_PAGE_CHARS ? null : left);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [page, pageTexts, restored, docKey, source, startEq, dismissEq, startLock, dismissLock]);

  // The fixed question shows at once; the AI's may replace it until the reader
  // starts typing (PassLock freezes it then and hands back the one it showed).
  const lockQuestion = settledText(lockAi.view) || FALLBACK.lock;
  const unlock = useCallback(
    (answer: string | null, question: string) => {
      if (locked === null) return;
      const rec = locked.recordId ? open.find((p) => p.id === locked.recordId) : undefined;
      if (rec) {
        // The open record that caused the lock is what the answer settles.
        if (answer !== null) void sendMessage({ type: 'PROV_UPDATE', id: rec.id, patch: { answer, status: 'answered' } });
        else if (rec.status === 'open') void sendMessage({ type: 'PROV_UPDATE', id: rec.id, patch: { status: 'unsure' } });
      } else {
        void add({ kind: 'lock', page: locked.page, question, answer: answer ?? '', status: answer === null ? 'unsure' : 'answered' });
      }
      unlocked.current.add(locked.page);
      dismissLock();
      setLocked(null);
    },
    [locked, open, add, dismissLock],
  );
  const lock =
    locked === null
      ? null
      : {
          page: locked.page,
          question: lockQuestion,
          onContinue: (a: string, q: string) => unlock(a, q),
          onUnsure: (q: string) => unlock(null, q),
        };

  // ---- Capsule prompt: verdict first, then the page one-liner -------------
  const [verdictDone, setVerdictDone] = useState(false);
  const wantsVerdict = pass >= 2 && pageCount > 0 && page === pageCount && !paper?.verdict && !verdictDone;
  const capsulePrompt =
    locked !== null
      ? null
      : wantsVerdict
        ? {
            text: 'Your verdict on this paper, in one line?',
            onAnswer: (answer: string) => {
              void add({ kind: 'verdict', page, question: 'Your verdict on this paper, in one line?', answer, status: 'answered' });
              if (paper) void sendMessage({ type: 'PAPER_UPDATE', id: paper.id, patch: { verdict: answer } });
              setVerdictDone(true);
            },
            onSkip: () => setVerdictDone(true),
          }
        : pass === 2 && ask !== null
          ? {
              text: `In one line, what did page ${ask} claim?`,
              onAnswer: (answer: string) => {
                void add({ kind: 'page', page: ask, question: `In one line, what did page ${ask} claim?`, answer, status: 'answered' });
                setAsk(null);
              },
              onSkip: () => setAsk(null),
            }
          : null;

  // ---- Open questions ----------------------------------------------------
  const nextOpen = useCallback(() => {
    if (!open.length) return;
    const next = open.find((p) => p.page > page) ?? open[0];
    jump(next.page);
    setCard({
      id: next.id,
      kind: 'open',
      kicker: `Open question · p. ${next.page}`,
      question: next.question,
      page: next.page,
      passage: '',
      recordId: next.id,
      answer: null,
      breakdownAsked: false,
    });
  }, [open, page, jump]);

  return {
    margin,
    capsulePrompt,
    lock,
    open,
    raiseForSelection,
    nextOpen,
    card: { commit, skip, breakDown, respond, close },
  };
}
