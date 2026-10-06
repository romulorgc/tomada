/**
 * O recorte do fundo guardado no projeto (`media/camera-matte.mp4` + `camera-matte.json`): ele ainda vale para a câmera de agora? Quem
 * pergunta é o serviço da câmera (cache), a leitura do projeto pelo editor e a exportação: nenhum deles desenha com uma máscara que
 * saiu de outra câmera.
 */
import { readFile, stat } from 'node:fs/promises'
import { MATTE_FILE, MATTE_META_FILE, matteIsFresh, parseMatteMeta, type MatteMeta } from '@shared/matte'
import { mediaUrl } from '@shared/media-url'
import type { Project } from '@shared/types'
import { resolveProjectFile } from '../project-files'

/** A máscara guardada vale para a câmera `cameraPath` (data `cameraMtimeMs`)? Devolve a URL do vídeo (com a versão) e o resumo. */
export async function freshMatte(projectId: string, dir: string, cameraPath: string, cameraMtimeMs: number): Promise<{ url: string; meta: MatteMeta } | null> {
  try {
    const metaFile = await resolveProjectFile(dir, MATTE_META_FILE)
    const meta = parseMatteMeta(await readFile(metaFile, 'utf8'))
    if (!matteIsFresh(meta, cameraPath, cameraMtimeMs)) return null
    const file = await resolveProjectFile(dir, MATTE_FILE)
    const info = await stat(file)
    if (!info.isFile() || info.size === 0) return null
    return { url: mediaUrl(projectId, MATTE_FILE, Math.trunc(info.mtimeMs)), meta }
  } catch {
    return null
  }
}

/** A URL da máscara que vale para a câmera do documento, ou `null` (não existe, é de outra câmera, ou o projeto não tem câmera). */
export async function currentMatteUrl(projectId: string, dir: string, project: Pick<Project, 'sources'>): Promise<string | null> {
  const cam = project.sources.camera
  if (!cam) return null
  try {
    const file = await resolveProjectFile(dir, cam.path, 'sources.camera.path')
    const info = await stat(file)
    return (await freshMatte(projectId, dir, cam.path, Math.trunc(info.mtimeMs)))?.url ?? null
  } catch {
    return null
  }
}
