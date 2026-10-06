import { describe, expect, it } from 'vitest'
import {
  FACE_DEADZONE,
  FACE_GAP_MS,
  FACE_HEADROOM_Y,
  FACE_MAX_AUTO_ZOOM,
  FACE_TARGET_H,
  FaceFormatError,
  autoZoomFor,
  buildFaceFramer,
  cameraCropRect,
  faceAimAt,
  faceCoverage,
  panFraming,
  parseFaceTrack,
  resolveFraming,
  type FaceBox,
  type FaceTrack
} from '@shared/face'
import { coverCrop } from '@shared/styles'

const CAM = { w: 1280, h: 720 }

/** Um rosto de caixa `w × h` (fração da câmera) centrado em (cx, cy), olhado de `sampleMs` em `sampleMs`. */
function box(t: number, cx: number, cy: number, w = 0.14, h = 0.3): FaceBox {
  return { t, x: cx - w / 2, y: cy - h / 2, w, h, score: 0.95 }
}

function track(boxes: FaceBox[], over: Partial<FaceTrack> = {}): FaceTrack {
  const last = boxes[boxes.length - 1]?.t ?? 0
  return { version: 1, engine: 'teste', frame: CAM, sampleMs: 200, durationMs: last + 200, boxes, createdAt: '2026-10-05T00:00:00.000Z', ...over }
}

/** Uma série: `fn(t)` dá o centro do rosto a cada 200 ms durante `ms`. */
function series(ms: number, fn: (t: number) => { cx: number; cy: number } | null, step = 200): FaceBox[] {
  const out: FaceBox[] = []
  for (let t = 0; t <= ms; t += step) {
    const c = fn(t)
    if (c) out.push(box(t, c.cx, c.cy))
  }
  return out
}

describe('camera-face.json: ler e validar', () => {
  it('lê, ordena por tempo e descarta caixa sem tamanho', () => {
    const text = JSON.stringify({
      version: 1,
      engine: 'yunet',
      frame: { w: 1280, h: 720 },
      sampleMs: 200,
      durationMs: 1000,
      boxes: [
        { t: 400, x: 0.4, y: 0.2, w: 0.1, h: 0.3, score: 0.9 },
        { t: 200, x: 0.41, y: 0.2, w: 0.1, h: 0.3, score: 0.9 },
        { t: 600, x: 0.4, y: 0.2, w: 0, h: 0.3, score: 0.9 }
      ],
      campoNovo: 'preservado sem erro'
    })
    const t = parseFaceTrack(text)
    expect(t.boxes.map((b) => b.t)).toEqual([200, 400])
    expect(t.engine).toBe('yunet')
    expect(t.frame).toEqual({ w: 1280, h: 720 })
  })

  it('JSON quebrado ou sem o tamanho da câmera vira erro com o motivo', () => {
    expect(() => parseFaceTrack('{nao e json')).toThrow(FaceFormatError)
    expect(() => parseFaceTrack(JSON.stringify({ version: 1, boxes: [] }))).toThrow(/frame/)
    expect(() => parseFaceTrack(JSON.stringify({ version: 1, frame: { w: 1, h: 1 }, boxes: [{ t: Number.NaN }] }))).toThrow(FaceFormatError)
  })

  it('cobertura: rostos achados sobre os olhares do detector', () => {
    const full = track(series(10_000, () => ({ cx: 0.5, cy: 0.4 })), { durationMs: 10_200 })
    expect(faceCoverage(full)).toBeCloseTo(1, 1)
    const half = track(series(10_000, (t) => (t < 5000 ? { cx: 0.5, cy: 0.4 } : null)), { durationMs: 10_000 })
    expect(faceCoverage(half)).toBeCloseTo(0.5, 1)
  })
})

