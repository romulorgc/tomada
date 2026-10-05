/**
 * Aba ESTILO: fundo (os 18 do legado + Noite, cor sólida, gradiente livre com ângulo e imagem do disco),
 * margem, cantos e sombra. Cada mudança é uma edição do documento (desfazível, salva sozinha); os controles
 * deslizantes juntam as mudanças seguidas num passo só (`coalesce`).
 */
import { defaultStyle } from '@shared/project'
import { BACKGROUND_PRESETS, NIGHT_PRESET, backgroundFromPreset, presetIdOf } from '@shared/styles'
import type { Background, Style } from '@shared/types'
import { ImageIcon } from '../../components/Icons'
import { t } from '../../i18n/pt-BR'
import { useApp } from '../../store'
import { ColorField, Hint, Section, Segmented, Slider } from '../controls'
import { useDoc, useEditor } from '../context'

const T = t.editor.style

const baseName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Um tom mais escuro de uma cor (para o gradiente nascer de uma cor sólida). */
function darken(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return '#0b0c10'
  const n = parseInt(m[1]!, 16)
  const f = (v: number): number => Math.max(0, Math.round(v * 0.45))
  const r = f((n >> 16) & 255)
  const g = f((n >> 8) & 255)
  const b = f(n & 255)
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

export function StylePanel() {
  const { store, detail } = useEditor()
  const notify = useApp((s) => s.notify)
  const style = useDoc((s) => s.project.style)
  const bg = style.background
  const active = presetIdOf(bg)

  const edit = (fn: (s: Style) => Style, coalesce?: string): void => {
    store.getState().change((p) => ({ ...p, style: fn(p.style) }), coalesce ? { coalesce } : undefined)
  }
  const setBg = (background: Background, coalesce?: string): void => edit((s) => ({ ...s, background }), coalesce)

  const pickImage = async (): Promise<void> => {
    try {
      const rel = await window.tomada.projects.pickBackground(detail.id)
      if (rel) setBg({ type: 'image', path: rel })
    } catch (err) {
      notify({ kind: 'error', text: T.imageFailed, detail: err instanceof Error ? err.message : String(err) })
    }
  }

  const switchType = (type: Background['type']): void => {
    if (type === 'image') {
      void pickImage()
      return
    }
    if (type === bg.type) return
    if (type === 'solid') setBg({ type: 'solid', color: bg.type === 'gradient' ? bg.from : NIGHT_PRESET.from })
    else if (bg.type === 'solid') setBg({ type: 'gradient', from: bg.color, to: darken(bg.color), angle: 135 })
    else setBg(backgroundFromPreset(NIGHT_PRESET.id))
  }

  const resetFrame = (): void => {
    const d = defaultStyle()
    edit((s) => ({ ...s, padding: d.padding, radius: d.radius, shadow: d.shadow }))
  }

  return (
    <div className="panel" data-testid="style-panel">
      <Section title={T.background} testId="bg-section">
        <div className="bg-grid" role="group" aria-label={T.background} data-testid="bg-swatches">
          {[NIGHT_PRESET, ...BACKGROUND_PRESETS].map((b) => (
            <button
              key={b.id}
              type="button"
              className="bg-tile"
              title={b.name}
              aria-label={b.name}
              aria-pressed={active === b.id}
              data-testid={`bg-${b.id}`}
              style={{ background: b.from === b.to ? b.from : `linear-gradient(135deg, ${b.from}, ${b.to})` }}
              onClick={() => setBg(backgroundFromPreset(b.id))}
            />
          ))}
        </div>

        <Segmented<Background['type']>
          label={T.backgroundFree}
          value={bg.type}
          onChange={switchType}
          options={[
            { value: 'gradient', label: T.gradient, testId: 'bg-type-gradient' },
            { value: 'solid', label: T.solid, testId: 'bg-type-solid' },
            { value: 'image', label: T.image, icon: <ImageIcon size={14} />, testId: 'bg-type-image' }
          ]}
        />

        {bg.type === 'gradient' ? (
          <div className="ctl-stack" data-testid="bg-gradient">
            <div className="ctl-pair">
              <ColorField label={T.colorFrom} value={bg.from} testId="bg-from" onChange={(c) => setBg({ ...bg, from: c }, 'bg-from')} />
              <ColorField label={T.colorTo} value={bg.to} testId="bg-to" onChange={(c) => setBg({ ...bg, to: c }, 'bg-to')} />
            </div>
            <Slider label={T.angle} value={bg.angle} min={0} max={360} step={5} testId="bg-angle" format={(v) => `${Math.round(v)}°`} onChange={(v) => setBg({ ...bg, angle: v }, 'bg-angle')} />
          </div>
        ) : null}
        {bg.type === 'solid' ? (
          <div className="ctl-stack" data-testid="bg-solid">
            <ColorField label={T.colorSolid} value={bg.color} testId="bg-color" onChange={(c) => setBg({ type: 'solid', color: c }, 'bg-color')} />
          </div>
        ) : null}
        {bg.type === 'image' ? (
          <div className="ctl-stack" data-testid="bg-image">
            <div className="file-row">
              <ImageIcon size={16} />
              <span title={bg.path}>{T.imageName(baseName(bg.path))}</span>
              <button type="button" className="btn btn-ghost" data-testid="bg-image-change" onClick={() => void pickImage()}>
                {T.changeImage}
              </button>
            </div>
            <Hint>{T.imageHelp}</Hint>
          </div>
        ) : null}
      </Section>

      <Section
        title={t.editor.style.title}
        action={
          <button type="button" className="link" data-testid="style-reset" onClick={resetFrame}>
            {T.reset}
          </button>
        }
      >
        <Slider label={T.margin} value={style.padding} min={0} max={0.3} step={0.005} testId="style-margin" format={T.percent} onChange={(v) => edit((s) => ({ ...s, padding: v }), 'style-margin')} />
        <Slider label={T.radius} value={style.radius} min={0} max={60} step={1} testId="style-radius" format={T.px} onChange={(v) => edit((s) => ({ ...s, radius: v }), 'style-radius')} />
      </Section>

      <Section title={T.shadow}>
        <Slider label={T.shadowOpacity} value={style.shadow.opacity} min={0} max={1} step={0.01} testId="shadow-opacity" format={T.percent} onChange={(v) => edit((s) => ({ ...s, shadow: { ...s.shadow, opacity: v } }), 'shadow-opacity')} />
        <Slider label={T.shadowBlur} value={style.shadow.blur} min={0} max={120} step={1} testId="shadow-blur" format={T.px} onChange={(v) => edit((s) => ({ ...s, shadow: { ...s.shadow, blur: v } }), 'shadow-blur')} />
        <Slider label={T.shadowOffset} value={style.shadow.offsetY} min={0} max={60} step={1} testId="shadow-offset" format={T.px} onChange={(v) => edit((s) => ({ ...s, shadow: { ...s.shadow, offsetY: v } }), 'shadow-offset')} />
      </Section>
    </div>
  )
}
