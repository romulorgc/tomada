import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('prepare_sync', Path(__file__).parents[2] / 'resources/prepare_lip_sync.py')
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)

class Response(io.BytesIO):
    headers = {}
    def __enter__(self): return self
    def __exit__(self, *args): self.close()

class PrepareChecks(unittest.TestCase):
    def test_redirect_is_rejected_before_destination_is_requested(self):
        with self.assertRaisesRegex(RuntimeError, 'Redirecionamento'):
            prepare.NoRedirectHandler().redirect_request(None, None, 302, 'redirect', {}, 'http://127.0.0.1/privado')

    def test_unapproved_url_never_opens_network(self):
        with patch.object(prepare.urllib.request, 'build_opener') as opener:
            with self.assertRaisesRegex(ValueError, 'URL'):
                prepare.download_asset('https://exemplo.invalid/modelo', Path('nao-escrever'), 'hash', 64)
            opener.assert_not_called()

    def test_limit_and_bad_hash_remove_partial(self):
        for data, limit, digest in [(b'abcd', 3, hashlib.sha256(b'abcd').hexdigest()), (b'abc', 3, 'errado')]:
            with tempfile.TemporaryDirectory() as folder, patch.object(prepare.urllib.request, 'build_opener') as opener:
                opener.return_value.open.return_value = Response(data)
                path = Path(folder) / 'modelo'
                with self.assertRaises(RuntimeError):
                    prepare.download_asset(prepare.MODEL_URL, path, digest, limit)
                self.assertFalse(path.exists())
                self.assertEqual(list(Path(folder).iterdir()), [])

    def test_valid_hash_publishes_atomically(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(prepare.urllib.request, 'build_opener') as opener:
            opener.return_value.open.return_value = Response(b'abc')
            path = Path(folder) / 'modelo'
            self.assertEqual(prepare.download_asset(prepare.MODEL_URL, path, hashlib.sha256(b'abc').hexdigest(), 3), 3)
            self.assertEqual(path.read_bytes(), b'abc')

if __name__ == '__main__': unittest.main()
