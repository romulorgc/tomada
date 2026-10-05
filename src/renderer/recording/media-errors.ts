/**
 * Erros de `getUserMedia`/`getDisplayMedia` em português claro, com o que fazer.
 * Puro (só lê `name`/`message`): testável sem navegador.
 */
export type MediaTarget = 'screen' | 'camera' | 'microphone'

const NAMES: Record<MediaTarget, string> = {
  screen: 'a tela ou janela',
  camera: 'a câmera',
  microphone: 'o microfone'
}

export function explainMediaError(err: unknown, target: MediaTarget): string {
  const name = err instanceof Error ? err.name : ''
  const raw = err instanceof Error ? err.message : String(err)
  const what = NAMES[target]
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return target === 'screen'
        ? `O Windows ou o Tomada não deixou capturar ${what}. Tente escolher a fonte de novo.`
        : `O Windows não deixou o Tomada usar ${what}. Abra Configurações > Privacidade e segurança e libere o acesso para aplicativos de área de trabalho.`
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return target === 'screen'
        ? 'A tela ou janela escolhida não existe mais. Escolha de novo.'
        : `Não encontrei ${what}. Confira se está conectado e escolha de novo.`
    case 'NotReadableError':
    case 'TrackStartError':
      return `${capitalize(what)} está em uso por outro programa ou não respondeu. Feche o outro programa e tente de novo.`
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return `${capitalize(what)} não aceita a configuração pedida. Escolha outro dispositivo.`
    case 'AbortError':
      return `A captura de ${what} foi interrompida antes de começar. Tente de novo.`
    default:
      return `Não consegui abrir ${what}: ${raw || name || 'erro desconhecido'}.`
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
