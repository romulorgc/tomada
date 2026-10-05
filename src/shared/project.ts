/**
 * Criação, validação e migração do documento `project.json`.
 * Código puro: sem DOM, sem Node.
 *
 * Regra de compatibilidade: quem lê aceita documentos de versão IGUAL OU MAIOR
 * que a atual. Campos que este código não conhece são preservados (nada se
 * perde ao regravar) e campos que faltam recebem os padrões. Versão menor que 2
 * não existe (a v1 era outro formato, em `legado/`).
 */
import { z } from 'zod'
import type { CaptionStyle, CaptureInfo, Project, Src, Style } from './types'

export const CURRENT_PROJECT_VERSION = 2

export class ProjectFormatError extends Error {
  override readonly name = 'ProjectFormatError'
}

// ---------------------------------------------------------------------------
// Padrões

export function defaultStyle(): Style {
  return {
    background: { type: 'gradient', from: '#1d2740', to: '#0b0c10', angle: 135 },
    padding: 0.06,
    radius: 18,
    shadow: { blur: 40, opacity: 0.45, offsetY: 16 },
    defaultLayout: 'bubble',
    camera: {
      shape: 'circle',
      size: 0.26,
      corner: 'bottom-right',
      borderWidth: 4,
      borderColor: '#ffffff',
      mirror: false
    },
    cursor: { mode: 'real', scale: 2, ripple: true, hideAfterIdleMs: 2000 }
  }
}

export function defaultCaptions(): CaptionStyle {
  return {
    enabled: false,
    style: 'karaoke',
    wordsPerLine: 5,
    position: 'bottom',
    box: false,
    highlightColor: '#FFD93D'
  }
}

export function defaultCapture(): CaptureInfo {
  return { kind: 'screen', boundsPx: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1 }
}

// ---------------------------------------------------------------------------
// Esquema zod (objetos "loose": campos desconhecidos passam intactos)

const D = defaultStyle()
const C = defaultCaptions()

const rectSchema = z.looseObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
const rangeSchema = z.looseObject({ start: z.number(), end: z.number() })

const layoutKind = z.enum(['bubble', 'side-by-side', 'screen', 'camera', 'stack', 'screen-focus'])

const srcSchema = z.looseObject({
  path: z.string().min(1),
  w: z.number(),
  h: z.number(),
  fps: z.number(),
  durationMs: z.number()
})

const cutSchema = z.looseObject({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  reason: z.enum(['silence', 'filler', 'retake', 'manual', 'ai']),
  enabled: z.boolean()
})

const zoomSchema = z.looseObject({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  scale: z.number(),
  focus: z.union([z.literal('auto'), z.looseObject({ x: z.number(), y: z.number() })]),
  origin: z.enum(['auto', 'manual'])
})

const layoutSegSchema = z.looseObject({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  layout: layoutKind
})

const backgroundSchema = z.union([
  z.looseObject({ type: z.literal('gradient'), from: z.string(), to: z.string(), angle: z.number() }),
  z.looseObject({ type: z.literal('solid'), color: z.string() })
])

const cameraStyleSchema = z.looseObject({
  shape: z.enum(['circle', 'rounded', 'square']).default(D.camera.shape),
  size: z.number().default(D.camera.size),
  corner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default(D.camera.corner),
  borderWidth: z.number().default(D.camera.borderWidth),
  borderColor: z.string().default(D.camera.borderColor),
  mirror: z.boolean().default(D.camera.mirror)
})

const cursorStyleSchema = z.looseObject({
  mode: z.enum(['real', 'synthetic']).default(D.cursor.mode),
  scale: z.number().default(D.cursor.scale),
  ripple: z.boolean().default(D.cursor.ripple),
  hideAfterIdleMs: z.number().default(D.cursor.hideAfterIdleMs)
})

const styleSchema = z.looseObject({
  background: backgroundSchema.default(D.background),
  padding: z.number().default(D.padding),
  radius: z.number().default(D.radius),
  shadow: z
    .looseObject({
      blur: z.number().default(D.shadow.blur),
      opacity: z.number().default(D.shadow.opacity),
      offsetY: z.number().default(D.shadow.offsetY)
    })
    .prefault({}),
  defaultLayout: layoutKind.default(D.defaultLayout),
  camera: cameraStyleSchema.prefault({}),
  cursor: cursorStyleSchema.prefault({})
})

