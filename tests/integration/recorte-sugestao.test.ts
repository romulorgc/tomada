/**
 * Recorte sugerido (C1, fallback) com o ffmpeg de verdade: uma "gravação de navegador" sintética (faixa de abas, barra de endereço,
 * filete e uma página colorida) e o serviço que a analisa. Sem Electron.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDerivedMedia } from '../../src/main/derived-media'
import { createMemoryLogger } from '../../src/main/logger'
import { createProjectStore } from '../../src/main/projects'
import { parseProject, serializeProject } from '../../src/shared/project'
import { copyTree, FIX, requireFfmpeg, useTmpDir } from '../helpers/env'

const tmp = useTmpDir()
const ID = '2026-10-04 1500 Projeto de exemplo'
const ff = requireFfmpeg()

/** Um projeto cuja tela é o vídeo `filter` (lavfi), `w`×`h`, 3 s. */
async function seed(w: number, h: number, filter: string) {
  const base = tmp()
  const root = join(base, 'projetos')
  mkdirSync(root)
  const dir = join(root, ID)
  copyTree(FIX.exemplo, dir)
  await ff.run(['-f', 'lavfi', '-i', `${filter},scale=${w}:${h}`, '-t', '3', '-r', '30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', join(dir, 'media', 'screen.mp4')])
  const file = join(dir, 'project.json')
  const p = parseProject(readFileSync(file, 'utf8'))
  p.sources.screen = { path: 'media/screen.mp4', w, h, fps: 30, durationMs: 3000 }
  writeFileSync(file, serializeProject(p))
  const logger = createMemoryLogger()
  const store = createProjectStore({ root: () => root, logger, trash: async () => undefined, openFolder: async () => undefined })
  return { dir, logger, derived: createDerivedMedia({ logger, ffmpeg: () => ff, read: (id) => store.read(id) }) }
}

const browserLike = (w: number, h: number): string =>
  `color=c=0xff00ff:s=${w}x${h}:d=3,drawbox=x=0:y=0:w=${w}:h=${Math.round(h * 0.055)}:color=0xdee1e6:t=fill,drawbox=x=0:y=${Math.round(h * 0.055)}:w=${w}:h=${Math.round(h * 0.06)}:color=0xffffff:t=fill,drawbox=x=0:y=${Math.round(h * 0.115)}:w=${w}:h=2:color=0xdadce0:t=fill,drawbox=x=${Math.round(w * 0.4)}:y=${Math.round(h * 0.5)}:w=${Math.round(w * 0.2)}:h=${Math.round(h * 0.1)}:color=0x00ffff:t=fill`

describe('o recorte sugerido pela análise da gravação', () => {
  it.each([
    [1920, 1080],
    [1360, 942],
    [1280, 720]
  ])('acha onde a barra do navegador acaba numa gravação %i×%i', async (w, h) => {
    const { derived, dir } = await seed(w, h, browserLike(w, h))
    const found = await derived.cropSuggest(ID)
    expect(found, 'achou a barra').not.toBeNull()
    // a página começa na linha 11,5% da altura (abas + endereço + filete), com a margem de uma linha do quadro analisado
    expect(found!.rect.y).toBeGreaterThan(0.115 - 0.012)
    expect(found!.rect.y).toBeLessThan(0.115 + 0.02)
    expect(found!.rect.x).toBe(0)
    expect(found!.rect.w).toBe(1)
    expect(found!.rect.y + found!.rect.h).toBeCloseTo(1, 9)
    expect(found!.confidence).toBeGreaterThan(0.75)
    // sem temporário
    expect(readdirSync(join(dir, 'media')).filter((n) => n.startsWith('.tmp'))).toEqual([])
  }, 60_000)

  it('uma gravação sem barra de navegador (tela lisa): nada a sugerir', async () => {
    const { derived } = await seed(1280, 720, 'color=c=0x336699:s=1280x720:d=3')
    expect(await derived.cropSuggest(ID)).toBeNull()
  }, 60_000)

  it('sem ffmpeg: o erro aparece com o motivo (nunca uma sugestão vazia que parece "sem barra")', async () => {
    const base = tmp()
    const root = join(base, 'projetos')
    mkdirSync(root)
    copyTree(FIX.exemplo, join(root, ID))
    const logger = createMemoryLogger()
    const store = createProjectStore({ root: () => root, logger, trash: async () => undefined, openFolder: async () => undefined })
    const derived = createDerivedMedia({ logger, ffmpeg: () => null, read: (id) => store.read(id) })
    await expect(derived.cropSuggest(ID)).rejects.toThrow(/ffmpeg/)
  })
})
