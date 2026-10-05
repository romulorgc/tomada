/**
 * Uma demonstração NARRADA, sintética, de um programa de agenda para barbearias ("Agendaí", inventado): o texto que uma
 * pessoa diria gravando a tela, com o assunto de cada frase marcado e a atividade de tela (cliques e teclas) de cada uma.
 * Serve de transcrição para os testes dos cortes verticais (unidade, e2e com a IA de teste e `npm run test:ia` com a IA de
 * verdade): nada aqui é dado de pessoa nem de gravação real.
 *
 * Os tempos são montados por regra (duração da palavra pelo tamanho, pausa depois de cada pontuação, pausa maior entre
 * assuntos), sem sorteio: o mesmo texto dá sempre os mesmos tempos.
 */
import type { Word } from '../../src/shared/types'

export type DemoTopic = 'intro' | 'cliente' | 'agenda' | 'lembrete' | 'relatorio' | 'ficha' | 'fim'

export type DemoSentence = { topic: DemoTopic; text: string; clicks?: number; keys?: number }

/** `~palavra` é uma hesitação (kind `filler`): entra na transcrição, não na legenda. */
export const DEMO_SCRIPT: readonly DemoSentence[] = [
  // --- abertura: cumprimento e apresentação (um corte NÃO deve começar aqui)
  { topic: 'intro', text: 'Oi pessoal, tudo bem?' },
  { topic: 'intro', text: 'Hoje eu vou mostrar o Agendaí, um sistema de agenda feito para barbearias.' },
  { topic: 'intro', text: 'Eu vou passar pelas principais telas, então fica comigo até o final.' },

  // --- cadastro de cliente
  { topic: 'cliente', text: 'Vamos começar pelo cadastro de clientes.' },
  { topic: 'cliente', text: 'Aqui na tela inicial eu clico em novo cliente.', clicks: 1 },
  { topic: 'cliente', text: 'O sistema pede só o nome e o telefone, mais nada.', clicks: 1, keys: 12 },
  { topic: 'cliente', text: 'Eu digito o nome, coloco o telefone e já salvo.', clicks: 1, keys: 20 },
  { topic: 'cliente', text: 'Repara que ele reconhece o número sozinho e já deixa o WhatsApp pronto para os lembretes.' },
  { topic: 'cliente', text: 'E se o cliente já existir, o sistema avisa antes de duplicar o cadastro.', clicks: 1 },
  { topic: 'cliente', text: 'Pronto, em menos de dez segundos o cliente está cadastrado e já pode receber um horário.', clicks: 1 },

  // --- agendar um horário
  { topic: 'agenda', text: 'Agora vamos agendar um horário.' },
  { topic: 'agenda', text: 'Eu abro a agenda da semana, ~hã, e clico no horário livre das duas da tarde.', clicks: 2 },
  { topic: 'agenda', text: 'Escolho o cliente que acabei de cadastrar e o serviço, que aqui é corte e barba.', clicks: 3 },
  { topic: 'agenda', text: 'O sistema já calcula a duração do serviço e bloqueia o tempo certo na agenda do barbeiro.' },
  { topic: 'agenda', text: 'Se eu tentar marcar em cima de outro horário, ele não deixa e mostra o conflito na hora.', clicks: 1 },
  { topic: 'agenda', text: 'E dá para arrastar o horário para outro dia se o cliente pedir para remarcar.', clicks: 2 },
  { topic: 'agenda', text: 'Em três cliques o horário está marcado, sem planilha e sem conflito.', clicks: 1 },

  // --- lembrete automático
  { topic: 'lembrete', text: 'Outra coisa que eu gosto muito é o lembrete automático.' },
  { topic: 'lembrete', text: 'Entro nas configurações e ligo o lembrete por WhatsApp.', clicks: 3 },
  { topic: 'lembrete', text: 'Escolho que a mensagem sai um dia antes e duas horas antes do horário.', clicks: 2, keys: 6 },
  { topic: 'lembrete', text: 'Dá para personalizar o texto, e eu deixei uma mensagem curta e simpática.', keys: 40 },
  { topic: 'lembrete', text: 'Com isso o cliente confirma pelo próprio celular e a falta de cliente na cadeira cai bastante.' },
  { topic: 'lembrete', text: 'Pronto, os lembretes agora saem sozinhos, sem você precisar mandar mensagem nenhuma.', clicks: 1 },

  // --- relatório de faturamento
  { topic: 'relatorio', text: 'Agora a parte que o dono da barbearia mais quer ver, o faturamento.' },
  { topic: 'relatorio', text: 'Eu abro o relatório do mês e escolho o período.', clicks: 2 },
  { topic: 'relatorio', text: 'Aqui aparece o total faturado, o ticket médio e quanto cada barbeiro produziu.' },
  { topic: 'relatorio', text: 'Clicando em um barbeiro eu vejo os serviços que ele fez, dia a dia.', clicks: 2 },
  { topic: 'relatorio', text: 'Dá para exportar tudo em planilha com um clique, para mandar para o contador.', clicks: 1 },
  { topic: 'relatorio', text: 'Em um minuto eu fecho o mês inteiro, e antes isso me tomava uma tarde de trabalho.' },

  // --- ficha do cliente
  { topic: 'ficha', text: 'Mais uma tela que ajuda muito é a ficha do cliente.' },
  { topic: 'ficha', text: 'Nela fica todo o histórico: quando ele veio, o que fez e quanto pagou.', clicks: 1 },
  { topic: 'ficha', text: 'Eu vejo quem está sumido há mais de sessenta dias e chamo de volta com um toque.', clicks: 2 },
  { topic: 'ficha', text: 'É assim que a gente traz o cliente de volta sem gastar nada com anúncio.' },

  // --- despedida
  { topic: 'fim', text: 'Bom, era isso que eu queria mostrar hoje.' },
  { topic: 'fim', text: 'Se você quiser testar o Agendaí, o link está na descrição.' },
  { topic: 'fim', text: 'Valeu, e até a próxima!' }
]

