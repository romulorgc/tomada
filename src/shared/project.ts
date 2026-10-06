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
import { audioQualitySchema } from './audio-quality'
import { videoScriptSchema } from './script'
import { retakeMarkSchema } from './retake-marker'
import { pipelineSchema } from './autopilot'
import { reviewItemSchema } from './review-schema'
import type { CaptionStyle, CaptionStyleId, CaptureInfo, Project, Src, Style } from './types'

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
      mirror: false,
      hidden: false,
      shrinkOnZoom: true
    },
    cursor: { mode: 'real', scale: 2, ripple: true, hideAfterIdleMs: 2000, halo: false }
  }
}

export function defaultCaptions(): CaptionStyle {
  return {
    enabled: false,
    style: 'natural',
    wordsPerLine: 5,
    position: 'bottom',
    box: true,
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

const layoutKind = z.enum(['bubble', 'side-by-side', 'screen', 'camera', 'stack', 'screen-focus', 'screen-wide', 'presenter'])

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
  enabled: z.boolean(),
  origin: z.enum(['auto', 'manual']).optional()
})

const muteSchema = z.looseObject({
  id: z.string(),
  start: z.number(),
  end: z.number(),
  reason: z.enum(['filler', 'manual']),
  enabled: z.boolean()
})

const blurRegionSchema = z.looseObject({
  id: z.string().min(1).max(100),
  start: z.number().finite().min(0),
  end: z.number().finite().min(0),
  rect: z.looseObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), w: z.number().finite().gt(0).max(1), h: z.number().finite().gt(0).max(1) })
    .refine(r => r.x + r.w <= 1.000000001 && r.y + r.h <= 1.000000001),
  mode: z.enum(['blur', 'pixelate', 'solid']).default('blur')
}).refine(r => r.end > r.start)

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
  ,origin: z.enum(['auto', 'manual']).optional()
})

const backgroundSchema = z.union([
  z.looseObject({ type: z.literal('gradient'), from: z.string(), to: z.string(), angle: z.number() }),
  z.looseObject({ type: z.literal('solid'), color: z.string() }),
  z.looseObject({ type: z.literal('image'), path: z.string() })
])

const cornerSchema = z.enum([
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right'
])

const cameraStyleSchema = z.looseObject({
  shape: z.enum(['circle', 'rounded', 'square']).default(D.camera.shape),
  size: z.number().default(D.camera.size),
  corner: cornerSchema.default(D.camera.corner),
  borderWidth: z.number().default(D.camera.borderWidth),
  borderColor: z.string().default(D.camera.borderColor),
  mirror: z.boolean().default(D.camera.mirror),
  hidden: z.boolean().default(D.camera.hidden),
  shrinkOnZoom: z.boolean().default(D.camera.shrinkOnZoom),
  framing: z.looseObject({ auto: z.boolean().optional(), zoom: z.number().optional(), dx: z.number().optional(), dy: z.number().optional() }).optional()
})

const cursorStyleSchema = z.looseObject({
  mode: z.enum(['real', 'synthetic']).default(D.cursor.mode),
  scale: z.number().default(D.cursor.scale),
  ripple: z.boolean().default(D.cursor.ripple),
  hideAfterIdleMs: z.number().default(D.cursor.hideAfterIdleMs),
  halo: z.boolean().default(D.cursor.halo)
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
  cursor: cursorStyleSchema.prefault({}),
  sideBySide: z
    .looseObject({ side: z.enum(['left', 'right']).optional(), ratio: z.enum(['portrait', 'square']).optional(), width: z.number().optional(), gap: z.number().optional() })
    .optional(),
  presenter: z
    .looseObject({
      side: z.enum(['left', 'right']).optional(),
      height: z.number().optional(),
      heightV: z.number().optional(),
      outline: z.boolean().optional(),
      outlineWidth: z.number().optional(),
      shadow: z.boolean().optional()
    })
    .optional()
})

/** O estilo de legenda; o "plain" das versões antigas do documento vira "natural". */
const captionStyleId = z.enum(['natural', 'highlight', 'clean', 'karaoke', 'plain']).transform((v): CaptionStyleId => (v === 'plain' ? 'natural' : v))

const captionStyleSchema = z.looseObject({
  enabled: z.boolean().default(C.enabled),
  style: captionStyleId.default(C.style),
  wordsPerLine: z.number().default(C.wordsPerLine),
  position: z.enum(['bottom', 'center', 'top']).default(C.position),
  box: z.boolean().default(C.box),
  highlightColor: z.string().default(C.highlightColor),
  textColor: z.string().optional(),
  size: z.number().optional(),
  positionY: z.number().optional(),
  uppercase: z.boolean().optional(),
  highlightWord: z.boolean().optional()
})

