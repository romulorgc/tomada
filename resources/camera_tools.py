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

  modo "matte" (recorte do fundo: a mascara da pessoa, em tons de cinza, como VIDEO; RobustVideoMatting em ONNX, na placa de video):
    stdin : {"mode": "matte", "video": "<mp4 da camera>", "out": "<mp4 de saida>", "model": "<rvm.onnx>", "ffmpeg": "<ffmpeg.exe>",
             "maxSide": 1280, "crf": 14}
    stdout: {"engine": "rvm", "device": "cuda"|"cpu", "frames", "fps", "frame": {"w","h"}, "startSeconds", "stats": {...}}
    A saida tem o MESMO tamanho, a MESMA taxa de quadros e a mesma ordem de quadros da camera (cinza: branco = a pessoa).

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


class SlotWriter:
    """Escreve a mascara numa grade fixa de 1/rate s, no MESMO instante em que cada quadro da camera aparece.

    A camera pode ter taxa variavel (quadros que faltam). Cada quadro vale do instante dele ate o do proximo (o render segura o quadro
    anterior), entao um quadro que falta repete o ultimo; dois quadros no mesmo instante: vale o ultimo. `sink(bytes)` recebe um quadro
    por instante da grade, em ordem.
    """

    def __init__(self, sink, rate, start_seconds):
        self.sink = sink
        self.rate = float(rate)
        self.start = float(start_seconds)
        self.pending = None
        self.pending_slot = 0
        self.written = 0

    def slot_of(self, seconds):
        return max(0, int(round((float(seconds) - self.start) * self.rate)))

    def push(self, seconds, payload):
        slot = self.slot_of(seconds)
        if self.pending is None:
            # o primeiro quadro vale desde o inicio da grade
            self.pending = payload
            self.pending_slot = 0
            return
        if slot <= self.pending_slot:
            self.pending = payload
            return
        for _ in range(slot - self.pending_slot):
            self.sink(self.pending)
            self.written += 1
        self.pending = payload
        self.pending_slot = slot

    def finish(self):
        if self.pending is not None:
            self.sink(self.pending)
            self.written += 1
            self.pending = None


