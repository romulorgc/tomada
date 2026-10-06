/**
 * Mede o mapa de conteúdo de um vídeo de tela de verdade (ffmpeg real): só os quadros-chave são lidos, a imagem que não muda vira uma
 * amostra só e o bloco principal sai onde a coluna de texto está. O vídeo é sintético (`pagina-webmail.ts`): a lista de e-mails nos 2
 * primeiros segundos e a coluna de um e-mail aberto nos 2 seguintes, com a faixa de abas e a barra de tarefas.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTENT_FRAME, keyframeTimesMs, measureContentMap } from '../../src/main/content-map'
import { axisProfile, mainBlock } from '@shared/content-map'
import { COLUMN, FRAME, pageGray } from '../helpers/pagina-webmail'
import { requireFfmpeg, useTmpDir } from '../helpers/env'

const tmp = useTmpDir()

/** 4 s a 30 qps, GOP de 1 s sem troca de cena (como o `media/screen.mp4` normalizado). */
function makeScreenVideo(out: string): void {
  const ff = requireFfmpeg()
  const list = pageGray({ column: null })
  const column = pageGray()
  const frames = Buffer.concat(Array.from({ length: 120 }, (_, i) => Buffer.from(i < 60 ? list : column)))
  const run = spawnSync(
    ff.paths.ffmpeg,
    ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${FRAME.w}x${FRAME.h}`, '-r', '30', '-i', 'pipe:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', out],
    { input: frames, maxBuffer: 1 << 26 }
  )
  if (run.status !== 0) throw new Error(`ffmpeg falhou: ${run.stderr.toString()}`)
}

describe('measureContentMap', () => {
  it('acha os quadros-chave (1 por segundo) e mede só eles', async () => {
    const file = join(tmp(), 'screen.mp4')
    makeScreenVideo(file)
    const ff = requireFfmpeg()
    expect(await keyframeTimesMs(ff, file)).toEqual([0, 1000, 2000, 3000])
    expect(CONTENT_FRAME).toEqual({ w: 640, h: 360 })
  })

  it('a imagem parada é uma amostra só; a troca da lista para a coluna é outra, no segundo em que aconteceu', async () => {
    const file = join(tmp(), 'screen.mp4')
    makeScreenVideo(file)
    const map = await measureContentMap(requireFfmpeg(), file)
    expect(map.map((s) => s.t)).toEqual([0, 2000])
    const crop = { x: 0, y: 0.07, w: 1, h: 0.86 } // a página, sem a faixa de abas nem a barra de tarefas
    const list = mainBlock(axisProfile(map[0]!, crop, 'x'))!
    const column = mainBlock(axisProfile(map[1]!, crop, 'x'))!
    expect(list.end - list.start).toBeGreaterThan(0.6)
    expect(column.start).toBeGreaterThan(COLUMN.start - 0.05)
    expect(column.start).toBeLessThan(COLUMN.start + 0.03)
    expect(column.end).toBeGreaterThan(COLUMN.end - 0.03)
    expect(column.end).toBeLessThan(COLUMN.end + 0.05)
  })

  it('arquivo que não é vídeo falha com o motivo (nada de mapa vazio calado)', async () => {
    const file = join(tmp(), 'nao-e-video.mp4')
    spawnSync('node', ['-e', `require('fs').writeFileSync(${JSON.stringify(file)}, 'isto não é um vídeo')`])
    await expect(measureContentMap(requireFfmpeg(), file)).rejects.toThrow()
  })
})
