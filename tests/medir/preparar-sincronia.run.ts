/** Preparação explícita, local e reproduzível; o detector em uso nunca acessa a rede. */
import { join } from 'node:path'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { it } from 'vitest'
import { ensureToolsDir } from '../../src/main/transcription/tools-dir'
import { runProcess } from '../../src/main/process-runner'
import { ROOT } from '../helpers/fs'

it('prepara os pacotes e os modelos locais da sincronia', async () => {
  const base = ensureToolsDir()
  const python = join(base, 'python', 'Scripts', 'python.exe')
  const wheels = join(base, 'lip-sync', 'wheels')
  await mkdir(wheels, { recursive: true })
  const common = ['-m', 'pip', '--isolated']
  const run = (args: string[]) => runProcess(python, args, { timeoutMs: 900_000, onStdout: (s) => process.stdout.write(s), env: { PYTHONUTF8: '1' } })
  // PyTorch CPU serve somente para converter e conferir o modelo; inferência usa ONNX CUDA.
  await run([...common, 'download', '--only-binary=:all:', '--index-url', 'https://download.pytorch.org/whl/cpu', '--dest', wheels, 'torch==2.6.0'])
  const packages = ['opencv-python-headless==4.11.0.86', 'scipy==1.15.2', 'onnx==1.17.0', 'onnxruntime-gpu==1.22.0',
    'nvidia-cufft-cu12==11.4.1.4', 'nvidia-cuda-runtime-cu12==12.9.79', 'nvidia-nvjitlink-cu12==12.9.86']
  await run([...common, 'download', '--only-binary=:all:', '--index-url', 'https://pypi.org/simple', '--dest', wheels, ...packages])
  await run([...common, 'install', '--no-index', '--find-links', wheels, 'torch==2.6.0', ...packages])
  const bytes = (await Promise.all((await readdir(wheels)).map(async (name) => (await stat(join(wheels, name))).size))).reduce((a, b) => a + b, 0)
  console.log(`[S1 preparação] rodas guardadas: ${bytes} bytes`)
  const result = await runProcess(python, [join(ROOT, 'resources', 'prepare_lip_sync.py')], {
    stdin: JSON.stringify({ base }), timeoutMs: 300_000, env: { PYTHONUTF8: '1' }
  })
  console.log(`[S1 preparação] ${result.stdout.trim()}`)
}, 1_200_000)