const autoExclusionsSchema = z.object({zooms:z.array(z.string()).optional(),layouts:z.array(z.string()).optional()})
const verticalSchema = z.looseObject({
  autoExclusions:autoExclusionsSchema.optional(),
  layout: layoutKind.default('screen-focus'),
  layouts: z.array(layoutSegSchema).default([]),
  zooms: z.array(zoomSchema).default([]),
  zoomPreset: z.enum(['subtle', 'moderate', 'intense', 'off']).optional(),
  camera: z.looseObject({ corner: cornerSchema.optional(), size: z.number().optional() }).optional(),
  hook: z.string().optional(),
  cameraTop: z.boolean().optional(),
  captions: z
    .looseObject({
      enabled: z.boolean().optional(),
      style: captionStyleId.optional(),
      wordsPerLine: z.number().optional(),
      position: z.enum(['bottom', 'center', 'top']).optional(),
      box: z.boolean().optional(),
      size: z.number().optional(),
      positionY: z.number().optional(),
      uppercase: z.boolean().optional(),
      highlightWord: z.boolean().optional(),
      highlightColor: z.string().optional(),
      textColor: z.string().optional()
    })
    .optional()
})

const clipSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  hook: z.string().default(''),
  ranges: z.array(rangeSchema),
  score: z.number().default(0),
  notes: z.looseObject({ hook: z.number(), flow: z.number(), value: z.number() }).optional(),
  reason: z.string().default(''),
  format: z.enum(['vertical', 'horizontal']).default('vertical'),
  layoutV: z.enum(['auto', 'stack', 'screen-focus', 'screen-wide', 'camera', 'presenter']).default('auto'),
  captionStyle: captionStyleId.optional(),
  captionsEnabled: z.boolean().optional(),
  source: z.enum(['ai', 'heuristic', 'manual']).optional()
})

const strings = z.array(z.string())
const metaSchema = z.looseObject({
  youtube: z
    .looseObject({
      titles: strings.optional(),
      description: z.string().optional(),
      tags: strings.optional(),
      chapters: z.array(z.looseObject({ start: z.number(), title: z.string() })).optional()
    })
    .optional(),
  perClip: z
    .record(
      z.string(),
      z.looseObject({ caption: z.string().optional(), hashtags: strings.optional(), tiktok: strings.optional(), reels: strings.optional(), shorts: strings.optional() })
    )
    .optional()
})

const captureSchema = z.looseObject({
  kind: z.enum(['screen', 'window']),
  boundsPx: rectSchema,
  scale: z.number(),
  frameSize: z.looseObject({ w: z.number(), h: z.number() }).optional(),
  cursorHidden: z.boolean().optional(),
  sourceName: z.string().optional(),
  browser: z.looseObject({ exe: z.string(), engine: z.enum(['chromium', 'gecko']), contentRect: z.boolean() }).optional()
})

const screenCropSchema = z.looseObject({
  mode: z.enum(['auto', 'manual', 'off']),
  manual: rectSchema.optional(),
  browserFrame: z.looseObject({ enabled: z.boolean(), domain: z.string().max(120).optional() }).optional()
})

export const projectSchema = z.looseObject({
  audioQuality: audioQualitySchema.optional(),
  pcmSyncWarning: z.boolean().optional(),
  autoExclusions:autoExclusionsSchema.optional(),
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
      cameraOffsetMs: z.number().default(0),
      cameraAvOffsetMs: z.number().finite().min(-600).max(600).optional(),
      cameraAvManualOffsetMs: z.number().finite().min(-300).max(300).optional(),
      cameraAvDetection: z.looseObject({ method: z.enum(['syncnet', 'calibration', 'none']), confidence: z.number().finite(), segments: z.number().int().min(0), measuredAt: z.string(), reason: z.string().optional() }).optional()
    })
    .prefault({}),
  capture: captureSchema.default(defaultCapture()),
  cuts: z.array(cutSchema).default([]),
  blurRegions: z.array(blurRegionSchema).max(1000).optional(),
  mutes: z.array(muteSchema).optional(),
  zooms: z.array(zoomSchema).default([]),
  layouts: z.array(layoutSegSchema).default([]),
  style: styleSchema.prefault({}),
  captions: captionStyleSchema.prefault({}),
  clips: z.array(clipSchema).default([]),
  zoomPreset: z.enum(['subtle', 'moderate', 'intense', 'off']).optional(),
  screenCrop: screenCropSchema.optional(),
  vertical: verticalSchema.optional(),
  wordFixes: z.record(z.string(), z.string()).optional(),
  autoCleaned: z.boolean().optional(),
  autopilot: pipelineSchema.optional(),
  review: z.looseObject({ items: z.record(z.string(), reviewItemSchema.extend({ edits: z.object({ cuts: z.array(cutSchema), zooms: z.array(zoomSchema), layouts: z.array(layoutSegSchema), captions: captionStyleSchema, style: styleSchema, autoExclusions:autoExclusionsSchema.optional(), wordFixes:z.record(z.string(),z.string()).optional(), mutes:z.array(muteSchema).optional(), meta:metaSchema.optional(), zoomPreset:z.enum(['subtle','moderate','intense','off']).optional() }).optional() })), metaOrigin: z.enum(['auto','manual']).optional(), titleOrigin: z.enum(['auto','manual']).optional() }).optional(),
  meta: metaSchema.optional(),
  script: videoScriptSchema.optional(),
  retakeMarks: z.array(retakeMarkSchema).optional(),
  cameraStyle: z.enum(['side-by-side', 'presenter']).optional()
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
