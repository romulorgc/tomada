"""Prepara SyncNet MIT em ONNX; roda apenas pelo comando de preparação do app."""
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

MODEL_SHA256 = "961e8696f888fce4f3f3a6c3d5b3267cf5b343100b238e79b2659bff2c605442"
MODEL_URL = "https://www.robots.ox.ac.uk/~vgg/software/lipsync/data/syncnet_v2.model"
ASSETS = [
    ("yunet.onnx", "https://media.githubusercontent.com/media/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
     "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"),
    ("example.avi", "https://www.robots.ox.ac.uk/~vgg/software/lipsync/data/example.avi",
     "1724121b3a50141cfc9e77c034f7de914024d015b92762ae12d3e1a7151b8621")
]
MODEL_MAX_BYTES = 64 * 1024 * 1024
ASSET_MAX_BYTES = 16 * 1024 * 1024


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # Rejeita antes de urllib abrir a URL do próximo hop.
        raise RuntimeError("Redirecionamento não aprovado para a sincronia.")


def download_asset(url, path, digest, max_bytes):
    if url not in {MODEL_URL, *(asset[1] for asset in ASSETS)} or not url.startswith("https://"):
        raise ValueError("URL não aprovada para a sincronia.")
    partial = path.with_suffix(".part")
    received = 0
    checksum = hashlib.sha256()
    try:
        opener = urllib.request.build_opener(NoRedirectHandler())
        with opener.open(url, timeout=120) as response:
            length = response.headers.get("Content-Length")
            if length and int(length) > max_bytes:
                raise RuntimeError("Arquivo de sincronia ultrapassa o limite de bytes.")
            with partial.open("wb") as output:
                while chunk := response.read(min(1024 * 1024, max_bytes - received + 1)):
                    received += len(chunk)
                    if received > max_bytes:
                        raise RuntimeError("Arquivo de sincronia ultrapassa o limite de bytes.")
                    output.write(chunk)
                    checksum.update(chunk)
        if checksum.hexdigest() != digest:
            raise RuntimeError("Arquivo de sincronia não passou na conferência SHA-256.")
        partial.replace(path)
        return received
    finally:
        partial.unlink(missing_ok=True)


def verify_asset(path, digest, max_bytes):
    if path.stat().st_size > max_bytes:
        raise RuntimeError("Arquivo de sincronia ultrapassa o limite de bytes.")
    with path.open("rb") as source:
        checksum = hashlib.file_digest(source, "sha256").hexdigest()
    if checksum != digest:
        raise RuntimeError("Arquivo de sincronia corrompido; prepare de novo.")


def prepare(base):
    import torch
    import onnxruntime as ort
    import numpy as np
    sys.path.insert(0, str(Path(__file__).parent / "vendor" / "syncnet"))
    from SyncNetModel import S
    target = Path(base) / "lip-sync"
    target.mkdir(parents=True, exist_ok=True)
    model = target / "syncnet_v2.model"
    downloaded = 0
    if not model.exists():
        downloaded += download_asset(MODEL_URL, model, MODEL_SHA256, MODEL_MAX_BYTES)
    verify_asset(model, MODEL_SHA256, MODEL_MAX_BYTES)
    for name, url, digest in ASSETS:
        path = target / name
        if not path.exists():
            downloaded += download_asset(url, path, digest, ASSET_MAX_BYTES)
        verify_asset(path, digest, ASSET_MAX_BYTES)
    torch.set_num_threads(2)
    network = S().eval()
    network.load_state_dict(torch.load(model, map_location="cpu", weights_only=True))

    class Branch(torch.nn.Module):
        def __init__(self, net, kind):
            super().__init__()
            self.net, self.kind = net, kind

        def forward(self, x):
            return self.net.forward_lip(x) if self.kind == "lip" else self.net.forward_aud(x)

    evidence = []
    torch.manual_seed(1)
    for kind, shape in [("lip", (1, 3, 5, 224, 224)), ("aud", (1, 1, 13, 20))]:
        branch = Branch(network, kind).eval()
        sample = torch.randn(shape)
        out = model.with_suffix(f".{kind}.onnx")
        torch.onnx.export(branch, sample, str(out), input_names=["input"], output_names=["embedding"],
                          dynamic_axes={"input": {0: "batch"}, "embedding": {0: "batch"}}, opset_version=17)
        session = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
        with torch.no_grad():
            expected = branch(sample).numpy()
        actual = session.run(None, {"input": sample.numpy()})[0]
        error = float(np.max(np.abs(expected - actual)))
        if error > .001:
            raise RuntimeError("A conversão ONNX mudou a resposta do detector.")
        evidence.append({"branch": kind, "maxError": error, "sha256": hashlib.sha256(out.read_bytes()).hexdigest(), "bytes": out.stat().st_size})
    result = {"modelBytes": model.stat().st_size, "downloadedBytes": downloaded, "modelSha256": MODEL_SHA256, "onnx": evidence}
    (target / "prepared.json").write_text(json.dumps(result), encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    prepare(json.load(sys.stdin)["base"])
