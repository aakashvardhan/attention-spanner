/**
 * Microphone capture and encoding shared by the two things that record speech:
 * the lecture/meeting recorder in the offscreen document, and the cloud STT
 * engine that stands in for the Web Speech API where it does not exist.
 *
 * These lived in recorder.ts until cloudStt.ts needed the same four pieces.
 * They are here rather than there because recorder.ts is offscreen-only and
 * cloudStt runs in extension pages too — importing one into the other would
 * drag the whole recorder into every page bundle.
 */

/** What MediaRecorder produces. The codecs parameter is dropped for the API,
 *  which wants a bare type. */
export const RECORDER_MIME = 'audio/webm;codecs=opus';
export const UPLOAD_MIME = 'audio/webm';

/** Chunked so a multi-megabyte segment can't blow the argument limit. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Speech, mono. Echo cancellation off — it is tuned for a far-end voice that
 *  does not exist here, and it eats quiet speech. */
export function micStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, noiseSuppression: true, echoCancellation: false },
  });
}

export function micErrorMessage(error: unknown): string {
  const name = (error as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError') {
    return 'Microphone blocked — allow it in Settings → Assistant, then try again.';
  }
  if (name === 'NotFoundError') return 'No microphone found.';
  return (error as Error)?.message || 'Could not start recording.';
}

/** Did getUserMedia fail because permission was refused, rather than for some
 *  other reason? Decides whether a caller reports 'denied' or 'other'. */
export function isPermissionError(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? '';
  return name === 'NotAllowedError' || name === 'SecurityError';
}
