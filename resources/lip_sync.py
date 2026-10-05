"""SyncNet local: JSON pelo stdin/stdout; nenhuma rede ou mídia persistida.

Offset positivo = imagem atrasada: o render amostra o vídeo MAIS À FRENTE.
O modelo MIT de Chung/Zisserman é preparado em ONNX fora dos projetos.
"""
import json
import math
import os
from pathlib import Path
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


def measure_embeddings(image, sound, shift=7):
    """Mesmo custo euclidiano do SyncNet; bordas sem padding e mínimo subquadro."""
    count = min(len(image), len(sound))
    if count <= 2 * shift + 10:
        return {"offsetMs": 0., "confidence": 0.}
    video = image[shift:count - shift]
    distances = np.array([np.linalg.norm(video - sound[shift + k:count - shift + k], axis=1).mean()
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


def speaking_windows(audio):
    """Até quatro janelas de 6 s de maior atividade, sem medir longos silêncios."""
    duration = len(audio) / 16000
    if duration < 2:
        return []
    length = min(6., duration)
    candidates = []
    for start in np.arange(0, max(.01, duration - length + .01), .5):
        clip = audio[round(start * 16000):round((start + length) * 16000)].astype(float)
        rms = np.sqrt(np.mean(clip ** 2))
        if rms >= 12:
            candidates.append((rms, float(start), length))
    windows = []
    for _, start, length in sorted(candidates, reverse=True):
        if all(abs(start - s) >= length * .8 for s, _ in windows):
            windows.append((start, length))
        if len(windows) == 4:
            break
    return sorted(windows)


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


def lip_sync(request):
    full = audio_samples(request, duration=1800)
    # Microfone muito baixo altera o coeficiente de energia do MFCC. Normalizar a amplitude,
    # sem mudar uma única amostra no tempo, evita confundir volume com dessincronia.
    peak = float(np.max(np.abs(full.astype(float)))) if len(full) else 0.
    if peak > 0:
        full = full.astype(float) * (28000 / peak)
    if "startMs" in request:
        windows = [(max(0., float(request["startMs"]) / 1000), min(12., float(request.get("durationMs", 6000)) / 1000))]
    else:
        windows = speaking_windows(full)
    if not windows:
        return {"detector": "syncnet", "segments": [], "offsetMs": None, "confidence": 0, "reason": "Sem fala suficiente para medir a sincronia."}
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
        result = measure_embeddings(np.concatenate(visual), np.concatenate(acoustic))
        segments.append({"startMs": round(start * 1000), "durationMs": round(duration * 1000), **result})
    accepted = [s for s in segments if s["confidence"] >= 3]
    center = float(np.median([s["offsetMs"] for s in accepted])) if accepted else 0.
    accepted = [s for s in accepted if abs(s["offsetMs"] - center) <= 40]
    valid = len(accepted) >= 2
    return {"detector": "syncnet", "provider": lip.get_providers()[0], "segments": segments,
            "offsetMs": round(float(np.median([s["offsetMs"] for s in accepted])), 2) if valid else None,
            "confidence": round(float(np.median([s["confidence"] for s in accepted])), 4) if valid else 0,
            **({} if valid else {"reason": "Sem dois trechos de rosto falando com confiança suficiente."})}


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


def visual_hand_contact(frames, audio_time, fps=100):
    """Duas regiões de pele abaixo do rosto convergem, unem-se e recuam. Ambiguidade é rejeição.

    Critério físico conservador, sem modelo novo: não infere mãos de movimento global.
    Luvas, oclusão, pouca luz ou braço ligado ao rosto podem exigir nova tentativa/manual.
    """
    import cv2
    from itertools import combinations
    if not len(frames):
        return None
    height, width = frames.shape[1:3]
    cache = {}
    def regions(index):
        if index < 0 or index >= len(frames): return []
        if index in cache: return cache[index]
        color = cv2.cvtColor(frames[index], cv2.COLOR_BGR2YCrCb)
        mask = cv2.inRange(color, np.array([20, 133, 77], dtype=np.uint8), np.array([245, 180, 135], dtype=np.uint8))
        # Exclui a região usual do rosto/cabeça e bordas, sem aceitar clarão da imagem inteira.
        mask[:round(height * .35)] = 0
        mask[round(height * .95):] = 0
        mask[:, :round(width * .05)] = 0
        mask[:, round(width * .95):] = 0
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        _, _, stats, centers = cv2.connectedComponentsWithStats(mask)
        selected = [(stat, center) for stat, center in zip(stats[1:], centers[1:])
                    if .004 * height * width <= stat[4] <= .15 * height * width and .25 <= stat[2] / max(1, stat[3]) <= 4]
        cache[index] = sorted(selected, key=lambda region: region[1][0])
        return cache[index]
    def gap(pair):
        return pair[1][0][0] - (pair[0][0][0] + pair[0][0][2])
    def track(origin, candidates, inward=0):
        # Acompanhamento local de área/altura; um rosto estável não substitui mão móvel.
        matches = []
        for region in candidates:
            dx, dy = region[1] - origin[1]
            if abs(dx) > width * .25 or abs(dy) > height * .06: continue
            if not .65 * origin[0][4] <= region[0][4] <= 1.5 * origin[0][4]: continue
            if inward and inward * dx < width * .025: continue
            matches.append((abs(dx) + abs(dy), region))
        return min(matches, key=lambda match: match[0])[1] if matches else None
    contacts = []
    for index in range(max(12, round((audio_time - .3) * fps)), min(len(frames) - 12, round((audio_time + .3) * fps) + 1)):
        snapshots = [regions(t) for t in [index - 12, index - 6, index, index + 6, index + 12]]
        # Muitas regiões são ambíguas e não devem disparar busca combinatória ilimitada.
        if any(len(snapshot) > 12 for snapshot in snapshots): continue
        before_regions, approach_regions, touch_regions, recoil_regions, after_regions = snapshots
        for before in combinations(before_regions, 2):
            if gap(before) < width * .12 or abs(before[0][1][1] - before[1][1][1]) > height * .12: continue
            approach = [track(before[0], approach_regions, 1), track(before[1], approach_regions, -1)]
            after = [track(before[0], after_regions), track(before[1], after_regions)]
            if any(region is None for region in [*approach, *after]): continue
            if approach[0] is approach[1] or after[0] is after[1]: continue
            if gap(after) < width * .12: continue
            recoil = [track(after[0], recoil_regions, 1), track(after[1], recoil_regions, -1)]
            if any(region is None for region in recoil) or recoil[0] is recoil[1]: continue
            if not gap(before) > gap(approach) + width * .05 or not gap(after) > gap(recoil) + width * .05: continue
            center = (before[0][1] + before[1][1]) / 2
            area = before[0][0][4] + before[1][0][4]
            for touch in touch_regions:
                dx, dy = touch[1] - center
                if abs(dx) > width * .08 or abs(dy) > height * .06: continue
                if not .65 * area <= touch[0][4] <= 1.35 * area: continue
                contacts.append((index, touch[1]))
    if not contacts or max(t[0] for t in contacts) - min(t[0] for t in contacts) > 4:
        return None
    # Dois contatos em posições distintas também são ambíguos, mesmo no mesmo instante.
    if any(abs(center[0] - contacts[0][1][0]) > width * .08 or abs(center[1] - contacts[0][1][1]) > height * .06 for _, center in contacts):
        return None
    return min(t[0] for t in contacts) / fps


def clap_sync(request):
    audio = audio_samples(request, duration=5, rate=48000).astype(float)
    audio_time = single_clap_time(audio)
    if audio_time is None:
        return {"offsetMs": None, "confidence": 0, "reason": "Não encontrei uma única palma curta. Grave de novo em silêncio e bata só uma palma."}
    frames = video_frames(request, 0, 5, fps=100)
    contact = visual_hand_contact(frames, audio_time)
    if contact is None:
        return {"offsetMs": None, "confidence": 0, "reason": "Não vi duas mãos se aproximando, encostando e se afastando. Mostre as mãos abaixo do rosto e tente novamente."}
    return {"offsetMs": round((contact - audio_time) * 1000, 1), "confidence": 4}


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
