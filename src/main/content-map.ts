/**
 * Mede o mapa de CONTEÚDO da tela gravada (ver `src/shared/content-map.ts`): onde, na imagem, está o texto e o que vale ser visto.
 *
 * Roda no processamento, sobre `media/screen.mp4`, que já é normalizado com um quadro-chave por segundo (GOP = 1 s, sem troca de cena).
 * Então a medida é barata: o ffmpeg decodifica SÓ os quadros-chave (`-skip_frame nokey`), reduz cada um para 640×360 em cinza e entrega
 * por um pipe; o cálculo da grade (bordas por célula) é do código compartilhado. Um vídeo de 10 minutos custa 600 quadros pequenos,
 * não 18 000 decodificações. O resultado vai para `events/content-map.jsonl`; a cena e a exportação só o leem.
 */
import { spawn } from 'node:child_process'
import { CONTENT_GRID, contentCellsFromGray, dedupeContentMap, type ContentMap, type ContentSample } from '@shared/content-map'
import { FfmpegError, runBinary, type Ffmpeg } from './ffmpeg'
import { assertFfmpegPath } from './ffmpeg-path'

/** O tamanho em que o quadro é lido. Com 3× de redução o contorno de uma letra ainda passa do limite de borda. */
export const CONTENT_FRAME = { w: 640, h: 360 } as const
/** No máximo este tanto de quadros medidos (1 por segundo: meia hora). Acima disso mede-se um a cada N. */
export const CONTENT_MAX_SAMPLES = 1800

export type ContentMapOptions = { timeoutMs?: number; signal?: AbortSignal }

/** Instantes (ms) dos quadros-chave do vídeo, em ordem de apresentação. */
export async function keyframeTimesMs(ff: Ffmpeg, file: string, opts: ContentMapOptions = {}): Promise<number[]> {
  const { stdout } = await runBinary(
    ff.paths.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', '-i', assertFfmpegPath(file, 'vídeo da tela')],
    { timeoutMs: opts.timeoutMs ?? 120_000, ...(opts.signal ? { signal: opts.signal } : {}) }
  )
  const times: number[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const [pts, flags] = line.trim().split(',')
    const t = Number(pts)
    if (flags?.includes('K') && Number.isFinite(t) && t >= 0) times.push(Math.round(t * 1000))
  }
  return times.sort((a, b) => a - b)
}

/** Os quadros-chave do vídeo, reduzidos e em cinza, um depois do outro (`CONTENT_FRAME.w × CONTENT_FRAME.h` bytes cada). */
async function readKeyframes(ff: Ffmpeg, file: string, keep: (index: number) => boolean, onFrame: (gray: Uint8Array, index: number) => void, opts: ContentMapOptions): Promise<number> {
  const { w, h } = CONTENT_FRAME
  const frameBytes = w * h
  const args = [
    '-hide_banner', '-loglevel', 'error', '-skip_frame', 'nokey', '-i', assertFfmpegPath(file, 'vídeo da tela'), '-an',
    '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'
  ]
  return new Promise<number>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new FfmpegError('Operação cancelada.', null, ''))
    const child = spawn(ff.paths.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let pending: Buffer = Buffer.alloc(0)
    let index = 0
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      child.kill()
      finish(() => reject(new FfmpegError('Operação cancelada.', null, stderr.slice(-400))))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      child.kill()
      finish(() => reject(new FfmpegError('O ffmpeg passou do tempo limite ao medir o conteúdo da tela e foi interrompido.', null, stderr.slice(-400))))
    }, opts.timeoutMs ?? 10 * 60_000)
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes)
        pending = pending.subarray(frameBytes)
        if (keep(index)) onFrame(new Uint8Array(frame.buffer, frame.byteOffset, frameBytes), index)
        index++
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2000)
    })
    child.on('error', (err: NodeJS.ErrnoException) => finish(() => reject(new FfmpegError(`Não consegui abrir o ffmpeg (${ff.paths.ffmpeg}): ${err.code === 'ENOENT' ? 'arquivo não encontrado.' : err.message}`, null, ''))))
    child.on('close', (code) => finish(() => (code === 0 ? resolve(index) : reject(new FfmpegError(`O ffmpeg terminou com código ${code} ao medir o conteúdo da tela.${stderr ? `\n${stderr.slice(-400)}` : ''}`, code, stderr.slice(-400))))))
  })
}

/**
 * O mapa de conteúdo de um vídeo de tela: a grade de bordas de cada quadro-chave, sem repetir a imagem que não mudou. Lança com o
 * motivo se o ffmpeg falhar ou se o vídeo não tiver nenhum quadro-chave (quem chama avisa o usuário; nada cai calado).
 */
export async function measureContentMap(ff: Ffmpeg, screenFile: string, opts: ContentMapOptions = {}): Promise<ContentMap> {
  const times = await keyframeTimesMs(ff, screenFile, opts)
  if (times.length === 0) throw new Error('O vídeo da tela não tem quadro-chave para medir.')
  const stride = Math.max(1, Math.ceil(times.length / CONTENT_MAX_SAMPLES))
  const samples: ContentSample[] = []
  const read = await readKeyframes(
    ff,
    screenFile,
    (i) => i < times.length && i % stride === 0,
    (gray, i) => samples.push({ t: times[i]!, cols: CONTENT_GRID.cols, rows: CONTENT_GRID.rows, cells: contentCellsFromGray(gray, CONTENT_FRAME.w, CONTENT_FRAME.h) }),
    opts
  )
  if (samples.length === 0) throw new Error(`O ffmpeg não entregou nenhum quadro para medir (${read} de ${times.length} quadros-chave).`)
  return dedupeContentMap(samples)
}
