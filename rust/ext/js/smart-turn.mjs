// Smart Turn v3.2 (pipecat-ai/smart-turn): has the speaker finished, or only
// paused? Loaded on the first Talk: 15 MB of ONNX Runtime and a 9 MB model
// that no other page needs. Both ship unmodified under /ort/ and /smart-turn/
// (scripts/rust-assets.mjs); nothing here leaves the device.
let ready = null;

export function loadSmartTurn() {
  ready ??= (async () => {
    const ort = await import('/ort/ort.wasm.min.mjs');
    ort.env.wasm.wasmPaths = '/ort/';
    // An extension page is not cross-origin isolated: no threads.
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create('/smart-turn/smart-turn-v3.2-cpu.onnx');
    return { ort, session };
  })();
  // A failed load is tried again on the next Talk.
  ready.catch(() => (ready = null));
  return ready.then(() => undefined);
}

/** The chance the turn is over, from 80 x 800 log-mel features (core::smart_turn). */
export async function turnProbability(features) {
  const { ort, session } = await ready;
  const out = await session.run({ input_features: new ort.Tensor('float32', features, [1, 80, 800]) });
  return out.logits.data[0];
}
