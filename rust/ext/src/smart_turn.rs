//! Smart Turn in the page, through js/smart-turn.mjs (ONNX Runtime Web). The
//! features are reader_core::smart_turn; this only loads the model and asks it.

use js_sys::{Float32Array, Promise};
use reader_core::smart_turn::{features, COMPLETE_ABOVE};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

#[wasm_bindgen(module = "/js/smart-turn.mjs")]
extern "C" {
    #[wasm_bindgen(js_name = loadSmartTurn)]
    fn load_smart_turn() -> Promise;
    #[wasm_bindgen(js_name = turnProbability)]
    fn turn_probability(features: &Float32Array) -> Promise;
}

/// Fetch and start the model; false when it cannot run here.
pub async fn load() -> bool {
    JsFuture::from(load_smart_turn()).await.is_ok()
}

/// Whether the speaker of `audio` (16 kHz, from core's `turn_audio`) has
/// finished. `None`: the model could not say.
// ponytail: features and inference run on the page's thread, ~0.2 s while
// nobody is speaking. A worker if the orb ever stutters at a pause.
pub async fn finished(audio: &[f32]) -> Option<bool> {
    let input = Float32Array::from(features(audio).as_slice());
    let p = JsFuture::from(turn_probability(&input)).await.ok()?;
    Some(p.as_f64()? as f32 > COMPLETE_ABOVE)
}
