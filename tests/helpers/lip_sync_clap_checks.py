import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location('sync', Path(__file__).parents[2] / 'resources/lip_sync.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

def hands_frames(contact=1., head_only=False, flash=False, low_face=False):
    frames = np.zeros((180, 90, 160, 3), dtype=np.uint8)
    for index, frame in enumerate(frames):
        time = index / 100
        skin = [140, 170, 220] # BGR; duas regiões com cor de pele, abaixo do rosto.
        if low_face: frame[36:65, 65:95] = skin
        else: frame[4:29, 65:95] = skin
        if flash and abs(time - contact) < .02: frame[:] = 255
        if head_only:
            if abs(time - contact) < .1:
                if low_face: frame[36:65, 60:90] = skin
                else: frame[4:29, 60:90] = skin
            continue
        spread = round(35 * min(1, abs(time - contact) / .15))
        left, right = 62 - spread, 80 + spread
        top, bottom = (69, 85) if low_face else (47, 72)
        frame[top:bottom, left:left + 18] = skin
        frame[top:bottom, right:right + 18] = skin
    return frames

def soft(low, high, axis, edge=1.4):
    return np.clip((axis - low) / edge + .5, 0, 1) * np.clip((high - axis) / edge + .5, 0, 1)

def skin_room(width=240, height=135):
    """Quarto sem nada de pele "separável": parede e piso claros, porta de madeira e rosto da MESMA família de cor."""
    base = np.zeros((height, width, 3), np.float32)
    base[:] = (152, 176, 214)                                  # BGR: parede cor de pele
    columns, rows = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    base += (columns[..., None] / width - .5) * np.array([6, 8, 10], np.float32)
    base[:int(height * .62), int(width * .78):] = (118, 150, 196)  # porta
    face = ((columns - width * .5) / (width * .09)) ** 2 + ((rows - height * .27) / (height * .17)) ** 2 < 1
    base[face] = (140, 165, 208)
    base[int(height * .46):, int(width * .30):int(width * .70)] += (-6, -8, -10)  # tronco
    return base, columns, rows

def hand_positions(t, contact, kind, width, speed=.5, recoil=.22, rest=62, hand=34):
    """Esquerda de cada mão no instante t (px; velocidades em px/ms). As mãos se encontram em `contact`."""
    if kind == 'still': return [width / 2 - rest - hand, width / 2 + rest]
    stop = 36. if kind == 'apart' else 0.
    if kind == 'freeze': t = min(t, contact)
    reach = speed * 1000 * (contact - t) if t <= contact else recoil * 1000 * (t - contact)
    distance = min(rest, stop + reach)
    if kind == 'one': return [width / 2 - rest - hand, width / 2 + distance]   # só a mão direita se move
    return [width / 2 - distance - hand, width / 2 + distance]

def room_clip(fps, seed, kind='hands', contact=1.5, start=1., duration=2.4, exposure=.025, jitter=.08, repeat_every_other=False, step_at=None):
    """Quadros e tempos REAIS de uma câmera: ruído, borrão de exposição, fase e intervalo variáveis."""
    width, height = 240, 135
    base, columns, rows = skin_room(width, height)
    axis, vertical = columns[0], soft(height * .56, height * .56 + 44, rows[:, 0])   # a mão é separável: linha × coluna
    rng = np.random.default_rng(seed)
    frames, times, gain = [], [], 1.
    time, count = start + rng.uniform(0, 1 / fps), 0
    while time < duration:
        if repeat_every_other and count % 2:
            frames.append(frames[-1].copy())     # a câmera entrega o mesmo quadro de novo
        else:
            samples = []
            for offset in np.linspace(-exposure, 0, 4):
                image = base.copy()
                for left in hand_positions(time + offset, contact, kind, width):
                    mask = vertical[:, None] * soft(left, left + 34, axis)[None, :]
                    image = image * (1 - mask[..., None]) + np.array((122, 148, 193), np.float32) * mask[..., None]
                samples.append(image)
            gain = float(np.clip(gain + rng.normal(0, .002), .98, 1.02)) * (1.12 if step_at and time >= step_at else 1.)
            frames.append(np.clip(np.mean(samples, axis=0) * gain + rng.normal(0, 1.6, base.shape), 0, 255).astype(np.uint8))
            gain = gain / (1.12 if step_at and time >= step_at else 1.)
        times.append(time)
        time += (1 / fps) * (1 + rng.uniform(-jitter, jitter))
        count += 1
    return np.stack(frames), np.array(times)

FACE = (240 * .5 - 21, 135 * .27 - 23, 42, 46)   # x, y, largura, altura do rosto parado

class RealisticClapChecks(unittest.TestCase):
    """Fundo cor de pele, mão sobre pele, borrão, ruído e de 15 a 60 qps: o que a máscara de cor não via."""
    def measure(self, fps, seed, **options):
        frames, times = room_clip(fps, seed, **options)
        return sync.hand_contact(frames, times, 1.5, FACE)

    def test_contact_found_from_15_to_60_fps_on_skin_coloured_walls(self):
        # O quadro mostra o contato ~meia exposição depois do instante físico; vale o instante em tempo de quadro.
        for fps, seeds, enough in [(60, range(1, 5), 4), (30, range(1, 7), 6), (24, range(1, 5), 4), (15, range(1, 9), 3)]:
            found = [self.measure(fps, seed) for seed in seeds]
            errors = [(found_one['time'] - 1.5) * 1000 for found_one in found if 'time' in found_one]
            self.assertGreaterEqual(len(errors), enough, f'{fps} qps: achou {len(errors)} de {len(found)}')
            for error in errors:   # nunca uma medida errada: no máximo o intervalo entre quadros, mesmo quando falta quadro
                self.assertLessEqual(abs(error), 1000 / fps + 5, f'{fps} qps: erro {error:.0f} ms')
            for result in found:
                self.assertTrue('time' in result or result['reason'] in ('none', 'slow'), result)

    def test_stale_repeated_frames_from_a_half_rate_camera_are_skipped(self):
        # 30 qps entregues, 15 reais: metade dos quadros é cópia exata do anterior.
        errors = []
        for seed in range(1, 6):
            result = self.measure(30, seed, repeat_every_other=True)
            if 'time' in result: errors.append((result['time'] - 1.5) * 1000)
        self.assertGreaterEqual(len(errors), 3)
        self.assertTrue(all(abs(error) <= 75 for error in errors), errors)

    def test_global_exposure_step_during_the_clap_does_not_hide_or_fake_it(self):
        result = self.measure(30, 3, step_at=1.43)   # a câmera clareia a imagem inteira em 12% no meio da aproximação
        self.assertTrue('time' in result and abs(result['time'] - 1.5) < .04, result)

    def test_hands_that_never_meet_stay_still_or_stick_together_are_rejected(self):
        for kind in ('still', 'apart', 'freeze', 'one'):
            for fps in (15, 30, 60):
                for seed in ((1, 2) if fps == 15 else (1,)):
                    result = self.measure(fps, seed, kind=kind)
                    self.assertNotIn('time', result, f'{kind} {fps} qps seed {seed}: {result}')

    def test_too_few_frames_per_second_is_reported(self):
        frames, times = room_clip(30, 1)
        self.assertEqual(sync.hand_contact(frames[::4], times[::4], 1.5, FACE).get('reason'), 'slow')

    def test_hand_motion_far_from_the_clap_is_not_the_clap(self):
        # O mesmo gesto, mas 1,2 s antes da palma do áudio: fora da janela, não pode virar offset de -1,2 s.
        frames, times = room_clip(30, 2, contact=1.1, start=.4, duration=2.6)
        self.assertNotIn('time', sync.hand_contact(frames, times, 1.9, FACE))

class ClapChecks(unittest.TestCase):
    def test_two_regions_converge_contact_and_separate(self):
        for offset in [0., .08, -.08]:
            self.assertAlmostEqual(sync.visual_hand_contact(hands_frames(1 + offset), 1.), 1 + offset, delta=.01)
    def test_low_stable_face_does_not_block_the_converging_pair(self):
        for offset in [0., .08, -.08]:
            self.assertAlmostEqual(sync.visual_hand_contact(hands_frames(1 + offset, low_face=True), 1.), 1 + offset, delta=.01)
    def test_low_head_without_hands_is_rejected(self):
        self.assertIsNone(sync.visual_hand_contact(hands_frames(head_only=True, low_face=True), 1.))
    def test_head_movement_and_global_flash_are_rejected(self):
        self.assertIsNone(sync.visual_hand_contact(hands_frames(head_only=True), 1.))
        self.assertIsNone(sync.visual_hand_contact(hands_frames(head_only=True, flash=True), 1.))
    def test_no_recoil_or_no_convergence_is_ambiguous(self):
        frames = hands_frames()
        frames[101:] = frames[100]
        self.assertIsNone(sync.visual_hand_contact(frames, 1.))
    def test_single_short_clap_required(self):
        one = np.zeros(240000)
        one[48000:48144] = 20000
        self.assertAlmostEqual(sync.single_clap_time(one), 1., delta=.002)
        one[96000:96144] = 15000
        self.assertIsNone(sync.single_clap_time(one))
        self.assertIsNone(sync.single_clap_time(np.zeros(240000)))

if __name__ == '__main__': unittest.main()
