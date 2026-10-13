/**
 * Junta os PEDAÇOS do recorte (`p0000.mp4`, `p0001.mp4`…) no vídeo final, SEM recodificar (`-c copy`): os pedaços saem do motor com a mesma
 * taxa, o mesmo tamanho e sem quadros B, então o concat do ffmpeg só soma as durações. Depois confere que a duração do resultado bate com a
 * soma dos quadros (um pedaço faltando ou repetido aparece aqui, não na prévia).
 *
 * Sem Electron. O ffmpeg e a pasta chegam resolvidos por quem chama (nada vem do renderer).
 */
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { matteChunkName } from '@shared/matte-parts'
import { ProcessError, runProcess, tail } from '../process-runner'

/** A junção ficou diferente do esperado: os pedaços não servem e o recorte recomeça do zero. */
export class MatteJoinError extends Error {
  override readonly name = 'MatteJoinError'
}

const JOIN_LIST = 'junta.txt'

/** "Duration: 00:01:28.20" do que o `ffmpeg -i arquivo` escreve no stderr, em segundos; `null` se não achar. */
export function parseFfmpegDuration(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr)
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/** A duração (s) de um vídeo, lida pelo próprio ffmpeg (o app não leva ffprobe). */
export async function probeDurationSeconds(ffmpeg: string, file: string, run: typeof runProcess = runProcess): Promise<number | null> {
  try {
    await run(ffmpeg, ['-hide_banner', '-i', file], { timeoutMs: 60_000 })
    return null
  } catch (err) {
    // sem saída, o ffmpeg termina com código 1 depois de escrever o cabeçalho no stderr: é o que queremos ler
    if (err instanceof ProcessError && err.reason === 'exit') return parseFfmpegDuration(err.stderr)
    throw err
  }
}

export type JoinOptions = {
  ffmpeg: string
  /** A pasta dos pedaços (absoluta, resolvida). */
  dir: string
  /** Os índices dos pedaços, em ordem (0..n-1). */
  indices: number[]
  /** O vídeo final (absoluto). */
  out: string
  /** Quantos quadros e a que taxa: a duração esperada do resultado. */
  frames: number
  fps: number
  signal?: AbortSignal
  run?: typeof runProcess
}

export async function joinMatteParts(o: JoinOptions): Promise<void> {
  const run = o.run ?? runProcess
  if (o.indices.length === 0) throw new MatteJoinError('Não há pedaços do recorte para juntar.')
  const list = join(o.dir, JOIN_LIST)
  // nomes relativos + cwd na pasta: o concat não precisa de aspas para caminhos com acento e espaço
  await writeFile(list, `${o.indices.map((i) => `file '${matteChunkName(i)}'`).join('\n')}\n`, 'utf8')
  try {
    await run(o.ffmpeg, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', JOIN_LIST, '-c', 'copy', '-movflags', '+faststart', o.out], {
      cwd: o.dir,
      timeoutMs: 5 * 60_000,
      ...(o.signal ? { signal: o.signal } : {})
    })
  } catch (err) {
    if (err instanceof ProcessError && err.reason === 'exit') throw new MatteJoinError(`Não consegui juntar os pedaços do recorte: ${tail(err.stderr, 4) || err.message}`)
    throw err
  } finally {
    await rm(list, { force: true }).catch(() => undefined)
  }
  const seconds = await probeDurationSeconds(o.ffmpeg, o.out, run)
  const expected = o.frames / o.fps
  // um quadro de folga para o arredondamento do contêiner; um pedaço a menos erra por ~10 s
  if (seconds === null || Math.abs(seconds - expected) > Math.max(0.25, 2 / o.fps)) {
    throw new MatteJoinError(`A junção dos pedaços do recorte ficou com ${seconds === null ? 'duração ilegível' : `${seconds.toFixed(2)} s`} e eram esperados ${expected.toFixed(2)} s.`)
  }
}
