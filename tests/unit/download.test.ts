/**
 * Download dos modelos e do whisper.cpp: origem fixa (HTTPS e lista de hosts, redirecionamentos conferidos salto a
 * salto), retomada pelo `.part` com `Range`, conferência de tamanho e SHA-256, cancelamento e tempo parado. Tudo com
 * um `fetch` falso: nenhuma rede.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertAllowedUrl, DownloadError, downloadFile, sha256File, type DownloadSpec } from '../../src/main/transcription/download'
import { useTmpDir } from '../helpers/env'

const tmp = useTmpDir('tomada-dl-')
const HOSTS = ['huggingface.co', 'hf.co']
const URL_OK = 'https://huggingface.co/org/repo/resolve/abc/model.bin'

const DATA = randomBytes(300_000)
const SHA = createHash('sha256').update(DATA).digest('hex')

type Call = { url: string; range: string | undefined; redirect: string | undefined }

/** `fetch` falso: cada chamada passa pelo `handler`, que devolve a resposta (ou lança). */
function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const call: Call = { url: String(input), range: headers.Range, redirect: init?.redirect }
    calls.push(call)
    return handler(call, calls.length)
  }) as typeof fetch
  return { impl, calls }
}

const bytesResponse = (body: Uint8Array, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(body as never, { status, headers: { 'content-length': String(body.length), ...extra } })

/** Resposta que entrega `first` e depois quebra a conexão (os dados já escritos ficam no `.part`). */
function droppingResponse(first: Uint8Array, total: number): Response {
  let sent = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(first)
        await new Promise((r) => setTimeout(r, 40))
        return
      }
      controller.error(new Error('rede caiu'))
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-length': String(total) } })
}

const spec = (dir: string, over: Partial<DownloadSpec> = {}): DownloadSpec => ({ url: URL_OK, dest: join(dir, 'model.bin'), allowedHosts: HOSTS, size: DATA.length, sha256: SHA, ...over })
const fast = { retryDelayMs: 1 }

describe('assertAllowedUrl', () => {
  it('aceita HTTPS dos hosts da lista, inclusive subdomínio', () => {
    expect(assertAllowedUrl(URL_OK, HOSTS).hostname).toBe('huggingface.co')
    expect(assertAllowedUrl('https://cdn-lfs.hf.co/x', HOSTS).hostname).toBe('cdn-lfs.hf.co')
  })

  it('recusa HTTP, host de fora, parecido com o permitido, usuário e senha e endereço inválido', () => {
    expect(() => assertAllowedUrl('http://huggingface.co/x', HOSTS)).toThrow(/HTTPS/)
    expect(() => assertAllowedUrl('https://evil.example/x', HOSTS)).toThrow(/fora da lista/)
    expect(() => assertAllowedUrl('https://evilhf.co/x', HOSTS)).toThrow(/fora da lista/)
    expect(() => assertAllowedUrl('https://huggingface.co.evil.example/x', HOSTS)).toThrow(/fora da lista/)
    expect(() => assertAllowedUrl('https://user:pass@huggingface.co/x', HOSTS)).toThrow(/usuário e senha/)
    expect(() => assertAllowedUrl('isto não é uma url', HOSTS)).toThrow(/inválido/)
    expect(() => assertAllowedUrl('file:///C:/Windows/System32/cmd.exe', HOSTS)).toThrow(DownloadError)
  })

  it('o erro de origem não vale a pena tentar de novo', () => {
    try {
      assertAllowedUrl('https://evil.example/x', HOSTS)
      expect.unreachable()
    } catch (err) {
      expect((err as DownloadError).retryable).toBe(false)
    }
  })
})

