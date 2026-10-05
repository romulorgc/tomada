/**
 * Ajustes da transcrição e da IA: o conteúdo das duas seções (o `Section` com título e ajuda é do Settings).
 *
 * Segurança: a chave de acesso é só de ESCRITA. Ela vai para o processo principal, que a cifra com o cofre do
 * sistema; a tela nunca a recebe de volta (só "há uma chave guardada").
 */
import { useCallback, useEffect, useState } from 'react'
import { DICTIONARY_MAX_TERMS, parseDictionaryText } from '@shared/dictionary'
import type { LlmStatus, TranscriptionPrefs } from '@shared/transcription'
import { CheckIcon, CrossIcon } from '../components/Icons'
import { TranscriptionPrepare } from '../components/TranscriptionPrepare'
import { Segmented } from '../editor/controls'
import { t } from '../i18n/pt-BR'
import { useApp } from '../store'

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

function SwitchRow({ label, hint, checked, onChange, testId, disabled }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; testId: string; disabled?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-6 py-2">
      <div className="min-w-0">
        <p className="text-[0.9375rem] font-medium">{label}</p>
        <p className="text-[0.8125rem] text-muted">{hint}</p>
      </div>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} data-testid={testId} onClick={() => onChange(!checked)}>
        <span />
      </button>
    </div>
  )
}

export function TranscriptionSettings() {
  const notify = useApp((s) => s.notify)
  const [prefs, setPrefs] = useState<TranscriptionPrefs | null>(null)
  const [saved, setSaved] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [p, d] = await Promise.all([window.tomada.transcription.getPrefs(), window.tomada.dictionary.get()])
      setPrefs(p)
      setSaved(d)
      setDraft(d.join('\n'))
    } catch (err) {
      window.tomada.log({ level: 'error', message: 'Falha ao ler os ajustes da transcrição', detail: messageOf(err) })
      setLoadError(messageOf(err))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const change = async (patch: Partial<TranscriptionPrefs>): Promise<void> => {
    try {
      setPrefs(await window.tomada.transcription.setPrefs(patch))
    } catch (err) {
      notify({ kind: 'error', text: t.settings.transcription.prefsFailed, detail: messageOf(err) })
    }
  }

  const terms = parseDictionaryText(draft)
  const dirty = terms.join('\n') !== saved.join('\n')
  const saveDictionary = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.tomada.dictionary.set(terms)
      setSaved(next)
      setDraft(next.join('\n'))
      notify({ kind: 'info', text: t.settings.transcription.dictionary.saved })
    } catch (err) {
      notify({ kind: 'error', text: t.settings.transcription.dictionary.saveFailed, detail: messageOf(err) })
    } finally {
      setSaving(false)
    }
  }

  if (loadError) {
    return (
      <div role="alert" className="rounded-thumb border border-line-strong bg-surface px-4 py-3 text-[0.9375rem]">
        <p className="text-danger">{loadError}</p>
        <button type="button" className="btn mt-3" onClick={() => void load()}>
          {t.common.retry}
        </button>
      </div>
    )
  }

  return (
    <div className="grid gap-5" data-testid="settings-transcription-body">
      <div className="rounded-thumb border border-line bg-surface px-4 py-4">
        <TranscriptionPrepare />
      </div>

      {prefs ? (
        <div className="rounded-thumb border border-line bg-surface px-4 py-2">
          <SwitchRow
            label={t.settings.transcription.auto.label}
            hint={t.settings.transcription.auto.hint}
            checked={prefs.auto}
            onChange={(v) => void change({ auto: v })}
            testId="pref-auto-transcribe"
          />
          <SwitchRow
            label={t.settings.transcription.autoClean.label}
            hint={t.settings.transcription.autoClean.hint}
            checked={prefs.autoClean}
            onChange={(v) => void change({ autoClean: v })}
            testId="pref-auto-clean"
          />
        </div>
      ) : null}

      <div className="rounded-thumb border border-line bg-surface px-4 py-4">
        <label htmlFor="dictionary" className="text-[0.9375rem] font-medium">
          {t.settings.transcription.dictionary.label}
        </label>
        <p className="mb-2 text-[0.8125rem] text-muted">{t.settings.transcription.dictionary.help}</p>
        <textarea
          id="dictionary"
          rows={5}
          value={draft}
          spellCheck={false}
          placeholder={t.settings.transcription.dictionary.placeholder}
          data-testid="dictionary-input"
          className="w-full resize-y rounded-control border border-line-strong bg-raised px-3 py-2 text-[0.9375rem] text-ink"
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="tnum text-[0.8125rem] text-muted" data-testid="dictionary-count">
            {t.settings.transcription.dictionary.count(terms.length, DICTIONARY_MAX_TERMS)}
          </span>
          <button type="button" className="btn" disabled={!dirty || saving} onClick={() => void saveDictionary()} data-testid="dictionary-save">
            {t.settings.transcription.dictionary.save}
          </button>
        </div>
      </div>
    </div>
  )
}

