"""Gabaritos do recorte em PEDACOS (R1): sem rosto, sem voz e sem placa de video. Importa o `camera_tools.py` do app (que so importa
bibliotecas padrao no topo) e prova as regras que a retomada precisa:

  - uma retomada no meio do video produz EXATAMENTE os mesmos instantes que a rodada inteira, a partir do pedaco que faltava;
  - o pedaco so ganha o nome final depois de pronto (nunca existe um `p0003.mp4` pela metade);
  - a mascara nunca e calculada acima de 1080p (nem para uma camera de 4K).
"""
import importlib.util
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("camera_tools", Path(__file__).parents[2] / "resources/camera_tools.py")
tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tools)

RATE = 30.0


def camera_times(seconds, drop_every=0, jitter=0.0):
    """Instantes dos quadros de uma camera de 30 qps; `drop_every` tira um quadro de cada N (taxa variavel)."""
    out = []
    n = int(seconds * RATE)
    for i in range(n):
        if drop_every and i % drop_every == drop_every - 1:
            continue
        out.append(i / RATE + (jitter if i % 2 else 0.0))
    return out


def run_full(times):
    """Rodada inteira: devolve [(slot, quadro)] na ordem em que o sink recebe."""
    got = []
    w = tools.SlotWriter(lambda payload: got.append((w.slot, payload)), RATE, 0.0)
    for i, t in enumerate(times):
        w.push(t, i)
    w.finish()
    return got


def run_resumed(times, first_slot_time):
    """Retomada: so entrega os quadros a partir do instante do aquecimento, com a ancora ligada."""
    got = []
    w = tools.SlotWriter(lambda payload: got.append((w.slot, payload)), RATE, 0.0, anchor=True)
    for i, t in enumerate(times):
        if t < first_slot_time - 0.0005:
            continue
        w.push(t, i)
    w.finish()
    return got


class FakeEncoder:
    """Grava os bytes que recebe num arquivo (sem ffmpeg)."""

    def __init__(self, path):
        self.path = path
        self.fh = open(path, "wb")
        self.frames = 0

    def write(self, payload):
        self.fh.write(payload + b"\n")  # o conteudo de cada instante fica no arquivo (as provas de retomada comparam byte a byte)
        self.frames += 1

    def close(self):
        self.fh.close()

    def kill(self):
        self.fh.close()


