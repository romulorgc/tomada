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
        self.fh.write(b"x")
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


if __name__ == "__main__":
    unittest.main()
