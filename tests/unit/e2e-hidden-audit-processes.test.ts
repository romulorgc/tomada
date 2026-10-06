import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, test } from 'vitest'

/** `born` é o instante de criação; ausente = todos nasceram juntos; null = o Windows não deixa abrir o processo. */
type Row = { pid: number; parent: number; exe: string; born?: number | null }
type Entry = { th32ProcessID: number; th32ParentProcessID: number; szExeFile: number[] }
type Result = { targets: number[]; roots: number[] }

// Executa o algoritmo REAL do worker com Toolhelp32 substituído na fronteira.
// Não carrega DLL, não enumera janelas e não cria processo Electron no RED.
const source = ts.createSourceFile('window-audit-worker.cjs', readFileSync(resolve('tests/helpers/window-audit-worker.cjs'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const functions = source.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && ['descendants', 'processTree', 'bornAt'].includes(node.name?.text ?? ''))
if (!['descendants', 'processTree'].every((name) => functions.some((node) => node.name?.text === name))) throw new Error('Não encontrei o algoritmo de árvore do auditor.')
const program = functions.map(node => node.getText(source)).join('\n')

function run(rows: Row[], historicalRoots: number[] = []): Result {
  let index = 0
  function populate(entry: Entry): number {
    const row = rows[index]
    if (!row) return 0
    entry.th32ProcessID = row.pid
    entry.th32ParentProcessID = row.parent
    entry.szExeFile = [...row.exe].map(c => c.charCodeAt(0)).concat(0)
    return 1
  }
  // OpenProcess/GetProcessTimes também ficam na fronteira: o horário de criação vem da linha da tabela falsa.
  const openProcess = (_access: number, _inherit: number, pid: number): number => (rows.find((r) => r.pid === pid)?.born === null ? 0 : pid)
  const processTimes = (pid: number, created: { lo?: number; hi?: number }): number => {
    created.lo = rows.find((r) => r.pid === pid)?.born ?? 1
    created.hi = 0
    return 1
  }
  const select = new Function('snapshot', 'firstProcess', 'nextProcess', 'closeHandle', 'koffi', 'workerData', 'roots', 'processesSeen', 'openProcess', 'processTimes', `const Entry = {}; let targetPids; const birthCache = new Map(); ${program}\nprocessTree(); return { targets: [...targetPids], roots: [...roots] }`)
  return select(() => 1, (_handle: number, entry: Entry) => populate(entry), (_handle: number, entry: Entry) => { index++; return populate(entry) }, () => undefined, { sizeof: () => 1 }, { rootPid: 1000 }, new Set(historicalRoots), new Set(), openProcess, processTimes) as Result
}

test.each(['powershell.exe', 'electron.exe'])('PID antigo reutilizado por %s fora da árvore não vira alvo', (exe) => {
  const selected = run([
    { pid: 1000, parent: 900, exe: 'node.exe' },
    { pid: 2500, parent: 8000, exe },
    { pid: 2501, parent: 2500, exe: 'conhost.exe' }
  ], [2500])
  expect(selected.targets).toEqual([])
  expect(selected.roots).toEqual([2500]) // O histórico segue disponível no relatório.
})

test('uma raiz encerrada não permanece como PID alvo sem processo vivo', () => {
  const selected = run([{ pid: 1000, parent: 900, exe: 'node.exe' }], [2500])
  expect(selected.targets).toEqual([])
  expect(selected.roots).toEqual([2500])
})

test('Electron ativo na árvore e seus descendentes continuam auditados', () => {
  const selected = run([
    { pid: 1000, parent: 900, exe: 'node.exe' },
    { pid: 2000, parent: 1000, exe: 'node.exe' },
    { pid: 2500, parent: 2000, exe: 'ELECTRON.EXE' },
    { pid: 2501, parent: 2500, exe: 'electron.exe' },
    { pid: 2600, parent: 2501, exe: 'ffmpeg.exe' },
    { pid: 8000, parent: 900, exe: 'electron.exe' }
  ], [4000])
  expect(new Set(selected.targets)).toEqual(new Set([2500, 2501, 2600]))
  expect(new Set(selected.roots)).toEqual(new Set([4000, 2500, 2501]))
})

test('pai morto cujo PID voltou a ser de um Electron não adota processos antigos do sistema', () => {
  // Reproduz a bateria real: o campo "pai" de dezenas de processos do sistema aponta para um número que o Electron reutilizou.
  const selected = run([
    { pid: 1000, parent: 900, exe: 'node.exe', born: 10 },
    { pid: 2500, parent: 1000, exe: 'electron.exe', born: 100 },
    { pid: 2501, parent: 2500, exe: 'electron.exe', born: 110 },
    { pid: 984, parent: 2500, exe: 'svchost.exe', born: 3 },
    { pid: 1436, parent: 2500, exe: 'svchost.exe', born: 4 },
    { pid: 1480, parent: 1436, exe: 'TextInputHost.exe', born: 5 }
  ])
  expect(new Set(selected.targets)).toEqual(new Set([2500, 2501]))
})

test('o pai da árvore do runner reutilizado por um processo antigo não puxa o sistema nem um Electron alheio', () => {
  const selected = run([
    { pid: 1000, parent: 900, exe: 'node.exe', born: 50 },
    { pid: 984, parent: 1000, exe: 'svchost.exe', born: 3 },
    { pid: 3000, parent: 984, exe: 'electron.exe', born: 4 },
    { pid: 2500, parent: 1000, exe: 'electron.exe', born: 100 }
  ])
  expect(new Set(selected.targets)).toEqual(new Set([2500]))
  expect(selected.roots).toEqual([2500])
})

test('um processo que o Windows não deixa abrir não é adotado como descendente', () => {
  const selected = run([
    { pid: 1000, parent: 900, exe: 'node.exe', born: 10 },
    { pid: 2500, parent: 1000, exe: 'electron.exe', born: 100 },
    { pid: 2501, parent: 2500, exe: 'electron.exe', born: 110 },
    { pid: 4000, parent: 2500, exe: 'protegido.exe', born: null }
  ])
  expect(new Set(selected.targets)).toEqual(new Set([2500, 2501]))
})
