# Mede candidatos de recorte de fundo (RVM mobilenetv3 e resnet50, MODNet; MediaPipe no venv do MediaPipe com ONLY=mediapipe_selfie) na camera REAL do usuário.
# Roda no venv do app (onnxruntime-gpu), pela fila pesada. Os resultados (JSON, quadros e mascaras) vao para test-results/matte/ (fora do git; tem a cara do usuário).
# Entradas por variavel de ambiente (padroes entre parenteses):
#   TOMADA_MATTE_VIDEO    a gravacao real     (gravacoes/2026-07-26-13-57-59/camera.mp4)
#   TOMADA_MATTE_MODELOS  pasta dos modelos   (%LOCALAPPDATA%/Tomada/models/matte-bench: rvm_mobilenetv3_fp32.onnx, rvm_resnet50_fp32.onnx,
#                         modnet_xenova.onnx, selfie_segmenter.tflite, selfie_multiclass_256x256.tflite; baixados so para medir)
#   TOMADA_MATTE_SAIDA    a saida             (test-results/matte)
# Outras: ONLY=<nomes separados por virgula>, CPU=1 (so o processador), MAX_FRAMES=<n>. Depois: compose_board.py monta as pranchas.
import json, os, sys, time
if os.name == 'nt':
    # as DLLs do CUDA/cuDNN (rodas nvidia-*-cu12 do venv do app) so sao achadas se a pasta for registrada ANTES do onnxruntime (igual ao camera_tools.py)
    for _entry in list(sys.path):
        _root = os.path.join(_entry, 'nvidia')
        if os.path.isdir(_root):
            for _name in sorted(os.listdir(_root)):
                _bin = os.path.join(_root, _name, 'bin')
                if os.path.isdir(_bin):
                    try:
                        os.add_dll_directory(_bin)
                    except OSError:
                        pass
                    os.environ['PATH'] = _bin + os.pathsep + os.environ.get('PATH', '')
import numpy as np, av, cv2
try:
    import onnxruntime as ort
except ImportError:  # venv do MediaPipe
    ort = None

if ort is not None and hasattr(ort, 'preload_dlls'):
    try:
        ort.preload_dlls()
    except Exception as e:  # noqa
        print('preload_dlls:', e, file=sys.stderr)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
VIDEO = os.environ.get('TOMADA_MATTE_VIDEO') or os.path.join(ROOT, 'gravacoes', '2026-07-26-13-57-59', 'camera.mp4')
MODELS = os.environ.get('TOMADA_MATTE_MODELOS') or os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Tomada', 'models', 'matte-bench')
OUT = os.environ.get('TOMADA_MATTE_SAIDA') or os.path.join(ROOT, 'test-results', 'matte')
KEY_T = [2, 4, 8, 10, 12, 14, 18, 24]
MAX_FRAMES = int(os.environ.get('MAX_FRAMES', '0')) or None
ONLY = [s for s in os.environ.get('ONLY', '').split(',') if s]
PROV = ['CUDAExecutionProvider', 'CPUExecutionProvider']
if os.environ.get('CPU') == '1':
    PROV = ['CPUExecutionProvider']


class RVM:
    def __init__(self, name, file, scale, dsr):
        self.name = name
        self.sess = ort.InferenceSession(os.path.join(MODELS, file), providers=PROV)
        self.cuda = 'CUDAExecutionProvider' in self.sess.get_providers()
        self.scale = scale
        self.dsr = np.array([dsr], np.float32)
        dev = 'cuda' if self.cuda else 'cpu'
        z = np.zeros((1, 1, 1, 1), np.float32)
        self.rec = [ort.OrtValue.ortvalue_from_numpy(z, dev, 0) for _ in range(4)]
        self.dev = dev

    def step(self, rgb):
        if self.scale != 1.0:
            h, w = rgb.shape[:2]
            rgb = cv2.resize(rgb, (int(w * self.scale), int(h * self.scale)), interpolation=cv2.INTER_AREA)
        src = np.ascontiguousarray(rgb.transpose(2, 0, 1)[None].astype(np.float32) / 255.0)
        io = self.sess.io_binding()
        io.bind_cpu_input('src', src)
        io.bind_cpu_input('downsample_ratio', self.dsr)
        for i in range(4):
            io.bind_ortvalue_input(f'r{i + 1}i', self.rec[i])
        io.bind_output('pha', 'cpu')
        for i in range(4):
            io.bind_output(f'r{i + 1}o', self.dev, 0)
        self.sess.run_with_iobinding(io)
        outs = io.get_outputs()
        self.rec = [outs[i + 1] for i in range(4)]
        return outs[0].numpy()[0, 0]


class MODNet:
    def __init__(self, name, file, size=(896, 512)):
        self.name = name
        self.sess = ort.InferenceSession(os.path.join(MODELS, file), providers=PROV)
        self.cuda = 'CUDAExecutionProvider' in self.sess.get_providers()
        self.size = size

    def step(self, rgb):
        x = cv2.resize(rgb, self.size, interpolation=cv2.INTER_AREA).astype(np.float32)
        x = (x / 255.0 - 0.5) / 0.5
        x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
        out = self.sess.run(None, {'input': x})[0]
        return out[0, 0]