class MatteChunkChecks(unittest.TestCase):
    def test_frame_size_never_above_1080p(self):
        for w, h in [(3840, 2160), (4096, 2160), (2560, 1440), (1920, 1080), (1280, 720), (640, 480), (2160, 3840)]:
            ow, oh = tools.matte_frame_size(w, h, 1280)
            self.assertLessEqual(max(ow, oh), 1920, (w, h))
            self.assertLessEqual(min(ow, oh), 1080, (w, h))
            self.assertEqual(ow % 2, 0)
            self.assertEqual(oh % 2, 0)
        # pedir mais que 1080p nao muda nada: o teto e do produto
        ow, oh = tools.matte_frame_size(3840, 2160, 4000)
        self.assertLessEqual(max(ow, oh), 1920)
        self.assertEqual(tools.matte_frame_size(3840, 2160, 1280), (1280, 720))
        # nunca amplia
        self.assertEqual(tools.matte_frame_size(640, 360, 1280), (640, 360))

    def test_resume_matches_full_run_from_the_chunk_that_was_missing(self):
        times = camera_times(30.0, drop_every=7, jitter=0.004)
        chunk_slots = 90  # 3 s
        full = run_full(times)
        for start_chunk in (1, 2, 5, 9):
            warmup = 1.0
            first_slot_time = max(0.0, start_chunk * chunk_slots / RATE - warmup)
            resumed = run_resumed(times, first_slot_time)
            want = [(s, p) for s, p in full if s >= start_chunk * chunk_slots]
            got = [(s, p) for s, p in resumed if s >= start_chunk * chunk_slots]
            self.assertEqual(got, want, "retomada no pedaco %d" % start_chunk)
            # nenhum instante repetido nem fora de ordem
            slots = [s for s, _ in resumed]
            self.assertEqual(slots, sorted(set(slots)))

    def test_resume_at_the_end_has_nothing_left(self):
        times = camera_times(10.0)
        full = run_full(times)
        total = len(full)
        chunk_slots = 100
        last_chunk = (total - 1) // chunk_slots
        beyond = last_chunk + 1
        resumed = run_resumed(times, max(0.0, beyond * chunk_slots / RATE - 1.0))
        self.assertEqual([s for s, _ in resumed if s >= beyond * chunk_slots], [])

    def test_parts_only_get_the_final_name_when_renamed_and_boundaries_are_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            events = []

            def make_encoder(path):
                # enquanto o pedaco esta sendo gravado, so existe o .tmp
                self.assertTrue(path.endswith(".tmp"))
                return FakeEncoder(path)

            sink = tools.PartsSink(make_encoder, tmp, 10, 0, lambda i, n, size: events.append((i, n, size)))
            for slot in range(25):
                sink(b"q", slot)
                names = sorted(os.listdir(tmp))
                if slot == 9:
                    # o primeiro pedaco fechou NA HORA (nao espera o seguinte comecar) e ja tem o nome final
                    self.assertIn("p0000.mp4", names)
                    self.assertNotIn("p0000.mp4.tmp", names)
                if slot == 14:
                    self.assertIn("p0001.mp4.tmp", names)
                    self.assertNotIn("p0001.mp4", names)
            sink.finish()
            self.assertEqual([e[:2] for e in events], [(0, 10), (1, 10), (2, 5)])
            self.assertEqual(sorted(os.listdir(tmp)), ["p0000.mp4", "p0001.mp4", "p0002.mp4"])
            self.assertEqual(list(sink.completed), [(0, 10), (1, 10), (2, 5)])

    def test_parts_skip_the_slots_before_the_first_missing_chunk(self):
        with tempfile.TemporaryDirectory() as tmp:
            events = []
            sink = tools.PartsSink(lambda path: FakeEncoder(path), tmp, 10, 2, lambda i, n, size: events.append((i, n)))
            for slot in range(15, 33):  # o aquecimento comeca no meio do pedaco 1 (descartado) e segue pelos pedacos 2 e 3
                sink(b"q", slot)
            sink.finish()
            self.assertEqual(events, [(2, 10), (3, 3)])
            self.assertEqual(sorted(os.listdir(tmp)), ["p0002.mp4", "p0003.mp4"])

    def test_abort_leaves_only_a_tmp_file_never_a_final_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            sink = tools.PartsSink(lambda path: FakeEncoder(path), tmp, 10, 0, lambda *a: None)
            for slot in range(13):
                sink(b"q", slot)
            sink.abort()
            self.assertEqual(sorted(os.listdir(tmp)), ["p0000.mp4", "p0001.mp4.tmp"])


class BackgroundBehaviour(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "prioridade do Windows")
    def test_lower_priority_puts_the_process_below_normal(self):
        code = """
import ctypes, importlib.util, sys
spec = importlib.util.spec_from_file_location('camera_tools', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
k = ctypes.windll.kernel32
k.GetCurrentProcess.restype = ctypes.c_void_p
k.GetPriorityClass.argtypes = [ctypes.c_void_p]
before = k.GetPriorityClass(k.GetCurrentProcess())
m._lower_priority()
print(before, k.GetPriorityClass(k.GetCurrentProcess()))
"""
        script = str(Path(__file__).parents[2] / "resources/camera_tools.py")
        out = subprocess.run([sys.executable, "-c", code, script], capture_output=True, text=True, timeout=30).stdout.split()
        self.assertEqual(out[1], str(0x4000), out)  # BELOW_NORMAL_PRIORITY_CLASS

    def test_worker_dies_when_its_parent_app_dies(self):
        # o "app" (pai) morre sem avisar: o Python do recorte (neto) se encerra sozinho, sem ficar escrevendo na pasta do projeto
        parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        script = str(Path(__file__).parents[2] / "resources/camera_tools.py")
        code = """
import importlib.util, sys, time
spec = importlib.util.spec_from_file_location('camera_tools', sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m._watch_parent(int(sys.argv[2]))
time.sleep(120)
"""
        child = subprocess.Popen([sys.executable, "-c", code, script, str(parent.pid)])
        try:
            time.sleep(2.0)
            self.assertIsNone(child.poll(), "o trabalhador não pode sair enquanto o app vive")
            parent.kill()
            parent.wait(timeout=10)
            deadline = time.time() + 6.0
            while child.poll() is None and time.time() < deadline:
                time.sleep(0.1)
            self.assertEqual(child.poll(), 4, "o trabalhador deveria ter saído sozinho com código 4")
        finally:
            for p in (child, parent):
                if p.poll() is None:
                    p.kill()