def _matte(request):
    _prepare_environment()
    import subprocess
    import threading

    import av
    import numpy as np
    import onnxruntime as ort

    video = request["video"]
    out_path = request["out"]
    model = request["model"]
    ffmpeg = request["ffmpeg"]
    max_side = int(request.get("maxSide") or 1280)
    crf = int(request.get("crf") or 14)
    started = time.time()

    available = ort.get_available_providers()
    providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in available]
    if not providers:
        raise RuntimeError("o onnxruntime nao tem nenhum provedor de execucao")
    session = ort.InferenceSession(model, providers=providers)
    cuda = "CUDAExecutionProvider" in session.get_providers()
    device = "cuda" if cuda else "cpu"
    if not cuda:
        _log("AVISO: sem a placa de video o recorte do fundo roda no processador (bem mais devagar)")

    container = av.open(video)
    stream = container.streams.video[0]
    stream.thread_type = "AUTO"
    duration_ms, frame_w, frame_h = _video_info(container, stream)
    # a taxa da LINHA DO TEMPO da camera (r_frame_rate, a grade em que os instantes dos quadros caem), nao a media: a webcam entrega ~56 qps
    # com a etiqueta de 60, e uma mascara a 56 fixos andaria de 1 a 3 quadros fora do lugar em relacao a camera
    rate = stream.base_rate
    if rate is None or not (5.0 <= float(rate) <= 240.0):
        rate = stream.average_rate or stream.guessed_rate
    if rate is None or float(rate) <= 0:
        raise RuntimeError("a camera nao tem taxa de quadros")
    fps = float(rate)
    start_seconds = float(stream.start_time * stream.time_base) if stream.start_time is not None else 0.0
    total = int(stream.frames) if stream.frames else int(round(duration_ms / 1000.0 * fps))
    # a mascara e calculada (e gravada) numa imagem de no maximo `maxSide` px no lado maior: a de 1080p custa 2x e a borda ja sai
    # suave de qualquer jeito (o render a estica e suaviza); o refinador do RVM cuida do detalhe do cabelo
    scale = min(1.0, max_side / float(max(frame_w, frame_h)))
    out_w = max(2, int(round(frame_w * scale / 2.0)) * 2)
    out_h = max(2, int(round(frame_h * scale / 2.0)) * 2)
    # razao de reducao do RVM: o corpo da rede enxerga ~512 px no lado maior
    dsr = min(1.0, 512.0 / float(max(out_w, out_h)))
    ratio_value = dsr

    # a mascara vira um MP4 em cinza (yuv420p, luma = mascara) com a mesma taxa de quadros: o encoder e o ffmpeg do app
    # a linha do tempo da mascara e a MESMA da camera, em segundos absolutos (o instante k da grade fica em k/rate): sem deslocamento no
    # arquivo (o mp4 o guardaria como lista de edicao, que quem le o arquivo nao aplica) e a camera que comeca depois de 0 e coberta pelo
    # SlotWriter, que segura o primeiro quadro desde o instante 0
    args = [ffmpeg, "-v", "error", "-y"]
    args += ["-f", "rawvideo", "-pix_fmt", "gray", "-s", "%dx%d" % (out_w, out_h), "-r", "%s" % rate, "-i", "-", "-an"]
    args += ["-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-crf", str(crf), "-pix_fmt", "yuv420p", "-g", str(max(1, int(round(fps)))), "-movflags", "+faststart", out_path]
    encoder = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    ffmpeg_err = []

    def drain():
        for raw in iter(lambda: encoder.stderr.readline(), b""):
            ffmpeg_err.append(raw.decode("utf-8", "replace").rstrip())
            del ffmpeg_err[:-20]

    threading.Thread(target=drain, daemon=True).start()

    # o estado recorrente (memoria entre quadros) fica na placa: o que torna a mascara estavel de um quadro para o outro
    z = np.zeros((1, 1, 1, 1), np.float32)
    rec = [ort.OrtValue.ortvalue_from_numpy(z, device, 0) for _ in range(4)]
    ratio = np.array([ratio_value], np.float32)
    def sink(payload):
        try:
            encoder.stdin.write(payload)
        except (BrokenPipeError, OSError):
            raise RuntimeError("o ffmpeg fechou antes da hora: " + " | ".join(ffmpeg_err[-4:]))

    writer = SlotWriter(sink, fps, 0.0)
    done = 0
    last_report = 0.0
    _log("PROGRESS 0")
    try:
        for frame in container.decode(stream):
            rgb = frame.reformat(width=out_w, height=out_h, format="rgb24").to_ndarray()
            src = np.ascontiguousarray(rgb.transpose(2, 0, 1)[None].astype(np.float32) / 255.0)
            io = session.io_binding()
            io.bind_cpu_input("src", src)
            io.bind_cpu_input("downsample_ratio", ratio)
            for i in range(4):
                io.bind_ortvalue_input("r%di" % (i + 1), rec[i])
            io.bind_output("pha", "cpu")
            for i in range(4):
                io.bind_output("r%do" % (i + 1), device, 0)
            session.run_with_iobinding(io)
            outs = io.get_outputs()
            rec = [outs[i + 1] for i in range(4)]
            alpha = np.clip(outs[0].numpy()[0, 0], 0.0, 1.0)
            gray = (alpha * 255.0 + 0.5).astype(np.uint8)
            when = frame.time if frame.time is not None else (start_seconds + done / fps)
            writer.push(when, gray.tobytes())
            done += 1
            now = time.time()
            if total > 0 and now - last_report >= 0.25:
                last_report = now
                _log("PROGRESS %.3f" % min(0.999, done / float(total)))
        writer.finish()
        encoder.stdin.close()
        code = encoder.wait()
    finally:
        container.close()
        if encoder.poll() is None:
            encoder.kill()
    if code != 0:
        raise RuntimeError("o ffmpeg nao conseguiu gravar a mascara: " + " | ".join(ffmpeg_err[-4:]))
    if done == 0:
        raise RuntimeError("a camera nao tem quadros")
    _log("PROGRESS 1")
    seconds = time.time() - started
    json.dump(
        {
            "engine": "rvm",
            "device": device,
            "frames": writer.written,
            "sourceFrames": done,
            "fps": fps,
            "frame": {"w": out_w, "h": out_h},
            "source": {"w": frame_w, "h": frame_h},
            "startSeconds": start_seconds,
            "stats": {"seconds": round(seconds, 2), "msPerFrame": round(seconds * 1000.0 / done, 2)},
        },
        sys.stdout,
    )
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
        elif mode == "matte":
            _matte(request)
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
