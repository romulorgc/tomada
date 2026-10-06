/**
 * Utilidades de arquivo. Sem Electron: roda igual no app e nos testes.
 */
import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Grava um arquivo de forma atômica: escreve num temporário ao lado, força para o
 * disco e renomeia por cima. Quem lê vê sempre o arquivo antigo inteiro ou o novo
 * inteiro, nunca um meio-termo (queda de energia, fechar no meio da gravação).
 * No Windows o rename pode falhar por instantes (antivírus, indexador): tenta de novo.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let created = false
  try {
    // 'wx': só cria; um nome que já exista (plantado, por exemplo) nunca é escrito por dentro, nem apagado no erro
    const handle = await open(tmp, 'wx')
    created = true
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    let lastError: unknown
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await rename(tmp, file)
        return
      } catch (err) {
        lastError = err
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
        await sleep(40 * (attempt + 1))
      }
    }
    throw lastError
  } catch (err) {
    if (created) await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK)
    return true
  } catch {
    return false
  }
}