class Pipeline:
    """O laço do recorte inteiro (SlotWriter + pedaços + pontos de retomada) com um "RVM" de brinquedo que TEM MEMÓRIA longa: o estado de cada
    quadro depende de todos os anteriores. Prova que uma retomada pelo ponto guardado dá EXATAMENTE a mesma máscara da rodada contínua."""

    CHUNK_SLOTS = 30

    def __init__(self, tmp, times):
        import numpy as np

        self.np = np
        self.dir = tmp
        self.times = times
        self.meta = {"outW": 8, "outH": 8, "ratio": 0.5, "fps": RATE, "chunkSlots": self.CHUNK_SLOTS, "model": 1}

    def initial_state(self):
        return [self.np.zeros(1, dtype=self.np.float64) for _ in range(4)]

    @staticmethod
    def infer(frame, state):
        # o estado de cada camada mistura o quadro de agora com TODA a historia (memoria longa, como o GRU do RVM)
        new = [0.97 * s + 0.03 * (frame * (i + 1)) for i, s in enumerate(state)]
        return ("%.9f" % float(new[0][0])).encode(), new

    def run(self, start_chunk=0, stop_after=None, use_checkpoint=True, warmup=1.0):
        np = self.np
        stop_file = os.path.join(self.dir, "parar")
        ck = tools.Checkpointer(self.dir, self.CHUNK_SLOTS, start_chunk, self.meta, np, lambda s: s)

        def on_chunk(index, frames, size):
            ck.drop(index)
            if stop_after is not None and index == stop_after:
                open(stop_file, "w").close()

        sink = tools.PartsSink(lambda path: FakeEncoder(path), self.dir, self.CHUNK_SLOTS, start_chunk, on_chunk)
        writer = tools.SlotWriter(lambda payload: sink(payload, writer.slot), RATE, 0.0, anchor=start_chunk > 0)
        state = self.initial_state()
        skip_time = None
        skip_slot = 0
        frames = list(enumerate(self.times))
        mode = None
        if start_chunk > 0:
            saved = ck.load(start_chunk) if use_checkpoint else None
            if saved is not None:
                state = saved["arrays"]
                writer.pending = saved["pending"]
                writer.pending_slot = saved["pending_slot"]
                skip_slot = start_chunk * self.CHUNK_SLOTS
                seek = max(0.0, (skip_slot - 1) / RATE - 1.0)
                mode = "checkpoint"
            else:
                skip_time = max(0.0, (start_chunk * self.CHUNK_SLOTS) / RATE - warmup)
                seek = max(0.0, skip_time - 0.5)
                mode = "warmup"
            frames = [(i, t) for i, t in frames if t >= seek]  # o salto do decodificador: cai um pouco antes
        state, done, stopped = tools.process_frames(
            ((t, float(i)) for i, t in frames), self.infer, state, writer, ck=ck, parts_sink=sink, stop_file=stop_file, skip_before_time=skip_time, skip_before_slot=skip_slot
        )
        if not stopped:
            writer.finish()
            sink.finish()
        else:
            sink.abort()
        return {"stopped": stopped, "done": done, "mode": mode, "chunks": [c[0] for c in sink.completed]}

    def parts(self):
        out = {}
        for name in sorted(os.listdir(self.dir)):
            if name.startswith("p") and name.endswith(".mp4"):
                with open(os.path.join(self.dir, name), "rb") as fh:
                    out[int(name[1:5])] = fh.read()
        return out


