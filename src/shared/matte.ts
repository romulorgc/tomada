/**
 * O RECORTE DO FUNDO da câmera (M4c): `media/camera-matte.mp4` é um vídeo em tons de cinza (branco = a pessoa) com o MESMO tamanho
 * proporcional, a mesma taxa e os mesmos quadros do `media/camera.mp4`; `media/camera-matte.json` guarda de onde ele saiu para o cache
 * (refaz só se a câmera mudar). Código puro: sem DOM, sem Node.
 */
export const MATTE_FILE = 'media/camera-matte.mp4'
export const MATTE_META_FILE = 'media/camera-matte.json'
/** O arquivo parcial enquanto a máscara é gerada (vira `MATTE_FILE` só quando termina inteira). */
export const MATTE_PARTIAL_FILE = 'media/camera-matte.partial.mp4'
export const MATTE_VERSION = 1

export type MatteMeta = {
  version: number
  /** O modelo que fez a máscara (`rvm-resnet50`…). */
  engine: string
  /** Caminho e data do arquivo da câmera de onde a máscara saiu. */
  source: string
  sourceMtimeMs: number
  frames: number
  fps: number
  frame: { w: number; h: number }
  createdAt: string
}

/** Lê o `camera-matte.json`; lança com o motivo se o arquivo não presta (a interface mostra e a máscara é refeita). */
export function parseMatteMeta(text: string): MatteMeta {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('O arquivo camera-matte.json não é um JSON válido.')
  }
  const o = raw as Partial<MatteMeta> | null
  if (!o || typeof o !== 'object' || o.version !== MATTE_VERSION) throw new Error('O arquivo camera-matte.json é de outra versão do programa.')
  if (typeof o.source !== 'string' || typeof o.sourceMtimeMs !== 'number' || typeof o.frames !== 'number' || !(o.frames > 0)) throw new Error('O arquivo camera-matte.json está incompleto.')
  const fps = typeof o.fps === 'number' && o.fps > 0 ? o.fps : 30
  const frame = o.frame && typeof o.frame.w === 'number' && typeof o.frame.h === 'number' ? o.frame : { w: 0, h: 0 }
  return {
    version: MATTE_VERSION,
    engine: typeof o.engine === 'string' ? o.engine : 'desconhecido',
    source: o.source,
    sourceMtimeMs: o.sourceMtimeMs,
    frames: o.frames,
    fps,
    frame,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : ''
  }
}

/** A máscara guardada ainda vale para esta câmera? (mesmo arquivo, mesma data) */
export function matteIsFresh(meta: MatteMeta, cameraPath: string, cameraMtimeMs: number): boolean {
  return meta.version === MATTE_VERSION && meta.source === cameraPath && meta.sourceMtimeMs === cameraMtimeMs
}
