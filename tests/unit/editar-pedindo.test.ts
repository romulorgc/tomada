import { defaultVerticalEdit,projectForFormat } from '../../src/shared/vertical'
import { describe, expect, it } from 'vitest'
import { EDIT_CONFIRM_FRACTION, EDIT_MAX_OPS, EDIT_SUGGESTIONS, aiOpSchema, buildEditPrompt, editSchema, editSystem, planAiEdit, type PlanInput } from '../../src/shared/ai-edit'
import { createProject } from '../../src/shared/project'
import { outputDuration } from '../../src/shared/timeline'
import type { Project } from '../../src/shared/types'
import { buildDemo, sentenceRange } from '../helpers/demo-script'

const demo = buildDemo()
const durationMs = demo.durationMs

function project(withCamera = true): Project {
  return createProject({
    title: 'Demonstração do Agendaí',
    sources: {
      screen: { path: 'media/screen.mp4', w: 1920, h: 1080, fps: 30, durationMs },
      ...(withCamera ? { camera: { path: 'media/camera.mp4', w: 640, h: 360, fps: 30, durationMs } } : {}),
      voice: { path: 'media/voice.wav', w: 0, h: 0, fps: 0, durationMs }
    }
  })
}

const plan = (ops: unknown[], extra: Partial<PlanInput> = {}) => planAiEdit({ project: project(), words: demo.words, durationMs, format: 'horizontal', ops, ...extra })
const cut = (a: number, b: number) => ({ op: 'cut', from: sentenceRange(demo, a, b)[0], to: sentenceRange(demo, a, b)[1] })

