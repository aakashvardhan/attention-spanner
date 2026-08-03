# Third-party models

Wake-word detection uses the pretrained openWakeWord pipeline, vendored here
rather than downloaded at runtime — an extension cannot fetch remote code, and a
build that reaches the network is a build that breaks when the network does.

| File | Origin |
| --- | --- |
| `melspectrogram.onnx` | [openWakeWord](https://github.com/dscripka/openWakeWord) v0.5.1 |
| `embedding_model.onnx` | openWakeWord v0.5.1, derived from Google's [speech_embedding](https://tfhub.dev/google/speech_embedding/1) |
| `hey_jarvis_v0.1.onnx` | openWakeWord v0.5.1 pretrained "hey jarvis" model |

openWakeWord is Apache-2.0. The speech embedding model it builds on is also
Apache-2.0.

These run entirely on-device. Audio reaching the wake detector never leaves the
machine — only the command spoken *after* the wake word is transcribed, and on
Chrome that is the browser's own recognizer.
