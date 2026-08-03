import { sendMessage } from '../../shared/messages';
import { getSettings } from '../../shared/storage';
import { VAD_POLL_MS } from '../../shared/constants';
import {
  SEGMENT_MINUTES,
  segmentStartSec,
  tailOf,
  type RecordingPurpose,
} from '../../shared/recordings';
import {
  RECORDER_MIME,
  UPLOAD_MIME,
  micErrorMessage,
  micStream,
  toBase64,
} from '../../shared/ai/audio';
import { transcribeSegment } from '../../shared/ai/transcribe';
import {
  hadSpeech,
  newVadState,
  peakOf,
  rmsOf,
  shouldRotate,
  silenceMs,
  vadStep,
  type VadState,
} from '../../shared/ai/vad';
import { FrameWatcher } from './frameWatcher';

/**
 * Audio capture for lectures, meetings and videos. Lives in the offscreen
 * document because that is the only extension context with a stable lifetime,
 * a DOM, and getUserMedia — the service worker has none of the three.
 *
 * The audio never leaves this file: segments are transcribed here and only the
 * resulting text is sent to the worker. That keeps megabytes of base64 off the
 * message bus and means nothing durable ever holds the recording itself.
 */

/** Speech, mono. Enough for transcription, and it keeps a 5-minute segment near 1.2 MB. */
const AUDIO_BITS_PER_SECOND = 32_000;

const SEGMENT_MS = SEGMENT_MINUTES * 60 * 1000;

export class Recorder {
  private id = '';
  private recorder: MediaRecorder | null = null;
  private ctx: AudioContext | null = null;
  private streams: MediaStream[] = [];
  private chunks: Blob[] = [];
  private segmentIndex = 0;
  private startedAt = 0;
  private stopping = false;
  private rotateTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Transcription runs off the recording path, but segments must be transcribed
   * in order — each one is handed the tail of the previous for continuity. This
   * chain serializes them without ever making the recorder wait on the network.
   */
  private queue: Promise<void> = Promise.resolve();
  private priorTail = '';
  /** First transcription failure, surfaced if NOTHING transcribed (see finish) */
  private firstError = '';
  private watcher: FrameWatcher | null = null;
  /** Vocabulary context threaded into every transcribe call */
  private title = '';
  private purpose: RecordingPurpose | undefined;
  /**
   * Live mode: cut segments on speech pauses instead of a five-minute timer, so
   * text arrives during the meeting. Off by default — it trades a real increase
   * in API calls for latency.
   */
  private live = false;
  private analyser: AnalyserNode | null = null;
  private vadBuf: Float32Array = new Float32Array(0);
  private vad: VadState = newVadState(0);
  private vadTimer: ReturnType<typeof setInterval> | undefined;
  /** Wall clock at the current segment's first sample — the basis for startSec
   *  now that segments are variable-length and segmentStartSec no longer holds. */
  private segmentStartedAt = 0;
  /** Transcribed vs dropped-as-silent, so the saving is measured, not assumed */
  private stats = { transcribed: 0, skippedSilent: 0 };

  async begin(
    id: string,
    mode: 'mic' | 'tab' | 'mixed',
    streamId?: string,
    opts?: { visualCapture?: boolean; title?: string; purpose?: RecordingPurpose },
  ): Promise<void> {
    if (this.recorder) this.stop();
    this.id = id;
    this.segmentIndex = 0;
    this.startedAt = Date.now();
    this.stopping = false;
    this.chunks = [];
    this.queue = Promise.resolve();
    this.priorTail = '';
    this.firstError = '';
    this.title = opts?.title ?? '';
    this.purpose = opts?.purpose;
    this.stats = { transcribed: 0, skippedSilent: 0 };
    this.live = await isLiveEnabled();

    try {
      const stream = await this.buildStream(mode, streamId, opts?.visualCapture ?? false);
      if (this.live) this.attachAnalyser(stream);
      this.startSegment(stream);
    } catch (error) {
      this.teardown();
      await sendMessage({
        type: 'REC_CAPTURE_ENDED',
        id,
        durationSeconds: 0,
        error: micErrorMessage(error),
      }).catch(() => undefined);
    }
  }

