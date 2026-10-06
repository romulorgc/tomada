"""SyncNet local: JSON pelo stdin/stdout; nenhuma rede ou mídia persistida.

Offset positivo = imagem atrasada: o render amostra o vídeo MAIS À FRENTE.
O modelo MIT de Chung/Zisserman é preparado em ONNX fora dos projetos.
"""
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import numpy as np


def mfcc(audio, sample_rate=16000):
    """MFCC do SyncNet: 13 coeficientes, 26 filtros, 25/10 ms, sem janela Hamming."""
    from scipy.fft import dct
    signal = np.asarray(audio, dtype=np.float64)
    signal = np.append(signal[0], signal[1:] - .97 * signal[:-1])
    length, step = round(.025 * sample_rate), round(.010 * sample_rate)
    count = 1 + max(0, math.ceil((len(signal) - length) / step))
    padded = np.pad(signal, (0, max(0, (count - 1) * step + length - len(signal))))
    indices = np.arange(length)[None, :] + np.arange(count)[:, None] * step
    power = np.abs(np.fft.rfft(padded[indices], 512)) ** 2 / 512
    energy = np.maximum(power.sum(axis=1), np.finfo(float).eps)
    mel = np.linspace(0, 2595 * np.log10(1 + sample_rate / 1400), 28)
    bins = np.floor(513 * (700 * (10 ** (mel / 2595) - 1)) / sample_rate).astype(int)
    filters = np.zeros((26, 257))
    for i in range(26):
        a, b, c = bins[i:i + 3]
        filters[i, a:b] = (np.arange(a, b) - a) / max(1, b - a)
        filters[i, b:c] = (c - np.arange(b, c)) / max(1, c - b)
    features = np.log(np.maximum(power @ filters.T, np.finfo(float).eps))
    cepstra = dct(features, type=2, axis=1, norm="ortho")[:, :13]
    cepstra *= 1 + 11 * np.sin(np.pi * np.arange(13) / 22)
    cepstra[:, 0] = np.log(energy)
    return cepstra.astype(np.float32)


def measure_embeddings(image, sound, shift=7, active=None):
    """Mesmo custo euclidiano do SyncNet; bordas sem padding e mínimo subquadro.

    `active` (um booleano por embedding) restringe a média aos instantes COM fala: o SyncNet foi treinado com
    fala contínua, e quadros de silêncio só somam distância ao acaso e diluem a confiança.
    """
    count = min(len(image), len(sound))
    if count <= 2 * shift + 10:
        return {"offsetMs": 0., "confidence": 0.}
    video = image[shift:count - shift]
    chosen = np.ones(len(video), dtype=bool) if active is None else np.asarray(active, dtype=bool)[shift:count - shift]
    if chosen.sum() < 20:   # menos de 0,8 s de fala: não há o que medir
        return {"offsetMs": 0., "confidence": 0.}
    distances = np.array([np.linalg.norm(video - sound[shift + k:count - shift + k], axis=1)[chosen].mean()
                          for k in range(-shift, shift + 1)])
    best = int(distances.argmin())
    correction = 0.
    if 0 < best < len(distances) - 1:
        a, b, c = distances[best - 1:best + 2]
        denom = a - 2 * b + c
        if denom > 1e-6:
            correction = float(np.clip(.5 * (a - c) / denom, -.5, .5))
    confidence = float(np.median(distances) - distances[best])
    # Mínimo na borda indica atraso fora da busca: jamais transforme em correção confiável.
    if best in (0, len(distances) - 1):
        confidence = 0.
    return {"offsetMs": round((shift - best - correction) * 40, 2), "confidence": round(confidence, 4)}


def absolute(value):
    if not isinstance(value, str) or not os.path.isabs(value) or value.startswith("-"):
        raise ValueError("Caminho de mídia inválido.")
    return value


