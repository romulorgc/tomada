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
  test.skip(process.env.TOMADA_MEDIR_EXPORTACAO !== '1', 'Medição manual: TOMADA_MEDIR_EXPORTACAO=1 (docs/etapas/acabamento-exportacao.md).')
  test.setTimeout(900_000)
  const rotulo = process.env.TOMADA_MEDIR_ROTULO ?? 'depois'
  s = await launchTomada({ seed: false })
  copyTree(ensureLongProject(), join(s.projects, LONG_FOLDER))
  // ~1 min de saída: o resto do projeto de 3 min sai num corte só
  editProject(s, (p) => { p.zoomPreset = 'moderate'; p.cuts.push({ id: 'resto', start: 62_000, end: LONG_MS, reason: 'manual', enabled: true }) }, LONG_FOLDER)
  const resultados: Record<string, unknown>[] = []
  for (const c of CONFIGS) {
    const inicio = Date.now()
    const done = await exportProject(s.page, LONG_FOLDER, { resolution: c.resolution, fps: c.fps, ...(c.format ? { format: c.format } : {}) })
    const total = Date.now() - inicio
    expect(done.phase, done.message).toBe('done')
    const r = done.report!
    const probe = probeJson(done.outputPath!)
    const luz = frameRgb(done.outputPath!, 300, 64, 36).reduce((a, b) => a + b, 0) / (64 * 36 * 3)
    expect(luz, 'o quadro exportado não pode estar preto').toBeGreaterThan(8)
    resultados.push({ configuracao: c.nome, tela: `${r.width}x${r.height}`, duracaoSaidaS: +(r.durationMs / 1000).toFixed(1), tempoTotalS: +(total / 1000).toFixed(1), tempoDoRelatorioS: +(r.elapsedMs / 1000).toFixed(1), quadrosPorSegundoDeRender: +r.renderFps.toFixed(1), megabytes: +(r.bytes / 1e6).toFixed(1), taxaDoArquivoMbps: +(Number(probe.format.bit_rate) / 1e6).toFixed(1), tamanhoDoArquivoMB: +(statSync(done.outputPath!).size / 1e6).toFixed(1) })
  }
  const pasta = join(ROOT, 'test-results', 'acabamento')
  mkdirSync(pasta, { recursive: true })
  writeFileSync(join(pasta, `medicao-exportacao-${rotulo}.json`), JSON.stringify({ rotulo, gpu: process.env.TOMADA_E2E_GPU === '1', resultados }, null, 2))
  console.log(JSON.stringify(resultados, null, 2))
})
