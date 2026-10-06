/**
 * Armazenamento de projetos em disco: cada projeto é uma pasta dentro da raiz,
 * com um `project.json`. Sem Electron: lixeira e "abrir no Explorer"
 * entram por parâmetro, então tudo isto roda igual nos testes.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { MediaFile, ProjectDetail } from '@shared/ipc'
import { EVENT_FILES } from '@shared/events'
import { FACE_FILE } from '@shared/face'
import { currentMatteUrl } from './camera/matte-file'
import { mediaUrl } from '@shared/media-url'
import { ProjectFormatError, parseProject, projectDurationMs, serializeProject } from '@shared/project'
import { isReservedWindowsName } from '@shared/safe-path'
import type { Project, ProjectSummary, Src } from '@shared/types'
import { pathExists, writeFileAtomic } from './fs-utils'
import type { Logger } from './logger'
import { assertDocumentPaths, isInside, resolveProjectFile } from './project-files'

export const PROJECT_FILE = 'project.json'
export const THUMB_PATH = 'media/thumb.jpg'
export const MAX_TITLE_LENGTH = 200

export class InvalidProjectIdError extends Error {
  override readonly name = 'InvalidProjectIdError'
}
export class ProjectNotFoundError extends Error {
  override readonly name = 'ProjectNotFoundError'
}

export type ProjectStoreDeps = {
  /** Raiz atual dos projetos (relida a cada chamada: o usuário pode mudar nos Ajustes). */
  root: () => string
  logger: Logger
  /** Manda a pasta para a Lixeira do sistema (`shell.trashItem`). */
  trash: (path: string) => Promise<void>
  /** Abre a pasta no Explorer. */
  openFolder: (path: string) => Promise<void>
}

export interface ProjectStore {
  /** Pasta absoluta do projeto; lança `InvalidProjectIdError` se o id tentar escapar da raiz. */
  dirOf(id: string): string
  list(): Promise<ProjectSummary[]>
  read(id: string): Promise<{ project: Project; dir: string }>
  detail(id: string): Promise<ProjectDetail>
  /** Grava o `project.json` de forma atômica. */
  write(id: string, project: Project): Promise<void>
  rename(id: string, title: string): Promise<ProjectSummary>
  trash(id: string): Promise<void>
  reveal(id: string): Promise<void>
  /** Copia uma imagem para `media/` do projeto (fundo do vídeo); devolve o caminho relativo. */
  importBackground(id: string, source: string): Promise<string>
}

/** Extensões de imagem aceitas como fundo. */
export const BACKGROUND_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const

/**
 * O id é o nome da pasta: um único segmento, sem separadores nem `..`. O Windows descarta pontos e espaços do fim
 * do nome (`...` vira a própria raiz) e nomes como `CON` são dispositivos: também ficam de fora.
 */
export function assertProjectId(id: unknown): asserts id is string {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 200 ||
    id === '.' ||
    id === '..' ||
    /[\\/:*?"<>|\u0000-\u001f]/.test(id) ||
    id !== id.trim() ||
    id.endsWith('.') ||
    isReservedWindowsName(id)
  ) {
    throw new InvalidProjectIdError(`Identificador de projeto inválido: ${JSON.stringify(id)}`)
  }
}