const captionStyleSchema = z.looseObject({
  enabled: z.boolean().default(C.enabled),
  style: z.enum(['plain', 'karaoke']).default(C.style),
  wordsPerLine: z.number().default(C.wordsPerLine),
  position: z.enum(['bottom', 'center', 'top']).default(C.position),
  box: z.boolean().default(C.box),
  highlightColor: z.string().default(C.highlightColor)
})

const clipSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  hook: z.string().default(''),
  ranges: z.array(rangeSchema),
  score: z.number().default(0),
  reason: z.string().default(''),
  format: z.enum(['vertical', 'horizontal']).default('vertical'),
  layoutV: z.enum(['stack', 'screen-focus', 'camera']).default('stack')
})

const captureSchema = z.looseObject({
  kind: z.enum(['screen', 'window']),
  boundsPx: rectSchema,
  scale: z.number()
})

export const projectSchema = z.looseObject({
  version: z.number().int().min(CURRENT_PROJECT_VERSION),
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.string(),
  sources: z
    .looseObject({
      screen: srcSchema.optional(),
      camera: srcSchema.optional(),
      voice: srcSchema.optional(),
      system: srcSchema.optional()
    })
    .prefault({}),
  sync: z
    .looseObject({
      screenOffsetMs: z.number().default(0),
      cameraOffsetMs: z.number().default(0)
    })
    .prefault({}),
  capture: captureSchema.default(defaultCapture()),
  cuts: z.array(cutSchema).default([]),
  zooms: z.array(zoomSchema).default([]),
  layouts: z.array(layoutSegSchema).default([]),
  style: styleSchema.prefault({}),
  captions: captionStyleSchema.prefault({}),
  clips: z.array(clipSchema).default([]),
  meta: z.looseObject({}).optional()
})

// Garante em tempo de compilação que o esquema produz o tipo `Project`.
const _schemaProduzProject: z.ZodType<Project, unknown> = projectSchema
void _schemaProduzProject

// ---------------------------------------------------------------------------
// Criar / migrar / serializar

export type CreateProjectInput = {
  title: string
  id?: string
  createdAt?: Date | string
  sources?: Project['sources']
  sync?: Partial<Project['sync']>
  capture?: CaptureInfo
}

/** Projeto novo com padrões bons. Só `title` é obrigatório. */
export function createProject(input: CreateProjectInput): Project {
  const createdAt =
    input.createdAt instanceof Date ? input.createdAt.toISOString() : (input.createdAt ?? new Date().toISOString())
  return {
    version: CURRENT_PROJECT_VERSION,
    id: input.id ?? globalThis.crypto.randomUUID(),
    title: input.title,
    createdAt,
    sources: input.sources ?? {},
    sync: { screenOffsetMs: 0, cameraOffsetMs: 0, ...input.sync },
    capture: input.capture ?? defaultCapture(),
    cuts: [],
    zooms: [],
    layouts: [],
    style: defaultStyle(),
    captions: defaultCaptions(),
    clips: []
  }
}

/**
 * Valida e completa um `project.json` já lido (qualquer versão ≥ 2).
 * Lança `ProjectFormatError` com o motivo legível se não der.
 */
export function migrate(raw: unknown): Project {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProjectFormatError('O project.json não é um objeto.')
  }
  const version = (raw as { version?: unknown }).version
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    throw new ProjectFormatError('O project.json não tem o campo "version".')
  }
  if (version < CURRENT_PROJECT_VERSION) {
    throw new ProjectFormatError(
      `Versão ${version} do projeto não é suportada (a mínima é ${CURRENT_PROJECT_VERSION}).`
    )
  }
  const parsed = projectSchema.safeParse(raw)
  if (!parsed.success) {
    const motivo = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('; ')
    throw new ProjectFormatError(`project.json inválido: ${motivo}`)
  }
  return parsed.data
}

/** Texto JSON → projeto validado. */
export function parseProject(text: string): Project {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new ProjectFormatError(`project.json não é um JSON válido: ${(err as Error).message}`)
  }
  return migrate(raw)
}

/** Projeto → texto do arquivo (indentado, com quebra de linha final). */
export function serializeProject(project: Project): string {
  return `${JSON.stringify(project, null, 2)}\n`
}

/** Maior duração entre as fontes de vídeo/áudio (ms). 0 se não houver nenhuma. */
export function projectDurationMs(project: Pick<Project, 'sources'>): number {
  const all: (Src | undefined)[] = [
    project.sources.screen,
    project.sources.camera,
    project.sources.voice,
    project.sources.system
  ]
  let max = 0
  for (const src of all) if (src && src.durationMs > max) max = src.durationMs
  return max
}
