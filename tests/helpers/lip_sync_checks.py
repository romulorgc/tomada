"""Gabaritos matemáticos sem rosto nem voz do usuário."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec = importlib.util.spec_from_file_location("lip_sync", Path(__file__).parents[2] / "resources/lip_sync.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SyncChecks(unittest.TestCase):
    def test_offset_positive_advances_late_camera(self):
        rng = np.random.default_rng(123)
        sound = rng.normal(size=(180, 32)).astype(np.float32)
        # A imagem chega três quadros depois da voz: +120 ms.
        image = np.concatenate([sound[:3], sound[:-3]])
        result = sync.measure_embeddings(image, sound)
        self.assertAlmostEqual(result["offsetMs"], 120, delta=5)
        self.assertGreater(result["confidence"], 3)

    def test_offset_negative_for_early_camera(self):
        rng = np.random.default_rng(321)
        image = rng.normal(size=(180, 32)).astype(np.float32)
        sound = np.concatenate([image[:2], image[:-2]])
        self.assertAlmostEqual(sync.measure_embeddings(image, sound)["offsetMs"], -80, delta=5)

    def test_no_evidence_is_rejected(self):
        empty = np.ones((100, 32), dtype=np.float32)
        result = sync.measure_embeddings(empty, empty)
        self.assertLess(result["confidence"], 0.01)

    def test_mfcc_is_finite_for_silence_and_has_100_steps_per_second(self):
        features = sync.mfcc(np.zeros(16000, dtype=np.int16))
        self.assertEqual(features.shape, (99, 13))
        self.assertTrue(np.isfinite(features).all())


    def test_digital_silence_and_muted_microphone_never_count_as_speech(self):
        rng = np.random.default_rng(1)
        muted = (rng.normal(size=16000 * 20) * 1.5).astype(np.int16)           # microfone mudo: ruído de ±5, pico de 24
        muted[40000] = 24
        self.assertEqual(int(sync.speech_activity(muted).sum()), 0)
        self.assertEqual(int(sync.speech_activity(np.zeros(16000 * 5, dtype=np.int16)).sum()), 0)
        # O defeito antigo: normalizar o pico a 28000 ANTES de decidir. O RMS de 12 do critério antigo passava fácil...
        loud_noise = muted.astype(float) * (28000 / 24)
        self.assertGreater(float(np.sqrt(np.mean(loud_noise ** 2))), 12)
        # ...e agora o ruído amplificado continua sem sílabas nem pausas: não vira fala.
        self.assertEqual(int(sync.speech_activity(loud_noise).sum()), 0)
        # Chiado estacionário (ventilador, ar-condicionado) também não tem sílabas nem pausas: não é fala, mesmo alto.
        hiss = (rng.normal(size=16000 * 12) * 380).astype(np.int16)
        self.assertEqual(int(sync.speech_activity(hiss).sum()), 0)

    def test_windows_follow_the_fraction_of_speech_not_the_volume_of_clicks(self):
        rng = np.random.default_rng(2)
        audio = (rng.normal(size=16000 * 30) * 2).astype(np.float32)             # piso de ruído baixo
        for start in range(2, 8):                                                # cliques fortíssimos (teclado) entre 2 e 8 s
            audio[start * 16000:start * 16000 + 40] = 20000
        voice = (rng.normal(size=16000 * 6) * 100).astype(np.float32)            # fala a ~ -50 dBFS, contínua de 18 a 24 s
        audio[18 * 16000:24 * 16000] = voice
        active = sync.speech_activity(audio)
        windows = sync.speaking_windows(active)
        self.assertEqual(len(windows), 1)
        self.assertAlmostEqual(windows[0][0], 18, delta=3)                       # nunca a janela dos cliques
        # E sem fala suficiente não inventa janela.
        self.assertEqual(sync.speaking_windows(sync.speech_activity(audio[:16000 * 12])), [])

    def test_gain_follows_the_speech_level_not_the_loudest_click(self):
        audio = np.zeros(16000 * 6, dtype=np.float32) + 1
        audio[16000:3 * 16000] = np.random.default_rng(3).normal(size=32000) * 100
        audio[4 * 16000] = 2037                                                  # um clique de -24 dBFS
        active = sync.speech_activity(audio)
        self.assertAlmostEqual(sync.speech_gain(audio, active), 30, delta=3)     # por pico seria 28000/2037 = 13,7
        self.assertEqual(sync.speech_gain(np.zeros(16000, dtype=np.float32), np.zeros(25, dtype=bool)), 1.)

    def test_mean_only_over_speech_frames_recovers_an_offset_diluted_by_silence(self):
        rng = np.random.default_rng(4)
        count = 180
        sound = rng.normal(size=(count, 32)).astype(np.float32)
        image = np.concatenate([sound[:3], sound[:-3]]).copy()                   # imagem 3 quadros depois (+120 ms)
        speaking = np.zeros(count, dtype=bool)
        speaking[60:110] = True
        image[~speaking] = rng.normal(size=(int((~speaking).sum()), 32)).astype(np.float32)   # silêncio: boca sem relação com o som
        whole = sync.measure_embeddings(image, sound)
        masked = sync.measure_embeddings(image, sound, active=speaking)
        self.assertLess(whole["confidence"], masked["confidence"] / 2)
        self.assertAlmostEqual(masked["offsetMs"], 120, delta=5)
        self.assertEqual(sync.measure_embeddings(image, sound, active=np.arange(count) < 25)["confidence"], 0.)   # menos de 0,8 s de fala


    def test_the_reason_for_a_missing_measurement_says_how_little_speech_there_was(self):
        self.assertIn("Só encontrei 5 s de fala", sync.few_speech(4.6))
        self.assertIn("a partir de 12 s", sync.few_speech(4.6))
        self.assertNotIn("Só encontrei", sync.few_speech(30.))


if __name__ == "__main__":
    unittest.main()
