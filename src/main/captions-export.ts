/**
 * Legendas em arquivo (M4a): SRT e VTT no tempo de SAÍDA (com os cortes), gravados em `exports/` do projeto.
 *
 * O renderer só diz QUAL projeto e QUAL tipo (`captions:export`); o processo principal lê o documento e a transcrição do
 * disco, monta as legendas (`buildCues`, puro e testado), escolhe o nome (do título do projeto, saneado) e grava SEM
 * sobrescrever nada (`wx`; nome tomado ganha " (2)"). O caminho de destino nunca vem da interface.
 *
 * Sem Electron: roda igual nos testes.
 */
import { writeFile, mkdir, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildCues, captionSourceOf, toSrt, toVtt } from '@shared/captions'
import { sanitizeFileName } from '@shared/export'
import { projectDurationMs } from '@shared/project'
import { uniqueName } from '@shared/recording'
import type { Project, Word } from '@shared/types'
import { isInside } from './project-files'

export type CaptionFileKind = 'srt' | 'vtt'

export type CaptionsExportDeps = {
  read(id: string): Promise<{ project: Project; dir: string }>
  /** As palavras da transcrição, ou `null` se o projeto não tem. */
  words(id: string): Promise<Word[] | null>
}

export type CaptionsExportResult = { path: string; cues: number }

export class CaptionsExportError extends Error {
  override readonly name = 'CaptionsExportError'
}

export function createCaptionsExporter(deps: CaptionsExportDeps): { export(projectId: string, kind: CaptionFileKind): Promise<CaptionsExportResult> } {
  return {
    async export(projectId, kind) {
      if (kind !== 'srt' && kind !== 'vtt') throw new CaptionsExportError('Tipo de legenda desconhecido.')
      const { project, dir } = await deps.read(projectId)
      const words = await deps.words(projectId)
      if (!words || words.length === 0) throw new CaptionsExportError('Este projeto ainda não tem transcrição: transcreva a voz na aba Texto para ter legendas.')
      const cues = buildCues(words, captionSourceOf(project, projectDurationMs(project)))
      if (cues.length === 0) throw new CaptionsExportError('Não há o que legendar: todas as palavras foram cortadas.')

      const out = join(dir, 'exports')
      await mkdir(out, { recursive: true })
      // `exports/` que aponta para fora da pasta do projeto (junção ou atalho) não serve de destino
      const [realProject, realOut] = await Promise.all([realpath(dir), realpath(out)])
      if (!isInside(realProject, realOut)) throw new CaptionsExportError('A pasta exports/ deste projeto aponta para fora da pasta dele.')

      const text = kind === 'srt' ? toSrt(cues) : toVtt(cues)
      const stem = `${sanitizeFileName(project.title)} - legendas`
      for (let attempt = 0; attempt < 100; attempt++) {
        const name = uniqueName(stem, (n) => existsSync(join(out, `${n}.${kind}`)))
        const target = join(out, `${name}.${kind}`)
        try {
          await writeFile(target, text, { encoding: 'utf8', flag: 'wx' }) // nunca sobrescreve
          return { path: target, cues: cues.length }
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        }
      }
      throw new CaptionsExportError(`Não achei um nome livre para a legenda em ${out}.`)
    }
  }
}
