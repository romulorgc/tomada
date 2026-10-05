/**
 * Ajudantes dos testes das abas Cortes, Publicar e IA (M4b): o projeto LONGO (3 min) com a transcrição da demonstração
 * sintética "Agendaí" e uma tela de cor lisa (só a legenda põe o amarelo de destaque no quadro), e a IA de TESTE com
 * respostas gravadas (`TOMADA_LLM_RESPONSES`, uma por tarefa). Nada aqui toca a IA de verdade nem dado de pessoa.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProject, serializeProject } from '../../src/shared/project'
import type { Project } from '../../src/shared/types'
import { buildDemo, sentenceRange, type Demo } from '../helpers/demo-script'
import { copyTree } from '../helpers/fs'
import { ensureLongProject, LONG_FOLDER, LONG_MS } from '../helpers/long-project'
import { launchTomada, type Session } from './helpers'

export { LONG_FOLDER, LONG_MS }

/** A demonstração narrada que cabe nos 180 s do projeto longo (30 frases, de "Oi pessoal" a "ficha do cliente"). */
export const DEMO: Demo = buildDemo({ maxMs: 178_000 })

/** Os assuntos do roteiro como cortes certos (índices de frase). */
export const TOPIC = { cliente: [3, 9], agenda: [10, 16], lembrete: [17, 22], relatorio: [23, 28] } as const

export const range = (a: number, b: number): [number, number] => sentenceRange(DEMO, a, b)

const temps: string[] = []

/** Grava a lista de respostas da IA de teste e devolve o caminho (apagado em `cleanupLong`). */
export function writeResponses(list: readonly unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'tomada-llm-'))
  temps.push(dir)
  const file = join(dir, 'respostas.json')
  writeFileSync(file, JSON.stringify(list))
  return file
}

