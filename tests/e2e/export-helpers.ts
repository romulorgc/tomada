/**
 * Ajudantes dos testes de exportação: roda uma exportação pelo IPC, edita o projeto de exemplo
 * antes de abrir o app, monta projetos sintéticos (clarão + bipe) e confere o arquivo final.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { ExportProgress } from '../../src/shared/ipc'
import { createProject, parseProject, serializeProject } from '../../src/shared/project'
import type { Project } from '../../src/shared/types'
import { FIXTURES_DIR } from '../helpers/fs'
import { EXAMPLE_FOLDER, type Session } from './helpers'

export type ExportOpts = { resolution: '1080p' | '1440p' | '2160p'; fps: 30 | 60 }

/** Pede a exportação pelo IPC e espera ela terminar (feita, falha ou cancelada). */
export async function exportProject(page: Page, projectId: string, opts: ExportOpts = { resolution: '1080p', fps: 30 }): Promise<ExportProgress> {
  return page.evaluate(
    async ({ projectId: id, opts: o }) => {
      const { exportId } = await window.tomada.exporter.start({ projectId: id, ...o })
      for (;;) {
        await new Promise((r) => setTimeout(r, 150))
        const st = await window.tomada.exporter.status()
        if (st && st.exportId === exportId && (st.phase === 'done' || st.phase === 'error' || st.phase === 'cancelled')) return st
      }
    },
    { projectId, opts }
  )
}

/** Edita o `project.json` de uma pasta da sessão ANTES de o app abrir o projeto. */
export function editProject(session: Session, edit: (p: Project) => void, folder = EXAMPLE_FOLDER): Project {
  const file = join(session.projects, folder, 'project.json')
  const p = parseProject(readFileSync(file, 'utf8'))
  edit(p)
  writeFileSync(file, serializeProject(p))
  return p
}

export function exportsDirOf(session: Session, folder = EXAMPLE_FOLDER): string {
  return join(session.projects, folder, 'exports')
}

/** Nomes dentro de `exports/` (vazio se a pasta nem existe). */
export function listExports(session: Session, folder = EXAMPLE_FOLDER): string[] {
  try {
    return readdirSync(exportsDirOf(session, folder))
  } catch {
    return []
  }
}

const ffmpeg = (args: string[]): void => {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
}

export const FLASH_FOLDER = '2026-10-05 1200 Flash e bipe'

/**
 * Projeto de sincronia: a tela é o vídeo do CLARÃO (branco por 100 ms a cada 2 s) e a voz é o BIPE (1 kHz,
 * nos mesmos instantes). Sem câmera, sem eventos, layout só tela. Os `cuts` ficam entre os clarões.
 */
export function seedFlashProject(session: Session, cuts: { start: number; end: number }[]): string {
  const dir = join(session.projects, FLASH_FOLDER)
  mkdirSync(join(dir, 'media'), { recursive: true })
  const src = join(FIXTURES_DIR, 'flash-bipe.mp4')
  ffmpeg(['-i', src, '-an', '-c:v', 'copy', join(dir, 'media', 'screen.mp4')])
  ffmpeg(['-i', src, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', join(dir, 'media', 'voice.wav')])
  const p = createProject({
    id: 'flash-0001',
    title: 'Flash e bipe',
    createdAt: '2026-10-05T15:00:00.000Z',
    sources: {
      screen: { path: 'media/screen.mp4', w: 640, h: 360, fps: 30, durationMs: 10_000 },
      voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs: 10_000 }
    },
    capture: { kind: 'screen', boundsPx: { x: 0, y: 0, w: 640, h: 360 }, scale: 1 }
  })
  p.style.defaultLayout = 'screen'
  p.style.padding = 0.06
  p.zoomPreset = 'off'
  p.cuts = cuts.map((c, i) => ({ id: `c${i}`, start: c.start, end: c.end, reason: 'manual', enabled: true }))
  writeFileSync(join(dir, 'project.json'), serializeProject(p))
  return FLASH_FOLDER
}