describe('editar pedindo: o pedido à IA', () => {
  it('o texto do sistema lista as operações e só os layouts que o formato aberto (e o projeto) tem', () => {
    const h = editSystem('horizontal', true)
    for (const op of ['"op":"cut"', '"op":"restore"', '"op":"zoom"', '"op":"layout"', '"op":"clip"', '"op":"captions"', '"op":"title"']) expect(h).toContain(op)
    for (const l of ['"bubble"', '"side-by-side"', '"screen"', '"camera"']) expect(h).toContain(l)
    expect(h).not.toContain('"screen-focus"')
    const v = editSystem('vertical', true)
    for (const l of ['"screen-focus"', '"stack"', '"screen-wide"', '"camera"']) expect(v).toContain(l)
    expect(v).not.toContain('"bubble"')
    const noCam = editSystem('horizontal', false)
    expect(noCam).not.toContain('"side-by-side"')
    expect(noCam).not.toContain('(só a câmera)')
    expect(h).toMatch(/Responda SOMENTE com um JSON/)
    expect(h).toMatch(/Nunca invente números de palavra/)
    expect(h).not.toMatch(/claude|anthropic|openai|gpt/i)
  })

  it('o pedido leva o texto da pessoa, o estado do projeto e a transcrição com o número de cada palavra', () => {
    const p = project()
    p.cuts = [
      { id: 'c1', start: 100, end: 400, reason: 'silence', enabled: true },
      { id: 'c2', start: demo.sentences[5]!.startMs, end: demo.sentences[5]!.endMs, reason: 'manual', enabled: true },
      { id: 'c3', start: 50_000, end: 51_000, reason: 'manual', enabled: false }
    ]
    p.zooms = [{ id: 'zoom-1', start: 20_000, end: 22_000, scale: 1.7, focus: 'auto', origin: 'manual' }]
    p.layouts = [{ id: 'layout-1', start: 30_000, end: 33_000, layout: 'side-by-side' }]
    p.clips = [{ id: 'clip-1', title: 'Cadastro', hook: 'x', ranges: [{ start: 16_000, end: 52_000 }], score: 80, reason: '', format: 'vertical', layoutV: 'auto' }]
    const prompt = buildEditPrompt({ instruction: 'Tira a parte do "preço"\ne corta o resto', words: demo.words, project: p, format: 'horizontal', durationMs, clicks: demo.clicks, keys: demo.keys })
    expect(prompt).toContain('Pedido da pessoa: "Tira a parte do \\"preço\\" e corta o resto"')
    expect(prompt).toMatch(/formato aberto: 16:9 \(horizontal\)/)
    expect(prompt).toMatch(/câmera: sim/)
    expect(prompt).toMatch(/legenda: desligada/)
    expect(prompt).toContain('1 silêncios cortados')
    expect(prompt).toMatch(/palavras \d+–\d+ \(cortado pela pessoa\)/)
    expect(prompt).not.toContain('50 s') // o corte desligado não conta
    expect(prompt).toContain('Zooms: 1')
    expect(prompt).toMatch(/Trechos de layout: 0:30–0:33 side-by-side/)
    expect(prompt).toMatch(/Cortes verticais já criados: "Cadastro" \(0:16–0:52\)/)
    // a transcrição: uma linha por frase, palavras com o número entre colchetes, atividade na tela
    const lines = prompt.split('\n').filter((l) => /^\d+:\d\d–\d+:\d\d · /.test(l))
    expect(lines).toHaveLength(demo.sentences.length)
    expect(lines[0]).toContain('sem ação na tela · [0]Oi [1]pessoal, [2]tudo [3]bem?')
    expect(prompt).toMatch(/\[\d+\]hã/) // a hesitação tem número (dá para cortá-la), a fala sem palavra não entra
    expect(prompt).toMatch(/1 clique, 20 teclas|1 clique, 12 teclas/)
    expect(prompt).not.toMatch(/[A-Za-z]:\\|tomada-media|\.mp4|\.wav/)
  })

  it('muitos cortes de silêncio viram uma linha só e a lista dos outros é limitada', () => {
    const p = project()
    p.cuts = Array.from({ length: 80 }, (_, k) => ({ id: `c${k}`, start: 1000 + k * 2000, end: 1300 + k * 2000, reason: k < 10 ? ('silence' as const) : ('manual' as const), enabled: true }))
    const prompt = buildEditPrompt({ instruction: 'oi', words: demo.words, project: p, format: 'vertical', durationMs })
    expect(prompt).toMatch(/formato aberto: 9:16 \(vertical\)/)
    expect(prompt).toContain('10 silêncios cortados')
    expect(prompt).toContain('e mais 30 cortes')
  })

  it('a resposta tem as operações como lista aberta (cada uma é conferida depois) e as sugestões do painel existem', () => {
    expect(editSchema.safeParse({ ops: [{ op: 'cut' }, 'lixo', 3], reply: 'ok' }).success).toBe(true)
    expect(editSchema.safeParse({ reply: 'sem ops' }).success).toBe(false)
    expect(EDIT_SUGGESTIONS).toEqual(['Deixa mais dinâmico', 'Corta as partes repetidas', 'Faz 3 cortes para TikTok', 'Gera título e descrição'])
    expect(aiOpSchema.safeParse({ op: 'cut', from: 1, to: 2 }).success).toBe(true)
    expect(aiOpSchema.safeParse({ op: 'cut', from: 1.5, to: 2 }).success).toBe(false)
  })
})

