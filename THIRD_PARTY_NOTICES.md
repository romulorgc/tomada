# Third-party notices

Tomada is released under the [AGPL-3.0](LICENSE). It builds on the work below. Each
component keeps its own license.

## Included in this repository

| Component | Where | License |
| --- | --- | --- |
| SyncNet model code (Joon Son Chung, Andrew Zisserman) | `resources/vendor/syncnet/SyncNetModel.py` | MIT, see `resources/vendor/syncnet/LICENSE.md` |
| YuNet face detector license text (OpenCV Zoo) | `resources/vendor/syncnet/LICENSE-YuNet.txt` | MIT |
| Anton, Inter and Montserrat fonts | `src/renderer/assets/fonts/` | SIL Open Font License 1.1, see the `OFL-*.txt` files |

## npm dependencies (runtime)

| Package | License |
| --- | --- |
| electron (dev dependency, bundles Chromium) | MIT |
| react, react-dom | MIT |
| zustand | MIT |
| zod | MIT |
| koffi | MIT |
| mediabunny | MPL-2.0 (compatible with the AGPL-3.0 through MPL-2.0 section 3.3) |
| @fontsource-variable/inter | OFL-1.1 |

Development dependencies (TypeScript, Vite, Vitest, Playwright, Tailwind CSS and others) are
not distributed with the app.

## Downloaded on first run, not distributed in this repository

The app prepares these on the user's computer, from the publishers' own servers. Tomada does
not redistribute them.

| Component | Source | License |
| --- | --- | --- |
| faster-whisper, CTranslate2 | PyPI | MIT |
| Whisper large-v3 turbo weights and whisper.cpp | Hugging Face, GitHub | MIT |
| Silero VAD (ggml build) | Hugging Face | MIT |
| YuNet face detector model | OpenCV Zoo on GitHub | MIT |
| RobustVideoMatting (ResNet50, ONNX) | GitHub release v1.0.0 | GPL-3.0 |
| onnxruntime, opencv-python-headless, PyAV | PyPI | their own licenses |
| NVIDIA CUDA runtime wheels (cuBLAS, cuDNN) | PyPI | NVIDIA's own license |

RobustVideoMatting is licensed under the GPL-3.0. Tomada downloads it separately and runs it
as a model file. It is never bundled in this repository.

## Provided by the user

- **ffmpeg** is not included. The app uses the copy on your `PATH` or the one you choose in
  Settings. Its license depends on the build you installed.
- **Claude Code** is not included. Tomada runs the copy you installed and signed in to.