class CheckpointChecks(unittest.TestCase):
    def setUp(self):
        self.times = camera_times(12.0, drop_every=9, jitter=0.003)

    def test_resume_from_the_checkpoint_gives_exactly_the_continuous_run(self):
        with tempfile.TemporaryDirectory() as full_dir, tempfile.TemporaryDirectory() as cut_dir:
            full = Pipeline(full_dir, self.times)
            r = full.run()
            self.assertFalse(r["stopped"])
            expected = full.parts()
            self.assertGreaterEqual(len(expected), 5)
            # nada sobra em disco depois de uma rodada inteira: o ponto de cada pedaco e apagado quando ele fecha
            self.assertEqual([n for n in os.listdir(full_dir) if n.endswith(".npz")], [])

            cut = Pipeline(cut_dir, self.times)
            first = cut.run(stop_after=1)  # para no fim do pedaco 1 (pedido de parada)
            self.assertTrue(first["stopped"])
            self.assertEqual(first["chunks"], [0, 1])
            # ficou o ponto de retomada do pedaco 2 (e so ele)
            self.assertEqual([n for n in os.listdir(cut_dir) if n.endswith(".npz")], ["s0002.npz"])
            os.remove(os.path.join(cut_dir, "parar"))

            second = cut.run(start_chunk=2)
            self.assertEqual(second["mode"], "checkpoint")
            self.assertFalse(second["stopped"])
            got = cut.parts()
            self.assertEqual(sorted(got), sorted(expected))
            for index in expected:
                self.assertEqual(got[index], expected[index], "pedaco %d diferente da rodada continua" % index)
            self.assertEqual([n for n in os.listdir(cut_dir) if n.endswith(".npz")], [])

    def test_resume_at_every_chunk_boundary_is_exact(self):
        with tempfile.TemporaryDirectory() as full_dir:
            full = Pipeline(full_dir, self.times)
            full.run()
            expected = full.parts()
        for cut_after in (0, 1, 2, 3):
            with tempfile.TemporaryDirectory() as cut_dir:
                cut = Pipeline(cut_dir, self.times)
                cut.run(stop_after=cut_after)
                os.remove(os.path.join(cut_dir, "parar"))
                cut.run(start_chunk=cut_after + 1)
                self.assertEqual(cut.parts(), expected, "retomada depois do pedaco %d" % cut_after)

    def test_without_the_checkpoint_the_resume_falls_back_to_warmup_and_still_covers_every_slot(self):
        with tempfile.TemporaryDirectory() as full_dir, tempfile.TemporaryDirectory() as cut_dir:
            full = Pipeline(full_dir, self.times)
            full.run()
            expected = full.parts()
            cut = Pipeline(cut_dir, self.times)
            cut.run(stop_after=1)
            os.remove(os.path.join(cut_dir, "parar"))
            os.remove(os.path.join(cut_dir, "s0002.npz"))  # o ponto sumiu
            second = cut.run(start_chunk=2)
            self.assertEqual(second["mode"], "warmup")
            got = cut.parts()
            self.assertEqual(sorted(got), sorted(expected))
            # o aquecimento nao e identico (a memoria longa do estado nao volta), mas cada pedaco tem o mesmo numero de instantes
            for index in expected:
                self.assertEqual(len(got[index].splitlines()), len(expected[index].splitlines()))
            self.assertEqual(got[0], expected[0])
            self.assertEqual(got[1], expected[1])
            self.assertNotEqual(got[2], expected[2])

    def test_a_checkpoint_that_does_not_fit_is_refused(self):
        import numpy as np

        with tempfile.TemporaryDirectory() as tmp:
            p = Pipeline(tmp, self.times)
            p.run(stop_after=0)
            good = tools.Checkpointer(tmp, Pipeline.CHUNK_SLOTS, 0, p.meta, np, lambda s: s)
            self.assertIsNotNone(good.load(1))
            self.assertIsNone(good.load(2))  # nao existe
            other_size = tools.Checkpointer(tmp, Pipeline.CHUNK_SLOTS, 0, dict(p.meta, outW=16), np, lambda s: s)
            self.assertIsNone(other_size.load(1))  # outro tamanho de imagem
            other_chunk = tools.Checkpointer(tmp, Pipeline.CHUNK_SLOTS, 0, dict(p.meta, chunkSlots=60), np, lambda s: s)
            self.assertIsNone(other_chunk.load(1))  # outro tamanho de pedaco
            path = tools.checkpoint_path(tmp, 1)
            with open(path, "rb") as fh:
                data = fh.read()
            with open(path, "wb") as fh:
                fh.write(data[: len(data) // 2])  # pela metade
            self.assertIsNone(good.load(1))
            with open(path, "wb") as fh:
                fh.write(b"isto nao e um npz")
            self.assertIsNone(good.load(1))


if __name__ == "__main__":
    unittest.main()