def ff_bytes(ff, args):
    process = subprocess.run([absolute(ff), "-hide_banner", "-loglevel", "error", "-nostdin", *args],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
    if process.returncode:
        raise RuntimeError("Não consegui decodificar a mídia para medir a sincronia.")
    return process.stdout


def audio_samples(request, start=0, duration=None, rate=16000):
    source = absolute(request.get("audio") or request["video"])
    args = ["-ss", str(start), "-i", source]
    if duration is not None:
        args += ["-t", str(duration)]
    args += ["-vn", "-ac", "1", "-ar", str(rate), "-af", "aresample=async=1:first_pts=0", "-f", "s16le", "pipe:1"]
    return np.frombuffer(ff_bytes(request["ffmpeg"], args), dtype="<i2").copy()


def video_frames(request, start, duration, fps=25):
    # Dimensões fixas para delimitar os quadros do pipe; proporção preservada com barras.
    data = ff_bytes(request["ffmpeg"], ["-ss", str(start), "-i", absolute(request["video"]), "-t", str(duration),
                    "-an", "-vf", f"fps={fps}:start_time=0,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2",
                    "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"])
    return np.frombuffer(data, dtype=np.uint8).reshape(-1, 360, 640, 3)


def speech_activity(audio):
    """Quadros de 40 ms com fala, medidos no nível ORIGINAL do arquivo (RMS em unidades de int16).

    Decidir depois de normalizar o volume não barra nada: o ruído de um microfone mudo, ampliado mil vezes,
    vira "fala". Piso absoluto de 25 (cerca de -62 dBFS) e 4x o piso de ruído da própria gravação.
    """
    samples = np.asarray(audio, dtype=float)
    count = len(samples) // 640
    if not count:
        return np.zeros(0, dtype=bool)
    envelope = np.sqrt((samples[:count * 640].reshape(count, 640) ** 2).mean(axis=1))
    low, high = float(np.percentile(envelope, 10)), float(np.percentile(envelope, 95))
    if high < 4 * max(low, 1.):   # sem sílabas e pausas (12 dB entre o forte e o fraco): chiado estacionário, não fala
        return np.zeros(count, dtype=bool)
    return envelope > max(4 * min(low, .1 * high), 25.)


def speaking_windows(active, length=6., limit=4):
    """Até quatro janelas de `length` s com a MAIOR FRAÇÃO de fala (não o maior volume: cliques de mouse
    e de teclado têm volume e nenhuma boca). Janela com menos de 25% de fala não entra."""
    if len(active) < 2.5 * 25:
        return []
    size = min(round(length * 25), len(active))
    candidates = []
    for first in range(0, len(active) - size + 1, 12):
        fraction = float(active[first:first + size].mean())
        if fraction >= .25 and fraction * size * .04 >= 1.2:
            candidates.append((fraction, first / 25, size / 25))
    windows = []
    for _, start, span in sorted(candidates, reverse=True):
        if all(abs(start - other) >= span * .8 for other, _ in windows):
            windows.append((start, span))
        if len(windows) == limit:
            break
    return sorted(windows)


def speech_gain(audio, active):
    """Ganho que leva o RMS dos quadros com fala a ~3000 (nível do exemplo oficial); nunca por pico, porque
    um clique de teclado a -24 dBFS num microfone com fala a -50 dBFS é quem manda no pico."""
    samples = np.asarray(audio, dtype=float)
    count = min(len(active), len(samples) // 640)
    spoken = samples[:count * 640].reshape(count, 640)[np.asarray(active[:count], dtype=bool)]
    return 3000. / max(float(np.sqrt(np.mean(spoken ** 2))), 1.) if spoken.size else 1.


def face_crops(frames, model=None):
    import cv2
    from scipy.signal import medfilt
    yunet = Path(model).parent / "yunet.onnx" if model else None
    detector = (cv2.FaceDetectorYN.create(str(yunet), "", (640, 360), .8, .3, 1000)
                if yunet and yunet.exists() else None)
    fallback = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    marks = []
    for i in range(0, len(frames), 3):
        if detector:
            _, faces = detector.detect(frames[i])
            faces = [] if faces is None else faces[:, :4]
        else:
            faces = fallback.detectMultiScale(cv2.cvtColor(frames[i], cv2.COLOR_BGR2GRAY), 1.1, 5, minSize=(45, 45))
        # Vários rostos: não adivinhar quem fala.
        if len(faces) == 1:
            x, y, w, h = faces[0]
            marks.append((i, x + w / 2, y + h / 2, max(w, h) / 2))
    if len(marks) < max(5, len(frames) / 3 * .60):
        return None
    marks = np.array(marks)
    positions = [medfilt(np.interp(np.arange(len(frames)), marks[:, 0], marks[:, col]), 13) for col in (1, 2, 3)]
    crops = []
    for image, x, y, size in zip(frames, *positions):
        # Recorte oficial: quadrado deslocado para baixo, inclui boca e queixo.
        pad = int(size * 1.8) + 1
        padded = np.pad(image, ((pad, pad), (pad, pad), (0, 0)), constant_values=110)
        crop = padded[int(y + pad - size):int(y + pad + size * 1.8),
                      int(x + pad - size * 1.4):int(x + pad + size * 1.4)]
        crops.append(cv2.resize(crop, (224, 224)))
    return np.stack(crops)


def sessions(model):
    # DLLs CUDA já instaladas pelo faster-whisper; sem tocar em PATH global.
    handles = []
    if os.name == "nt":
        site = Path(sys.prefix) / "Lib" / "site-packages" / "nvidia"
        for folder in site.glob("*/bin"):
            handles.append(os.add_dll_directory(str(folder)))
            os.environ["PATH"] = str(folder) + os.pathsep + os.environ.get("PATH", "")
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 2
    opts.log_severity_level = 3
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    lip = ort.InferenceSession(str(Path(model).with_suffix(".lip.onnx")), opts, providers=providers)
    aud = ort.InferenceSession(str(Path(model).with_suffix(".aud.onnx")), opts, providers=providers)
    return lip, aud, handles


def few_speech(seconds):
    """Por que a medição não teve confiança: quase sempre falta fala (o exemplo oficial tem mais de 12 s)."""
    if seconds < 12:
        return (f"Só encontrei {seconds:.0f} s de fala nesta gravação, pouco para medir a sincronia pela boca "
                "(o ideal é a partir de 12 s, de frente para a câmera, com boa luz e o microfone mais perto).")
    return "Sem dois trechos de rosto falando com confiança suficiente."


def lip_sync(request):
    full = audio_samples(request, duration=1800).astype(float)
    # Fala e silêncio se decidem no nível ORIGINAL da gravação; o volume só é ajustado por janela, depois.
    active = speech_activity(full)
    if "startMs" in request:
        windows = [(max(0., float(request["startMs"]) / 1000), min(12., float(request.get("durationMs", 6000)) / 1000))]
        if request.get("preCropped"):
            active = np.ones(len(active), dtype=bool)   # o exemplo oficial é fala contínua, recortada à mão
    else:
        windows = speaking_windows(active)
    if not windows:
        silent = len(full) == 0 or float(np.max(np.abs(full))) < 100
        reason = ("Esta gravação não tem voz: o microfone gravou silêncio. Confira se o microfone certo estava ligado e sem mudo."
                  if silent else "Há pouca fala nesta gravação para medir a sincronia (menos de uns 2 segundos juntos, de frente para a câmera).")
        return {"detector": "syncnet", "segments": [], "offsetMs": None, "confidence": 0, "reason": reason}
    lip, aud, handles = sessions(absolute(request["model"]))
    segments = []
    for start, duration in windows:
        frames = video_frames(request, start, duration)
        if request.get("preCropped"):
            import cv2
            # O exemplo oficial já vem recortado em 224×224; retirar somente as barras do pipe.
            crops = np.stack([cv2.resize(frame[:, 140:500], (224, 224)) for frame in frames])
        else:
            crops = face_crops(frames, request["model"])
        if crops is None:
            continue
        audio = full[round(start * 16000):round((start + duration) * 16000)]
        spoken = active[round(start * 25):round(start * 25) + len(audio) // 640]
        # Microfone baixo altera o coeficiente de energia do MFCC: leva a fala a um nível comum, sem mexer no tempo.
        audio = audio * speech_gain(audio, spoken)
        shift_samples = round(float(request.get("audioShiftMs", 0)) * 16)
        if shift_samples > 0:
            audio = np.pad(audio, (shift_samples, 0))[:len(audio)]
        elif shift_samples < 0:
            audio = np.pad(audio[-shift_samples:], (0, -shift_samples))
        features = mfcc(audio).T
        count = min(len(crops) - 5, (features.shape[1] - 20) // 4 + 1)
        visual, acoustic = [], []
        for i in range(0, count, 10):
            ends = range(i, min(count, i + 10))
            images = np.stack([crops[t:t + 5].transpose(3, 0, 1, 2) for t in ends]).astype(np.float32)
            sounds = np.stack([features[:, t * 4:t * 4 + 20][None] for t in ends]).astype(np.float32)
            visual.append(lip.run(None, {"input": images})[0])
            acoustic.append(aud.run(None, {"input": sounds})[0])
        if not visual:
            continue
        # O embedding t cobre 0,2 s (5 quadros de 40 ms): conta como fala se ao menos 3 deles têm fala.
        padded = np.append(spoken, np.zeros(5, dtype=bool))
        speaking = np.array([padded[t:t + 5].sum() >= 3 for t in range(count)])
        result = measure_embeddings(np.concatenate(visual), np.concatenate(acoustic), active=speaking)
        segments.append({"startMs": round(start * 1000), "durationMs": round(duration * 1000), **result})
    accepted = [s for s in segments if s["confidence"] >= 3]
    center = float(np.median([s["offsetMs"] for s in accepted])) if accepted else 0.
    accepted = [s for s in accepted if abs(s["offsetMs"] - center) <= 40]
    valid = len(accepted) >= 2
    return {"detector": "syncnet", "provider": lip.get_providers()[0], "segments": segments,
            "offsetMs": round(float(np.median([s["offsetMs"] for s in accepted])), 2) if valid else None,
            "confidence": round(float(np.median([s["confidence"] for s in accepted])), 4) if valid else 0,
            "speechSeconds": round(float(active.sum()) * .04, 1),
            **({} if valid else {"reason": few_speech(float(active.sum()) * .04)})}


def single_clap_time(audio):
    """Um único transiente curto, com silêncio antes/depois. Duas palmas são ambíguas."""
    block = 96
    if len(audio) < 48000:
        return None
    envelope = np.max(np.abs(audio[:len(audio) // block * block].reshape(-1, block)), axis=1)
    peak = float(envelope.max())
    if peak < 800 or peak / max(100, np.median(envelope)) < 8:
        return None
    active = np.flatnonzero(envelope > max(800, peak * .2, np.median(envelope) * 8))
    groups = np.split(active, np.flatnonzero(np.diff(active) > 20) + 1)
    if len(groups) != 1 or not len(groups[0]) or (groups[0][-1] - groups[0][0]) * .002 > .08:
        return None
    time = float(groups[0][0]) * .002
    return time if .4 < time < 4.6 else None


def native_frames(request, duration=5, size=(480, 270)):
    """Quadros nos instantes REAIS do contêiner (pts), sem reamostrar a taxa nenhuma.

    A câmera real varia de 15 a 60 qps e muda com a luz do quarto; reamostrar a 100 qps inventaria quadros
    repetidos e esconderia onde a imagem realmente mudou. O tempo de cada quadro vem do `showinfo`.
    """
    width, height = size
    filters = (f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
               f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,showinfo")
    process = None
    for mode in (["-fps_mode", "passthrough"], ["-vsync", "0"]):
        process = subprocess.run([absolute(request["ffmpeg"]), "-hide_banner", "-loglevel", "info", "-nostdin",
                                  "-i", absolute(request["video"]), "-t", str(duration), "-an", *mode,
                                  "-vf", filters, "-pix_fmt", "bgr24", "-f", "rawvideo", "pipe:1"],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120, check=False)
        if process.returncode == 0:
            break
    if process is None or process.returncode:
        raise RuntimeError("Não consegui decodificar a mídia para medir a sincronia.")
    times = np.array([float(value) for value in re.findall(
        r"Parsed_showinfo[^\n]*?pts_time:\s*(-?[0-9.]+)", process.stderr.decode("utf-8", "ignore"))])
    data = np.frombuffer(process.stdout, dtype=np.uint8)
    if len(data) % (width * height * 3):
        raise RuntimeError("Não consegui ler os quadros do vídeo da calibração.")
    frames = data.reshape(-1, height, width, 3)
    # O filtro pode ver uns quadros além do corte de `-t`; o que o pipe entregou são os primeiros.
    if len(times) < len(frames):
        raise RuntimeError("Não consegui ler os instantes dos quadros do vídeo da calibração.")
    return frames, times[:len(frames)]


def face_box(frames, times, audio_time, model):
    """Maior rosto (mediana de várias detecções perto da palma); sem modelo ou sem rosto, None."""
    if not model or not os.path.isfile(model) or not len(frames):
        return None
    import cv2
    height, width = frames.shape[1:3]
    detector = cv2.FaceDetectorYN.create(str(model), "", (width, height), .7, .3, 50)
    near = np.flatnonzero((times >= audio_time - 1.2) & (times <= audio_time + .4))
    boxes = []
    for index in near[::max(1, len(near) // 12)]:
        _, faces = detector.detect(frames[index])
        if faces is not None and len(faces):
            boxes.append(max(faces[:, :4], key=lambda box: box[2] * box[3]))
    return tuple(float(value) for value in np.median(boxes, axis=0)) if len(boxes) >= 3 else None


def hand_contact(frames, times, audio_time, face=None, window=.35):
    """Instante em que as duas mãos se encontram: {"time", ...} ou {"reason": motivo}.

    Não depende de cor de pele (parede, porta e piso claros enganam a máscara): usa só MOVIMENTO entre
    quadros vizinhos, numa faixa abaixo do rosto. Antes do contato há dois blocos de movimento, um de
    cada lado, e o vão entre as pontas internas deles diminui de quadro em quadro; no contato o vão some.
    O instante do contato sai da reta (vão × tempo) pelos tempos REAIS dos quadros, então vale de 15 a
    60 qps (a incerteza é o intervalo entre o último quadro com vão e o seguinte). Quadros repetidos pela
    câmera não entram. Sem convergência, sem as duas mãos, sem as mãos pararem ou se afastarem depois, ou
    com dois encontros distintos: rejeição com o motivo.
    """
    import cv2
    times = np.asarray(times, dtype=float)
    count = len(frames)
    if count < 8 or times[-1] - times[0] <= 0 or (count - 1) / (times[-1] - times[0]) < 9:
        return {"reason": "slow"}
    height, width = frames.shape[1:3]
    top = round(height * .35) if face is None else int(np.clip(face[1] + face[3] * .85, height * .30, height * .75))
    left, right = round(width * .01), width - round(width * .01)
    zone_height, zone = height - top, (height - top) * (right - left)
    kernel = max(3, round(width * .008)) | 1
    hole = max(2, round(width * .006))      # buraco de poucas colunas dentro de uma mão não é vão
    touch = max(2., width * .02)            # vão menor que isto conta como mãos juntas
    floor_gap = .06 * width                 # abaixo disto o vão medido já é ruído de borda/borrão, não distância
    lit_min = max(3., .04 * zone_height)    # linhas em movimento para uma coluna "acesa"
    lo = max(1, int(np.searchsorted(times, audio_time - window - .5)))
    hi = min(count - 1, int(np.searchsorted(times, audio_time + window + .6)))
    blurred = {}

    def blur(index):
        if index not in blurred:
            blurred[index] = cv2.GaussianBlur(frames[index][top:, left:right], (kernel, kernel), 0).astype(np.int16)
        return blurred[index]

    kept, profiles, previous = [], {}, lo - 1
    for index in range(lo, hi + 1):
        small = np.abs(frames[index][::3, ::3].astype(np.int16) - frames[previous][::3, ::3])
        if small.mean() < .5 and np.percentile(small, 99.9) <= 4:
            continue   # a câmera repetiu o quadro: não há imagem nova neste instante
        now, before = blur(index), blur(previous)
        # Exposição automática multiplica a imagem toda; o ganho típico dos pixels (a mediana) sai da conta, e depois
        # o deslocamento médio (clarão). O que sobra é o que de fato se mexeu.
        sample_now, sample_before = now[::3, ::3].reshape(-1, 3).astype(np.float32), before[::3, ::3].reshape(-1, 3).astype(np.float32)
        usable = sample_before.min(axis=1) > 30
        gain = np.clip(np.median(sample_now[usable] / sample_before[usable], axis=0), .8, 1.25) if usable.sum() > 200 else np.ones(3, np.float32)
        change = now - (before * gain).astype(np.int16) if np.abs(gain - 1).max() > .01 else now - before   # ganho de ruído não conta
        change -= np.median(change.reshape(-1, 3), axis=0).astype(np.int16)
        magnitude = np.abs(change).max(axis=2)
        moving = (magnitude > max(9., 3 * 1.48 * float(np.median(magnitude)))).astype(np.uint8)   # acima do ruído do sensor
        moving &= (cv2.boxFilter(moving, -1, (3, 3), normalize=False) >= 3).astype(np.uint8)   # tira pontos soltos; mantém traços finos
        kept.append(index)
        profiles[index] = moving.sum(axis=0).astype(float) if moving.sum() <= .55 * zone else None
        blurred.pop(previous, None)
        previous = index
    if not any(profile is not None for profile in profiles.values()):
        return {"reason": "none"}

    def centre_of(profile):
        return float((profile * np.arange(len(profile))).sum() / max(profile.sum(), 1e-9))

    def state(profile, meet, seed):
        """("two", vão, massa, centro do vão), ("merged", 0, massa), ("side", 0, massa) ou None.

        `seed` = primeira passada, com o ponto de encontro só estimado (aceita o vão mais próximo dele);
        depois o ponto de encontro sai do vão do fim da aproximação e o vão tem de CONTÊ-LO, pois no meio de
        mão que se move há também "vãos" no miolo da própria mão (a máscara de movimento é oca)."""
        if profile is None:
            return ("flash", 0., 0.)   # mudança na imagem toda: não diz nada sobre as mãos, nem que pararam
        lit = profile >= lit_min
        total = float(profile[lit].sum())
        if total < .004 * zone:
            return None
        columns = np.flatnonzero(lit)
        floor = max(.12 * total, .002 * zone)
        best = None
        for j in np.flatnonzero(np.diff(columns) > hole + 1):
            a, b = int(columns[j]) + 1, int(columns[j + 1]) - 1
            if profile[:a][lit[:a]].sum() < floor or profile[b + 1:][lit[b + 1:]].sum() < floor:
                continue
            distance = 0 if a <= meet <= b else (min(abs(a - meet), abs(b - meet)) if seed else None)
            if distance is not None and (best is None or (distance, -(b - a)) < best[0]):
                best = ((distance, -(b - a)), b - a + 1, (a, b))
        if best is not None and best[1] > touch / 2:
            return ("two", best[1], total, best[2])  # (…, (início, fim) do vão)
        meet = int(round(meet))
        if min(profile[:meet][lit[:meet]].sum(), profile[meet:][lit[meet:]].sum()) >= floor:
            return ("merged", 0., total)
        return ("side", 0., total)

    def find_events(meet, seed):
        states = [state(profiles[index], meet, seed) for index in kept]
        found = []
        for n, end in enumerate(kept):
            here = states[n]
            if here is None or here[0] != "two" or here[1] <= floor_gap:
                continue
            following = states[n + 1] if n + 1 < len(kept) else None
            near = following is not None and times[kept[n + 1]] - times[end] <= .3
            # Ainda se aproximando: o vão do quadro seguinte é menor e com força de movimento parecida. Se a força
            # despencou, é o quadro das mãos que pararam e voltaram (a máscara guarda o "fantasma" do quadro anterior).
            if near and following[0] == "two" and floor_gap < following[1] < here[1] - .01 * width and following[2] >= .5 * here[2]:
                continue
            approach = []
            for m in range(n, -1, -1):
                earlier = states[m]
                if earlier is None or earlier[0] != "two" or earlier[1] <= floor_gap or times[end] - times[kept[m]] > .4 \
                        or (approach and earlier[1] < approach[-1][1] - .01 * width):
                    break
                approach.append((kept[m], earlier[1], earlier[3]))
                if len(approach) == 5:
                    break
            approach.reverse()
            if len(approach) < 2 or approach[0][1] < .10 * width or approach[0][1] - approach[-1][1] < .04 * width:
                continue
            # A reta usa só o fim da aproximação (o mais recente que já cobre 60 ms): o começo é mão se apressando.
            recent = approach
            while len(recent) > 2 and times[end] - times[recent[1][0]] >= .06:
                recent = recent[1:]
            instants = np.array([times[j] for j, _, _ in recent])
            gaps = np.array([gap for _, gap, _ in recent], dtype=float)
            slope, intercept = np.polyfit(instants, gaps, 1)
            if slope >= 0:
                continue
            # Duas mãos fecham o vão pelos DOIS lados. Uma mão só, rápida, deixa a máscara "antes e depois" dela mesma
            # (dois blocos que andam juntos para o mesmo lado): não é palma.
            closure = approach[0][1] - approach[-1][1]
            if min(approach[-1][2][0] - approach[0][2][0], approach[0][2][1] - approach[-1][2][1]) < .2 * closure:
                continue
            joined = near and (following[0] == "merged" or (following[0] == "two" and following[1] <= floor_gap))
            # Prazo: o quadro em que as mãos já aparecem juntas ou, se pararam de repente, o próximo quadro. Se o
            # próximo quadro ainda mostra um vãozinho (perto, mas sem encostar), o encontro cai logo depois dele.
            following_time = float(times[kept[n + 1]]) if n + 1 < len(kept) else float(times[end])
            deadline = following_time + (following_time - float(instants[-1]) if joined and following[0] == "two" else 0.)
            deadline = min(deadline, float(times[end]) + .15)
            # As bordas acesas engordam um pouco: o quadro "juntas" aparece até ~1% da largura antes do encontro real.
            contact = float(np.clip(-intercept / slope, instants[-1], deadline + min(.01 * width / -slope, .3 * (deadline - instants[-1]))))
            if not joined and not seed:
                # Sem as mãos juntas no quadro seguinte: ou o vão ainda encolheu bastante, ou as mãos pararam já bem
                # perto; e o vão que sobra tem de caber no intervalo até esse quadro (senão pararam no meio do caminho).
                if following is not None and following[0] == "flash":
                    continue
                if near and following[0] == "two":
                    if following[1] > .95 * gaps[-1]:
                        continue
                elif gaps[-1] > .12 * width:
                    continue
                if gaps[-1] / -slope > 1.2 * (deadline - instants[-1]) + .02:
                    continue
            # O ponto de encontro está dentro do vão de TODOS os quadros da aproximação: interseção dos vãos largos.
            wide = [run for _, gap, run in approach if gap >= .5 * approach[0][1]]
            start, stop = max(run[0] for run in wide), min(run[1] for run in wide)
            centre = (start + stop) / 2 if start <= stop else (approach[0][2][0] + approach[0][2][1]) / 2
            found.append({"time": contact, "index": n, "centre": centre, "first": approach[0][0], "frames": len(approach),
                          "interval": following_time - float(instants[-1]), "gaps": [round(float(g)) for g in gaps],
                          "peak": max(states[kept.index(j)][2] for j, _, _ in approach), "states": states})
        # Quadros fantasma depois do contato formam "aproximações" mais longas da mesma mão: vale o fim mais cedo.
        earliest = {}
        for event in found:
            if event["first"] not in earliest or event["index"] < earliest[event["first"]]["index"]:
                earliest[event["first"]] = event
        return list(earliest.values())

    strong = [(profile.sum(), centre_of(profile)) for index, profile in profiles.items()
              if profile is not None and abs(times[index] - audio_time) <= window]
    if not strong:
        return {"reason": "none"}
    biggest = max(mass for mass, _ in strong)
    meet = float(np.median([centre for mass, centre in strong if mass >= .5 * biggest]))
    events = find_events(meet, True)
    if events:   # o ponto de encontro real está no vão do fim da aproximação (contém o encontro de todos os quadros antes)
        first = min(events, key=lambda event: abs(event["time"] - audio_time))
        events = find_events(first["centre"], False)
    events = [event for event in events if abs(event["time"] - audio_time) <= window + .35]
    if not events:
        return {"reason": "none"}
    chosen = min(events, key=lambda event: abs(event["time"] - audio_time))
    if abs(chosen["time"] - audio_time) > window:
        return {"reason": "none"}
    # Outro encontro de mãos, de força parecida e em outro instante: não dá para saber qual foi a palma.
    if any(abs(event["time"] - chosen["time"]) > .12 and event["peak"] >= .5 * chosen["peak"] for event in events):
        return {"reason": "ambiguous"}
    # Passado o borrão do fim da aproximação (80 ms), as mãos têm de continuar se mexendo: afastar-se, recuar.
    # Mãos coladas e paradas não provam que a palma foi aquela.
    after = [state[2] for n, state in enumerate(chosen["states"])
             if state and chosen["time"] + .08 < times[kept[n]] <= chosen["time"] + .6]
    if max(after, default=0.) < .08 * chosen["peak"]:
        return {"reason": "stuck"}
    return {"time": chosen["time"], "frames": chosen["frames"], "interval": chosen["interval"], "gaps": chosen["gaps"]}


def visual_hand_contact(frames, audio_time, fps=100, times=None, face=None):
    """Contato das duas mãos (segundos) ou None. `times` são os instantes reais; sem eles, `fps` fixo."""
    instants = np.arange(len(frames)) / fps if times is None else times
    return hand_contact(frames, instants, audio_time, face).get("time")


CLAP_REASONS = {
    "slow": "A câmera gravou devagar demais (menos de 10 quadros por segundo). Feche outros programas que usam a câmera e acenda mais a luz.",
    "face": "Não vi o seu rosto. Fique de frente para a câmera, com o rosto inteiro à mostra e boa luz.",
    "none": "Não vi as duas mãos se aproximando e se encontrando. Mostre as duas mãos abaixo do rosto, bem abertas, junte-as numa palma só e abra de novo logo depois.",
    "ambiguous": "Vi mais de um movimento de mãos. Fique parado, só as mãos se mexem, e bata uma palma só.",
    "stuck": "As mãos ficaram juntas e paradas depois da palma. Bata e abra as mãos logo em seguida.",
    "lost": "A câmera perdeu quadros justo na hora da palma. Feche outros programas que usam a câmera e tente de novo."
}


def clap_sync(request):
    audio = audio_samples(request, duration=5, rate=48000).astype(float)
    audio_time = single_clap_time(audio)
    if audio_time is None:
        return {"offsetMs": None, "confidence": 0, "reason": "Não encontrei uma única palma curta. Grave de novo em silêncio e bata só uma palma."}
    frames, times = native_frames(request)
    model = absolute(request["faceModel"]) if request.get("faceModel") else None
    if model and not os.path.isfile(model):   # pedido com modelo de rosto que não existe: nunca cair numa zona fixa
        raise RuntimeError("Falta o modelo de rosto da sincronia (yunet.onnx). Prepare a sincronia neste computador.")
    face = face_box(frames, times, audio_time, model)
    if face is None and model:
        return {"offsetMs": None, "confidence": 0, "reason": CLAP_REASONS["face"]}
    found = hand_contact(frames, times, audio_time, face)
    if "time" not in found:
        reason = CLAP_REASONS[found["reason"]]
        rate = (len(times) - 1) / (times[-1] - times[0]) if len(times) > 1 and times[-1] > times[0] else 0
        if found["reason"] == "none" and 9 <= rate < 24:
            reason += f" A câmera gravou só {round(rate)} quadros por segundo: aproxime as mãos mais devagar, em meio segundo."
        return {"offsetMs": None, "confidence": 0, "reason": reason + " Tente de novo."}
    if found["interval"] > .09:   # faltaram quadros justo na palma: a medida teria mais de ~1 quadro de incerteza
        return {"offsetMs": None, "confidence": 0, "reason": CLAP_REASONS["lost"]}
    return {"offsetMs": round((found["time"] - audio_time) * 1000, 1), "confidence": 4}


if __name__ == "__main__":
    try:
        # -I ignora PYTHONUTF8; o stdin do Node é UTF-8 mesmo no Windows (caminho com ô).
        sys.stdin.reconfigure(encoding="utf-8")
        request = json.load(sys.stdin)
        result = clap_sync(request) if request.get("mode") == "clap" else lip_sync(request)
        print(json.dumps(result, allow_nan=False))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True), file=sys.stderr)
        sys.exit(1)
