/**
 * Download de um arquivo grande (modelo, whisper.cpp) com TRÊS garantias:
 *
 *  1. **Origem fixa**: só HTTPS e só hosts da lista da chamada (a lista mora no código, nunca vem do renderer). Cada
 *     redirecionamento é conferido de novo contra a lista: um CDN fora dela derruba o download.
 *  2. **Retomável**: o que já chegou fica em `<destino>.part`; cair a rede (ou fechar o app) e baixar de novo
 *     continua dali (cabeçalho `Range`). Servidor que ignora o `Range` recomeça do zero, sem corromper nada.
 *  3. **Conferido**: tamanho e SHA-256 (quando conhecidos) são checados no arquivo inteiro antes de ele ganhar o nome
 *     definitivo. Arquivo que não confere é apagado e vira erro visível.
 *
 * Sem Electron: `fetch` entra por parâmetro, então os testes provam tudo sem rede.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export class DownloadError extends Error {
  override readonly name = 'DownloadError'
  constructor(
    message: string,
    /** Vale tentar de novo (rede caiu) ou não (origem proibida, arquivo que não confere)? */
    readonly retryable: boolean
  ) {
    super(message)
  }
}

export type DownloadSpec = {
  url: string
  /** Onde o arquivo fica quando termina. */
  dest: string
  /** Hosts aceitos (o exato ou subdomínio: "hf.co" aceita "cdn-lfs.hf.co"). */
  allowedHosts: readonly string[]
  /** Tamanho esperado em bytes (confere no fim e dá a barra de progresso). */
  size?: number
  /** SHA-256 esperado (hex minúsculo). */
  sha256?: string
}

export type DownloadProgress = { received: number; total: number | null }

export type DownloadOptions = {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  onProgress?: (p: DownloadProgress) => void
  /** Tentativas contra queda de rede (cada uma retoma do `.part`). */
  attempts?: number
  /** Espera sem chegar um byte antes de desistir da tentativa (ms). */
  idleTimeoutMs?: number
  /** Espera entre tentativas (ms), dobrando; para os testes. */
  retryDelayMs?: number
  /** Notícia de bastidor (ex.: "queda de rede, tentando de novo em 2 s"). */
  onNote?: (message: string) => void
}

const MAX_REDIRECTS = 5
const hostAllowed = (host: string, allowed: readonly string[]): boolean => allowed.some((a) => host === a || host.endsWith(`.${a}`))

/** Confere uma URL contra a regra de origem fixa; lança `DownloadError` (não retentável) se não passar. */
export function assertAllowedUrl(raw: string, allowedHosts: readonly string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new DownloadError(`Endereço de download inválido: ${raw}`, false)
  }
  if (url.protocol !== 'https:') throw new DownloadError(`Só baixo por HTTPS (recebi ${url.protocol}//${url.host}).`, false)
  if (url.username || url.password) throw new DownloadError('Endereço de download com usuário e senha não é aceito.', false)
  if (!hostAllowed(url.hostname.toLowerCase(), allowedHosts)) {
    throw new DownloadError(`Origem fora da lista permitida: ${url.hostname}. Só baixo de ${allowedHosts.join(', ')}.`, false)
  }
  return url
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DownloadError('Cancelado.', false))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DownloadError('Cancelado.', false))
      },
      { once: true }
    )
  })

/** SHA-256 de um arquivo, lendo em pedaços (não carrega 1,6 GB na memória). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** Abre a resposta seguindo redirecionamentos À MÃO (cada salto é conferido contra a lista de hosts). */
async function open(spec: DownloadSpec, startAt: number, opts: DownloadOptions, signal: AbortSignal): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch
  let url = assertAllowedUrl(spec.url, spec.allowedHosts)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { 'User-Agent': 'Tomada/0.1', Accept: '*/*' }
    if (startAt > 0) headers.Range = `bytes=${startAt}-`
    let res: Response
    try {
      res = await doFetch(url, { headers, redirect: 'manual', signal })
    } catch (err) {
      if (signal.aborted && opts.signal?.aborted) throw new DownloadError('Cancelado.', false)
      throw new DownloadError(`Não consegui falar com ${url.hostname}: ${err instanceof Error ? err.message : String(err)}`, true)
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      await res.body?.cancel().catch(() => undefined)
      if (!location) throw new DownloadError(`${url.hostname} redirecionou sem dizer para onde.`, true)
      url = assertAllowedUrl(new URL(location, url).href, spec.allowedHosts)
      continue
    }
    return res
  }
  throw new DownloadError('Redirecionamentos demais.', false)
}

/**
 * Baixa `spec.url` para `spec.dest`. Devolve o tamanho final. Lança `DownloadError`:
 * `retryable` diz se tentar de novo adianta.
 */
