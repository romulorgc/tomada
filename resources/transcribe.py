# -*- coding: utf-8 -*-
"""
Transcricao do Tomada com faster-whisper, rodando no venv do proprio app.

Protocolo (o processo principal e o unico que chama este arquivo, e so por aqui):

  python transcribe.py --check        -> JSON no stdout com o que o ambiente enxerga (GPU, versoes)
  python transcribe.py                -> le UM objeto JSON no stdin, transcreve e escreve UM objeto JSON no stdout

  stdin : {"audio": "<wav>", "modelDir": "<pasta do modelo>", "language": "pt",
           "prompt": "...", "hotwords": "...", "device": "cuda", "computeType": "int8_float16"}
  stdout: {"engine", "model", "language", "duration", "words": [{"text","start","end","prob"}],
           "segments": [{"start","end","text"}], "vad": [{"start","end"}], "stats": {...}}   (tempos em SEGUNDOS)
  stderr: linhas "PROGRESS <0..1>" durante a transcricao; "ERRO: ..." quando falha (codigo de saida 1)

O caminho do audio e do modelo chegam pelo stdin (nunca pela linha de comando) e quem os monta e o processo
principal, a partir de pastas fixas. Nada daqui sai da maquina: HF_HUB_OFFLINE fica ligado.
"""
import json
import os
import sys
import time


def _prepare_environment():
    # tudo local: nenhuma chamada de rede, nenhuma telemetria
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("PYTHONUTF8", "1")
    # CUDA 12 + cuDNN 9 chegam por rodas do pip (nvidia-cublas-cu12, nvidia-cudnn-cu12): as DLLs ficam em
    # <venv>/Lib/site-packages/nvidia/<pacote>/bin e o Windows so as acha se a pasta for registrada ANTES do ctranslate2.
    if os.name == "nt":
        roots = []
        for entry in sys.path:
            candidate = os.path.join(entry, "nvidia")
            if os.path.isdir(candidate):
                roots.append(candidate)
        for root in roots:
            for name in sorted(os.listdir(root)):
                bin_dir = os.path.join(root, name, "bin")
                if os.path.isdir(bin_dir):
                    try:
                        os.add_dll_directory(bin_dir)
                    except OSError:
                        pass
                    os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


def _log(message):
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def _check():
    _prepare_environment()
    info = {"python": sys.version.split()[0]}
    import faster_whisper
    import ctranslate2

    info["fasterWhisper"] = getattr(faster_whisper, "__version__", "?")
    info["ctranslate2"] = ctranslate2.__version__
    info["cudaDevices"] = ctranslate2.get_cuda_device_count()
    info["computeTypes"] = sorted(ctranslate2.get_supported_compute_types("cuda")) if info["cudaDevices"] > 0 else []
    json.dump(info, sys.stdout)
    sys.stdout.flush()


def _run(request):
    _prepare_environment()
    started = time.time()
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    audio_path = request["audio"]
    model_dir = request["modelDir"]
    language = request.get("language") or "pt"
    device = request.get("device") or "cuda"
    compute_type = request.get("computeType") or "int8_float16"

    t0 = time.time()
    model = WhisperModel(model_dir, device=device, compute_type=compute_type)
    load_s = time.time() - t0

    audio = decode_audio(audio_path, sampling_rate=16000)
    duration = len(audio) / 16000.0

    # VAD "justo" (so a fala, sem folga de 400 ms): e ele que diz onde ha fala sem palavra transcrita e onde ha silencio
    tight = get_speech_timestamps(
        audio,
        VadOptions(threshold=0.5, min_speech_duration_ms=80, min_silence_duration_ms=100, speech_pad_ms=30),
        16000,
    )
    vad = [{"start": c["start"] / 16000.0, "end": c["end"] / 16000.0} for c in tight]

    # parametros fixados no projeto
    prompt = request.get("prompt") or "Hum... é, tipo, né? Ãh, então..."
    hotwords = request.get("hotwords") or None
    segments_iter, info = model.transcribe(
        audio,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False,
        beam_size=5,
        initial_prompt=prompt,
        hotwords=hotwords,
        hallucination_silence_threshold=2.0,
    )

    words = []
    segments = []
    t1 = time.time()
    _log("PROGRESS 0")
    last_report = 0.0
    for seg in segments_iter:
        segments.append({"start": seg.start, "end": seg.end, "text": seg.text})
        for w in seg.words or []:
            words.append({"text": w.word, "start": w.start, "end": w.end, "prob": w.probability})
        if duration > 0:
            fraction = min(1.0, max(0.0, seg.end / duration))
            now = time.time()
            if now - last_report >= 0.25:
                last_report = now
                _log("PROGRESS %.3f" % fraction)
    run_s = time.time() - t1
    _log("PROGRESS 1")

    out = {
        "engine": "faster-whisper",
        "model": "large-v3-turbo (%s, %s)" % (device, compute_type),
        "language": getattr(info, "language", language),
        "duration": duration,
        "words": words,
        "segments": segments,
        "vad": vad,
        "stats": {"loadSeconds": load_s, "transcribeSeconds": run_s, "totalSeconds": time.time() - started},
    }
    json.dump(out, sys.stdout, ensure_ascii=False)
    sys.stdout.flush()


def main():
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
            sys.stdin.reconfigure(encoding="utf-8")
        if "--check" in sys.argv[1:]:
            _check()
            return 0
        request = json.loads(sys.stdin.read())
        _run(request)
        return 0
    except Exception as exc:  # noqa: BLE001 - o motivo vai inteiro para o processo principal
        import traceback

        _log("ERRO: %s: %s" % (type(exc).__name__, exc))
        _log(traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