export function cleanupLong(): void {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

const ffmpeg = (args: string[]): void => {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
}

export type LongOptions = {
  /** Respostas gravadas da IA de teste (todas as tarefas). Sem isto, a IA de teste não acha cortes nem muda nada. */
  responses?: readonly unknown[]
  /** `off`: a IA está desligada (provar as mensagens e a heurística). */
  llm?: 'mock' | 'off'
  /** Ajusta o documento antes de o app abrir. */
  edit?: (p: Project) => void
  /** Mantém a câmera do projeto (padrão: sem câmera, para só a legenda pôr amarelo no quadro). */
  camera?: boolean
  /** `false`: o projeto não tem transcrição. */
  transcript?: boolean
  /** `false`: mantém a tela colorida do projeto sintético (padrão: tela de cor lisa). */
  solidScreen?: boolean
  /** `false`: deixa a edição vertical por conta do programa (zooms e layouts pela atividade), em vez de fixá-la. */
  fixedVertical?: boolean
}

/**
 * Abre o Tomada com o projeto longo já na biblioteca: tela de cor lisa, sem câmera, 30 cortes de silêncio (a "limpeza" que cada
 * corte herda), legenda Destaque ligada no vertical (sem zoom, para o quadro ser previsível) e a transcrição da demonstração.
 */
export async function launchLong(opts: LongOptions = {}): Promise<Session> {
  const base = mkdtempSync(join(tmpdir(), 'tomada-e2e-'))
  const dir = join(base, 'projetos', LONG_FOLDER)
  mkdirSync(join(base, 'projetos'), { recursive: true })
  copyTree(ensureLongProject(), dir)

  // a tela do projeto sintético tem cor demais: troca por um azul-marinho liso (mesma receita de codificação)
  if (opts.solidScreen !== false) {
    ffmpeg([
      '-f', 'lavfi', '-i', `color=c=0x1b2a41:s=1920x1080:r=30:d=${LONG_MS / 1000}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '27', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(dir, 'media', 'screen.mp4')
    ])
  }

  const file = join(dir, 'project.json')
  const p = parseProject(readFileSync(file, 'utf8'))
  if (opts.camera !== true) {
    delete p.sources.camera
    p.style.defaultLayout = 'screen'
  }
  if (opts.fixedVertical !== false) {
    p.zoomPreset = undefined
    p.vertical = { layout: 'screen-focus', layouts: [], zooms: [], zoomPreset: 'off', captions: { enabled: true, style: 'highlight', wordsPerLine: 3 } }
  }
  opts.edit?.(p)
  writeFileSync(file, serializeProject(p))

  // a transcrição é ANTERIOR ao projeto: a limpeza automática (que só roda em transcrição nova) não mexe nos cortes
  if (opts.transcript !== false) {
    writeFileSync(
      join(dir, 'transcript.json'),
      `${JSON.stringify({ engine: 'teste', model: 'demo', language: 'pt', durationMs: LONG_MS, words: DEMO.words, segments: [], vad: [], createdAt: '2026-10-05T10:00:00.000Z' })}\n`
    )
  }
  // os cliques e as teclas da demonstração (atividade de tela por frase)
  writeFileSync(join(dir, 'events', 'clicks.jsonl'), `${DEMO.clicks.map((t) => JSON.stringify({ t, x: 0.5, y: 0.5, button: 'left', upT: t + 80 })).join('\n')}\n`)
  writeFileSync(join(dir, 'events', 'keys.jsonl'), `${DEMO.keys.map((t) => JSON.stringify({ t })).join('\n')}\n`)

  const env: Record<string, string> = { TOMADA_LLM: opts.llm ?? 'mock' }
  if (opts.responses) env.TOMADA_LLM_RESPONSES = writeResponses(opts.responses)
  return launchTomada({ base, env })
}

/** O `project.json` do projeto longo como está no disco agora. */
export function readLong(session: Session): Project {
  return parseProject(readFileSync(join(session.projects, LONG_FOLDER, 'project.json'), 'utf8'))
}

export function longDir(session: Session): string {
  return join(session.projects, LONG_FOLDER)
}

// ---------------------------------------------------------------------------
// Respostas gravadas da IA de teste

/** Os três cortes certos (um por assunto). Um vídeo de 3 min comporta 2 por pedido: o terceiro vem em "Sugerir mais cortes". */
const AGENDA_CLIP = {
  title: 'Agende em três cliques, sem planilha',
  hook: 'Agende em três cliques, sem planilha',
  ranges: [range(...TOPIC.agenda)],
  score: 90,
  notes: { hook: 88, flow: 90, value: 92 },
  reason: 'Mostra o agendamento do pedido ao horário marcado.'
}
const LEMBRETE_CLIP = {
  title: 'Lembrete automático por WhatsApp',
  hook: 'Os lembretes saem sozinhos',
  ranges: [range(...TOPIC.lembrete)],
  score: 82,
  notes: { hook: 80, flow: 84, value: 82 },
  reason: 'Liga o lembrete e mostra o resultado.'
}
const RELATORIO_CLIP = {
  title: 'Feche o mês em um minuto',
  hook: 'Feche o mês em um minuto',
  ranges: [range(...TOPIC.relatorio)],
  score: 76,
  notes: { hook: 74, flow: 78, value: 76 },
  reason: 'O relatório do mês, do pedido à planilha.'
}

/** 1º pedido: agenda e lembrete. 2º pedido ("Sugerir mais cortes"): a agenda de novo (já existe) e o relatório. */
export const CLIPS_RESPONSES = [
  { task: 'clips', match: '', times: 1, response: { clips: [AGENDA_CLIP, LEMBRETE_CLIP] } },
  { task: 'clips', match: '', times: 1, response: { clips: [{ ...AGENDA_CLIP, score: 85 }, RELATORIO_CLIP] } }
]

/** Os textos de publicação: 3 títulos, descrição, tags, capítulos (um por assunto) e legenda dos dois primeiros cortes. */
export const PUBLISH_RESPONSE = {
  task: 'publish',
  match: '',
  response: {
    titles: ['Agenda de barbearia sem planilha: o Agendaí por dentro', 'Cadastro, agenda, lembrete e relatório em 3 minutos', 'Para quem cuida de uma barbearia e quer parar de anotar à mão'],
    description: 'O Agendaí é uma agenda feita para barbearias. Neste vídeo você vê o cadastro de clientes, a agenda da semana, o lembrete por WhatsApp e o relatório do mês.\n\nServe para quem ainda anota horário em caderno ou planilha.',
    tags: ['agenda', 'barbearia', 'agendamento online', 'lembrete por whatsapp', 'relatório de faturamento'],
    chapters: [
      { from: range(...TOPIC.cliente)[0], title: 'Cadastro de clientes' },
      { from: range(...TOPIC.agenda)[0], title: 'Agenda da semana' },
      { from: range(...TOPIC.lembrete)[0], title: 'Lembrete por WhatsApp' },
      { from: range(...TOPIC.relatorio)[0], title: 'Relatório do mês' }
    ],
    clips: [
      { id: 'clip-1', caption: 'Agende em três cliques, sem planilha. Veja como no Agendaí.', tiktok: ['#agenda', '#barbearia', '#agendamento'], reels: ['#agenda', '#barbearia', '#gestao'], shorts: ['#agenda', '#Shorts'] },
      { id: 'clip-2', caption: 'Os lembretes saem sozinhos, por WhatsApp.', tiktok: ['#lembrete', '#whatsapp', '#barbearia'], reels: ['#lembrete', '#whatsapp', '#barbearia'], shorts: ['#lembrete', '#Shorts'] }
    ]
  }
}

/** Uma resposta de "editar pedindo" que vale para pedidos com `match` no texto. */
export const editResponse = (match: string, ops: unknown[], reply: string): unknown => ({ task: 'edit', match, response: { ops, reply } })

/** Texto da interface que nunca pode nomear o fornecedor da IA. */
export const VENDOR = /claude|anthropic|openai|chatgpt|\bgpt\b|gemini|sonnet|opus|haiku/i