  /** The Capture button: forwarded to the watcher when one is running. */
  grabFrame(): void {
    this.watcher?.grabNow();
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    clearTimeout(this.rotateTimer);
    clearInterval(this.vadTimer);
    // Flushes the final partial segment through onstop, which then tears down.
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    else void this.finish();
  }

  private async buildStream(
    mode: 'mic' | 'tab' | 'mixed',
    streamId: string | undefined,
    visualCapture: boolean,
  ): Promise<MediaStream> {
    if (mode === 'mic') return this.track(await micStream());

    if (!streamId) throw new Error('No tab stream id — start tab recording from the popup.');
    // Audio and video must be redeemed in ONE getUserMedia call: a tabCapture
    // stream id is single-use.
    const tab = this.track(await tabStream(streamId, visualCapture));

    const videoTrack = tab.getVideoTracks()[0];
    if (videoTrack) {
      this.watcher = new FrameWatcher(
        this.id,
        new MediaStream([videoTrack]),
        this.startedAt,
        () => this.priorTail,
      );
      void this.watcher.start();
    }
    // MediaRecorder must never see the video track: audio/webm + video throws.
    // The AudioContext graph below ignores video tracks on its own.
    const tabAudio = videoTrack ? new MediaStream(tab.getAudioTracks()) : tab;

    // Capturing a tab takes its audio away from the speakers. Re-emitting it is
    // what keeps the meeting audible to the person in it.
    const ctx = new AudioContext();
    this.ctx = ctx;
    const tabSource = ctx.createMediaStreamSource(tabAudio);
    tabSource.connect(ctx.destination);

    if (mode === 'tab') return tabAudio;

    const mic = this.track(await micStream());
    const merged = ctx.createMediaStreamDestination();
    tabSource.connect(merged);
    ctx.createMediaStreamSource(mic).connect(merged);
    return merged.stream;
  }

  private track(stream: MediaStream): MediaStream {
    this.streams.push(stream);
    return stream;
  }

  /**
   * Tap the stream MediaRecorder is recording, so the detector hears exactly
   * what lands in the segment. Mic mode has no AudioContext of its own, hence
   * the lazy create.
   *
   * Deliberately not connected to ctx.destination: the tab passthrough in
   * buildStream is the only path that should reach the speakers, and a second
   * one would double the meeting's volume — or, in mixed mode, feed the mic
   * back into the room.
   */
  private attachAnalyser(stream: MediaStream): void {
    if (stream.getAudioTracks().length === 0) return;
    const ctx = (this.ctx ??= new AudioContext());
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    this.analyser = analyser;
    this.vadBuf = new Float32Array(analyser.fftSize);
  }

  /** One detector sample: rotate the segment when speech has settled. */
  private pollVad(recorder: MediaRecorder): void {
    const analyser = this.analyser;
    if (!analyser) return;
    analyser.getFloatTimeDomainData(this.vadBuf);
    const now = Date.now();
    this.vad = vadStep(this.vad, rmsOf(this.vadBuf), peakOf(this.vadBuf), now);
    const gate = {
      segmentMs: now - this.segmentStartedAt,
      silenceMs: silenceMs(this.vad, now),
    };
    if (shouldRotate(gate) && recorder.state !== 'inactive') recorder.stop();
  }

  /**
   * Start one segment. Rotation stops and recreates the recorder rather than
   * using start(timeslice): only the first blob of a timesliced recording
   * carries the WebM header, so later chunks cannot be decoded — or uploaded —
   * on their own. Stopping yields a complete, standalone file every time.
   */
  private startSegment(stream: MediaStream): void {
    const mimeType = MediaRecorder.isTypeSupported(RECORDER_MIME) ? RECORDER_MIME : '';
    const recorder = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
    this.recorder = recorder;
    this.chunks = [];
    this.segmentStartedAt = Date.now();
    this.vad = newVadState(this.segmentStartedAt);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };

