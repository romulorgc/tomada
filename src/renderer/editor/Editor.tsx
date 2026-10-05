/**
 * O EDITOR: barra superior · prévia ao centro · painel lateral com abas · linha do tempo embaixo
 * (redimensionável). Aqui moram os estados compartilhados: o documento (com desfazer e salvamento
 * automático), a reprodução, o motor da prévia, os eventos do cursor e as mídias derivadas.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from 'zustand'
import { createClipQueue, queueSummary } from '@shared/clip-queue'
import { clipScene } from '@shared/clips'
import { DEFAULT_CLEAN, type Levels } from '@shared/clean'
import { createEditorStore } from '@shared/editor-store'
import { eventsFromText } from '@shared/events'
import { regenerateZooms } from '@shared/edits'
import { formatSpan } from '@shared/format'
import type { PeaksData, ProjectDetail, ThumbsData } from '@shared/ipc'
import { assertMediaUrl, mediaUrl } from '@shared/media-url'
import { HORIZONTAL_1080, VERTICAL_1080, deriveProject, prepareEvents, type CursorData } from '@shared/scene'
import type { Transcript } from '@shared/types'
import { ensureVertical } from '@shared/vertical'
import { DEFAULT_ZOOM_PRESET, generateAutoZooms } from '@shared/zoom'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'
import { useTranscription } from '../transcription-store'
import { createAiUiStore } from './ai-store'
import { createClipsUiStore } from './clips-store'
import { EditorContext, useEditor, type AssetState, type EditorCtx } from './context'
import { PreviewEngine } from './engine'
import { ExportDialog } from './ExportDialog'
import { useEditorOps } from './ops'
import { createPlaybackStore } from './playback-store'
import { applyClean, buildCleanInput } from './text/clean-actions'
import { createTextStore } from './text/text-store'
import { SidePanel } from './panels/SidePanel'
import { PreviewStage } from './PreviewStage'
import { useEditorShortcuts } from './shortcuts'
import { Timeline } from './timeline/Timeline'
import { TopBar } from './TopBar'
import { Transport } from './Transport'
import { useExportController } from './use-export'
import './editor.css'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

async function fetchText(url: string | null): Promise<string | undefined> {
  if (!url) return undefined
  const r = await fetch(assertMediaUrl(url))
  if (!r.ok) throw new Error(`Não consegui ler ${url} (${r.status}).`)
  return r.text()
}

const TIMELINE_KEY = 'tomada.editor.timelineHeight'
const MIN_TIMELINE_PX = 176

function readSavedHeight(): number | null {
  try {
    const v = Number(window.localStorage.getItem(TIMELINE_KEY))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

/** Atalhos e o resto que precisa do contexto já montado. */
function EditorInner({ onBack, layoutRef }: { onBack: () => void; layoutRef: React.RefObject<HTMLDivElement | null> }) {
  const ctx = useEditor()
  const ops = useEditorOps()
  useEditorShortcuts(ops, !ctx.exporter.open)

  // Palavra selecionada na aba Texto e zoom/trecho/intervalo selecionado na linha do tempo não convivem: o Delete teria dois alvos.
  const { store: docStore, text: textStore } = ctx
  useEffect(
    () =>
      docStore.subscribe((s, prev) => {
        const picked = (s.selection && s.selection !== prev.selection) || (s.range && s.range !== prev.range)
        if (picked && textStore.getState().selection) textStore.getState().select(null)
      }),
    [docStore, textStore]
  )

  // --- altura da linha do tempo (arrastar a alça; ↑/↓ no teclado) -----------------------------------------
  const [height, setHeight] = useState<number | null>(() => readSavedHeight())
  const maxFor = (): number => Math.round((layoutRef.current?.clientHeight ?? window.innerHeight) * 0.62)
  const defaultFor = (): number => Math.max(MIN_TIMELINE_PX, Math.round((layoutRef.current?.clientHeight ?? window.innerHeight) * 0.36))
  const clampH = (v: number): number => Math.min(maxFor(), Math.max(MIN_TIMELINE_PX, Math.round(v)))
  const current = height === null ? defaultFor() : clampH(height)
  const dragStart = useRef<{ y: number; h: number } | null>(null)

  const persist = (h: number): void => {
    try {
      window.localStorage.setItem(TIMELINE_KEY, String(h))
    } catch {
      // sem armazenamento: a altura só vale nesta sessão
    }
  }
  const onSplitDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStart.current = { y: e.clientY, h: current }
  }
  const onSplitMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const s = dragStart.current
    if (s) setHeight(clampH(s.h - (e.clientY - s.y)))
  }
  const onSplitUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragStart.current) return
    dragStart.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    persist(current)
  }
  const onSplitKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const next = clampH(current + (e.key === 'ArrowUp' ? 24 : -24))
    setHeight(next)
    persist(next)
  }

  const canvasRef = ctx.refs.canvas
  return (
    <div className="ed" ref={layoutRef} style={{ ['--tl-h' as string]: `${current}px` }} data-testid="editor">
      <TopBar onBack={onBack} />
      <div className="ed-stage">
        <PreviewStage canvasRef={canvasRef} hostRef={ctx.refs.host} frameRef={ctx.refs.frame} />
        <Transport />
      </div>
      <SidePanel />
      <div
        className="ed-split"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t.editor.timeline.label}
        aria-valuemin={MIN_TIMELINE_PX}
        aria-valuemax={maxFor()}
        aria-valuenow={current}
        tabIndex={0}
        data-testid="timeline-split"
        onPointerDown={onSplitDown}
        onPointerMove={onSplitMove}
        onPointerUp={onSplitUp}
        onPointerCancel={onSplitUp}
        onKeyDown={onSplitKey}
      >
        <i aria-hidden="true" />
      </div>
      <Timeline />
      {ctx.exporter.open ? <ExportDialog /> : null}
    </div>
  )
}

