import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { afterAll } from 'vitest'
import { createAutopilot, type AutopilotDeps } from '../../src/main/autopilot'
import { createMemoryLogger } from '../../src/main/logger'
import { DEFAULT_AUTOPILOT, PIPELINE_STEPS, type AutopilotPrefs, type PipelineStepId } from '../../src/shared/autopilot'
import { createProject } from '../../src/shared/project'
import type { Project, Transcript, Word } from '../../src/shared/types'
import type { LlmProvider } from '../../src/main/llm/provider'

const folders: string[] = []
afterAll(async () => { for (const folder of folders) await rm(folder, { recursive: true, force: true }) })

export const clipWords: Word[] = Array.from({ length: 36 }, (_, i) => ({ i, text: i % 12 === 11 ? 'resultado.' : 'Demonstre', start: i * 3000 + 150, end: (i + 1) * 3000 - 350, prob: 1, kind: 'word' }))
export const clipResponse = (score: number, part: number) => ({ title: `Resultado ${part}`, hook: 'Resolva sua tarefa agora', ranges: [[part * 12, part * 12 + 11]], score, notes: { hook: score, flow: score, value: score }, reason: 'Demonstração sintética completa' })

export async function pilotWorld(options: { provider?: LlmProvider; words?: Word[]; steps?: PipelineStepId[]; vocabulary?: string[]; initial?: Partial<Project>; exporter?(dir: string): Partial<AutopilotDeps['exporter']> } = {}) {
  const root = resolve('test-results/acabamento-piloto')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(join(root, 'cenario-'))
  folders.push(dir)
  await Promise.all(['media', 'events', 'exports'].map((name) => mkdir(join(dir, name))))
  const words = options.words ?? clipWords
  const durationMs = Math.max(108_000, words.at(-1)?.end ?? 0)
  let project: Project = { ...createProject({ id: 'acabamento', title: 'Demonstração', sources: { screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs } } }), ...options.initial }
  const transcript: Transcript = { words, segments: [], vad: [], durationMs, engine: 'teste', model: 'sintético', language: 'pt', createdAt: '2026-10-06' }
  const prefs: AutopilotPrefs = { ...DEFAULT_AUTOPILOT, mode: 'prepare', steps: Object.fromEntries(PIPELINE_STEPS.map((id) => [id, (options.steps ?? ['clips']).includes(id)])) }
  const deps = {
    store: { dirOf: () => dir, read: async () => ({ project: structuredClone(project), dir }), write: async (_id: string, value: Project) => { project = structuredClone(value) }, list: async () => [{ id: project.id, title: project.title, createdAt: project.createdAt, durationMs, hasScreen: !!project.sources.screen, hasCamera: !!project.sources.camera, thumbPath: null, thumbVersion: 0 }] },
    transcription: { getTranscript: async () => structuredClone(transcript), idle: async () => {}, start: async () => {} },
    exporter: options.exporter?.(dir) ?? {}, derived: {}, llm: { provider: () => options.provider ?? null }, logger: createMemoryLogger(), prefs: () => prefs,
    vocabulary: () => options.vocabulary ?? [], emit: () => {}, ready: () => {}
  } as unknown as AutopilotDeps
  return { service: createAutopilot(deps), project: () => structuredClone(project), prefs, transcript }
}
