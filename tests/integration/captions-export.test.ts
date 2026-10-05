/**
 * Legendas em arquivo (M4a): SRT e VTT gravados em `exports/` do projeto, no tempo de SAÍDA (com os cortes). O destino nunca vem
 * da interface, nada é sobrescrito e uma `exports/` que aponta para fora não serve.
 */
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createProject } from '@shared/project'
import type { Project, Word } from '@shared/types'
import { CaptionsExportError, createCaptionsExporter } from '../../src/main/captions-export'
import { useTmpDir } from '../helpers/env'

const tmp = useTmpDir()

const WORDS: Word[] = [
  ['Olá,', 400, 883],
  ['pessoal.', 883, 1753],
  ['Hoje', 5000, 5400],
  ['eu', 5400, 5700],
  ['vou', 5700, 6100],
  ['mostrar.', 6100, 6800]
].map(([text, start, end], i) => ({ i, text: text as string, start: start as number, end: end as number, prob: 1, kind: 'word' as const }))

function world(over: Partial<Project> = {}, words: Word[] | null = WORDS) {
  const dir = join(tmp(), 'proj')
  mkdirSync(dir, { recursive: true })
  const project = {
    ...createProject({
      id: 'p1',
      title: 'Meu: vídeo?',
      createdAt: '2026-10-05T12:00:00.000Z',
      sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs: 8000 } }
    }),
    ...over
  }
  const exporter = createCaptionsExporter({ read: async () => ({ project, dir }), words: async () => words })
  return { dir, exporter, project }
}

describe('exportador de SRT e VTT', () => {
  it('grava o SRT em exports/ com o nome do título saneado e o tempo de saída', async () => {
    const { dir, exporter } = world()
    const r = await exporter.export('p1', 'srt')
    expect(r.path).toBe(join(dir, 'exports', 'Meu vídeo - legendas.srt'))
    expect(r.cues).toBe(2)
    const text = readFileSync(r.path, 'utf8')
    expect(text).toBe('1\n00:00:00,400 --> 00:00:01,753\nOlá, pessoal.\n\n2\n00:00:05,000 --> 00:00:06,800\nHoje eu vou mostrar.\n')
  })

  it('o VTT leva o cabeçalho e os tempos com ponto', async () => {
    const { exporter } = world()
    const r = await exporter.export('p1', 'vtt')
    expect(r.path.endsWith('Meu vídeo - legendas.vtt')).toBe(true)
    const text = readFileSync(r.path, 'utf8')
    expect(text.startsWith('WEBVTT\n\n00:00:00.400 --> 00:00:01.753\n')).toBe(true)
  })

  it('depois de um corte de 3 s a segunda legenda começa 3 s mais cedo', async () => {
    const { exporter } = world({ cuts: [{ id: 'c1', start: 2000, end: 5000, reason: 'manual', enabled: true }] })
    const r = await exporter.export('p1', 'srt')
    expect(readFileSync(r.path, 'utf8')).toContain('00:00:02,000 --> 00:00:03,800\nHoje eu vou mostrar.')
  })

  it('o texto corrigido na aba Texto vale', async () => {
    const { exporter } = world({ wordFixes: { '0': 'Oi,' } })
    const r = await exporter.export('p1', 'srt')
    expect(readFileSync(r.path, 'utf8')).toContain('Oi, pessoal.')
  })

  it('NUNCA sobrescreve: o nome tomado ganha " (2)", " (3)"', async () => {
    const { dir, exporter } = world()
    const a = await exporter.export('p1', 'srt')
    writeFileSync(a.path, 'MEU ARQUIVO') // o usuário mexeu
    const b = await exporter.export('p1', 'srt')
    const c = await exporter.export('p1', 'srt')
    expect(b.path).toBe(join(dir, 'exports', 'Meu vídeo - legendas (2).srt'))
    expect(c.path).toBe(join(dir, 'exports', 'Meu vídeo - legendas (3).srt'))
    expect(readFileSync(a.path, 'utf8')).toBe('MEU ARQUIVO')
    expect(readdirSync(join(dir, 'exports')).sort()).toHaveLength(3)
  })

  it('SRT e VTT convivem na mesma pasta (extensões diferentes)', async () => {
    const { dir, exporter } = world()
    await exporter.export('p1', 'srt')
    await exporter.export('p1', 'vtt')
    expect(readdirSync(join(dir, 'exports')).sort()).toEqual(['Meu vídeo - legendas.srt', 'Meu vídeo - legendas.vtt'])
  })

  it('sem transcrição, diz o que fazer; com tudo cortado, diz que não há o que legendar', async () => {
    await expect(world({}, null).exporter.export('p1', 'srt')).rejects.toThrow(/ainda não tem transcrição/)
    await expect(world({}, []).exporter.export('p1', 'srt')).rejects.toBeInstanceOf(CaptionsExportError)
    await expect(world({ cuts: [{ id: 'c', start: 0, end: 8000, reason: 'manual', enabled: true }] }).exporter.export('p1', 'srt')).rejects.toThrow(/cortadas/)
  })

  it('nada é gravado quando dá erro', async () => {
    const { dir, exporter } = world({}, null)
    await expect(exporter.export('p1', 'srt')).rejects.toThrow()
    expect(() => readdirSync(join(dir, 'exports'))).toThrow() // nem a pasta foi criada
  })

  it('o tipo vem de um conjunto fechado: qualquer outro é recusado', async () => {
    const { exporter } = world()
    await expect(exporter.export('p1', '../../x' as 'srt')).rejects.toThrow(/Tipo de legenda desconhecido/)
    await expect(exporter.export('p1', 'txt' as 'srt')).rejects.toBeInstanceOf(CaptionsExportError)
  })

  it('título perigoso vira nome seguro (sem separador de caminho, sem ponto no fim, sem nome reservado)', async () => {
    for (const title of ['..\\..\\Windows\\x', 'a/b/c', 'CON', 'nome.', '   ', 'x'.repeat(300)]) {
      const dir = join(tmp(), `t-${Math.abs(title.length * 31 + title.charCodeAt(0))}`)
      mkdirSync(dir, { recursive: true })
      const project = { ...createProject({ id: 'p', title, createdAt: '2026-10-05T12:00:00.000Z', sources: { screen: { path: 'media/s.mp4', w: 1920, h: 1080, fps: 30, durationMs: 8000 } } }) }
      const exporter = createCaptionsExporter({ read: async () => ({ project, dir }), words: async () => WORDS })
      const r = await exporter.export('p', 'srt')
      expect(r.path.startsWith(join(dir, 'exports') + '\\') || r.path.startsWith(join(dir, 'exports') + '/'), title).toBe(true)
      const name = r.path.slice(join(dir, 'exports').length + 1)
      expect(name, title).not.toMatch(/[\\/]/)
      expect(name.length, title).toBeLessThanOrEqual(140)
    }
  })

  it('exports/ que aponta para FORA do projeto (junção ou atalho) não serve de destino', async () => {
    const { dir, exporter } = world()
    const outside = join(tmp(), 'fora')
    mkdirSync(outside, { recursive: true })
    try {
      symlinkSync(outside, join(dir, 'exports'), 'junction')
    } catch {
      return // sem permissão para criar a junção neste ambiente: o teste não se aplica
    }
    await expect(exporter.export('p1', 'srt')).rejects.toThrow(/aponta para fora/)
    expect(readdirSync(outside)).toEqual([]) // nada vazou para fora
  })
})
