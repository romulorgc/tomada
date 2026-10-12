/**
 * A JUNÇÃO dos pedaços do recorte (R1) com o ffmpeg de verdade, e os gabaritos em Python do que a retomada precisa:
 *  - os pedaços saem do motor como o `camera_tools.py` os grava (x264 em cinza, sem quadros B, mp4 por pedaço) e, juntados por cópia, o
 *    vídeo final tem TODOS os quadros, na mesma taxa, sem salto nem sobreposição nas emendas (conferido pelo instante de cada pacote);
 *  - a conferência de duração pega pedaço faltando;
 *  - o Python do app prova que uma retomada produz os mesmos instantes que a rodada inteira e que nada passa de 1080p.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { matteChunkName } from '@shared/matte-parts'
import { joinMatteParts, MatteJoinError } from '../../src/main/camera/matte-join'
import { locateFfmpeg } from '../../src/main/ffmpeg'
import { runProcess } from '../../src/main/process-runner'
import { ensureToolsDir } from '../../src/main/transcription/tools-dir'
import { useTmpDir } from '../helpers/env'
import { ROOT } from '../helpers/fs'
import { probeJson } from '../helpers/media'

const tmp = useTmpDir()
const ffmpeg = (): string => locateFfmpeg()!.ffmpeg

/** Um pedaço como o `Encoder` do `camera_tools.py` o grava: quadros cinza crus → x264 sem quadros B, `-f mp4`. */
function makeChunk(file: string, frames: number, rate: string, size = '160x90'): void {
  execFileSync(
    ffmpeg(),
    ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=${size}:r=${rate}`, '-frames:v', String(frames), '-vf', 'format=gray', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '0', '-f', 'mp4', file],
    { timeout: 60_000 }
  )
}

function packetTimes(file: string): number[] {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8', maxBuffer: 1 << 24 })
  return out.trim().split(/\r?\n/).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
}

describe('juntar pedaços do recorte sem recodificar', () => {
  it.each([
    ['30 qps', '30', 30],
    ['29,97 qps (30000/1001)', '30000/1001', 30000 / 1001],
    ['56 qps (a webcam do usuário, grade de 60 com etiqueta 56)', '56', 56]
  ])('%s: todos os quadros, instantes uniformes através das emendas', (_name, rate, fps) => {
    const dir = join(tmp(), 'pedaços ô')
    mkdirSync(dir, { recursive: true })
    const sizes = [300, 300, 137]
    sizes.forEach((n, i) => makeChunk(join(dir, matteChunkName(i)), n, rate))
    const out = join(dir, '..', 'junto ô.mp4')
    return joinMatteParts({ ffmpeg: ffmpeg(), dir, indices: [0, 1, 2], out, frames: 737, fps }).then(() => {
      const v = probeJson(out).streams.find((s) => s.codec_type === 'video')!
      expect(Number(v.nb_frames)).toBe(737)
      const times = packetTimes(out)
      expect(times).toHaveLength(737)
      const step = 1 / fps
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!, `quadro ${i}`).toBeCloseTo(step, 2)
      // a duração do arquivo é a soma dos quadros
      expect(Number(probeJson(out).format.duration)).toBeCloseTo(737 / fps, 1)
      // não sobrou a lista da junção na pasta dos pedaços
      expect(existsSync(join(dir, 'junta.txt'))).toBe(false)
    })
  })

  it('pedaço faltando: a duração não bate e a junção lança (nunca um recorte curto dado como bom)', async () => {
    const dir = join(tmp(), 'pedacos')
    mkdirSync(dir, { recursive: true })
    makeChunk(join(dir, matteChunkName(0)), 300, '30')
    makeChunk(join(dir, matteChunkName(2)), 300, '30')
    const out = join(dir, '..', 'junto.mp4')
    // a lista pede 0 e 2 (o 1 sumiu): o arquivo sai com 600 quadros, mas eram 900 esperados
    await expect(joinMatteParts({ ffmpeg: ffmpeg(), dir, indices: [0, 2], out, frames: 900, fps: 30 })).rejects.toBeInstanceOf(MatteJoinError)
    rmSync(out, { force: true })
    // pedaço que nem existe: o ffmpeg ou falha ou entrega só o que achou; nos dois casos o erro é de junção
    await expect(joinMatteParts({ ffmpeg: ffmpeg(), dir, indices: [0, 1], out, frames: 600, fps: 30 })).rejects.toBeInstanceOf(MatteJoinError)
  })

  it('sem nenhum pedaço: erro claro', async () => {
    const dir = join(tmp(), 'vazio')
    mkdirSync(dir, { recursive: true })
    await expect(joinMatteParts({ ffmpeg: ffmpeg(), dir, indices: [], out: join(dir, 'x.mp4'), frames: 1, fps: 30 })).rejects.toThrow(/Não há pedaços/)
  })
})

describe('gabaritos em Python do recorte em pedaços (no venv do app)', () => {
  it('a retomada produz os mesmos instantes que a rodada inteira; os pedaços só ganham o nome final inteiros; nada passa de 1080p', async () => {
    const base = ensureToolsDir()
    const result = await runProcess(join(base, 'python', 'Scripts', 'python.exe'), [join(ROOT, 'tests', 'helpers', 'matte_chunks_checks.py')], { env: { PYTHONUTF8: '1' }, timeoutMs: 60_000 })
    expect(result.stderr).toContain('Ran 6 tests')
    expect(result.stderr).toContain('OK')
  })
})