describe('editar pedindo: aplicar as operações', () => {
  it('um corte vira UMA mudança com motivo "ai", o vídeo encolhe e o resumo diz quanto', () => {
    const input = project()
    const before = structuredClone(input)
    const r = planAiEdit({ project: input, words: demo.words, durationMs, format: 'horizontal', ops: [cut(4, 5)] })
    expect(r.changed).toBe(true)
    expect(r.refused).toEqual([])
    expect(r.project.cuts).toHaveLength(1)
    expect(r.project.cuts[0]).toMatchObject({ reason: 'ai', enabled: true })
    expect(r.beforeMs).toBe(durationMs)
    expect(r.afterMs).toBe(outputDuration(durationMs, r.project.cuts))
    expect(r.removedMs).toBe(r.beforeMs - r.afterMs)
    expect(r.removedMs).toBeGreaterThan(5000)
    expect(r.summary).toMatch(/^Cortei 1 trecho \(−\d+(,\d)? s\)\.$/)
    expect(r.needsConfirm).toBe(false)
    expect(input).toEqual(before) // o documento de entrada não foi tocado
  })

  it('o resumo junta o que mudou: "Cortei 2 trechos (−…), adicionei 1 zoom e troquei o título."', () => {
    const r = plan([cut(4, 4), cut(7, 7), { op: 'zoom', from: sentenceRange(demo, 12, 12)[0], to: sentenceRange(demo, 12, 12)[1] }, { op: 'title', text: 'Agendaí em 3 minutos' }])
    expect(r.summary).toMatch(/^Cortei 2 trechos \(−\d+(,\d)? s\), adicionei 1 zoom e troquei o título\.$/)
    expect(r.project.title).toBe('Agendaí em 3 minutos')
    expect(r.project.zooms).toHaveLength(1)
    expect(r.project.zooms[0]).toMatchObject({ origin: 'manual', scale: 1.6 }) // o padrão do 16:9 (F3: 1,5 a 1,8×)
  })

  it('operação inválida é RECUSADA com o motivo e as válidas valem; nada é aplicado pela metade', () => {
    const r = plan([cut(4, 4), { op: 'cut', from: 5, to: 99_999 }, { op: 'cut', from: 30, to: 10 }, { op: 'dance' }, 'lixo', { op: 'zoom', from: 1 }])
    expect(r.changed).toBe(true)
    expect(r.applied).toHaveLength(1)
    expect(r.project.cuts).toHaveLength(1)
    expect(r.refused.map((x) => [x.index, x.op])).toEqual([[1, 'cut'], [2, 'cut'], [3, 'dance'], [4, ''], [5, 'zoom']])
    expect(r.refused[0]!.why).toBe('a palavra 99999 não existe')
    expect(r.refused[1]!.why).toBe('o trecho 30–10 termina antes de começar')
    expect(r.refused[2]!.why).toBe('operação desconhecida "dance"')
    expect(r.refused[3]!.why).toBe('não é uma operação')
    expect(r.refused[4]!.why).toMatch(/^faltam dados ou há dados inválidos/)
    expect(r.summary).toMatch(/^Cortei 1 trecho \(−\d+(,\d)? s\)\. 5 operações foram recusadas: a palavra 99999 não existe; /)
  })

  it('só operações inválidas: nada muda, o documento é o mesmo objeto e o resumo diz que nada foi aplicado', () => {
    const input = project()
    const r = planAiEdit({ project: input, words: demo.words, durationMs, format: 'horizontal', ops: [{ op: 'cut', from: -3, to: 4 }, { op: 'zoom', from: 7, to: 8, scale: 99 }] })
    expect(r.changed).toBe(false)
    expect(r.project).toBe(input)
    expect(r.applied).toEqual([])
    expect(r.refused).toHaveLength(2)
    expect(r.summary).toBe('Não apliquei nada: as 2 operações da IA eram inválidas.')
  })

  it('sem operações a mensagem é a da própria IA; resposta com operações demais é recusada inteira', () => {
    expect(plan([], { reply: 'Não achei nenhuma parte sobre preço.' })).toMatchObject({ changed: false, summary: 'Não achei nenhuma parte sobre preço.', reply: 'Não achei nenhuma parte sobre preço.' })
    expect(plan([]).summary).toBe('A IA não propôs nenhuma mudança.')
    const many = plan(Array.from({ length: EDIT_MAX_OPS + 1 }, () => cut(4, 4)))
    expect(many.changed).toBe(false)
    expect(many.summary).toMatch(/operações demais/)
  })

  it('cortar o que já está cortado e restaurar o que não está cortado são recusados', () => {
    const p = project()
    const first = planAiEdit({ project: p, words: demo.words, durationMs, format: 'horizontal', ops: [cut(4, 5)] })
    const again = planAiEdit({ project: first.project, words: demo.words, durationMs, format: 'horizontal', ops: [cut(4, 5)] })
    expect(again.changed).toBe(false)
    expect(again.refused[0]!.why).toBe('esse trecho já estava cortado')
    const [from, to] = sentenceRange(demo, 9, 9)
    const none = plan([{ op: 'restore', from, to }])
    expect(none.refused[0]!.why).toBe('esse trecho não estava cortado')
  })

  it('restaurar devolve o trecho cortado (o corte da IA some do que vale) e o resumo diz quanto voltou', () => {
    const cutRes = plan([cut(4, 5)])
    const [from, to] = sentenceRange(demo, 4, 5)
    const back = planAiEdit({ project: cutRes.project, words: demo.words, durationMs, format: 'horizontal', ops: [{ op: 'restore', from, to }] })
    expect(back.changed).toBe(true)
    expect(back.summary).toMatch(/^Devolvi 1 trecho \(\+\d+(,\d)? s\)\.$/)
    expect(back.afterMs).toBeGreaterThan(cutRes.afterMs)
    expect(back.removedMs).toBeLessThan(0)
  })

  it('zoom: escala fora de 1,1–4 é recusada; outro zoom em cima do mesmo trecho não cabe; o padrão é 1,6× no 16:9 e 1,35× no vertical', () => {
    const [from, to] = sentenceRange(demo, 12, 12)
    expect(plan([{ op: 'zoom', from, to, scale: 5 }]).refused[0]!.why).toBe('a escala 5 está fora de 1.1 a 4')
    const twice = plan([{ op: 'zoom', from, to }, { op: 'zoom', from, to }])
    expect(twice.applied).toHaveLength(1)
    expect(twice.refused[0]!.why).toMatch(/o zoom não cabe ali/)
    const v = planAiEdit({ project: project(), words: demo.words, durationMs, format: 'vertical', ops: [{ op: 'zoom', from, to }] })
    expect(v.project.zooms[0]!.scale).toBe(1.35)
  })

  it('layout: só os do formato aberto, e os que mostram a câmera exigem câmera no projeto', () => {
    const [from, to] = sentenceRange(demo, 12, 14)
    const ok = plan([{ op: 'layout', from, to, layout: 'side-by-side' }])
    expect(ok.applied).toHaveLength(1)
    expect(ok.project.layouts[0]).toMatchObject({ layout: 'side-by-side' })
    expect(ok.summary).toBe('Mudei o layout de 1 trecho.')
    expect(plan([{ op: 'layout', from, to, layout: 'stack' }]).refused[0]!.why).toBe('o layout "stack" não existe no formato 16:9')
    expect(planAiEdit({ project: project(), words: demo.words, durationMs, format: 'vertical', ops: [{ op: 'layout', from, to, layout: 'bubble' }] }).refused[0]!.why).toBe('o layout "bubble" não existe no formato 9:16')
    const noCam = planAiEdit({ project: project(false), words: demo.words, durationMs, format: 'horizontal', ops: [{ op: 'layout', from, to, layout: 'side-by-side' }] })
    expect(noCam.refused[0]!.why).toBe('este projeto não tem câmera')
    expect(planAiEdit({ project: project(false), words: demo.words, durationMs, format: 'horizontal', ops: [{ op: 'layout', from, to, layout: 'screen' }] }).applied).toHaveLength(1)
  })

  it('corte vertical pelo pedido: passa pelas MESMAS regras (borda de frase, 10–90 s, sem repetir) e entra na lista', () => {
    const range = sentenceRange(demo, 10, 16)
    const ok = plan([{ op: 'clip', title: 'Agende em três cliques', hook: 'Agende em três cliques sem planilha', ranges: [range] }])
    expect(ok.applied).toHaveLength(1)
    expect(ok.project.clips).toHaveLength(1)
    expect(ok.project.clips[0]).toMatchObject({ id: 'clip-1', title: 'Agende em três cliques', layoutV: 'auto', format: 'vertical', source: 'ai' })
    expect(ok.summary).toBe('Criei 1 corte vertical.')
    // curto demais (uma frase de 4 s)
    const tiny = plan([{ op: 'clip', title: 'Curto', ranges: [sentenceRange(demo, 4, 4)] }])
    expect(tiny.refused[0]!.why).toMatch(/^o corte «Curto» foi recusado: dura/)
    // no meio de uma frase, longe das bordas
    const mid = demo.sentences[12]!
    const bad = plan([{ op: 'clip', title: 'Meio', ranges: [[mid.firstWord + 6, sentenceRange(demo, 14, 14)[1]]] }])
    expect(bad.refused[0]!.why).toMatch(/não começa no início de uma frase/)
    // o mesmo corte duas vezes
    const twice = plan([{ op: 'clip', title: 'A', ranges: [range] }, { op: 'clip', title: 'B', ranges: [range] }])
    expect(twice.applied).toHaveLength(1)
    expect(twice.refused[0]!.why).toMatch(/repete o corte «A»/)
    expect(plan([{ op: 'clip', title: '  ', ranges: [range] }]).refused[0]!.why).toBe('o corte veio sem título')
    // 4 trechos: o esquema recusa
    expect(plan([{ op: 'clip', title: 'X', ranges: [[0, 1], [2, 3], [4, 5], [6, 7]] }]).refused[0]!.why).toMatch(/^faltam dados/)
  })

  it('legenda: estilo traz as medidas dele no formato aberto; estilo inexistente, palavras por linha fora do máximo do formato e "nada a mudar" são recusados', () => {
    const ok = plan([{ op: 'captions', enabled: true, style: 'clean', wordsPerLine: 3 }])
    expect(ok.project.captions).toMatchObject({ enabled: true, style: 'clean', wordsPerLine: 3, box: true })
    expect(ok.summary).toBe('Mudei a legenda.')
    // no 16:9 o estilo traz 5 palavras numa linha; no vertical, 2 e sem caixa
    expect(plan([{ op: 'captions', enabled: true, style: 'natural' }]).project.captions).toMatchObject({ style: 'natural', wordsPerLine: 5, box: true })
    const v = planAiEdit({ project: project(), words: demo.words, durationMs, format: 'vertical', ops: [{ op: 'captions', enabled: true, style: 'karaoke' }] })
    expect(v.project.captions).toMatchObject({ style: 'karaoke', wordsPerLine: 2, box: false })
    expect(planAiEdit({ project: project(), words: demo.words, durationMs, format: 'vertical', ops: [{ op: 'captions', wordsPerLine: 4 }] }).refused[0]!.why).toBe('palavras por linha vai de 1 a 3')
    expect(plan([{ op: 'captions', style: 'neon' }]).refused[0]!.why).toBe('o estilo de legenda "neon" não existe')
    expect(plan([{ op: 'captions', wordsPerLine: 9 }]).refused[0]!.why).toBe('palavras por linha vai de 1 a 6')
    expect(plan([{ op: 'captions' }]).refused[0]!.why).toBe('não diz o que mudar na legenda')
    expect(plan([{ op: 'captions', enabled: false }]).refused[0]!.why).toBe('a legenda já está assim')
  })

  it('título: vazio e igual ao de agora são recusados; o comprido é cortado em 200 caracteres', () => {
    expect(plan([{ op: 'title', text: '   ' }]).refused[0]!.why).toBe('o título veio vazio')
    expect(plan([{ op: 'title', text: 'Demonstração do Agendaí' }]).refused[0]!.why).toBe('o título já é esse')
    expect(plan([{ op: 'title', text: 'x'.repeat(500) }]).project.title).toHaveLength(200)
  })

  it('pede confirmação quando o pedido tira mais de 20% do vídeo, e só nesse caso', () => {
    // as quatro frases do cadastro (de ~40 s de 208) saem sem confirmar; o relatório + a ficha + o cadastro, passa de 20%
    const small = plan([cut(4, 5)])
    expect(small.needsConfirm).toBe(false)
    const big = plan([cut(3, 9), cut(23, 28), cut(29, 32)])
    expect(big.removedMs / big.beforeMs).toBeGreaterThan(0.2)
    expect(big.needsConfirm).toBe(true)
    expect(big.summary).toMatch(/^Cortei 3 trechos/)
    // o limite é "mais de 20%": a conta é a mesma que o plano usa
    for (const r of [small, big]) expect(r.needsConfirm).toBe(r.removedMs > r.beforeMs * EDIT_CONFIRM_FRACTION)
  })

  it('um pedido que cortaria o vídeo inteiro é recusado inteiro', () => {
    const everything = plan([{ op: 'cut', from: 0, to: demo.words.length - 1 }])
    expect(everything.changed).toBe(false)
    expect(everything.summary).toBe('Recusei o pedido: ele cortaria o vídeo inteiro.')
    expect(everything.refused.some((r) => r.why === 'a mudança cortaria o vídeo inteiro')).toBe(true)
  })
})

it('trocar gancho no item vertical conserva duração e não muda o título',() => {
  const doc = {...project(),vertical:defaultVerticalEdit()}
  const result = planAiEdit({project:projectForFormat(doc,'vertical'),words:demo.words,durationMs,format:'vertical',ops:[{op:'hook',text:'Organize sua agenda em segundos'}]})
  expect(result.changed).toBe(true)
  expect(result.project.vertical?.hook).toBe('Organize sua agenda em segundos')
  expect(result.project.title).toBe(doc.title)
  expect(result.afterMs).toBe(result.beforeMs)
  expect(plan([{op:'hook',text:'Resultado'}]).changed).toBe(false)
})
