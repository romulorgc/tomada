/**
 * A IA está disponível agora? Lido do processo principal quando o painel abre (a pessoa pode ter instalado o programa ou colado
 * a chave nos Ajustes desde a última vez). Nunca mostra o nome do fornecedor: o motivo vem em português e só diz "IA".
 */
import { useCallback, useEffect, useState } from 'react'

export type AiAvailability = { loaded: boolean; available: boolean; detail: string | null; refresh(): void }

export function useAiStatus(): AiAvailability {
  const [state, setState] = useState<{ loaded: boolean; available: boolean; detail: string | null }>({ loaded: false, available: false, detail: null })
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    void window.tomada.ai
      .status()
      .then((s) => alive && setState({ loaded: true, available: s.available, detail: s.detail }))
      .catch((err: unknown) => {
        window.tomada.log({ level: 'error', message: 'Falha ao ler o estado da IA', detail: err instanceof Error ? err.message : String(err) })
        if (alive) setState({ loaded: true, available: false, detail: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      alive = false
    }
  }, [n])
  const refresh = useCallback(() => setN((v) => v + 1), [])
  return { ...state, refresh }
}