    recorder.onstop = () => {
      clearInterval(this.vadTimer);
      const blob = new Blob(this.chunks, { type: UPLOAD_MIME });
      this.chunks = [];
      const index = this.segmentIndex++;
      // Variable-length segments in live mode, so the offset comes from the wall
      // clock rather than segmentStartSec's index arithmetic.
      const startSec = this.live
        ? Math.max(0, Math.round((this.segmentStartedAt - this.startedAt) / 1000))
        : segmentStartSec(index);

      if (blob.size === 0) {
        // nothing captured
      } else if (this.live && !hadSpeech(this.vad)) {
        // The cheapest transcription is the one never requested. Silence today
        // costs a full Gemini call that comes back as "No speech detected" and
        // is thrown away by cleanTranscript. priorTail is deliberately left
        // alone so the next real segment still gets its continuity context.
        this.stats.skippedSilent++;
      } else {
        this.stats.transcribed++;
        this.enqueueTranscription(blob, startSec);
      }

      if (this.stopping) {
        void this.finish();
      } else {
        this.startSegment(stream);
      }
    };

    recorder.start();
    if (this.live && this.analyser) {
      this.vadTimer = setInterval(() => this.pollVad(recorder), VAD_POLL_MS);
    } else {
      this.rotateTimer = setTimeout(() => {
        if (recorder.state !== 'inactive') recorder.stop();
      }, SEGMENT_MS);
    }
  }

  private enqueueTranscription(blob: Blob, startSec: number): void {
    const id = this.id;
    this.queue = this.queue.then(async () => {
      // Wall clock, not the nominal segment length: the last segment is short,
      // and a rotation can slip under load.
      const endSec = Math.max(startSec, Math.round((Date.now() - this.startedAt) / 1000));
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const text = await transcribeSegment({
          dataBase64: toBase64(bytes),
          mimeType: UPLOAD_MIME,
          priorTail: this.priorTail,
          title: this.title,
          purpose: this.purpose,
        });
        if (!text) return;
        this.priorTail = tailOf(text);
        await sendMessage({ type: 'REC_SEGMENT_READY', id, startSec, endSec, text });
      } catch (error) {
        // One failed segment must not sink the recording — the rest still
        // transcribe, and the gap is visible in the reader's timestamps. But
        // the reason is kept: if EVERY segment fails, silence would leave the
        // user with an empty transcript and nothing to act on.
        console.error('[recorder] segment failed at', startSec, error);
        this.firstError ||= (error as Error)?.message || 'Transcription failed.';
      }
    });
  }

  private async finish(): Promise<void> {
    const id = this.id;
    const durationSeconds = this.startedAt
      ? Math.round((Date.now() - this.startedAt) / 1000)
      : 0;
    this.teardown();
    if (this.live) {
      // The cost of the recording, in the only unit that matters. Measured
      // rather than projected: how much silence-skip saves depends entirely on
      // how much dead air the recording had.
      console.info(
        `[recorder] ${this.stats.transcribed} segments transcribed, ` +
          `${this.stats.skippedSilent} skipped as silent`,
      );
    }
    // Let the in-flight transcriptions land before the worker summarizes.
    await this.queue.catch(() => undefined);
    await sendMessage({
      type: 'REC_CAPTURE_ENDED',
      id,
      durationSeconds,
      error: this.firstError || undefined,
    }).catch(() => undefined);
  }

  private teardown(): void {
    clearTimeout(this.rotateTimer);
    clearInterval(this.vadTimer);
    this.vadTimer = undefined;
    this.analyser = null;
    this.watcher?.stop();
    this.watcher = null;
    for (const stream of this.streams) stream.getTracks().forEach((t) => t.stop());
    this.streams = [];
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.recorder = null;
  }
}

/** Read once per recording — a mid-recording toggle shouldn't change the
 *  rotation strategy underneath a segment. Storage proxies to the worker here. */
async function isLiveEnabled(): Promise<boolean> {
  try {
    return (await getSettings()).assistantLiveEnabled;
  } catch {
    return false;
  }
}

/** chrome.tabCapture hands over a stream id; only getUserMedia can redeem it —
 *  once. Video rides in the same call when the frame watcher wants it. */
function tabStream(streamId: string, withVideo: boolean): Promise<MediaStream> {
  const source = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  return navigator.mediaDevices.getUserMedia({
    audio: { mandatory: source },
    ...(withVideo ? { video: { mandatory: source } } : {}),
    // The constraint shape above is Chrome-specific and absent from lib.dom
  } as unknown as MediaStreamConstraints);
}

