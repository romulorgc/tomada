<p align="center">
  <img src="resources/tomada.png" alt="Tomada" width="96">
</p>

<h1 align="center">Tomada</h1>

<p align="center">
  Editor de vídeo com IA para Windows. Grave a tela uma vez e receba o vídeo do YouTube
  editado, cortes verticais e o recorte da sua imagem sem fundo, no seu próprio PC.
</p>

<p align="center">
  <a href="README.md">English</a> | Português
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licença: AGPL-3.0" src="https://img.shields.io/badge/licen%C3%A7a-AGPL--3.0-blue"></a>
  <img alt="Plataforma: Windows" src="https://img.shields.io/badge/plataforma-Windows%2010%20%7C%2011-lightgrey">
</p>

*Tomada* é a cena filmada de uma vez, como numa gravação de cinema.

O Tomada usa o Claude Code que você já tem instalado e com login feito no seu computador;
ele nunca pede nem guarda as suas credenciais. Também funciona com uma chave de API da Anthropic.

<!-- demo -->

![O editor do Tomada com a linha do tempo, a escolha de layout e a prévia](assets/readme/editor.png)

## O que acontece quando você para de gravar

Sem nenhum clique, o Tomada processa a gravação, transcreve na sua placa de vídeo, corta
silêncios, muletas e recomeços, põe zoom nos seus cliques, escolhe os layouts, exporta o vídeo
do YouTube, sugere os melhores cortes verticais com legenda e escreve título, descrição,
capítulos e hashtags. Depois você revisa, ajusta e posta. O Tomada não publica nada por você.

## Recursos

**Gravação**
- Tela inteira ou uma janela, com câmera e microfone.
- A posição do cursor e os cliques são registrados a 120 Hz, mais se houve tecla (nunca qual).
- A janela do navegador é gravada só com a página, sem abas e sem barra de endereço.
- Teleprompter fora da gravação e uma tecla "errei" que corta a frase errada.

**Edição**
- Transcrição local com tempo por palavra. Apague uma palavra no texto e o vídeo é cortado.
- Limpeza automática de silêncios, muletas e recomeços, cada uma desfazível.
- Zoom automático nos cliques, layouts que seguem a atividade da tela, legendas em quatro estilos.
- Câmera em bolha, ao lado da tela ou sozinha. O layout apresentador recorta você do fundo,
  no estilo de tela verde, sem precisar de tela verde.
- Desfoque, pixelado ou tarja sólida para dados sensíveis. Os pixels originais não vão para o arquivo exportado.
- O que você muda à mão fica: o automático nunca desfaz.

**Saída**
- YouTube 16:9 em 1080p, 1440p ou 4K, a 30 ou 60 quadros por segundo.
- Cortes verticais 1080x1920 de 30 a 60 segundos, com gancho e legenda.
- Título, descrição com capítulos, tags e hashtags de cada plataforma, prontos para copiar.

**IA (precisa do Claude Code ou de uma chave de API da Anthropic)**
- Escolhe os melhores cortes verticais, tira os recomeços e escreve os textos de publicação.
- "Ajustar pedindo": escreva "corta mais o começo" e a edição é aplicada.

Sem um motor de IA, o Tomada ainda grava, transcreve, limpa e exporta, e você edita à mão.
A edição automática por IA é o coração do produto e precisa de um dos dois.

## Requisitos

- Windows 10 ou 11, 64 bits.
- **Claude Code**, instalado e com login feito na sua própria assinatura Claude (Pro ou Max).
  Como alternativa, uma **chave de API da Anthropic**.
- [ffmpeg](https://ffmpeg.org/) no `PATH`, ou escolhido nos Ajustes.
- Python 3.11 (3.9 a 3.14 são aceitos) para preparar os motores locais de transcrição e de recorte.
  O Tomada cria o próprio ambiente virtual e baixa cerca de 3 GB, uma vez só.
- Placa NVIDIA recomendada: a transcrição e o recorte rodam em CUDA, e a exportação usa
  codificação H.264 por hardware quando há. Sem placa, o Tomada usa o processador e fica mais lento.
- Node.js 22 ou mais novo, para rodar a partir do código.

## Rodar a partir do código

Ainda não há instalador.

```bash
git clone https://github.com/romulorgc/tomada.git
cd tomada
npm ci
npm run build
npm start
```

Na primeira execução, a tela "Prepare o Tomada" confere o ffmpeg, a codificação da placa, a
transcrição, o motor de IA, a câmera e o microfone. Para desenvolver, use `npm run dev`.
Testes: `npm run typecheck`, `npm test` e `npm run test:e2e`. Veja o [CONTRIBUTING.md](CONTRIBUTING.md).

## Como funciona

- **Captura.** Uma thread de trabalho lê o cursor, os botões do mouse e o retângulo da janela
  pela API Win32 (`koffi`), a 120 Hz, com resolução de timer de 1 ms. A voz é gravada em PCM
  bruto ao lado do vídeo.
- **Um só renderizador.** A prévia e a exportação desenham cada quadro com as mesmas funções
  puras num Canvas 2D. A exportação roda numa janela escondida, decodifica com WebCodecs pelo
  `mediabunny` e codifica H.264 por hardware quando há. O bruto nunca é modificado.
- **Fala para texto, local.** `faster-whisper` na placa de vídeo, num ambiente Python próprio,
  com `whisper.cpp` como segundo motor. Nada é enviado.
- **Recorte local.** RobustVideoMatting no ONNX Runtime para o layout apresentador, e um
  detector de rosto para o enquadramento da câmera.
- **IA como texto que entra e texto que sai.** Só o texto da transcrição é enviado. Com o
  Claude Code, o Tomada roda `claude -p` numa pasta de trabalho vazia, sem ferramentas, sem sessão
  salva e com o pedido pelo stdin. Com a chave de API, chama a Messages API por HTTPS e guarda a
  chave cifrada com o `safeStorage` do Electron.
- **Projetos não destrutivos.** Cada gravação é uma pasta com os arquivos brutos e um
  `project.json`. A edição é um documento, então desfazer e "tentar de novo" saem baratos.

## Privacidade

Gravações, transcrições e ajustes ficam no seu PC. O projeto não tem servidor nem telemetria.
Conexões de rede:

- downloads na primeira execução, de pacotes e modelos do PyPI, do Hugging Face e do GitHub;
- pedidos de IA, só quando você usa os recursos de IA: o texto da transcrição vai à Anthropic,
  pelo seu Claude Code ou pela sua chave de API. Áudio e vídeo nunca saem do computador.

## Estado e roteiro

Versão 0.1. Só Windows. A interface está em português do Brasil.

- [ ] Instalador para Windows (`.exe`)
- [ ] Interface em inglês

## Contribuir

Toda mudança entra por pull request e é revisada pelo mantenedor. Quem contribui assina um CLA.
Leia o [CONTRIBUTING.md](CONTRIBUTING.md). Vulnerabilidades devem ser relatadas como descrito no
[SECURITY.md](SECURITY.md).

## Licença

O Tomada é distribuído sob a [GNU Affero General Public License v3.0](LICENSE). Os componentes
de terceiros estão listados em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Há uma licença comercial separada para quem não pode usar os termos da AGPL-3.0. Para pedir,
abra uma issue com o modelo "Commercial license".

## Autor

Criado e mantido por Rômulo Carvalho.
[GitHub @romulorgc](https://github.com/romulorgc) | [X @romulocarvs](https://x.com/romulocarvs)
