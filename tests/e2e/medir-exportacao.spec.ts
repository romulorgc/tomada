/**
 * Medição manual do tempo de exportar ~1 minuto (acabamento D): `TOMADA_MEDIR_EXPORTACAO=1` e, para medir com a GPU (encoder por
 * hardware) sem janela visível, `TOMADA_E2E_GPU=1`. O resultado vai para `test-results/acabamento/medicao-exportacao-<rótulo>.json`
 * (`TOMADA_MEDIR_ROTULO`, padrão "depois"). Não faz parte da bateria: sem a variável o spec fica marcado como pulado.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { copyTree } from '../helpers/fs'
import { ensureLongProject, LONG_FOLDER, LONG_MS } from '../helpers/long-project'
import { frameRgb, probeJson } from '../helpers/media'
import { editProject, exportProject } from './export-helpers'
import { launchTomada, ROOT, type Session } from './helpers'

let s: Session | undefined
test.afterEach(async () => { if (s) { await s.close(); s = undefined } })

const CONFIGS: { nome: string; resolution: '1080p' | '1440p'; fps: 30 | 60; format?: 'vertical' }[] = [
  { nome: 'YouTube 1080p30', resolution: '1080p', fps: 30 },
  { nome: 'YouTube 1440p30', resolution: '1440p', fps: 30 },
  { nome: 'Vertical 1080x1920 30', resolution: '1080p', fps: 30, format: 'vertical' }
]

test('exportar 1 minuto: tempo e taxa por configuração', async () => {
  test.skip(process.env.TOMADA_MEDIR_EXPORTACAO !== '1', 'Medição manual: TOMADA_MEDIR_EXPORTACAO=1.')
  test.setTimeout(900_000)
  const rotulo = process.env.TOMADA_MEDIR_ROTULO ?? 'depois'
  s = await launchTomada({ seed: false })
  copyTree(ensureLongProject(), join(s.projects, LONG_FOLDER))
  // ~1 min de saída: o resto do projeto de 3 min sai num corte só
  editProject(s, (p) => { p.zoomPreset = 'moderate'; p.cuts.push({ id: 'resto', start: 62_000, end: LONG_MS, reason: 'manual', enabled: true }) }, LONG_FOLDER)
  const resultados: Record<string, unknown>[] = []
  // Cada configuração roda 3 vezes: a primeira de uma sessão paga o aquecimento do encoder e das mídias, então o que vale é a mediana.
  const REPETICOES = 3
  for (const c of CONFIGS) {
    const rodadas: { tempoS: number; renderQps: number; megabytes: number; taxaMbps: number }[] = []
    let ultima = ''
    for (let i = 0; i < REPETICOES; i++) {
      const inicio = Date.now()
      const done = await exportProject(s.page, LONG_FOLDER, { resolution: c.resolution, fps: c.fps, ...(c.format ? { format: c.format } : {}) })
      const total = Date.now() - inicio
      expect(done.phase, done.message).toBe('done')
      const r = done.report!
      const luz = frameRgb(done.outputPath!, 300, 64, 36).reduce((a, b) => a + b, 0) / (64 * 36 * 3)
      expect(luz, 'o quadro exportado não pode estar preto').toBeGreaterThan(8)
      rodadas.push({ tempoS: +(total / 1000).toFixed(1), renderQps: +r.renderFps.toFixed(1), megabytes: +(statSync(done.outputPath!).size / 1e6).toFixed(1), taxaMbps: +(Number(probeJson(done.outputPath!).format.bit_rate) / 1e6).toFixed(1) })
      ultima = `${r.width}x${r.height}, ${(r.durationMs / 1000).toFixed(1)} s de vídeo`
    }
    const tempos = rodadas.map((r) => r.tempoS).sort((a, b) => a - b)
    resultados.push({ configuracao: c.nome, saida: ultima, medianaS: tempos[Math.floor(tempos.length / 2)], rodadas })
  }
  const pasta = join(ROOT, 'test-results', 'acabamento')
  mkdirSync(pasta, { recursive: true })
  writeFileSync(join(pasta, `medicao-exportacao-${rotulo}.json`), JSON.stringify({ rotulo, gpu: process.env.TOMADA_E2E_GPU === '1', resultados }, null, 2))
  console.log(JSON.stringify(resultados, null, 2))
})
