import { describe, expect, it } from 'vitest'
import { explainMediaError } from '../../src/renderer/recording/media-errors'

const err = (name: string, message = ''): Error => Object.assign(new Error(message), { name })

describe('erros de câmera, microfone e tela em português', () => {
  it('permissão negada aponta a configuração de privacidade do Windows (câmera e microfone)', () => {
    expect(explainMediaError(err('NotAllowedError'), 'camera')).toContain('Privacidade')
    expect(explainMediaError(err('NotAllowedError'), 'microphone')).toContain('o microfone')
  })

  it('dispositivo ausente, em uso e sem suporte à configuração têm mensagens diferentes', () => {
    expect(explainMediaError(err('NotFoundError'), 'camera')).toContain('Não encontrei a câmera')
    expect(explainMediaError(err('NotReadableError'), 'camera')).toContain('em uso por outro programa')
    expect(explainMediaError(err('OverconstrainedError'), 'microphone')).toContain('não aceita a configuração')
  })

  it('tela que sumiu manda escolher de novo', () => {
    expect(explainMediaError(err('NotFoundError'), 'screen')).toContain('Escolha de novo')
  })

  it('erro desconhecido mostra o que o sistema disse (nada de falha muda)', () => {
    expect(explainMediaError(err('Estranho', 'algo deu errado'), 'camera')).toContain('algo deu errado')
    expect(explainMediaError('texto solto', 'microphone')).toContain('texto solto')
  })
})