export function createProjectStore(deps: ProjectStoreDeps): ProjectStore {
  const { logger } = deps
  // Evita encher o log com o mesmo aviso a cada atualização da biblioteca.
  const warned = new Set<string>()
  const warnOnce = (key: string, message: string, detail?: unknown): void => {
    if (warned.has(key)) return
    warned.add(key)
    logger.warn(message, detail)
  }

  const dirOf = (id: string): string => {
    assertProjectId(id)
    const root = deps.root()
    const dir = join(root, id)
    const rel = relative(root, dir)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes(sep)) {
      throw new InvalidProjectIdError(`Identificador de projeto inválido: ${JSON.stringify(id)}`)
    }
    return dir
  }

  /**
   * `dirOf` mais a conferência no disco: uma pasta de projeto que é atalho ou junção para FORA da raiz não serve
   * (senão ler, gravar ou mandar para a Lixeira agiria sobre outro lugar). Pasta que ainda não existe passa.
   */
  const checkedDir = async (id: string): Promise<string> => {
    const dir = dirOf(id)
    let real: [string, string]
    try {
      real = await Promise.all([realpath(deps.root()), realpath(dir)])
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return dir
      throw err
    }
    if (!isInside(real[0], real[1])) {
      throw new InvalidProjectIdError(`A pasta do projeto ${JSON.stringify(id)} aponta para fora da pasta dos projetos.`)
    }
    return dir
  }

  const readProject = async (dir: string): Promise<Project> => {
    const text = await readFile(join(dir, PROJECT_FILE), 'utf8')
    return parseProject(text)
  }

  const summarize = async (id: string, dir: string, project: Project): Promise<ProjectSummary> => {
    let thumbPath: string | null = null
    let thumbVersion = 0
    try {
      const info = await stat(join(dir, THUMB_PATH))
      if (info.isFile() && info.size > 0) {
        thumbPath = THUMB_PATH
        thumbVersion = Math.trunc(info.mtimeMs)
      }
    } catch {
      // sem miniatura: o cartão mostra um espaço reservado
    }
    return {
      id,
      title: project.title,
      createdAt: project.createdAt,
      durationMs: projectDurationMs(project),
      thumbPath,
      thumbVersion,
      hasScreen: Boolean(project.sources.screen),
      hasCamera: Boolean(project.sources.camera)
    }
  }

  const mediaFile = async (id: string, dir: string, src: Src | undefined, field: string): Promise<MediaFile | null> => {
    if (!src) return null
    // caminho que escapa da pasta é erro de verdade (sobe para a tela), não "arquivo não encontrado"
    const file = await resolveProjectFile(dir, src.path, field)
    try {
      const info = await stat(file)
      if (!info.isFile()) throw new Error('não é um arquivo')
      return { url: mediaUrl(id, src.path, info.mtimeMs), bytes: info.size }
    } catch (err) {
      logger.warn(`Arquivo de mídia do projeto ${id} não encontrado: ${src.path}`, err)
      return null
    }
  }

  return {
    dirOf,

    async list() {
      const root = deps.root()
      await mkdir(root, { recursive: true })
      const entries = await readdir(root, { withFileTypes: true })
      const out: ProjectSummary[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const dir = join(root, entry.name)
        try {
          const project = await readProject(dir)
          out.push(await summarize(entry.name, dir, project))
        } catch (err) {
          const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
          const reason = err instanceof ProjectFormatError ? err.message : missing ? `sem ${PROJECT_FILE}` : String(err)
          warnOnce(`${dir}::${reason}`, `Pasta ignorada na biblioteca (${entry.name}): ${reason}`)
        }
      }
      out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id))
      return out
    },

    async read(id) {
      const dir = await checkedDir(id)
      if (!(await pathExists(dir))) throw new ProjectNotFoundError(`Projeto não encontrado: ${id}`)
      try {
        return { project: await readProject(dir), dir }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new ProjectNotFoundError(`O projeto ${id} não tem ${PROJECT_FILE}.`)
        }
        throw err
      }
    },

    async detail(id) {
      const { project, dir } = await this.read(id)
      // O documento pode vir de terceiros: nenhum caminho dele sai da pasta do projeto.
      await assertDocumentPaths(dir, project)
      const eventUrl = async (rel: string): Promise<string | null> => ((await pathExists(await resolveProjectFile(dir, rel))) ? mediaUrl(id, rel) : null)
      /** Arquivo derivado que pode ter sido refeito: a URL leva a data dele, para a interface não ler a versão antiga do cache. */
      const versionedUrl = async (rel: string): Promise<string | null> => {
        try {
          const info = await stat(await resolveProjectFile(dir, rel))
          return info.isFile() ? mediaUrl(id, rel, Math.trunc(info.mtimeMs)) : null
        } catch {
          return null
        }
      }
      return {
        id,
        dir,
        project,
        media: {
          screen: await mediaFile(id, dir, project.sources.screen, 'sources.screen.path'),
          camera: await mediaFile(id, dir, project.sources.camera, 'sources.camera.path')
        },
        events: {
          cursor: await eventUrl(EVENT_FILES.cursor),
          clicks: await eventUrl(EVENT_FILES.clicks),
          keys: await eventUrl(EVENT_FILES.keys)
        },
        analysis: { face: await versionedUrl(FACE_FILE), matte: await currentMatteUrl(id, dir, project) }
      }
    },

    async write(id, project) {
      const dir = await checkedDir(id)
      await writeFileAtomic(join(dir, PROJECT_FILE), serializeProject(project))
    },

    async rename(id, title) {
      const clean = typeof title === 'string' ? title.trim() : ''
      if (!clean) throw new Error('O título não pode ficar vazio.')
      if (clean.length > MAX_TITLE_LENGTH) throw new Error(`O título passa de ${MAX_TITLE_LENGTH} caracteres.`)
      const { project, dir } = await this.read(id)
      const updated: Project = { ...project, title: clean,review:{...project.review,items:project.review?.items ?? {},titleOrigin:'manual'} }
      await writeFileAtomic(join(dir, PROJECT_FILE), serializeProject(updated))
      logger.info(`Projeto renomeado: ${id} → "${clean}"`)
      return summarize(id, dir, updated)
    },

    async trash(id) {
      const dir = await checkedDir(id)
      if (!(await pathExists(dir))) throw new ProjectNotFoundError(`Projeto não encontrado: ${id}`)
      await deps.trash(dir)
      // "Deu certo" só se a pasta saiu mesmo do lugar.
      if (await pathExists(dir)) {
        throw new Error(`Não consegui mandar o projeto para a Lixeira: a pasta continua em ${dir}.`)
      }
      logger.info(`Projeto enviado para a Lixeira: ${id}`)
    },

    async reveal(id) {
      const dir = await checkedDir(id)
      if (!(await pathExists(dir))) throw new ProjectNotFoundError(`Projeto não encontrado: ${id}`)
      await deps.openFolder(dir)
    },

    async importBackground(id, source) {
      const dir = await checkedDir(id)
      if (!(await pathExists(dir))) throw new ProjectNotFoundError(`Projeto não encontrado: ${id}`)
      const ext = extname(source).toLowerCase()
      if (!(BACKGROUND_EXTENSIONS as readonly string[]).includes(ext)) {
        throw new Error(`Use uma imagem PNG, JPG ou WebP (esta é "${ext || 'sem extensão'}").`)
      }
      const info = await stat(source).catch(() => null)
      if (!info || !info.isFile()) throw new Error(`Não encontrei a imagem: ${source}`)
      if (info.size > 40 * 1024 * 1024) throw new Error('A imagem passa de 40 MB. Use uma menor.')
      // o nome leva um resumo do caminho e do tamanho: a mesma imagem não se duplica, outra não se confunde
      const tag = createHash('sha1').update(`${source}|${info.size}|${Math.trunc(info.mtimeMs)}`).digest('hex').slice(0, 8)
      const rel = `media/fundo-${tag}${ext}`
      const target = await resolveProjectFile(dir, rel)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      logger.info(`Imagem de fundo importada para o projeto ${id}: ${rel}`)
      return rel
    }
  }
}