export function AiSettings() {
  const notify = useApp((s) => s.notify)
  const [status, setStatus] = useState<LlmStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; message?: string } | null>(null)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      setStatus(await window.tomada.ai.status())
    } catch (err) {
      window.tomada.log({ level: 'error', message: 'Falha ao ler o estado da IA', detail: messageOf(err) })
      setLoadError(messageOf(err))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const setPreference = async (provider: 'auto' | 'cli' | 'api'): Promise<void> => {
    try {
      setStatus(await window.tomada.ai.setPrefs({ provider }))
      setTest(null)
    } catch (err) {
      notify({ kind: 'error', text: t.settings.ai.prefsFailed, detail: messageOf(err) })
    }
  }

  const saveKey = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.tomada.ai.setKey(key.trim()))
      setKey('')
      setTest(null)
      notify({ kind: 'info', text: t.settings.ai.key.saved })
    } catch (err) {
      notify({ kind: 'error', text: t.settings.ai.key.failed, detail: messageOf(err) })
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.tomada.ai.clearKey())
      setTest(null)
      notify({ kind: 'info', text: t.settings.ai.key.cleared })
    } catch (err) {
      notify({ kind: 'error', text: t.settings.ai.key.failed, detail: messageOf(err) })
    } finally {
      setBusy(false)
    }
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    setTest(null)
    try {
      setTest(await window.tomada.ai.test())
    } catch (err) {
      setTest({ ok: false, message: messageOf(err) })
    } finally {
      setTesting(false)
    }
  }

  if (loadError) {
    return (
      <div role="alert" className="rounded-thumb border border-line-strong bg-surface px-4 py-3 text-[0.9375rem]">
        <p className="text-danger">{loadError}</p>
        <button type="button" className="btn mt-3" onClick={() => void load()}>
          {t.common.retry}
        </button>
      </div>
    )
  }
  if (!status) return <div className="skeleton h-24 w-full" aria-busy="true" aria-label={t.common.loading} />

  const P = t.settings.ai
  return (
    <div className="grid gap-5" data-testid="settings-ai-body">
      <div className="grid gap-3 rounded-thumb border border-line bg-surface px-4 py-4">
        <div className="flex items-center gap-2 text-[0.9375rem] font-semibold" data-testid="ai-status" data-available={status.available}>
          <span className={status.available ? 'text-ok' : 'text-muted'}>{status.available ? <CheckIcon size={16} /> : <CrossIcon size={16} />}</span>
          {status.available ? P.status.ready : P.status.missing}
        </div>
        {status.detail ? <p className="text-[0.8125rem] text-muted">{status.detail}</p> : null}
        <ul className="grid gap-1 text-[0.8125rem] text-muted">
          <li data-testid="ai-cli">{status.cliFound ? P.cli.found : P.cli.missing}</li>
          <li data-testid="ai-key-state">{status.hasKey ? P.key.has : P.key.none}</li>
        </ul>

        <div>
          <p className="mb-1.5 text-[0.8125rem] text-muted">{P.preference.label}</p>
          <Segmented
            label={P.preference.label}
            value={status.preference}
            onChange={(v) => void setPreference(v)}
            options={[
              { value: 'auto', label: P.preference.auto, testId: 'ai-pref-auto' },
              { value: 'cli', label: P.preference.cli, testId: 'ai-pref-cli' },
              { value: 'api', label: P.preference.api, testId: 'ai-pref-api' }
            ]}
          />
        </div>

        <div>
          <label htmlFor="ai-key" className="text-[0.9375rem] font-medium">
            {P.key.label}
          </label>
          <p className="mb-2 text-[0.8125rem] text-muted">{P.key.help}</p>
          <div className="flex flex-wrap gap-2">
            <input
              id="ai-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              placeholder={P.key.placeholder}
              data-testid="ai-key-input"
              className="min-w-0 flex-1 rounded-control border border-line-strong bg-raised px-3 py-2 text-[0.9375rem] text-ink"
              onChange={(e) => setKey(e.target.value)}
            />
            <button type="button" className="btn" disabled={busy || key.trim().length === 0} onClick={() => void saveKey()} data-testid="ai-key-save">
              {P.key.save}
            </button>
            {status.hasKey ? (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void clearKey()} data-testid="ai-key-clear">
                {P.key.clear}
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn" disabled={testing || !status.available} onClick={() => void runTest()} data-testid="ai-test">
            {testing ? <span className="spinner" aria-hidden="true" /> : null}
            {testing ? P.testing : P.test}
          </button>
          {test ? (
            <p className={['text-[0.8125rem]', test.ok ? 'text-ok' : 'text-danger'].join(' ')} role={test.ok ? 'status' : 'alert'} data-testid="ai-test-result" data-ok={test.ok}>
              {test.ok ? P.testOk : P.testFailed}
              {test.message ? <span className="block whitespace-pre-wrap break-words text-muted">{test.message}</span> : null}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