export type DemoSentenceInfo = { topic: DemoTopic; text: string; startMs: number; endMs: number; firstWord: number; lastWord: number }

export type Demo = {
  words: Word[]
  sentences: DemoSentenceInfo[]
  /** Instantes (ms) de cliques e de teclas. */
  clicks: number[]
  keys: number[]
  durationMs: number
}

const PAUSE_END_MS = 650
const PAUSE_COMMA_MS = 170
const PAUSE_TOPIC_MS = 1300
const WORD_GAP_MS = 45

function wordMs(text: string): number {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length
  return Math.min(700, 110 + 55 * Math.max(1, letters))
}

/** Monta as palavras com tempo, as frases com início e fim e os instantes de cliques e teclas. `maxMs` corta as frases que passariam disso. */
export function buildDemo(opts: { maxMs?: number; startMs?: number } = {}): Demo {
  const words: Word[] = []
  const sentences: DemoSentenceInfo[] = []
  const clicks: number[] = []
  const keys: number[] = []
  let t = opts.startMs ?? 600
  let prevTopic: DemoTopic | null = null
  for (const s of DEMO_SCRIPT) {
    if (prevTopic !== null && s.topic !== prevTopic) t += PAUSE_TOPIC_MS
    prevTopic = s.topic
    const tokens = s.text.split(' ')
    // quanto a frase vai durar, para ver se cabe antes de gravar nada
    let probe = t
    for (const tok of tokens) probe += wordMs(tok.replace(/^~/, '')) + WORD_GAP_MS + (/[.!?]$/.test(tok) ? PAUSE_END_MS : /[,:;]$/.test(tok) ? PAUSE_COMMA_MS : 0)
    if (opts.maxMs !== undefined && probe > opts.maxMs) break
    const startMs = t
    const firstWord = words.length
    for (const raw of tokens) {
      const filler = raw.startsWith('~')
      const tok = filler ? raw.slice(1) : raw
      const start = t
      const end = t + wordMs(tok)
      words.push({ i: words.length, text: tok, start, end, prob: 0.95, kind: filler ? 'filler' : 'word' })
      t = end + WORD_GAP_MS + (/[.!?]$/.test(tok) ? PAUSE_END_MS : /[,:;]$/.test(tok) ? PAUSE_COMMA_MS : 0)
    }
    const last = words[words.length - 1]!
    sentences.push({ topic: s.topic, text: s.text.replace(/~/g, ''), startMs, endMs: last.end, firstWord, lastWord: words.length - 1 })
    const span = last.end - startMs
    for (let k = 0; k < (s.clicks ?? 0); k++) clicks.push(Math.round(startMs + ((k + 1) / ((s.clicks ?? 0) + 1)) * span))
    for (let k = 0; k < (s.keys ?? 0); k++) keys.push(Math.round(startMs + span * 0.2 + k * 130))
  }
  return { words, sentences, clicks, keys, durationMs: t + 400 }
}

/** O texto da frase `n` do roteiro com os números das palavras, para os testes montarem respostas gravadas da IA. */
export function sentenceRange(demo: Demo, from: number, to: number): [number, number] {
  return [demo.sentences[from]!.firstWord, demo.sentences[to]!.lastWord]
}