describe('o caminho do rosto (zona morta + mola)', () => {
  it('sem rosto ou sem duração não há caminho (o recorte volta ao centro)', () => {
    expect(buildFaceFramer(null, 0, 10_000)).toBeNull()
    expect(buildFaceFramer(track([]), 0, 10_000)).toBeNull()
    expect(buildFaceFramer(track(series(1000, () => ({ cx: 0.5, cy: 0.4 }))), 0, 0)).toBeNull()
  })

  it('rosto parado: o centro fica no rosto o tempo todo', () => {
    const f = buildFaceFramer(track(series(10_000, () => ({ cx: 0.62, cy: 0.38 }))), 0, 10_000)!
    for (const t of [0, 3000, 9999]) {
      const a = faceAimAt(f, t)
      expect(a.cx).toBeCloseTo(0.62, 3)
      expect(a.cy).toBeCloseTo(0.38, 3)
    }
    expect(f.faceH).toBeCloseTo(0.3, 5)
    expect(f.faceW).toBeCloseTo(0.14, 5)
  })

  it('tremor do detector DENTRO da zona morta não mexe o recorte (zero tremor)', () => {
    let i = 0
    const jitter = (t: number) => ({ cx: 0.5 + ((i++ % 2) * 2 - 1) * 0.012, cy: 0.4 + ((t / 200) % 3 === 0 ? 0.012 : -0.012) })
    const f = buildFaceFramer(track(series(20_000, jitter)), 0, 20_000)!
    const xs = f.cx.slice(30)
    const spread = Math.max(...xs) - Math.min(...xs)
    expect(spread).toBeLessThan(0.002)
    const ys = f.cy.slice(30)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.002)
  })

  it('uma detecção errada no meio (o rosto "pula" por um olhar) é tirada pela mediana', () => {
    const boxes = series(10_000, () => ({ cx: 0.5, cy: 0.4 }))
    boxes[25] = box(boxes[25]!.t, 0.9, 0.7) // um quadro com o detector enganado
    const f = buildFaceFramer(track(boxes), 0, 10_000)!
    const worst = Math.max(...f.cx.map((v) => Math.abs(v - 0.5)))
    expect(worst).toBeLessThan(0.001)
  })

  it('a pessoa se desloca de verdade: o recorte a acompanha, devagar, sem salto, e assenta perto do rosto', () => {
    // até 10 s no 0,35; depois no 0,6
    const f = buildFaceFramer(track(series(30_000, (t) => ({ cx: t < 10_000 ? 0.35 : 0.6, cy: 0.4 }))), 0, 30_000)!
    const before = faceAimAt(f, 9900).cx
    expect(before).toBeCloseTo(0.35, 2)
    // monotônico e sem degrau: no máximo 2% da largura por quadro de 30 Hz (a resposta a um salto de 25% da imagem)
    let prev = f.cx[0]!
    let maxStep = 0
    let monotonic = true
    for (let i = 1; i < f.cx.length; i++) {
      const d = f.cx[i]! - prev
      maxStep = Math.max(maxStep, Math.abs(d))
      if (d < -1e-6) monotonic = false
      prev = f.cx[i]!
    }
    expect(monotonic).toBe(true)
    expect(maxStep).toBeLessThan(0.02)
    // 1 s depois de o rosto parar de andar já está perto; no fim está na zona morta do rosto
    expect(Math.abs(faceAimAt(f, 21_000).cx - 0.6)).toBeLessThanOrEqual(FACE_DEADZONE.x + 0.01)
    expect(faceAimAt(f, 29_000).cx).toBeGreaterThan(0.6 - FACE_DEADZONE.x - 0.005)
  })

  it('buraco curto de detecção é ligado em linha reta; buraco longo mantém o enquadramento onde estava', () => {
    // 0-3 s no 0,3 · buraco de 1 s · 4-7 s no 0,7 (o rosto passou de um lado ao outro durante o buraco)
    const near = [...series(3000, () => ({ cx: 0.3, cy: 0.4 })), ...series(7000, () => ({ cx: 0.7, cy: 0.4 })).filter((b) => b.t >= 4000)]
    const f1 = buildFaceFramer(track(near), 0, 7000)!
    expect(faceAimAt(f1, 3500).cx).toBeGreaterThan(0.3) // já a caminho
    // buraco de 8 s (maior que FACE_GAP_MS): fica no último lugar visto, não anda para o próximo
    expect(8000).toBeGreaterThan(FACE_GAP_MS)
    const far = [...series(3000, () => ({ cx: 0.3, cy: 0.4 })), ...series(15_000, () => ({ cx: 0.7, cy: 0.4 })).filter((b) => b.t >= 11_000)]
    const f2 = buildFaceFramer(track(far), 0, 15_000)!
    expect(faceAimAt(f2, 7000).cx).toBeCloseTo(0.3, 2)
    expect(faceAimAt(f2, 14_900).cx).toBeGreaterThan(0.6)
  })

  it('o deslocamento da câmera (sync) leva o tempo do arquivo ao tempo de origem', () => {
    const boxes = series(20_000, (t) => ({ cx: t < 10_000 ? 0.3 : 0.7, cy: 0.4 }))
    const a = buildFaceFramer(track(boxes), 0, 20_000)!
    const b = buildFaceFramer(track(boxes), 2000, 22_000)!
    // o mesmo movimento, 2 s mais tarde no relógio da gravação
    expect(faceAimAt(b, 12_000 + 1000).cx).toBeCloseTo(faceAimAt(a, 10_000 + 1000).cx, 2)
  })

  it('é determinístico', () => {
    const t = track(series(10_000, (x) => ({ cx: 0.4 + 0.1 * Math.sin(x / 1500), cy: 0.4 })))
    expect(buildFaceFramer(t, 120, 10_000)).toEqual(buildFaceFramer(t, 120, 10_000))
  })
})

