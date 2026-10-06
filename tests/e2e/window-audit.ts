import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { test } from '@playwright/test'
import { ROOT } from '../helpers/fs'

type AuditReport = {
  sampleCount: number
  windowCount: number
  electronRoots: number[]
  visibleWindows: unknown[]
  showEvents: unknown[]
  errors: string[]
}

let sequence = 0
/** Inicia ANTES do launch: cobre criação, carregamento, auxiliares, exportação e encerramento. */
export async function startWindowAudit(): Promise<null | { output: string; stop(): Promise<void> }> {
  if (process.env.TOMADA_E2E_HIDDEN !== '1' || process.platform !== 'win32') return null
  const dir = join(ROOT, 'test-results', 'acabamento')
  mkdirSync(dir, { recursive: true })
  const output = join(dir, `janelas-${Date.now()}-${process.pid}-${++sequence}.json`)
  const worker = new Worker(join(ROOT, 'tests', 'helpers', 'window-audit-worker.cjs'), { workerData: { rootPid: process.pid, output, test: test.info().titlePath.join(' > ') } })
  let failure: Error | undefined
  worker.on('error', (error) => { failure = error })
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
  let stopped: Promise<void> | undefined
  return {
    output,
    stop() {
      // Alguns specs fecham para reabrir com a mesma base; se a reabertura falhar,
      // afterEach fecha de novo a referência antiga. Não poste num worker encerrado.
      return stopped ??= (async () => {
        if (failure) throw failure
        const report = await new Promise<AuditReport>((resolve, reject) => {
          worker.once('message', (message: { report: AuditReport }) => resolve(message.report))
          worker.once('error', reject)
          worker.postMessage('stop')
        })
        await worker.terminate()
        if (report.errors.length || report.visibleWindows.length || report.showEvents.length) {
          throw new Error(`Auditoria de janelas ocultas falhou: ${report.visibleWindows.length} janelas visíveis, ${report.showEvents.length} eventos de exibição, ${report.errors.join('; ')}. Registro: ${output}`)
        }
        if (!report.sampleCount || !report.electronRoots.length || !report.windowCount) throw new Error(`Auditoria não encontrou janelas do Electron: ${output}`)
      })()
    }
  }
}
