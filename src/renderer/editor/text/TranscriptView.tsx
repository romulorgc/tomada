/**
 * A transcrição na aba Texto: parágrafos com as palavras clicáveis, as cortadas riscadas, hesitações e muletas
 * destacadas, fichas de pausa que cortam ao clique, a palavra que está tocando acesa e a seleção/busca.
 *
 * Lista VIRTUALIZADA por parágrafo (uma gravação de uma hora passa de 9.000 palavras): só os parágrafos perto da
 * janela existem no DOM. A altura de cada um é estimada pelo tamanho do texto e corrigida pela medida real assim que
 * ele aparece; o que a correção desloca acima da janela é compensado na rolagem, para o texto não "pular".
 *
 * A palavra atual NÃO passa pelo React: uma assinatura do tempo de reprodução move o atributo `data-now` direto no DOM
 * (a 60 quadros por segundo, re-renderizar nove mil palavras seria o jeito certo de travar a tela).
 *
 * Gestos (por delegação, um só ouvinte para o texto todo): clique = buscar a palavra na prévia · arrastar ou
 * Shift+clique = selecionar · duplo clique = selecionar a palavra · ficha de pausa = cortar/restaurar a pausa.
 */
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from 'zustand'
import { isHesitationWord, suggestedCrutchIndexes } from '@shared/clean'
import { formatDuration, formatSpan } from '@shared/format'
import { correctedTranscriptWords } from '@shared/dictionary-corrections'
import { PAUSE_CHIP_MIN_MS, buildParagraphs, findMatches, pauseAfter, struckWords, wordIndexAt, type Paragraph } from '@shared/text-edit'
import type { Word } from '@shared/types'
import { t } from '../../i18n/pt-BR'
import { useDoc, useEditor } from '../context'
import { useEditorOps } from '../ops'
import { selectionRange } from './text-store'

const T = t.editor.text

// --- geometria (px) -------------------------------------------------------------------------------------------
/** Altura de uma linha de texto (0,875 rem × 1,85, ver `.tx-words` no CSS). */
const LINE_H = 26
/** Respiro embaixo de cada parágrafo (faz parte da altura medida). */
const PARA_PAD = 14
/** Largura da coluna do tempo + as margens do texto. */
const GUTTER = 44 + 28
const CHAR_W = 7.4
const AVG_WORD_CHARS = 6.6
const OVERSCAN_PX = 900
/** Depois de rolar à mão, a rolagem automática da palavra atual espera isto (ms). */
const USER_SCROLL_GRACE_MS = 2500

// --- bits do estado de cada palavra (o `memo` compara só números) ----------------------------------------------
const F_STRUCK = 1
const F_CRUTCH = 2
const F_HESIT = 4
const F_SEL = 8
const F_MATCH = 16
const F_MATCH_NOW = 32
const F_FIXED = 64
const F_LOW = 128

const estimateHeight = (p: Paragraph, width: number): number => {
  const perLine = Math.max(10, Math.floor((width - GUTTER) / CHAR_W))
  const chars = (p.last - p.first + 1) * AVG_WORD_CHARS
  return Math.max(1, Math.ceil(chars / perLine)) * LINE_H + PARA_PAD
}

/** Maior índice `p` com `tops[p] <= y` (0 se `y` está antes de tudo). */
function paragraphAtY(tops: readonly number[], y: number): number {
  let lo = 0
  let hi = tops.length - 1
  let at = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tops[mid]! <= y) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return at
}

/** Parágrafo que contém a palavra `i`. */
function paragraphOfWord(paragraphs: readonly Paragraph[], i: number): number {
  let lo = 0
  let hi = paragraphs.length - 1
  let at = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (paragraphs[mid]!.first <= i) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return at
}

const WordSpan = memo(function WordSpan({ i, text, flags, gap }: { i: number; text: string; flags: number; gap: boolean }) {
  return (
    <span
      className="tx-w"
      data-i={i}
      data-gap={gap ? '' : undefined}
      data-struck={flags & F_STRUCK ? '' : undefined}
      data-filler={flags & F_HESIT ? '' : flags & F_CRUTCH ? 'crutch' : undefined}
      data-sel={flags & F_SEL ? '' : undefined}
      data-match={flags & F_MATCH_NOW ? 'now' : flags & F_MATCH ? '' : undefined}
      data-fixed={flags & F_FIXED ? '' : undefined}
      data-low={flags & F_LOW ? '' : undefined}
      title={flags & F_LOW ? T.view.lowConfidence : undefined}
    >
      {text}
    </span>
  )
})

