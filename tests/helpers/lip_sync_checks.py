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


if __name__ == "__main__":
    unittest.main()
