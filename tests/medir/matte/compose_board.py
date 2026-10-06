# Monta as pranchas comparativas dos candidatos de recorte na gravacao REAL do usuário (so nesta maquina; saida em test-results/matte/, fora do git).
# Le o que matte_bench.py gravou (TOMADA_MATTE_SAIDA, padrao test-results/matte). TIMES=4,10,14,24 escolhe os instantes.
#  - prancha-candidatos.png : por instante, a imagem original e cada candidato composto sobre verde (a borda e as maos aparecem)
#  - prancha-bordas.png     : o mesmo, mas ampliado na cabeca/cabelo e na mao/braco do microfone (recortes de 1:1 do quadro 1080p)
import os, sys
import cv2
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
BASE = os.environ.get('TOMADA_MATTE_SAIDA') or os.path.join(ROOT, 'test-results', 'matte')
MODELS = [
    ('rvm_mobilenetv3_1080p', 'RVM mobilenet 1080p'),
    ('rvm_mobilenetv3_720p', 'RVM mobilenet 720p'),
    ('rvm_resnet50_1080p', 'RVM resnet50 1080p'),
    ('modnet_512', 'MODNet 896x512'),
    ('mediapipe_selfie', 'MediaPipe selfie'),
    ('mediapipe_multiclass', 'MediaPipe multiclasse'),
]
TIMES = [int(x) for x in os.environ.get('TIMES', '4,10,14,24').split(',')]
GREEN = np.array([60, 200, 60], np.float32)


def load(t):
    img = cv2.imread(os.path.join(BASE, 'frames', f't{t}.jpg'))
    return img


def comp(img, alpha):
    a = (alpha.astype(np.float32) / 255.0)[..., None]
    bg = np.empty_like(img, np.float32)
    bg[:] = GREEN[::-1]  # BGR
    return np.clip(img.astype(np.float32) * a + bg * (1 - a), 0, 255).astype(np.uint8)


def label(img, text):
    out = img.copy()
    cv2.rectangle(out, (0, 0), (out.shape[1], 26), (0, 0, 0), -1)
    cv2.putText(out, text, (6, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return out


def alpha_of(name, t):
    p = os.path.join(BASE, name, f't{t}.png')
    if not os.path.exists(p):
        return None
    return cv2.imread(p, cv2.IMREAD_GRAYSCALE)


def board(crop, cell_w, out_name):
    rows = []
    for t in TIMES:
        img = load(t)
        if img is None:
            continue
        x0, y0, x1, y1 = crop(img)
        cells = [label(cv2.resize(img[y0:y1, x0:x1], (cell_w, int(cell_w * (y1 - y0) / (x1 - x0))), interpolation=cv2.INTER_AREA), f't={t}s original')]
        for name, title in MODELS:
            a = alpha_of(name, t)
            if a is None:
                continue
            c = comp(img, a)[y0:y1, x0:x1]
            cells.append(label(cv2.resize(c, (cell_w, cells[0].shape[0]), interpolation=cv2.INTER_AREA), title))
        rows.append(np.hstack(cells))
    if rows:
        w = max(r.shape[1] for r in rows)
        rows = [np.pad(r, ((0, 0), (0, w - r.shape[1]), (0, 0))) for r in rows]
        cv2.imwrite(os.path.join(BASE, out_name), np.vstack(rows), [cv2.IMWRITE_PNG_COMPRESSION, 6])
        print('ok', out_name)


board(lambda im: (0, 0, im.shape[1], im.shape[0]), 330, 'prancha-candidatos.png')
# ampliacao 1:1 em torno da cabeca e do tronco (centro do quadro), onde cabelo, maos e braco do microfone aparecem
board(lambda im: (int(im.shape[1] * 0.28), int(im.shape[0] * 0.05), int(im.shape[1] * 0.78), int(im.shape[0] * 0.95)), 330, 'prancha-bordas.png')