describe('downloadFile', () => {
  it('baixa, confere tamanho e SHA-256 e entrega o progresso até o total', async () => {
    const dir = tmp()
    const { impl, calls } = fakeFetch(() => bytesResponse(DATA))
    const seen: number[] = []
    const size = await downloadFile(spec(dir), { fetchImpl: impl, ...fast, onProgress: (p) => seen.push(p.received) })
    expect(size).toBe(DATA.length)
    expect(readFileSync(join(dir, 'model.bin')).equals(DATA)).toBe(true)
    expect(existsSync(join(dir, 'model.bin.part'))).toBe(false)
    expect(seen.at(-1)).toBe(DATA.length)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.redirect).toBe('manual') // os redirecionamentos são conferidos à mão
    expect(calls[0]!.range).toBeUndefined()
    expect(await sha256File(join(dir, 'model.bin'))).toBe(SHA)
  })

  it('a rede cai no meio: a nova tentativa RETOMA do que já chegou (Range) e conclui', async () => {
    const dir = tmp()
    const half = 120_000
    const { impl, calls } = fakeFetch((call, n) => {
      if (n === 1) return droppingResponse(DATA.subarray(0, half), DATA.length)
      expect(call.range).toBe(`bytes=${half}-`)
      return bytesResponse(DATA.subarray(half), 206)
    })
    const notes: string[] = []
    await downloadFile(spec(dir), { fetchImpl: impl, ...fast, onNote: (m) => notes.push(m) })
    expect(calls).toHaveLength(2)
    expect(readFileSync(join(dir, 'model.bin')).equals(DATA)).toBe(true)
    expect(notes.join(' ')).toMatch(/Tentando de novo/)
  })

  it('o que ficou no .part de uma execução anterior também é retomado', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'model.bin.part'), DATA.subarray(0, 50_000))
    const { impl, calls } = fakeFetch(() => bytesResponse(DATA.subarray(50_000), 206))
    await downloadFile(spec(dir), { fetchImpl: impl, ...fast })
    expect(calls[0]!.range).toBe('bytes=50000-')
    expect(readFileSync(join(dir, 'model.bin')).equals(DATA)).toBe(true)
  })

  it('servidor que ignora o Range (200 com o arquivo inteiro): recomeça do zero, sem corromper', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'model.bin.part'), randomBytes(70_000))
    const { impl } = fakeFetch(() => bytesResponse(DATA, 200))
    await downloadFile(spec(dir), { fetchImpl: impl, ...fast })
    expect(readFileSync(join(dir, 'model.bin')).equals(DATA)).toBe(true)
  })

  it('o .part já está inteiro (416): só confere e entrega', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'model.bin.part'), DATA)
    const { impl } = fakeFetch(() => new Response(null, { status: 416 }))
    await downloadFile(spec(dir), { fetchImpl: impl, ...fast })
    expect(readFileSync(join(dir, 'model.bin')).equals(DATA)).toBe(true)
  })

  it('já está pronto e confere: não toca na rede', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'model.bin'), DATA)
    const { impl, calls } = fakeFetch(() => bytesResponse(DATA))
    await downloadFile(spec(dir), { fetchImpl: impl, ...fast })
    expect(calls).toHaveLength(0)
  })

  it('SHA-256 que não confere: apaga tudo e falha sem tentar de novo', async () => {
    const dir = tmp()
    const { impl, calls } = fakeFetch(() => bytesResponse(DATA))
    const err = await downloadFile(spec(dir, { sha256: 'a'.repeat(64) }), { fetchImpl: impl, ...fast }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DownloadError)
    expect((err as DownloadError).retryable).toBe(false)
    expect((err as DownloadError).message).toMatch(/não confere/)
    expect(calls).toHaveLength(1)
    expect(existsSync(join(dir, 'model.bin'))).toBe(false)
    expect(existsSync(join(dir, 'model.bin.part'))).toBe(false)
  })

  it('arquivo maior que o esperado: apaga o que veio e tenta de novo', async () => {
    const dir = tmp()
    const { impl, calls } = fakeFetch((_c, n) => (n === 1 ? bytesResponse(Buffer.concat([DATA, Buffer.from('lixo')])) : bytesResponse(DATA)))
    await downloadFile(spec(dir), { fetchImpl: impl, ...fast })
    expect(calls).toHaveLength(2)
    expect(readFileSync(join(dir, 'model.bin')).equals(DATA)).toBe(true)
  })

  it('parou antes do fim e sem tentativas sobrando: erro visível com os números, e o .part fica para retomar', async () => {
    const dir = tmp()
    const { impl } = fakeFetch(() => bytesResponse(DATA.subarray(0, 1000)))
    const err = await downloadFile(spec(dir), { fetchImpl: impl, attempts: 1 }).catch((e: unknown) => e)
    expect((err as DownloadError).message).toMatch(/parou em 1000 de 300000 bytes/)
    expect(existsSync(join(dir, 'model.bin.part'))).toBe(true)
    expect(existsSync(join(dir, 'model.bin'))).toBe(false)
  })

  it('redirecionamento para fora da lista derruba o download antes de baixar qualquer coisa', async () => {
    const dir = tmp()
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/model.bin' } }))
    const err = await downloadFile(spec(dir), { fetchImpl: impl, ...fast }).catch((e: unknown) => e)
    expect((err as DownloadError).message).toMatch(/fora da lista/)
    expect((err as DownloadError).retryable).toBe(false)
    expect(calls).toHaveLength(1) // não chegou a pedir o endereço de fora
  })

  it('redirecionamento para http também é recusado', async () => {
    const dir = tmp()
    const { impl } = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'http://huggingface.co/model.bin' } }))
    await expect(downloadFile(spec(dir), { fetchImpl: impl, ...fast })).rejects.toThrow(/HTTPS/)
  })

  it('segue redirecionamento para um subdomínio permitido (relativo ou absoluto), mantendo o Range', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'model.bin.part'), DATA.subarray(0, 1000))
    const { impl, calls } = fakeFetch((call, n) => {
      if (n === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn-lfs.hf.co/blob/xyz' } })
      if (n === 2) return new Response(null, { status: 307, headers: { location: '/outro/caminho' } })
      expect(call.url).toBe('https://cdn-lfs.hf.co/outro/caminho')
      return bytesResponse(DATA.subarray(1000), 206)
    })
    await downloadFile(spec(dir), { fetchImpl: impl, ...fast })
    expect(calls.map((c) => c.range)).toEqual(['bytes=1000-', 'bytes=1000-', 'bytes=1000-'])
    expect(readFileSync(join(dir, 'model.bin')).equals(DATA)).toBe(true)
  })

  it('redirecionamento sem fim é cortado', async () => {
    const dir = tmp()
    const { impl, calls } = fakeFetch(() => new Response(null, { status: 302, headers: { location: URL_OK } }))
    await expect(downloadFile(spec(dir), { fetchImpl: impl, attempts: 1 })).rejects.toThrow(/Redirecionamentos demais/)
    expect(calls.length).toBeLessThanOrEqual(7)
  })

  it('404 não adianta tentar de novo; 503 tenta até esgotar e o erro diz qual foi', async () => {
    const dir = tmp()
    const notFound = fakeFetch(() => new Response('nada', { status: 404 }))
    const e1 = await downloadFile(spec(dir), { fetchImpl: notFound.impl, ...fast }).catch((e: unknown) => e)
    expect((e1 as DownloadError).retryable).toBe(false)
    expect(notFound.calls).toHaveLength(1)
    expect((e1 as DownloadError).message).toMatch(/404/)

    const down = fakeFetch(() => new Response('indisponível', { status: 503 }))
    const e2 = await downloadFile(spec(dir), { fetchImpl: down.impl, attempts: 3, ...fast }).catch((e: unknown) => e)
    expect(down.calls).toHaveLength(3)
    expect((e2 as DownloadError).retryable).toBe(true)
    expect((e2 as DownloadError).message).toMatch(/503/)
  })

  it('falha de rede (fetch lança) é retentável e o motivo aparece', async () => {
    const dir = tmp()
    const { impl, calls } = fakeFetch((_c, n) => {
      if (n === 1) throw new Error('getaddrinfo ENOTFOUND huggingface.co')
      return bytesResponse(DATA)
    })
    await downloadFile(spec(dir), { fetchImpl: impl, ...fast })
    expect(calls).toHaveLength(2)
    const dir2 = tmp()
    const bad = fakeFetch(() => {
      throw new Error('getaddrinfo ENOTFOUND huggingface.co')
    })
    await expect(downloadFile(spec(dir2), { fetchImpl: bad.impl, attempts: 2, ...fast })).rejects.toThrow(/Não consegui falar com huggingface.co: getaddrinfo ENOTFOUND/)
  })

  it('cancelar interrompe, diz "Cancelado." e deixa o .part para retomar', async () => {
    const dir = tmp()
    const ctl = new AbortController()
    let sent = false
    const { impl } = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (!sent) {
                sent = true
                controller.enqueue(DATA.subarray(0, 40_000))
                await new Promise((r) => setTimeout(r, 30))
                ctl.abort()
              }
              await new Promise((r) => setTimeout(r, 1000))
            }
          }),
          { status: 200, headers: { 'content-length': String(DATA.length) } }
        )
    )
    const err = await downloadFile(spec(dir), { fetchImpl: impl, signal: ctl.signal, ...fast }).catch((e: unknown) => e)
    expect((err as DownloadError).message).toBe('Cancelado.')
    expect((err as DownloadError).retryable).toBe(false)
    expect(existsSync(join(dir, 'model.bin'))).toBe(false)
  })

  it('conexão parada (nenhum byte por um tempo) vira erro retentável com o motivo', async () => {
    const dir = tmp()
    const { impl } = fakeFetch(
      () =>
        new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) }), { status: 200, headers: { 'content-length': String(DATA.length) } })
    )
    const err = await downloadFile(spec(dir), { fetchImpl: impl, attempts: 1, idleTimeoutMs: 60 }).catch((e: unknown) => e)
    expect((err as DownloadError).message).toMatch(/parada/)
    expect((err as DownloadError).retryable).toBe(true)
  })

  it('já cancelado antes de começar: nem pede', async () => {
    const dir = tmp()
    const ctl = new AbortController()
    ctl.abort()
    const { impl, calls } = fakeFetch(() => bytesResponse(DATA))
    await expect(downloadFile(spec(dir), { fetchImpl: impl, signal: ctl.signal })).rejects.toThrow('Cancelado.')
    expect(calls).toHaveLength(0)
  })
})
