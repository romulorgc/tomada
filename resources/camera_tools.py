# -*- coding: utf-8 -*-
"""
Analise da camera do Tomada (M4c), rodando no venv do proprio app.

Protocolo (o processo principal e o unico que chama este arquivo, e so por aqui):

  python camera_tools.py --check   -> JSON no stdout com o que o ambiente enxerga (versoes, provedores do ONNX)
  python camera_tools.py           -> le UM objeto JSON no stdin, executa o modo pedido e escreve UM objeto JSON no stdout

  modo "face" (detecta o rosto, uma vez por gravacao; YuNet, licenca MIT):
    stdin : {"mode": "face", "video": "<mp4 da camera>", "model": "<yunet.onnx>", "sampleMs": 200}
    stdout: {"engine": "yunet", "frame": {"w","h"}, "sampleMs", "durationMs",
             "boxes": [{"t": ms no arquivo, "x","y","w","h": 0..1 na imagem, "score"}]}

  stderr: linhas "PROGRESS <0..1>" durante o trabalho; "ERRO: ..." quando falha (codigo de saida 1)

Os caminhos chegam pelo stdin (nunca pela linha de comando) e quem os monta e o processo principal, a partir de pastas fixas.
Nada daqui sai da maquina. O video e lido com o PyAV (que ja vem com o faster-whisper e abre caminho com acento).
"""
import json
import os
import sys
import time


def _prepare_environment():
    os.environ.setdefault("PYTHONUTF8", "1")
    # CUDA 12 + cuDNN 9 chegam por rodas do pip (nvidia-*-cu12): as DLLs ficam em <venv>/Lib/site-packages/nvidia/<pacote>/bin
    # e o Windows so as acha se a pasta for registrada ANTES do onnxruntime.
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
    import cv2
    import numpy
    import av

    info["opencv"] = cv2.__version__
    info["numpy"] = numpy.__version__
    info["av"] = av.__version__
    info["yunet"] = hasattr(cv2, "FaceDetectorYN")
    try:
        import onnxruntime

        info["onnxruntime"] = onnxruntime.__version__
        info["providers"] = onnxruntime.get_available_providers()
    except Exception as exc:  # noqa: BLE001 - sem onnxruntime so o recorte de fundo fica indisponivel
        info["onnxruntime"] = None
        info["providers"] = []
        info["onnxruntimeError"] = "%s: %s" % (type(exc).__name__, exc)
    json.dump(info, sys.stdout)
    sys.stdout.flush()


def _video_info(container, stream):
    """Duracao em ms (pelo fluxo; senao pelo contêiner) e tamanho da imagem."""
    duration_ms = 0.0
    if stream.duration is not None and stream.time_base is not None:
        duration_ms = float(stream.duration * stream.time_base) * 1000.0
    if duration_ms <= 0 and container.duration:
        duration_ms = container.duration / 1000.0  # av.time_base = 1_000_000 us
    return duration_ms, stream.codec_context.width, stream.codec_context.height


def _face(request):
    _prepare_environment()
    import av
    import cv2

    video = request["video"]
    model = request["model"]
    sample_ms = float(request.get("sampleMs") or 200)
    started = time.time()

    container = av.open(video)
    stream = container.streams.video[0]
    stream.thread_type = "AUTO"
    duration_ms, frame_w, frame_h = _video_info(container, stream)
    if frame_w <= 0 or frame_h <= 0:
        raise RuntimeError("a camera nao tem imagem")

    # o detector olha uma versao de 640 px de largura: o rosto continua enorme e a detecao e dezenas de vezes mais rapida
    work_w = min(640, frame_w)
    work_h = max(2, int(round(work_w * frame_h / frame_w)))
    # o modelo entra por BYTES: o OpenCV nao abre caminho com acento no Windows (o PyAV abre)
    import numpy as np

    with open(model, "rb") as fh:
        model_bytes = np.frombuffer(fh.read(), dtype=np.uint8)
    detector = cv2.FaceDetectorYN.create("onnx", model_bytes, np.empty(0, dtype=np.uint8), (work_w, work_h), 0.6, 0.3, 5)

    boxes = []
    looked = 0
    next_t = 0.0
    last_report = 0.0
    _log("PROGRESS 0")
    for frame in container.decode(stream):
        if frame.pts is None:
            continue
        t_ms = float(frame.pts * stream.time_base) * 1000.0
        if t_ms + 1.0 < next_t:
            continue
        next_t = max(next_t + sample_ms, t_ms + sample_ms * 0.5)
        looked += 1
        image = frame.reformat(width=work_w, height=work_h, format="bgr24").to_ndarray()
        _, faces = detector.detect(image)
        if faces is not None and len(faces) > 0:
            # o rosto principal: o maior entre os confiaveis (a pessoa que fala fica perto da camera)
            best = max(faces, key=lambda f: float(f[2]) * float(f[3]) * float(f[14]))
            x, y, w, h = [float(v) for v in best[:4]]
            score = float(best[14])
            x0 = max(0.0, x / work_w)
            y0 = max(0.0, y / work_h)
            x1 = min(1.0, (x + w) / work_w)
            y1 = min(1.0, (y + h) / work_h)
            if x1 - x0 > 0.01 and y1 - y0 > 0.01:
                boxes.append(
                    {
                        "t": round(t_ms, 1),
                        "x": round(x0, 5),
                        "y": round(y0, 5),
                        "w": round(x1 - x0, 5),
                        "h": round(y1 - y0, 5),
                        "score": round(score, 4),
                    }
                )
        now = time.time()
        if duration_ms > 0 and now - last_report >= 0.25:
            last_report = now
            _log("PROGRESS %.3f" % min(1.0, max(0.0, t_ms / duration_ms)))
    container.close()
    _log("PROGRESS 1")

    out = {
        "engine": "yunet",
        "frame": {"w": frame_w, "h": frame_h},
        "sampleMs": sample_ms,
        "durationMs": round(duration_ms, 1),
        "looks": looked,
        "boxes": boxes,
        "stats": {"seconds": round(time.time() - started, 2)},
    }
    json.dump(out, sys.stdout)
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
        mode = request.get("mode")
        if mode == "face":
            _face(request)
        else:
            raise RuntimeError("modo desconhecido: %r" % (mode,))
        return 0
    except Exception as exc:  # noqa: BLE001 - o motivo vai inteiro para o processo principal
        import traceback

        _log("ERRO: %s: %s" % (type(exc).__name__, exc))
        _log(traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