export function TranscriptView({ words, durationMs }: { words: Word[]; durationMs: number }) {
  const { store, playback, text, engineRef } = useEditor()
  const ops = useEditorOps()
  const cuts = useDoc((s) => s.project.cuts)
  const fixes = useDoc((s) => s.project.wordFixes)
  const corrections = useDoc((s) => s.project.review?.dictionaryCorrections)
  const selection = useStore(text, (s) => s.selection)
  const query = useStore(text, (s) => s.query)
  const matchAt = useStore(text, (s) => s.matchAt)
  const searchOpen = useStore(text, (s) => s.searchOpen)

  // Os controles continuam apontando para as posições originais. Só a apresentação agrupa o nome corrigido.
  const display = useMemo(() => {
    const positions = new Map(words.map((w, k) => [w.i, k]))
    const corrected = correctedTranscriptWords(words, fixes, corrections)
    const spans = new Map<number, { word: Word; first: number; last: number }>()
    const owners: number[] = []
    corrected.forEach((word, k) => {
      const first = positions.get(word.i)!
      const last = k + 1 < corrected.length ? positions.get(corrected[k + 1]!.i)! - 1 : words.length - 1
      spans.set(first, { word, first, last })
      for (let source = first; source <= last; source++) owners[source] = first
    })
    return { spans, owners }
  }, [words, fixes, corrections])

  const paragraphs = useMemo(() => buildParagraphs(words), [words])
  const struck = useMemo(() => struckWords(words, cuts), [words, cuts])
  const crutches = useMemo(() => new Set(suggestedCrutchIndexes(words, durationMs)), [words, durationMs])
  const hesitations = useMemo(() => words.map((w) => isHesitationWord(w) || w.kind === 'gap-speech'), [words])
  const matches = useMemo(() => (searchOpen ? findMatches(words, query) : []), [words, query, searchOpen])

  // pausa cortada? (a mesma conta das palavras, sobre o ponto médio de cada pausa)
  const pauseStruck = useMemo(() => {
    const mids = words.map((w, k) => {
      const next = words[k + 1]
      const mid = next ? (w.end + next.start) / 2 : w.end
      return { start: mid, end: mid }
    })
    return struckWords(mids, cuts)
  }, [words, cuts])

  const flags = useMemo(() => {
    const f = new Uint8Array(words.length)
    for (let k = 0; k < words.length; k++) {
      let v = 0
      if (struck[k]) v |= F_STRUCK
      if (hesitations[k]) v |= F_HESIT
      else if (crutches.has(k)) v |= F_CRUTCH
      if (fixes && fixes[String(words[k]!.i)] !== undefined) v |= F_FIXED
      if (words[k]!.kind === 'word' && words[k]!.prob < 0.5) v |= F_LOW
      f[k] = v
    }
    const r = selectionRange(selection)
    if (r) for (let k = Math.max(0, r.from); k <= Math.min(words.length - 1, r.to); k++) f[k]! |= F_SEL
    matches.forEach((m, n) => {
      for (let k = m.first; k <= m.last; k++) f[k]! |= n === matchAt ? F_MATCH_NOW : F_MATCH
    })
    return f
  }, [words, struck, hesitations, crutches, fixes, selection, matches, matchAt])

  // --- janela e alturas ------------------------------------------------------------------------------------------
  const scroller = useRef<HTMLDivElement>(null)
  const inner = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 480, width: 320 })
  const [rev, setRev] = useState(0)
  const measured = useRef<number[]>([])
  const measuredFor = useRef(0)
  const userScrollAt = useRef(0)

  const layout = useMemo(() => {
    const w = Math.round(viewport.width / 8) * 8
    if (measuredFor.current !== w) {
      // a largura mudou: as alturas medidas não valem mais
      measured.current = []
      measuredFor.current = w
    }
    const tops: number[] = new Array<number>(paragraphs.length)
    let y = 0
    for (let p = 0; p < paragraphs.length; p++) {
      tops[p] = y
      y += measured.current[p] ?? estimateHeight(paragraphs[p]!, w)
    }
    return { tops, total: y, width: w }
    // `rev` entra de propósito: é o aviso de que `measured` mudou
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paragraphs, rev, viewport.width])
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  const first = paragraphs.length === 0 ? 0 : paragraphAtY(layout.tops, viewport.top - OVERSCAN_PX)
  const last = paragraphs.length === 0 ? -1 : paragraphAtY(layout.tops, viewport.top + viewport.height + OVERSCAN_PX)
  const topPad = layout.tops[first] ?? 0
  const bottomPad = last < 0 ? 0 : layout.total - (layout.tops[last + 1] ?? layout.total)

  useEffect(() => {
    const sc = scroller.current
    if (!sc) return
    const read = (): void => setViewport((v) => (v.height === sc.clientHeight && v.width === sc.clientWidth ? v : { ...v, height: sc.clientHeight, width: sc.clientWidth }))
    read()
    const ro = new ResizeObserver(read)
    ro.observe(sc)
    return () => ro.disconnect()
  }, [])

  const raf = useRef(0)
  const onScroll = useCallback(() => {
    if (raf.current !== 0) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      const sc = scroller.current
      if (sc) setViewport((v) => (v.top === sc.scrollTop ? v : { ...v, top: sc.scrollTop }))
    })
  }, [])
  useEffect(
    () => () => {
      if (raf.current !== 0) cancelAnimationFrame(raf.current)
    },
    []
  )

  // --- palavra atual ---------------------------------------------------------------------------------------------
  const nowRef = useRef(-1)

  const scrollToWord = useCallback(
    (i: number): void => {
      const sc = scroller.current
      if (!sc) return
      const L = layoutRef.current
      const p = paragraphOfWord(paragraphs, i)
      const top = L.tops[p] ?? 0
      sc.scrollTop = Math.max(0, top - sc.clientHeight * 0.3)
    },
    [paragraphs]
  )

  const follow = useCallback(
    (i: number): void => {
      const sc = scroller.current
      if (!sc || i < 0) return
      if (performance.now() - userScrollAt.current < USER_SCROLL_GRACE_MS) return
      const el = sc.querySelector<HTMLElement>(`.tx-w[data-i="${i}"]`)
      if (el) {
        const r = el.getBoundingClientRect()
        const s = sc.getBoundingClientRect()
        if (r.top >= s.top + 8 && r.bottom <= s.bottom - 8) return
        sc.scrollTop += r.top - s.top - s.height * 0.35
        return
      }
      scrollToWord(i)
    },
    [scrollToWord]
  )

  const paintNow = useCallback((): void => {
    const sc = scroller.current
    if (!sc) return
    sc.querySelectorAll('.tx-w[data-now]').forEach((el) => el.removeAttribute('data-now'))
    if (nowRef.current >= 0) sc.querySelector(`.tx-w[data-i="${nowRef.current}"]`)?.setAttribute('data-now', '')
  }, [])

  useEffect(() => {
    const update = (sourceMs: number): void => {
      const sourceIdx = wordIndexAt(words, sourceMs)
      const idx = display.owners[sourceIdx] ?? sourceIdx
      if (idx === nowRef.current) return
      nowRef.current = idx
      paintNow()
      follow(idx)
    }
    update(playback.getState().sourceMs)
    let lastMs = playback.getState().sourceMs
    return playback.subscribe((s) => {
      if (s.sourceMs === lastMs) return
      lastMs = s.sourceMs
      update(s.sourceMs)
    })
  }, [words, playback, paintNow, follow, display])

  // o React pode recriar as palavras (a janela anda): a acesa volta; e as alturas reais corrigem as estimadas
  useLayoutEffect(() => {
    paintNow()
    const sc = scroller.current
    const root = inner.current
    if (!sc || !root) return
    const L = layoutRef.current
    const anchor = sc.scrollTop
    let changed = false
    let shift = 0
    root.querySelectorAll<HTMLElement>('[data-p]').forEach((el) => {
      const p = Number(el.dataset.p)
      const h = el.offsetHeight
      if (!Number.isInteger(p) || h <= 0) return
      const old = measured.current[p]
      if (old !== undefined && Math.abs(old - h) < 1) return
      const was = old ?? estimateHeight(paragraphs[p]!, L.width)
      measured.current[p] = h
      changed = true
      // um parágrafo inteiro acima da janela que muda de altura desloca tudo o que está abaixo dele
      if ((L.tops[p] ?? 0) + was <= anchor) shift += h - was
    })
    if (changed) {
      if (shift !== 0) sc.scrollTop = anchor + shift
      setRev((r) => r + 1)
    }
  })

  // a busca leva o texto ao resultado em foco
  useEffect(() => {
    const m = matches[matchAt]
    if (m) scrollToWord(m.first)
    // só quando muda o resultado em foco ou o termo, não a cada re-render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchAt, query, matches.length])

  // --- gestos -----------------------------------------------------------------------------------------------------
  const drag = useRef<{ anchor: number; moved: boolean } | null>(null)
  const wordOf = (target: EventTarget | null): number | null => {
    const el = (target as Element | null)?.closest?.('.tx-w[data-i]') as HTMLElement | null
    if (!el) return null
    const i = Number(el.dataset.i)
    return Number.isInteger(i) ? i : null
  }

  const selectWords = useCallback(
    (anchor: number, focus: number): void => {
      // palavra selecionada e zoom/trecho/intervalo selecionado na linha do tempo não convivem: Delete teria dois alvos
      store.getState().setSelection(null)
      store.getState().setRange(null)
      const a = display.spans.get(display.owners[anchor] ?? anchor), f = display.spans.get(display.owners[focus] ?? focus)
      text.getState().select(anchor <= focus ? { anchor: a?.first ?? anchor, focus: f?.last ?? focus } : { anchor: a?.last ?? anchor, focus: f?.first ?? focus })
    },
    [store, text, display]
  )

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const i = wordOf(e.target)
    if (i === null) return
    const caret = text.getState().caret
    if (e.shiftKey && caret !== null) {
      selectWords(caret, i)
      drag.current = { anchor: caret, moved: true }
    } else {
      drag.current = { anchor: i, moved: false }
    }
    const end = (): void => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      const d = drag.current
      drag.current = null
      if (!d) return
      if (!d.moved) {
        // clique simples: o texto é um controle de busca
        text.getState().select(null)
        text.getState().setCaret(d.anchor)
        ops.seekWord(d.anchor)
      } else if (text.getState().caret === null) {
        text.getState().setCaret(d.anchor)
      }
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const i = wordOf(e.target)
    if (i === null || (i === d.anchor && !d.moved)) return
    d.moved = true
    selectWords(d.anchor, i)
  }

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const i = wordOf(e.target)
    if (i === null) return
    text.getState().setCaret(i)
    selectWords(i, i)
  }

  const onClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const el = e.target as Element
    const chip = el.closest?.('[data-pause]') as HTMLElement | null
    if (chip) {
      const k = Number(chip.dataset.pause)
      if (Number.isInteger(k)) ops.togglePauseAfter(k)
      return
    }
    const time = el.closest?.('[data-time]') as HTMLElement | null
    if (time) {
      const ms = Number(time.dataset.time)
      if (Number.isFinite(ms)) engineRef.current?.seekSource(ms)
    }
  }

  const onUserScroll = (): void => {
    userScrollAt.current = performance.now()
  }

  const rendered: number[] = []
  for (let p = first; p <= last; p++) rendered.push(p)

  return (
    <div
      ref={scroller}
      className="tx-scroll"
      role="document"
      aria-label={T.view.label}
      data-testid="transcript-view"
      data-words={words.length}
      tabIndex={0}
      onScroll={onScroll}
      onWheel={onUserScroll}
      onTouchMove={onUserScroll}
    >
      <div
        ref={inner}
        className="tx-inner"
        style={{ paddingTop: topPad, paddingBottom: bottomPad }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onDoubleClick={onDoubleClick}
        onClick={onClick}
      >
        {rendered.map((p) => {
          const par = paragraphs[p]!
          const items: React.ReactNode[] = []
          for (let k = par.first; k <= par.last; k++) {
            const w = words[k]!
            const span = display.spans.get(k)
            if (!span) continue
            let spanFlags = 0
            for (let source = span.first; source <= span.last; source++) spanFlags |= flags[source]!
            items.push(
              <Fragment key={k}>
                <WordSpan i={k} text={span.word.text.trim()} flags={spanFlags} gap={w.kind === 'gap-speech'} />{' '}
                {pauseAfter(words, span.last) >= PAUSE_CHIP_MIN_MS ? (
                  <>
                    <button type="button" className="tx-pause" data-pause={span.last} data-struck={pauseStruck[span.last] ? '' : undefined} title={pauseStruck[span.last] ? T.pauseTip.restore : T.pauseTip.cut} data-testid="pause-chip">
                      {T.pause(formatSpan(pauseAfter(words, span.last)))}
                    </button>{' '}
                  </>
                ) : null}
              </Fragment>
            )
          }
          return (
            <div key={p} className="tx-para" data-p={p} data-testid="transcript-paragraph">
              <button type="button" className="tx-time tnum" data-time={par.startMs} tabIndex={-1} title={formatDuration(par.startMs)}>
                {formatDuration(par.startMs)}
              </button>
              <p className="tx-words">{items}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}