export function Editor({ detail }: { detail: ProjectDetail }) {
  const notify = useApp((s) => s.notify)
  const go = useApp((s) => s.go)

  // --- os dois estados: documento e reprodução --------------------------------------------------------------
  const store = useMemo(
    () =>
      createEditorStore({
        project: detail.project,
        save: (p) => window.tomada.projects.save(detail.id, p),
        onSaveError: (message) => {
          window.tomada.log({ level: 'error', message: 'Falha ao salvar o project.json', detail: message })
          notify({ kind: 'error', text: t.editor.saveFailed, detail: message })
        }
      }),
    // um projeto novo remonta o editor inteiro (a `key` do ProjectView)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail.id]
  )
  const playback = useMemo(() => createPlaybackStore(), [detail.id])
  const text = useMemo(() => createTextStore(), [detail.id])
  const clips = useMemo(() => createClipsUiStore(), [detail.id])
  const aiUi = useMemo(() => createAiUiStore(), [detail.id])
  const queue = useMemo(
    () =>
      createClipQueue({
        projectId: detail.id,
        flush: () => store.getState().flush(),
        startExport: (req) => window.tomada.exporter.start(req),
        cancelExport: (id) => window.tomada.exporter.cancel(id),
        onProgress: (listener) => window.tomada.on('export:progress', listener),
        pollStatus: () => window.tomada.exporter.status(),
        onFinished: (items) => {
          const r = queueSummary(items)
          if (r.total === 0) return
          if (r.failed > 0) notify({ kind: 'error', text: t.editor.clips.queue.finishedBad, detail: t.editor.clips.queue.summary(r.done, r.failed, r.cancelled, r.total) })
          else if (r.done > 0) notify({ kind: 'info', text: t.editor.clips.queue.finishedOk(r.done) })
        }
      }),
    // um projeto novo remonta o editor inteiro (a `key` do ProjectView)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [detail.id, store]
  )
  const project = useStore(store, (s) => s.project)
  const doc = useStore(store, (s) => s.doc)
  const durationMs = Math.max(project.sources.screen?.durationMs ?? 0, project.sources.camera?.durationMs ?? 0, project.sources.voice?.durationMs ?? 0)
  const hasScreen = Boolean(project.sources.screen)
  const hasCamera = Boolean(project.sources.camera)
  const voicePath = project.sources.voice?.path

  const canvas = useRef<HTMLCanvasElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<PreviewEngine | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const [engineGen, setEngineGen] = useState(0)

  // --- eventos (cursor, cliques, teclas) ------------------------------------------------------------------
  const [cursorData, setCursorData] = useState<CursorData | null>(null)
  const [eventsError, setEventsError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [cursor, clicks, keys] = await Promise.all([fetchText(detail.events.cursor), fetchText(detail.events.clicks), fetchText(detail.events.keys)])
        if (alive) setCursorData(prepareEvents(eventsFromText({ cursor, clicks, keys }), durationMs))
      } catch (err) {
        window.tomada.log({ level: 'error', message: 'Falha ao ler os eventos do projeto', detail: messageOf(err) })
        if (alive) {
          setEventsError(messageOf(err))
          setCursorData(prepareEvents({ cursor: [], clicks: [], keys: [] }, durationMs))
        }
      }
    })()
    return () => {
      alive = false
    }
    // eventos só mudam se o projeto trocar (o componente é remontado por `key`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.id])

  // --- transcrição (aba Texto) ------------------------------------------------------------------------------------
  const [transcript, setTranscript] = useState<AssetState<Transcript>>({ status: voicePath ? 'loading' : 'none', data: null, error: null })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const loadTranscript = useCallback(() => {
    setTranscript((s) => ({ status: 'loading', data: s.data, error: null }))
    void window.tomada.transcription
      .get(detail.id)
      .then((data) => {
        if (mounted.current) setTranscript(data ? { status: 'ready', data, error: null } : { status: 'none', data: null, error: null })
      })
      .catch((err: unknown) => {
        window.tomada.log({ level: 'error', message: 'Falha ao ler a transcrição do projeto', detail: messageOf(err) })
        if (mounted.current) setTranscript({ status: 'error', data: null, error: messageOf(err) })
      })
  }, [detail.id])
  useEffect(() => {
    loadTranscript()
  }, [loadTranscript])
  // o trabalho deste projeto terminou (aqui ou em segundo plano): lê o texto novo
  const jobState = useTranscription((s) => s.jobs[detail.id]?.state)
  useEffect(() => {
    if (jobState === 'done') loadTranscript()
  }, [jobState, loadTranscript])

  // --- cena -----------------------------------------------------------------------------------------------
  const format = useStore(store, (s) => s.format)
  const formatRef = useRef(format)
  formatRef.current = format
  const words = transcript.data?.words ?? null
  const derived = useMemo(
    () => (cursorData ? deriveProject(project, cursorData, format === 'vertical' ? VERTICAL_1080 : HORIZONTAL_1080, words) : null),
    [project, cursorData, format, words]
  )

  // A prévia de um corte: o MESMO documento que a exportação desenha (os trechos do corte, o gancho dele, o layout e a legenda
  // dele), sempre no 9:16. A linha do tempo segue mostrando o vídeo inteiro.
  const previewId = useStore(clips, (s) => s.previewId)
  const previewClip = useMemo(() => (previewId ? doc.clips.find((c) => c.id === previewId) : undefined), [previewId, doc.clips])
  const sceneProject = useMemo(() => (previewClip ? clipScene(doc, previewClip) : project), [previewClip, doc, project])
  const sceneDerived = useMemo(
    () => (!previewClip ? derived : cursorData ? deriveProject(sceneProject, cursorData, VERTICAL_1080, words) : null),
    [previewClip, derived, sceneProject, cursorData, words]
  )
  // a prévia só existe no 9:16 e enquanto o corte existe
  useEffect(() => {
    if (previewId && (format !== 'vertical' || !previewClip)) clips.getState().preview(null)
  }, [previewId, previewClip, format, clips])
  const sceneRef = useRef({ project: sceneProject, derived: sceneDerived })
  sceneRef.current = { project: sceneProject, derived: sceneDerived }

  // Entrar no 9:16 pela primeira vez: zooms do preset Intenso e layouts escolhidos pela atividade (uma vez; não entra no "desfazer").
  // Espera a transcrição chegar (a escolha de layout usa onde há fala).
  useEffect(() => {
    if (format !== 'vertical' || !cursorData || transcript.status === 'loading') return
    store.getState().changeDoc((doc) => ensureVertical(doc, cursorData, { durationMs, words, hasCursorEvents: Boolean(detail.events.cursor) }), { history: false })
  }, [format, cursorData, transcript.status, words, durationMs, store, detail.events.cursor])

  // Ao abrir um projeto que nunca teve zoom automático, gera os do preset padrão (uma vez; não entra no "desfazer").
  const generated = useRef(false)
  useEffect(() => {
    if (!cursorData || generated.current) return
    generated.current = true
    const p = store.getState().doc
    if (p.zoomPreset === undefined && p.zooms.length === 0 && detail.events.cursor) {
      const auto = generateAutoZooms({ clicks: cursorData.clicks, keys: cursorData.keys, cursor: cursorData.grid, duration: durationMs, preset: DEFAULT_ZOOM_PRESET })
      store.getState().change((doc) => regenerateZooms(doc, DEFAULT_ZOOM_PRESET, auto), { history: false })
    }
  }, [cursorData, store, durationMs, detail.events.cursor])

  // --- motor da prévia ------------------------------------------------------------------------------------
  const screenUrl = detail.media.screen?.url ?? null
  const cameraUrl = detail.media.camera?.url ?? null
  useEffect(() => {
    const canvasEl = canvas.current
    const hostEl = host.current
    const frameEl = frame.current
    if (!canvasEl || !hostEl) return
    const engine = new PreviewEngine({
      canvas: canvasEl,
      host: hostEl,
      screenUrl,
      cameraUrl,
      playback,
      onError: (message) => window.tomada.log({ level: 'error', message: 'Falha ao reproduzir', detail: message }),
      onAudioError: (message) => {
        playback.setState({ audioError: message })
        if (message) window.tomada.log({ level: 'warn', message: 'Áudio da prévia', detail: message })
      },
      onFontsError: (message) => {
        window.tomada.log({ level: 'error', message: 'Falha ao carregar as fontes das legendas', detail: message })
        notify({ kind: 'error', text: t.editor.captions.fontsFailed, detail: message })
      }
    })
    engineRef.current = engine
    // o canvas tem a proporção do formato: 16:9 (até 1920 px de largura) ou 9:16 (até 1080)
    const fit = (): void => {
      if (!frameEl) return
      const dpr = window.devicePixelRatio || 1
      const px = Math.round(frameEl.clientWidth * dpr)
      if (formatRef.current === 'vertical') {
        const w = Math.min(1080, Math.max(270, px))
        engine.setSize(w, Math.round((w * 16) / 9))
      } else {
        const w = Math.min(1920, Math.max(320, px))
        engine.setSize(w, Math.round((w * 9) / 16))
      }
    }
    fitRef.current = fit
    fit()
    const ro = new ResizeObserver(fit)
    if (frameEl) ro.observe(frameEl)
    const { project: p, derived: d } = sceneRef.current
    if (d) engine.setScene(p, d)
    setEngineGen((n) => n + 1)
    return () => {
      ro.disconnect()
      engine.destroy()
      if (engineRef.current === engine) engineRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenUrl, cameraUrl, playback])

  // trocar de formato muda a proporção da prévia
  useEffect(() => {
    fitRef.current?.()
  }, [format])

  useEffect(() => {
    if (sceneDerived) engineRef.current?.setScene(sceneProject, sceneDerived)
  }, [sceneProject, sceneDerived, engineGen])

  // ao entrar na prévia de um corte, a reprodução vai ao começo dele (uma vez por corte; editar o corte não a leva de volta)
  const seekedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!previewId) {
      seekedFor.current = null
      return
    }
    if (!previewClip || !sceneDerived || seekedFor.current === previewId) return
    seekedFor.current = previewId
    engineRef.current?.seekOutput(0)
  }, [previewId, previewClip, sceneDerived])

  // arquivo que o projeto cita e não está no disco: erro à vista na própria prévia
  useEffect(() => {
    const missing = (hasScreen && !detail.media.screen) || (hasCamera && !detail.media.camera)
    playback.setState({ error: missing ? t.project.missingFile : null })
  }, [hasScreen, hasCamera, detail.media.screen, detail.media.camera, playback])

  // imagem de fundo (quando o estilo usa uma)
  const bg = project.style.background
  useEffect(() => {
    if (bg.type !== 'image') return
    let alive = true
    void (async () => {
      try {
        // só arquivo do PRÓPRIO projeto: o caminho é relativo e validado (http:, https:, file:, data:, `..` e absoluto lançam)
        const response = await fetch(assertMediaUrl(mediaUrl(detail.id, bg.path)))
        if (!response.ok) throw new Error(`Não consegui ler a imagem de fundo (${response.status}).`)
        const bitmap = await createImageBitmap(await response.blob())
        if (alive) engineRef.current?.setBackgroundImage(bg.path, { image: bitmap, w: bitmap.width, h: bitmap.height })
      } catch (err) {
        notify({ kind: 'error', text: t.editor.backgroundFailed, detail: messageOf(err) })
      }
    })()
    return () => {
      alive = false
    }
  }, [bg, detail.id, notify, engineGen])

  // --- áudio da prévia: voz crua já; a tratada assume quando o ffmpeg termina ------------------------------
  const cameraOffset = project.sync.cameraOffsetMs
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    let alive = true
    let voiceUrl: string | null = null
    try {
      voiceUrl = voicePath ? window.tomada.mediaUrl(detail.id, voicePath) : null
    } catch (err) {
      // caminho do documento que sai da pasta do projeto: sem voz crua (o processo principal já avisou ao abrir)
      window.tomada.log({ level: 'error', message: 'Caminho de voz inválido no projeto', detail: messageOf(err) })
    }
    engine.setAudio(voiceUrl, cameraOffset, false)
    void window.tomada.derived
      .previewAudio(detail.id)
      .then((r) => {
        if (alive && r) engine.setAudio(r.url, 0, true)
      })
      .catch((err: unknown) => {
        window.tomada.log({ level: 'error', message: 'Falha ao preparar o áudio da prévia', detail: messageOf(err) })
        if (alive) notify({ kind: 'error', text: 'Não consegui preparar a voz tratada da prévia', detail: messageOf(err) })
      })
    return () => {
      alive = false
    }
    // a voz crua vale por projeto; o deslocamento da câmera só muda ao regravar
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineGen, detail.id, voicePath])

  // --- forma de onda e miniaturas ---------------------------------------------------------------------------
  const initialPeaks: AssetState<PeaksData> = { status: voicePath ? 'loading' : 'none', data: null, error: null }
  const [peaks, setPeaks] = useState<AssetState<PeaksData>>(initialPeaks)
  const [thumbs, setThumbs] = useState<AssetState<ThumbsData>>({ status: hasScreen || hasCamera ? 'loading' : 'none', data: null, error: null })
  const loadAssets = useCallback(
    (only?: 'peaks' | 'thumbs') => {
      if (only !== 'peaks') {
        setThumbs((s) => ({ ...s, status: 'loading', error: null }))
        void window.tomada.derived
          .thumbs(detail.id)
          .then((data) => setThumbs(data ? { status: 'ready', data, error: null } : { status: 'none', data: null, error: null }))
          .catch((err: unknown) => setThumbs({ status: 'error', data: null, error: messageOf(err) }))
      }
      if (only !== 'thumbs' && voicePath) {
        setPeaks((s) => ({ ...s, status: 'loading', error: null }))
        void window.tomada.derived
          .peaks(detail.id)
          .then((data) => setPeaks(data ? { status: 'ready', data, error: null } : { status: 'none', data: null, error: null }))
          .catch((err: unknown) => setPeaks({ status: 'error', data: null, error: messageOf(err) }))
      }
    },
    [detail.id, voicePath]
  )
  useEffect(() => {
    loadAssets()
  }, [loadAssets])
  const retryAssets = useCallback(() => {
    loadAssets(peaks.status === 'error' && thumbs.status !== 'error' ? 'peaks' : thumbs.status === 'error' && peaks.status !== 'error' ? 'thumbs' : undefined)
  }, [loadAssets, peaks.status, thumbs.status])

  // Nível do áudio (para achar silêncio): só depois que há texto. Depois dele, a limpeza automática, uma vez por projeto.
  const [levels, setLevels] = useState<AssetState<Levels>>({ status: 'none', data: null, error: null })
  const levelsAsked = useRef(false)
  useEffect(() => {
    const tr = transcript.data
    if (levelsAsked.current || transcript.status !== 'ready' || !tr || tr.words.length === 0) return
    levelsAsked.current = true
    setLevels({ status: 'loading', data: null, error: null })
    void (async () => {
      let lv: Levels | null = null
      try {
        lv = await window.tomada.derived.levels(detail.id)
        if (mounted.current) setLevels(lv ? { status: 'ready', data: lv, error: null } : { status: 'none', data: null, error: null })
      } catch (err) {
        window.tomada.log({ level: 'error', message: 'Falha ao medir o volume do áudio', detail: messageOf(err) })
        if (mounted.current) setLevels({ status: 'error', data: null, error: messageOf(err) })
      }
      if (!mounted.current) return
      // Limpeza automática: só em projeto cuja transcrição é NOVA (feita depois do projeto existir), uma vez, e se a pessoa não desligou.
      const doc = store.getState().project
      if (doc.autoCleaned || !tr.createdAt || tr.createdAt < doc.createdAt) return
      try {
        const prefs = await window.tomada.transcription.getPrefs()
        if (!prefs.autoClean || !mounted.current) return
        // a marca fica FORA do desfazer: quem desfaz a limpeza não a vê voltar na próxima vez que abrir o projeto
        store.getState().change((d) => ({ ...d, autoCleaned: true }), { history: false })
        const out = applyClean(store, buildCleanInput(tr, lv, durationMs), DEFAULT_CLEAN, durationMs)
        if (out.applied && out.plan.deltaMs > 0) notify({ kind: 'info', text: t.editor.clean.autoDone(formatSpan(out.plan.deltaMs)) })
      } catch (err) {
        window.tomada.log({ level: 'error', message: 'Falha na limpeza automática', detail: messageOf(err) })
        notify({ kind: 'error', text: 'Não consegui aplicar a limpeza automática', detail: messageOf(err) })
      }
    })()
  }, [transcript.status, transcript.data, detail.id, store, durationMs, notify])

  // --- exportação ---------------------------------------------------------------------------------------------
  const flush = useCallback(() => store.getState().flush(), [store])
  const exporter = useExportController(detail.id, flush)

  // Ao fechar o projeto, o que ainda não foi gravado vai para o disco.
  useEffect(
    () => () => {
      void store.getState().flush()
      store.getState().dispose()
    },
    [store]
  )

  const onBack = useCallback(() => {
    void store
      .getState()
      .flush()
      .then(() => go({ name: 'library' }))
  }, [store, go])

  const value = useMemo<EditorCtx>(
    () => ({
      detail,
      store,
      playback,
      engineRef,
      cursorData,
      eventsError,
      derived,
      sceneDerived,
      durationMs,
      hasScreen,
      hasCamera,
      peaks,
      thumbs,
      retryAssets,
      transcript,
      reloadTranscript: loadTranscript,
      levels,
      text,
      exporter,
      clips,
      queue,
      ai: aiUi,
      refs: { canvas, host, frame }
    }),
    [detail, store, playback, cursorData, eventsError, derived, sceneDerived, durationMs, hasScreen, hasCamera, peaks, thumbs, retryAssets, transcript, loadTranscript, levels, text, exporter, clips, queue, aiUi]
  )

  return (
    <EditorContext.Provider value={value}>
      <EditorInner onBack={onBack} layoutRef={layoutRef} />
    </EditorContext.Provider>
  )
}
