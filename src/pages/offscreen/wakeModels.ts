import { createWakeDetector, type OrtLike, type WakeDetector } from '../../shared/ai/wakeDetector';

/**
 * Load the three openWakeWord models and hand back a detector.
 *
 * Everything about where the bytes come from lives here, so wakeDetector.ts
 * stays free of it and remains testable without a 13 MB WASM runtime.
 *
 * The '/wasm' subpath entry is what makes this work under MV3. ORT's default
 * behaviour is to fetch its runtime from a CDN, which an extension may not do —
 * remote code is forbidden outright. The bundled entry instead references the
 * WASM as a build asset, so Vite emits it alongside the code and rewrites the
 * URL to a chrome-extension:// one. Nothing is fetched off-origin.
 *
 * `numThreads = 1` is not optional either: the threaded build wants
 * SharedArrayBuffer, which needs a cross-origin isolation an offscreen document
 * does not have. Three models this small run on one thread in well under a
 * millisecond.
 */

let detector: Promise<WakeDetector> | null = null;

async function build(): Promise<WakeDetector> {
  // The '/wasm' subpath, not the package root: the root entry pulls in the
  // WebGPU (jsep) backend, whose 26 MB WASM the bundler then emits as an asset
  // we never load. CPU is ample for three models this size.
  const ort = (await import('onnxruntime-web/wasm')) as unknown as OrtLike & {
    env: { wasm: { numThreads: number } };
    InferenceSession: { create(path: string, opts?: unknown): Promise<never> };
  };
  ort.env.wasm.numThreads = 1;

  const url = (name: string) => chrome.runtime.getURL(`models/${name}`);
  const [mel, embed, wake] = await Promise.all([
    ort.InferenceSession.create(url('melspectrogram.onnx')),
    ort.InferenceSession.create(url('embedding_model.onnx')),
    ort.InferenceSession.create(url('hey_jarvis_v0.1.onnx')),
  ]);
  return createWakeDetector(ort as unknown as OrtLike, { mel, embed, wake });
}

/** Memoized: the models are loaded once per offscreen document, not per session */
export function loadWakeDetector(): Promise<WakeDetector> {
  detector ??= build().catch((error) => {
    detector = null; // let a later attempt retry rather than cache the failure
    throw error;
  });
  return detector;
}
