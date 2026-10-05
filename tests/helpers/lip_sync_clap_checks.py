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
