/**
 * O áudio da PRÉVIA "não tocou" (F3, item 4). No log de 09/10 apareceu 3 vezes `play() request was interrupted by a call to pause()`:
 * o motor pausa o áudio de propósito (segura o relógio, cancela o cruzamento da emenda, o usuário pausa) e o `play()` pendente rejeita
 * com `AbortError`. Isso era reportado como falha ("O áudio da prévia não tocou"), com a pílula do transporte em aviso até o fim da
 * sessão. Agora a interrupção não é falha; a falha de verdade (e o áudio que devia tocar e não toca) vira aviso VISÍVEL com o motivo.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { launchTomada, type Session } from './helpers'
import { openEditor } from './editor-helpers'

let s: Session | undefined
test.afterEach(async () => {
  if (s) {
    const problems = s.problems
    await s.close()
    s = undefined
    expect(problems, `erros na interface:\n${problems.join('\n')}`).toEqual([])
  }
})

/** Tudo que o app registrou no log desta sessão. */
function readLog(session: Session): string {
  const dir = join(session.userData, 'logs')
  if (!existsSync(dir)) return ''
  return readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n')
}

async function openWithTreatedAudio(session: Session): Promise<void> {
  await openEditor(session)
  await expect(session.page.getByTestId('audio-status')).toHaveAttribute('data-treated', 'true', { timeout: 60_000 })
}

test('um play() interrompido pelo pause() do próprio motor NÃO vira aviso de áudio nem falha no log', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  const { page } = s
  await openWithTreatedAudio(s)

  // observa o que acontece com cada play() do <audio> (sem consumir a rejeição): o resultado de cada um fica em window.__playOutcomes
  await page.evaluate(() => {
    const w = window as unknown as { __playOutcomes: string[] }
    w.__playOutcomes = []
    const original = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      const promise = original.call(this)
      if (this instanceof HTMLAudioElement) promise.then(() => w.__playOutcomes.push('ok'), (err: { name?: string }) => w.__playOutcomes.push(err?.name ?? 'erro'))
      return promise
    }
  })
  // anda 1 s (Shift+→, o áudio fica buscando) e, no MESMO instante, toca e pausa (Espaço, Espaço): o play() do áudio fica pendente enquanto
  // ele busca e o pause() o interrompe (AbortError). É a sequência de quem revisa os cortes, como no log de 09/10.
  await page.evaluate(async () => {
    const press = (code: string, shiftKey = false): void => void document.body.dispatchEvent(new KeyboardEvent('keydown', { code, key: code === 'Space' ? ' ' : code, shiftKey, bubbles: true }))
    for (let i = 0; i < 8; i++) {
      press('ArrowRight', true)
      press('Space')
      press('Space')
      await new Promise((r) => setTimeout(r, 60))
    }
  })
  await page.waitForTimeout(800)
  const outcomes = await page.evaluate(() => (window as unknown as { __playOutcomes: string[] }).__playOutcomes)
  // a repetição reproduz o log de 09/10: houve play() interrompido (AbortError)
  expect(outcomes, `resultados dos play(): ${outcomes.join(',')}`).toContain('AbortError')

  const chip = page.getByTestId('audio-status')
  await expect(chip).toHaveAttribute('data-treated', 'true')
  expect(await chip.getAttribute('data-tone')).toBeNull()
  // o log registra a interrupção UMA vez, como nota (esperada), e nenhuma falha
  await expect.poll(() => readLog(s!).includes('interrompido por um pause() do próprio motor'), { timeout: 10_000 }).toBe(true)
  const log = readLog(s)
  expect(log).not.toMatch(/não tocou/)
  expect(log.split('interrompido por um pause() do próprio motor').length - 1).toBe(1)
})

test('o áudio toca de verdade quando o motor pede som: o relógio do <audio> anda com a prévia', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  const { page } = s
  await openWithTreatedAudio(s)
  await page.getByTestId('play-toggle').click()
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-playing', 'true')
  const sample = async (): Promise<{ t: number; paused: boolean }> =>
    page.evaluate(() => {
      const a = document.querySelector('[data-testid="preview-audio"]') as HTMLAudioElement
      return { t: a.currentTime, paused: a.paused }
    })
  await page.waitForTimeout(700)
  const first = await sample()
  await page.waitForTimeout(900)
  const second = await sample()
  expect(second.paused).toBe(false)
  expect(second.t).toBeGreaterThan(first.t + 0.4)
  expect(await page.getByTestId('audio-status').getAttribute('data-tone')).toBeNull()
})

test('uma falha REAL do play() (o sistema recusa) vira aviso visível com o motivo, e entra UMA vez no log (não 60 por segundo)', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  const { page } = s
  await openWithTreatedAudio(s)
  await page.evaluate(() => {
    const original = HTMLMediaElement.prototype.play
    ;(window as unknown as { __playOriginal: typeof original }).__playOriginal = original
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (this instanceof HTMLAudioElement) return Promise.reject(new DOMException('play() failed because the user did not interact with the document first.', 'NotAllowedError'))
      return original.call(this)
    }
  })
  await page.getByTestId('play-toggle').click()
  const chip = page.getByTestId('audio-status')
  await expect(chip).toHaveAttribute('data-tone', 'warn', { timeout: 10_000 })
  await expect(chip).toHaveAttribute('title', /NotAllowedError/)
  await page.waitForTimeout(1500)
  const lines = readLog(s).split('\n').filter((l) => /não tocou: o sistema não deixou/.test(l))
  expect(lines.length).toBe(1)
  // o sistema volta a deixar tocar: o áudio anda de novo e o aviso sai sozinho (nada de pílula amarela até o fim da sessão)
  await page.evaluate(() => {
    HTMLMediaElement.prototype.play = (window as unknown as { __playOriginal: HTMLMediaElement['play'] }).__playOriginal
  })
  await expect(chip).toHaveAttribute('data-treated', 'true', { timeout: 15_000 })
  expect(await chip.getAttribute('data-tone')).toBeNull()
})

test('o áudio que devia tocar e não começa: o vigia tenta de novo e AVISA em vez de ficar mudo', async () => {
  test.setTimeout(120_000)
  s = await launchTomada()
  const { page } = s
  await openWithTreatedAudio(s)
  await page.evaluate(() => {
    const original = HTMLMediaElement.prototype.play
    // o play() "funciona" (a promessa resolve) mas o áudio nunca sai do lugar: o pior caso, sem erro nenhum
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (this instanceof HTMLAudioElement) {
        this.pause()
        return Promise.resolve()
      }
      return original.call(this)
    }
  })
  await page.getByTestId('play-toggle').click()
  const chip = page.getByTestId('audio-status')
  await expect(chip).toHaveAttribute('data-tone', 'warn', { timeout: 15_000 })
  await expect(chip).toHaveAttribute('title', /não começou a tocar/)
  await expect.poll(() => /tentativa 3 de tocar de novo/.test(readLog(s!)), { timeout: 5000 }).toBe(true)
  expect(readLog(s)).toMatch(/Áudio da prévia.*não começou a tocar depois de várias tentativas/)
})