describe('o recorte da câmera', () => {
  const PORTRAIT = 3 / 4
  const inside = (r: { x: number; y: number; w: number; h: number }): boolean => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9

  it('sem rosto é o recorte "cobrir" do centro, como sempre foi', () => {
    expect(cameraCropRect(CAM, PORTRAIT, null)).toEqual(coverCrop(CAM, PORTRAIT))
    expect(cameraCropRect(CAM, 16 / 9, null)).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('o rosto longe do centro (0,8): o quadro em pé o centraliza em vez de cortar a cabeça', () => {
    const aim = { cx: 0.8, cy: 0.4, faceW: 0.14, faceH: 0.3 }
    const r = cameraCropRect(CAM, PORTRAIT, aim)
    const center = r.x + r.w / 2
    // o recorte é uma faixa estreita: o centro dele chega perto do rosto (limitado pela borda da imagem)
    expect(center).toBeGreaterThan(0.7)
    expect(inside(r)).toBe(true)
    // e o rosto (x 0,73-0,87) cabe dentro do recorte
    expect(r.x).toBeLessThan(0.8 - 0.07)
    expect(r.x + r.w).toBeGreaterThan(0.8 + 0.07)
  })

  it('a aproximação automática põe o rosto na altura-alvo do quadro (e nunca afasta nem passa do teto)', () => {
    const base = coverCrop(CAM, PORTRAIT)
    expect(autoZoomFor({ faceW: 0.1, faceH: 0.3 }, base)).toBeCloseTo((FACE_TARGET_H * base.h) / 0.3, 5)
    expect(autoZoomFor({ faceW: 0.2, faceH: 0.5 }, base)).toBe(1) // já grande: não afasta
    expect(autoZoomFor({ faceW: 0.01, faceH: 0.05 }, base)).toBe(FACE_MAX_AUTO_ZOOM) // minúsculo: teto
    // o rosto largo demais para o recorte estreito limita a aproximação pela largura
    const wide = autoZoomFor({ faceW: 0.2, faceH: 0.2 }, base)
    expect(0.2 * wide).toBeLessThanOrEqual(0.55 * base.w + 1e-9)
  })

  it('com folga vertical (aproximado) o centro do rosto fica na altura de folga, acima do meio', () => {
    const aim = { cx: 0.5, cy: 0.4, faceW: 0.1, faceH: 0.2 }
    const r = cameraCropRect(CAM, PORTRAIT, aim)
    expect(r.h).toBeLessThan(1)
    const faceInCrop = (aim.cy - r.y) / r.h
    expect(faceInCrop).toBeCloseTo(FACE_HEADROOM_Y, 1)
  })

  it('auto desligado: centro, só com o ajuste manual', () => {
    const aim = { cx: 0.8, cy: 0.4, faceW: 0.14, faceH: 0.3 }
    const off = cameraCropRect(CAM, PORTRAIT, aim, { auto: false })
    expect(off).toEqual(coverCrop(CAM, PORTRAIT))
    const zoomed = cameraCropRect(CAM, PORTRAIT, aim, { auto: false, zoom: 2 })
    expect(zoomed.w).toBeCloseTo(off.w / 2, 6)
    expect(zoomed.h).toBeCloseTo(off.h / 2, 6)
  })

  it('o ajuste manual (zoom, dx, dy) vem por cima e o recorte nunca sai da imagem', () => {
    const aim = { cx: 0.5, cy: 0.4, faceW: 0.14, faceH: 0.3 }
    const base = cameraCropRect(CAM, PORTRAIT, aim)
    const more = cameraCropRect(CAM, PORTRAIT, aim, { zoom: 1.5 })
    expect(more.w).toBeCloseTo(base.w / 1.5, 6)
    const moved = cameraCropRect(CAM, PORTRAIT, aim, { dx: 0.1 })
    expect(moved.x).toBeCloseTo(base.x + 0.1, 6)
    // valores absurdos são presos
    expect(inside(cameraCropRect(CAM, PORTRAIT, aim, { zoom: 99, dx: 9, dy: -9 }))).toBe(true)
    expect(resolveFraming({ zoom: 99, dx: 9, dy: -9 })).toEqual({ auto: true, zoom: 3, dx: 0.5, dy: -0.5 })
    expect(resolveFraming({ zoom: Number.NaN })).toMatchObject({ zoom: 1 })
  })

  it('propriedade: para qualquer rosto, proporção e ajuste o recorte cabe na imagem e tem a proporção pedida', () => {
    let seed = 7
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    for (let i = 0; i < 400; i++) {
      const aspect = [1, 3 / 4, 1.125, 4 / 3, 9 / 16][i % 5]!
      const aim = rnd() < 0.2 ? null : { cx: rnd(), cy: rnd(), faceW: 0.03 + rnd() * 0.25, faceH: 0.05 + rnd() * 0.5 }
      const framing = { auto: rnd() < 0.8, zoom: 1 + rnd() * 2, dx: rnd() - 0.5, dy: rnd() - 0.5 }
      const r = cameraCropRect(CAM, aspect, aim, framing)
      expect(inside(r)).toBe(true)
      expect((r.w * CAM.w) / (r.h * CAM.h)).toBeCloseTo(aspect, 4)
    }
  })

  it('arrastar na prévia move a imagem: o recorte anda ao contrário (e ao contrário de novo se a câmera está espelhada)', () => {
    const crop = { w: 0.42, h: 1 }
    const dest = { w: 500, h: 667 }
    const right = panFraming(undefined, 50, 0, dest, crop)
    expect(right.dx).toBeLessThan(0)
    expect(right.dx).toBeCloseTo(-(50 / 500) * 0.42, 6)
    const mirrored = panFraming(undefined, 50, 0, dest, crop, true)
    expect(mirrored.dx).toBeCloseTo(-right.dx, 6)
    const down = panFraming({ dy: 0.1 }, 0, 100, dest, { w: 0.4, h: 0.6 })
    expect(down.dy).toBeCloseTo(0.1 - (100 / 667) * 0.6, 6)
    expect(panFraming(undefined, 1e9, 0, dest, crop).dx).toBe(-0.5)
  })
})