class MediaPipeSeg:
    '''MediaPipe Selfie Segmentation (API de tarefas, tflite/XNNPACK na CPU). multiclass: alfa = 1 - fundo.'''

    def __init__(self, name, file, multiclass=False):
        import mediapipe as mp
        from mediapipe.tasks import python as mpt
        from mediapipe.tasks.python import vision
        self.mp = mp
        self.name = name
        self.cuda = False
        self.multiclass = multiclass
        opts = vision.ImageSegmenterOptions(
            base_options=mpt.BaseOptions(model_asset_path=os.path.join(MODELS, file)),
            running_mode=vision.RunningMode.IMAGE,
            output_confidence_masks=True,
            output_category_mask=False,
        )
        self.seg = vision.ImageSegmenter.create_from_options(opts)

    def step(self, rgb):
        img = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        r = self.seg.segment(img)
        if self.multiclass:
            return 1.0 - r.confidence_masks[0].numpy_view()[:, :, 0].astype(np.float32)
        return r.confidence_masks[0].numpy_view()[:, :, 0].astype(np.float32)


def build():
    if ONLY == ['mediapipe_selfie']:
        return [MediaPipeSeg('mediapipe_selfie', 'selfie_segmenter.tflite'), MediaPipeSeg('mediapipe_multiclass', 'selfie_multiclass_256x256.tflite', True)]
    ms = [
        RVM('rvm_mobilenetv3_1080p', 'rvm_mobilenetv3_fp32.onnx', 1.0, 0.25),
        RVM('rvm_mobilenetv3_720p', 'rvm_mobilenetv3_fp32.onnx', 2 / 3, 0.4),
        RVM('rvm_resnet50_1080p', 'rvm_resnet50_fp32.onnx', 1.0, 0.25),
        RVM('rvm_resnet50_720p', 'rvm_resnet50_fp32.onnx', 2 / 3, 0.4),
        MODNet('modnet_512', 'modnet_xenova.onnx', (896, 512)),
    ]
    return [m for m in ms if not ONLY or m.name in ONLY]


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(OUT, 'frames'), exist_ok=True)
    models = build()
    for m in models:
        print(m.name, 'CUDA' if m.cuda else 'CPU', flush=True)
        os.makedirs(os.path.join(OUT, m.name), exist_ok=True)
    stats = {m.name: dict(t=[], sum_abs=0.0, n=0, edge_abs=0.0, edge_n=0, flips=0, flip_n=0, area=0.0, prev=None) for m in models}
    motion = dict(sum=0.0, n=0, prev=None)
    c = av.open(VIDEO)
    s = c.streams.video[0]
    s.thread_type = 'AUTO'
    key_left = list(KEY_T)
    idx = 0
    t0 = time.perf_counter()
    for fr in c.decode(video=0):
        if MAX_FRAMES and idx >= MAX_FRAMES:
            break
        rgb = fr.to_ndarray(format='rgb24')
        tsec = float(fr.time) if fr.time is not None else idx / 60
        small_rgb = cv2.resize(rgb, (480, 270), interpolation=cv2.INTER_AREA)
        luma = cv2.cvtColor(small_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
        if motion['prev'] is not None:
            motion['sum'] += float(np.abs(luma - motion['prev']).mean())
            motion['n'] += 1
        motion['prev'] = luma
        is_key = bool(key_left) and tsec >= key_left[0]
        if is_key:
            kt = key_left.pop(0)
            cv2.imwrite(os.path.join(OUT, 'frames', f't{kt}.jpg'), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
        for m in models:
            st = stats[m.name]
            a0 = time.perf_counter()
            alpha = m.step(rgb)
            dt = (time.perf_counter() - a0) * 1000
            if idx >= 5:
                st['t'].append(dt)
            a = cv2.resize(alpha, (480, 270), interpolation=cv2.INTER_AREA).astype(np.float32)
            st['area'] += float(a.mean())
            if st['prev'] is not None:
                d = np.abs(a - st['prev'])
                st['sum_abs'] += float(d.mean())
                st['n'] += 1
                edge = (np.maximum(a, st['prev']) > 0.05) & (np.minimum(a, st['prev']) < 0.95)
                st['edge_abs'] += float(d[edge].sum())
                st['edge_n'] += int(edge.sum())
                st['flips'] += int(((a > 0.5) != (st['prev'] > 0.5)).sum())
                st['flip_n'] += a.size
            st['prev'] = a
            if is_key:
                full = cv2.resize(alpha, (1920, 1080), interpolation=cv2.INTER_LINEAR)
                cv2.imwrite(os.path.join(OUT, m.name, f't{kt}.png'), np.clip(full * 255.0 + 0.5, 0, 255).astype(np.uint8))
        idx += 1
        if idx % 200 == 0:
            print(f'{idx} quadros, {time.perf_counter() - t0:.0f}s', flush=True)
    res = {}
    for m in models:
        st = stats[m.name]
        ts = np.array(st['t']) if st['t'] else np.array([0.0])
        res[m.name] = dict(
            device='CUDA' if m.cuda else 'CPU',
            frames=idx,
            ms_mean=round(float(ts.mean()), 2),
            ms_p50=round(float(np.percentile(ts, 50)), 2),
            ms_p95=round(float(np.percentile(ts, 95)), 2),
            fps=round(1000.0 / float(ts.mean()), 1),
            flicker_mean_abs=round(st['sum_abs'] / max(1, st['n']), 5),
            flicker_edge_abs=round(st['edge_abs'] / max(1, st['edge_n']), 4),
            flip_fraction_x1e4=round(st['flips'] / max(1, st['flip_n']) * 1e4, 3),
            area_mean=round(st['area'] / max(1, idx), 4),
        )
    res['_movimento_entrada_mean_abs'] = round(motion['sum'] / max(1, motion['n']), 5)
    path = os.path.join(OUT, 'resultados-' + ('-'.join(ONLY) if ONLY else 'onnx') + '.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(res, f, indent=2)
    print(json.dumps(res, indent=2))


if __name__ == '__main__':
    main()
