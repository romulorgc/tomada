/**
 * `runProcess` ao cancelar ou estourar o tempo encerra a ÁRVORE inteira (o filho e os netos) e só rejeita DEPOIS que tudo fechou.
 * É o que protege a limpeza do arquivo parcial da máscara: o Python abre o ffmpeg, e um ffmpeg órfão seguiria com o parcial aberto
 * (no Windows o arquivo não se apaga) enquanto o app já diria "cancelado".
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProcessError, runProcess } from '../../src/main/process-runner'
import { useTmpDir } from '../helpers/env'

const tmp = useTmpDir()

/**
 * O filho abre um neto (que segura um arquivo ABERTO para escrita, como o ffmpeg com o parcial) e fica vivo. O neto sai DESTACADO do
 * objeto de trabalho do Node: é o que o Python faz ao abrir o ffmpeg (CreateProcess comum), e o motivo de o ffmpeg sobreviver à morte
 * do Python. (Sem `detached` o libuv amarra os netos ao pai e eles morrem junto, o que esconderia o defeito.)
 */
const CHILD = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const dir = process.argv[2]
const grand = spawn(process.execPath, [dir + '/neto.js', dir], { stdio: 'ignore', detached: true })
grand.unref()
fs.writeFileSync(dir + '/neto.pid', String(grand.pid))
setInterval(() => {}, 1000)
`
const GRANDCHILD = `
const fs = require('node:fs')
const dir = process.argv[2]
const fd = fs.openSync(dir + '/parcial.mp4', 'w')
fs.writeSync(fd, 'pela metade')
fs.writeFileSync(dir + '/neto.pronto', '1')
setInterval(() => {}, 1000)
`

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const limit = Date.now() + ms
  while (!ok()) {
    if (Date.now() > limit) throw new Error(`esperei em vão: ${what}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

function setup() {
  const dir = tmp()
  writeFileSync(join(dir, 'filho.js'), CHILD)
  writeFileSync(join(dir, 'neto.js'), GRANDCHILD)
  const pidOf = (): number => Number(readFileSync(join(dir, 'neto.pid'), 'utf8'))
  return { dir, pidOf, ready: () => existsSync(join(dir, 'neto.pronto')) }
}

describe('runProcess: cancelar e estourar o tempo encerram a árvore e esperam', () => {
  it('cancelar: o neto morre, o arquivo que ele segurava aberto pode ser apagado na hora, e o erro é "cancelado"', async () => {
    const { dir, pidOf, ready } = setup()
    const ctl = new AbortController()
    const running = runProcess(process.execPath, [join(dir, 'filho.js'), dir], { signal: ctl.signal })
    const settled = running.then(
      () => null,
      (err: unknown) => err
    )
    await until('o neto abrir o arquivo', ready)
    const grand = pidOf()
    expect(alive(grand)).toBe(true)
    ctl.abort()
    const err = await settled
    expect(err).toBeInstanceOf(ProcessError)
    expect((err as ProcessError).reason).toBe('cancelled')
    try {
      // quando o cancelamento chega a quem pediu, a árvore já acabou: apagar o parcial NÃO precisa de nova tentativa
      expect(() => rmSync(join(dir, 'parcial.mp4'))).not.toThrow()
      await until('o neto sumir', () => !alive(grand), 3000)
    } finally {
      if (alive(grand)) process.kill(grand, 'SIGKILL') // limpa o rastro se o teste falhar
    }
    expect(alive(grand)).toBe(false)
  })

  it('estourar o tempo: mesma coisa, com o motivo "tempo limite"', async () => {
    const { dir, pidOf, ready } = setup()
    const running = runProcess(process.execPath, [join(dir, 'filho.js'), dir], { timeoutMs: 2500 })
    const settled = running.then(
      () => null,
      (err: unknown) => err
    )
    await until('o neto abrir o arquivo', ready)
    const grand = pidOf()
    const err = await settled
    try {
      expect(err).toBeInstanceOf(ProcessError)
      expect((err as ProcessError).reason).toBe('timeout')
      expect(() => rmSync(join(dir, 'parcial.mp4'))).not.toThrow()
      await until('o neto sumir', () => !alive(grand), 3000)
    } finally {
      if (alive(grand)) process.kill(grand, 'SIGKILL')
    }
  })

  it('um programa comum continua igual: devolve a saída e o código de saída 0; falha com código vira "exit"', async () => {
    const ok = await runProcess(process.execPath, ['-e', 'console.log("oi")'])
    expect(ok.stdout.trim()).toBe('oi')
    await expect(runProcess(process.execPath, ['-e', 'process.exit(3)'])).rejects.toMatchObject({ reason: 'exit', exitCode: 3 })
  })

  it('já cancelado antes de começar: rejeita na hora, sem abrir processo', async () => {
    const ctl = new AbortController()
    ctl.abort()
    await expect(runProcess(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { signal: ctl.signal })).rejects.toMatchObject({ reason: 'cancelled' })
  })
})