export async function downloadFile(spec: DownloadSpec, opts: DownloadOptions = {}): Promise<number> {
  const attempts = Math.max(1, opts.attempts ?? 5)
  const part = `${spec.dest}.part`
  await mkdir(dirname(spec.dest), { recursive: true })

  // já está pronto e confere: nada a fazer
  const have = await sizeOf(spec.dest)
  if (have > 0 && (spec.size === undefined || have === spec.size)) {
    if (!spec.sha256 || (await sha256File(spec.dest)) === spec.sha256) {
      opts.onProgress?.({ received: have, total: have })
      return have
    }
    await rm(spec.dest, { force: true })
  }

  let lastError: DownloadError | null = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (opts.signal?.aborted) throw new DownloadError('Cancelado.', false)
    try {
      return await oneAttempt(spec, part, opts)
    } catch (err) {
      const e = err instanceof DownloadError ? err : new DownloadError(`Falha no download: ${err instanceof Error ? err.message : String(err)}`, true)
      if (!e.retryable || attempt === attempts) throw e
      lastError = e
      const wait = (opts.retryDelayMs ?? 2000) * 2 ** (attempt - 1)
      opts.onNote?.(`${e.message} Tentando de novo em ${Math.round(wait / 1000)} s (${attempt}/${attempts - 1}).`)
      await sleep(wait, opts.signal)
    }
  }
  throw lastError ?? new DownloadError('Download não concluído.', true)

  async function oneAttempt(s: DownloadSpec, partFile: string, o: DownloadOptions): Promise<number> {
    let startAt = await sizeOf(partFile)
    if (s.size !== undefined && startAt > s.size) {
      await rm(partFile, { force: true })
      startAt = 0
    }
    // um controlador por tentativa: o tempo parado e o cancelamento do chamador derrubam a conexão
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort()
    o.signal?.addEventListener('abort', onAbort, { once: true })
    const idleMs = o.idleTimeoutMs ?? 45_000
    let idle: NodeJS.Timeout | undefined
    let idled = false
    const poke = (): void => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => {
        idled = true
        ctl.abort()
      }, idleMs)
    }
    try {
      poke()
      const res = await open(s, startAt, o, ctl.signal)
      let append = startAt > 0
      if (res.status === 416 && s.size !== undefined && startAt === s.size) {
        // o `.part` já tem tudo: só falta conferir
        await res.body?.cancel().catch(() => undefined)
      } else {
        if (res.status === 200 && startAt > 0) {
          // o servidor ignorou o Range: recomeça do zero
          append = false
          startAt = 0
        } else if (res.status !== 200 && res.status !== 206) {
          await res.body?.cancel().catch(() => undefined)
          const retryable = res.status >= 500 || res.status === 429 || res.status === 408
          throw new DownloadError(`${new URL(s.url).hostname} respondeu ${res.status}.`, retryable)
        }
        if (!res.body) throw new DownloadError('A resposta veio sem conteúdo.', true)
        const lengthHeader = Number(res.headers.get('content-length'))
        const remaining = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null
        const total = s.size ?? (remaining !== null ? startAt + remaining : null)
        let received = startAt
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            received += chunk.length
            poke()
            o.onProgress?.({ received, total })
            cb(null, chunk)
          }
        })
        await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(partFile, { flags: append ? 'a' : 'w' }), { signal: ctl.signal })
      }
      return await finish(s, partFile)
    } catch (err) {
      if (err instanceof DownloadError) throw err
      if (idled) throw new DownloadError(`A conexão ficou parada por ${Math.round(idleMs / 1000)} s.`, true)
      if (o.signal?.aborted) throw new DownloadError('Cancelado.', false)
      throw new DownloadError(`A conexão caiu: ${err instanceof Error ? err.message : String(err)}`, true)
    } finally {
      if (idle) clearTimeout(idle)
      o.signal?.removeEventListener('abort', onAbort)
    }
  }

  async function finish(s: DownloadSpec, partFile: string): Promise<number> {
    const got = await sizeOf(partFile)
    if (s.size !== undefined && got !== s.size) {
      if (got > s.size) {
        await rm(partFile, { force: true })
        throw new DownloadError(`O arquivo baixado tem ${got} bytes e o esperado é ${s.size}. Apaguei o que veio; tente de novo.`, true)
      }
      throw new DownloadError(`O download parou em ${got} de ${s.size} bytes.`, true)
    }
    if (s.sha256) {
      const actual = await sha256File(partFile)
      if (actual !== s.sha256) {
        await rm(partFile, { force: true })
        throw new DownloadError(`O arquivo baixado não confere com o esperado (SHA-256 ${actual.slice(0, 12)}… no lugar de ${s.sha256.slice(0, 12)}…). Apaguei o que veio; tente de novo.`, false)
      }
    }
    await rm(s.dest, { force: true })
    await rename(partFile, s.dest)
    return got
  }
}
