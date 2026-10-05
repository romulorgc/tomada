/**
 * TODO texto de interface mora aqui (pt-BR), para dar para traduzir depois.
 * Convenções: frase com inicial maiúscula só no começo; o botão diz o que acontece
 * (e a confirmação repete o mesmo verbo); erro explica o que houve e o que fazer.
 */
export const ptBR = {
  app: { name: 'Tomada', tagline: 'Gravar e editar, tudo neste computador' },

  nav: {
    label: 'Navegação principal',
    library: 'Biblioteca',
    record: 'Gravar',
    settings: 'Ajustes'
  },

  common: {
    cancel: 'Cancelar',
    retry: 'Tentar de novo',
    close: 'Fechar aviso',
    loading: 'Carregando…',
    back: 'Voltar à biblioteca',
    crashed: 'Algo quebrou nesta tela'
  },

  library: {
    title: 'Biblioteca',
    count: (n: number): string => (n === 1 ? '1 gravação' : `${n} gravações`),
    newRecording: 'Nova gravação',
    loadError: 'Não consegui abrir a biblioteca',
    empty: {
      title: 'Nenhuma gravação ainda',
      body: 'Grave a tela e a câmera de uma vez. Tudo fica neste computador, sem enviar nada para lugar nenhum.',
      cta: 'Gravar agora'
    },
    card: {
      open: (title: string): string => `Abrir ${title}`,
      rename: 'Renomear',
      reveal: 'Mostrar na pasta',
      remove: 'Apagar',
      renameLabel: 'Novo título da gravação',
      hasScreen: 'Tem a tela',
      hasCamera: 'Tem a câmera',
      noThumb: 'Sem miniatura'
    },
    notices: {
      renamed: 'Título salvo.',
      removed: 'Gravação apagada. Ela está na Lixeira do Windows.',
      renameFailed: 'Não consegui renomear',
      removeFailed: 'Não consegui apagar',
      revealFailed: 'Não consegui abrir a pasta'
    },
    confirmDelete: {
      title: (name: string): string => `Apagar “${name}”?`,
      body: 'A pasta inteira, com o vídeo bruto e as edições, vai para a Lixeira do Windows. Dá para restaurar de lá.',
      confirm: 'Apagar'
    }
  },

  project: {
    loadError: 'Não consegui abrir esta gravação',
    screen: 'Tela',
    camera: 'Câmera',
    play: 'Reproduzir',
    pause: 'Pausar',
    position: 'Posição no vídeo',
    files: 'Arquivos',
    folder: 'Pasta',
    created: 'Criada em',
    noMedia: 'Este projeto não tem vídeo da tela nem da câmera.',
    missingFile: 'O arquivo não foi encontrado na pasta do projeto.',
    videoError: 'O vídeo não abriu. Veja o arquivo na pasta do projeto.',
    revealFolder: 'Mostrar na pasta',
    fileLine: (w: number, h: number, fps: number): string => `${w}×${h}, ${Math.round(fps)} quadros por segundo`
  },

  editor: {
    preview: 'Prévia do vídeo',
    saveFailed: 'Não consegui salvar as mudanças',
    playFailed: 'Não consegui reproduzir',
    noEvents: 'Esta gravação não tem cursor e cliques: o zoom automático fica desligado.',
    openFailed: 'Não consegui abrir o editor',
    previewError: 'A prévia não consegue mostrar este vídeo',
    previewErrorHint: 'Os arquivos continuam na pasta do projeto. Abra a pasta para conferir.',
    audioMissing: 'Sem som na prévia',
    audioNone: 'Sem áudio nesta gravação',
    audioTreated: 'Voz tratada (igual à exportação)',
    audioRaw: 'Voz crua: preparando a voz tratada…',
    backgroundFailed: 'Não consegui carregar a imagem de fundo',

    top: {
      back: 'Biblioteca',
      backTip: 'Voltar à biblioteca',
      titleLabel: 'Título do vídeo',
      titleTip: 'Renomear',
      undo: 'Desfazer',
      redo: 'Refazer',
      ratio: 'Proporção do vídeo',
      ratioHorizontal: '16:9',
      ratioVertical: '9:16',
      ratioSoon: 'Vertical: chega na próxima etapa',
      save: { saved: 'Salvo', saving: 'Salvando…', error: 'Erro ao salvar', retry: 'Tentar de novo' },
      saveTip: (reason: string): string => `Não consegui gravar o project.json: ${reason}`,
      export: 'Exportar',
      exporting: (pct: number): string => `Exportando ${pct}%`,
      exportDone: 'Exportado',
      exportError: 'Falhou: ver'
    },

    transport: {
      label: 'Controles de reprodução',
      play: 'Reproduzir',
      pause: 'Pausar',
      start: 'Ir ao começo',
      end: 'Ir ao fim',
      frameBack: 'Quadro anterior',
      frameForward: 'Próximo quadro',
      speed: (rate: number): string => (rate < 0 ? `◀ ${Math.abs(rate)}×` : `${rate}×`),
      shortcuts: 'Atalhos do teclado'
    },

    tabs: { label: 'Painel do editor', style: 'Estilo', camera: 'Câmera', zoom: 'Zoom', layout: 'Layout', text: 'Texto', ai: 'IA', soon: 'Em breve' },

    style: {
      title: 'Aparência',
      background: 'Fundo',
      backgroundFree: 'Fundo livre',
      gradient: 'Gradiente',
      solid: 'Cor',
      image: 'Imagem',
      colorFrom: 'Cor inicial',
      colorTo: 'Cor final',
      colorSolid: 'Cor do fundo',
      angle: 'Ângulo',
      chooseImage: 'Escolher imagem…',
      changeImage: 'Trocar imagem…',
      imageName: (name: string): string => name,
      imageHelp: 'PNG, JPG ou WebP. A imagem é copiada para a pasta do projeto.',
      imageFailed: 'Não consegui usar essa imagem',
      margin: 'Margem',
      radius: 'Cantos arredondados',
      shadow: 'Sombra',
      shadowOpacity: 'Intensidade',
      shadowBlur: 'Desfoque',
      shadowOffset: 'Distância',
      reset: 'Restaurar padrão',
      percent: (v: number): string => `${Math.round(v * 100)}%`,
      px: (v: number): string => `${Math.round(v)} px`
    },

    camera: {
      title: 'Câmera',
      none: 'Esta gravação não tem câmera.',
      show: 'Mostrar a câmera',
      shape: 'Forma',
      shapes: { circle: 'Círculo', rounded: 'Arredondada', square: 'Quadrada' },
      size: 'Tamanho',
      position: 'Posição',
      positionHelp: 'Ou arraste a câmera na prévia.',
      positionOnlyBubble: 'A posição vale para o layout "Tela e câmera".',
      positions: {
        'top-left': 'No alto, à esquerda',
        'top-center': 'No alto, no centro',
        'top-right': 'No alto, à direita',
        'middle-left': 'No meio, à esquerda',
        'middle-center': 'No centro',
        'middle-right': 'No meio, à direita',
        'bottom-left': 'Embaixo, à esquerda',
        'bottom-center': 'Embaixo, no centro',
        'bottom-right': 'Embaixo, à direita'
      },
      border: 'Borda',
      borderWidth: 'Espessura',
      borderColor: 'Cor da borda',
      behavior: 'Comportamento',
      mirror: 'Espelhar a imagem',
      shrink: 'Encolher durante o zoom'
    },

    zoom: {
      title: 'Zoom automático',
      off: 'Desligado',
      presets: { off: 'Desligado', subtle: 'Sutil', moderate: 'Moderado', intense: 'Intenso' },
      presetHelp: {
        off: 'Sem zoom nos cliques.',
        subtle: 'Aproxima pouco (1,4×) e devagar.',
        moderate: 'O equilíbrio para a maioria dos vídeos (1,7×).',
        intense: 'Aproxima muito (2×) e rápido, bom para telas pequenas.'
      },
      count: (n: number): string => (n === 0 ? 'Nenhum zoom' : n === 1 ? '1 zoom' : `${n} zooms`),
      countDetail: (auto: number, manual: number): string => `${auto} automático${auto === 1 ? '' : 's'}, ${manual} manual${manual === 1 ? '' : 'is'}`,
      regenerate: 'Gerar de novo a partir dos cliques',
      regenerateWarn: (auto: number, manual: number): string =>
        `Isto substitui ${auto === 1 ? 'o zoom automático' : `os ${auto} zooms automáticos`} e mantém ${manual === 0 ? 'nenhum manual (não há)' : manual === 1 ? 'o zoom manual' : `os ${manual} zooms manuais`}.`,
      regenerateConfirm: 'Substituir',
      regenerateCancel: 'Cancelar',
      noEvents: 'Sem cursor e cliques, o zoom automático não tem o que seguir.',
      selected: 'Zoom selecionado',
      none: 'Nenhum zoom selecionado',
      noneHelp: 'Clique num zoom na linha do tempo para ajustar. Arraste na trilha Zoom para criar um (ou tecle Z).',
      scale: 'Aproximação',
      scaleValue: (v: number): string => `${v.toFixed(2).replace('.', ',').replace(/,?0+$/, '')}×`,
      focus: 'Foco',
      focusAuto: 'Segue o cursor',
      focusManual: 'Ponto fixo',
      focusManualHelp: 'Clique na prévia para fixar o ponto.',
      focusHint: 'Clique na prévia para fixar o foco deste zoom',
      focusBack: 'Voltar a seguir o cursor',
      origin: { auto: 'Automático', manual: 'Manual' },
      range: 'Trecho',
      remove: 'Apagar zoom'
    },

    layout: {
      title: 'Layout',
      video: 'Layout do vídeo',
      videoHelp: 'Vale para todo o vídeo, menos nos trechos que você trocar na trilha Layout.',
      options: { bubble: 'Tela e câmera', 'side-by-side': 'Lado a lado', screen: 'Só a tela', camera: 'Só a câmera' },
      needsCamera: 'Precisa de câmera',
      needsScreen: 'Precisa de tela',
      segment: 'Trecho selecionado',
      segmentHelp: 'Troca o layout só neste trecho.',
      none: 'Nenhum trecho selecionado',
      noneHelp: 'Arraste na trilha Layout para criar um trecho com outro layout, ou tecle S para dividir no ponto da reprodução.',
      remove: 'Apagar trecho',
      range: 'Trecho'
    },

    soon: {
      badge: 'Em breve',
      text: { title: 'Editar pelo texto', body: 'A transcrição por palavra chega na próxima etapa: apagar uma frase vai cortar o vídeo.' },
      ai: { title: 'Edição com IA', body: 'Cortes de silêncio e de recomeços, cortes verticais prontos e "edite pedindo" chegam depois da transcrição.' }
    },

    timeline: {
      label: 'Linha do tempo',
      tracks: { video: 'Vídeo', zoom: 'Zoom', layout: 'Layout' },
      ruler: 'Régua de tempo',
      cut: 'Cortar',
      cutTip: 'Cortar o intervalo marcado',
      split: 'Dividir',
      splitTip: 'Dividir o layout no ponto da reprodução',
      zoomHere: 'Zoom',
      zoomHereTip: 'Criar um zoom no intervalo marcado',
      restoreTip: 'Clique para restaurar este trecho',
      restore: (from: string, to: string): string => `Restaurar o trecho cortado de ${from} a ${to}`,
      reenable: (from: string, to: string): string => `Reativar o corte de ${from} a ${to}`,
      hideCuts: 'Esconder cortes',
      hideCutsTip: 'Mostrar só o que vai ficar (tempo de saída)',
      showCuts: 'Mostrar cortes',
      fit: 'Ajustar',
      fitTip: 'Ajustar a linha do tempo à largura',
      zoomIn: 'Aproximar',
      zoomOut: 'Afastar',
      zoomSlider: 'Zoom da linha do tempo',
      rangeLabel: (from: string, to: string, len: string): string => `${from} → ${to} (${len})`,
      rangeHint: 'Delete corta',
      selection: 'Seleção',
      noSelection: 'Arraste na trilha Vídeo para marcar um trecho',
      noAudio: 'Sem áudio nesta gravação',
      noZoomsHint: 'Sem zooms: arraste aqui para criar um',
      layoutEmpty: (name: string): string => `Layout do vídeo: ${name}. Arraste aqui para trocar só um trecho`,
      peaksFailed: 'Não consegui gerar a forma de onda',
      thumbsFailed: 'Não consegui gerar as miniaturas',
      retry: 'Tentar de novo',
      wavePending: 'Calculando a forma de onda…',
      zoomSeg: (scale: string, manual: boolean): string => `Zoom ${scale}${manual ? '' : ' (automático)'}`,
      layoutSeg: (name: string): string => `Layout: ${name}`,
      cutTotal: (len: string): string => `${len} cortados`,
      outputTotal: (len: string): string => `Saída ${len}`
    },

    shortcuts: {
      title: 'Atalhos do editor',
      play: 'Tocar / pausar',
      jkl: 'Voltar, parar, avançar (repetir acelera)',
      frame: 'Um quadro para trás / para a frente',
      second: 'Um segundo para trás / para a frente',
      homeEnd: 'Começo / fim',
      cut: 'Cortar o intervalo marcado (ou apagar o selecionado)',
      split: 'Dividir o layout no ponto da reprodução',
      zoom: 'Criar zoom no intervalo marcado',
      undo: 'Desfazer',
      redo: 'Refazer',
      timelineZoom: 'Aproximar / afastar a linha do tempo',
      scroll: 'Rolar a linha do tempo',
      escape: 'Limpar a seleção'
    },

    export: {
      title: 'Exportar vídeo',
      subtitle: 'MP4 para o YouTube, feito neste computador.',
      presets: 'Qualidade',
      preset: { '1080p': 'YouTube 1080p', '1440p': 'YouTube 1440p', '2160p': 'YouTube 4K' },
      presetSize: (w: number, h: number): string => `${w}×${h}`,
      fps: 'Quadros por segundo',
      fileName: 'Nome do arquivo',
      folder: 'Pasta',
      folderChoose: 'Escolher…',
      folderDefault: 'Pasta "exports" do projeto',
      folderPicked: 'Pasta escolhida',
      folderReset: 'Usar a pasta do projeto',
      summary: (len: string, size: string): string => `Vídeo final de ${len}, cerca de ${size}`,
      nothing: 'Todos os trechos foram cortados: não há o que exportar.',
      start: 'Exportar',
      button: (label: string): string => `Exportar ${label}`,
      close: 'Fechar',
      keepEditing: 'Continuar editando',
      cancel: 'Cancelar exportação',
      cancelling: 'Cancelando…',
      phases: {
        preparing: 'Preparando…',
        rendering: 'Gerando o vídeo',
        mux: 'Juntando o vídeo e o áudio…',
        checking: 'Conferindo o arquivo…'
      },
      frames: (frame: number, total: number): string => `${frame} de ${total} quadros`,
      speed: (fps: number): string => `${fps} quadros por segundo`,
      eta: (text: string): string => `faltam ${text}`,
      audioReady: 'Áudio pronto',
      runningHint: 'A exportação roda fora da tela do editor: dá para continuar editando.',
      doneTitle: 'Vídeo exportado',
      doneBody: (name: string): string => name,
      report: (w: number, h: number, fps: number, mb: string, diff: number): string => `${w}×${h} · ${fps} qps · ${mb} MB · áudio × vídeo ${diff} ms`,
      play: 'Tocar',
      reveal: 'Mostrar na pasta',
      copyPath: 'Copiar caminho',
      copied: 'Caminho copiado.',
      copyFailed: 'Não consegui copiar o caminho',
      openFailed: 'Não consegui abrir o arquivo',
      revealFailed: 'Não consegui abrir a pasta',
      pickFailed: 'Não consegui escolher a pasta',
      failedTitle: 'Não consegui exportar',
      retry: 'Tentar de novo',
      cancelled: 'Exportação cancelada. Nada foi gravado.',
      again: 'Exportar de novo'
    }
  },

  record: {
    title: 'Gravar',
    modes: {
      label: 'O que gravar',
      'screen-camera': 'Tela e câmera',
      screen: 'Só a tela',
      camera: 'Só a câmera'
    },
    source: {
      title: 'Tela ou janela',
      screens: 'Telas',
      windows: 'Janelas',
      primary: 'principal',
      noWindows: 'Nenhuma janela aberta para gravar.',
      noScreens: 'Nenhuma tela encontrada.',
      loadFailed: 'Não consegui listar as telas e janelas',
      selected: 'Selecionada',
      missing: 'A fonte escolhida da última vez não está mais aberta. Escolha outra.',
      size: (w: number, h: number): string => `${w}×${h}`
    },
    camera: {
      title: 'Câmera',
      none: 'Sem câmera',
      previewLabel: 'Prévia da câmera',
      loading: 'Abrindo a câmera…',
      off: 'Sem câmera: só a tela e o som.',
      noDevices: 'Nenhuma câmera encontrada.'
    },
    mic: {
      title: 'Microfone',
      none: 'Sem microfone',
      level: 'Nível do microfone',
      noDevices: 'Nenhum microfone encontrado.',
      default: 'Microfone padrão'
    },
    system: { title: 'Som do computador', help: 'Grava o que toca nos alto-falantes (vídeos, música, avisos).', on: 'Ligado', off: 'Desligado' },
    quality: { title: 'Quadros por segundo', fps30: '30', fps60: '60', help: '30 serve para quase tudo; 60 deixa o cursor e a rolagem mais suaves e pesa mais.' },
    advanced: {
      title: 'Ajustes do som e da bolha',
      noiseSuppression: 'Reduzir ruído do microfone',
      echoCancellation: 'Cancelar eco',
      bubble: 'Mostrar a bolha da câmera durante a gravação (não aparece no vídeo)'
    },
    start: 'Gravar',
    startShortcut: 'Ctrl+Shift+R',
    starting: 'Preparando…',
    countdown: 'Contagem regressiva em andamento',
    busy: {
      recording: 'Gravando. Use a barra flutuante ou Ctrl+Shift+R para parar.',
      processing: 'Processando a gravação anterior…'
    },
    cannot: {
      'no-source': 'Escolha a tela ou a janela que vai gravar.',
      'no-camera': 'Escolha uma câmera ou mude para "Só a tela".',
      nothing: 'Escolha o que gravar.'
    },
    deviceError: 'Não consegui abrir os dispositivos',
    privacyHint: 'O vídeo e o som ficam só neste computador.',
    notices: {
      sourceEnded: 'A tela ou janela gravada fechou. A gravação foi salva até esse ponto.',
      discarded: 'Gravação descartada. Ela está na Lixeira do Windows.'
    },
    errors: {
      startFailed: 'Não consegui começar a gravar',
      sourceEndedEarly: 'A tela ou janela escolhida fechou antes da gravação começar.',
      writeFailed: 'Não consegui gravar em disco. Salvando o que já está no disco.',
      recorderFailed: 'O gravador falhou. Salvando o que já foi gravado.',
      commandFailed: 'Não consegui executar o comando',
      stopFailed: 'Não consegui parar e salvar a gravação'
    }
  },

  processing: {
    title: 'Processando a gravação',
    empty: 'Nenhuma gravação em processamento.',
    headline: 'Preparando o vídeo para editar',
    body: 'Isto roda no seu computador. Não feche o Tomada.',
    failedTitle: 'Não consegui terminar o processamento',
    failedBody: 'A gravação bruta está salva e nada foi perdido. Corrija o problema e tente de novo.',
    retry: 'Tentar de novo',
    retrying: 'Tentando de novo…',
    retryFailed: 'Não consegui tentar de novo',
    reveal: 'Mostrar a pasta',
    toLibrary: 'Ir para a biblioteca',
    saved: 'Gravação salva na biblioteca.',
    notes: 'Avisos',
    steps: {
      save: 'Salvar cursor, cliques e teclas',
      screen: 'Preparar o vídeo da tela',
      camera: 'Preparar o vídeo da câmera',
      voice: 'Extrair a voz',
      system: 'Extrair o som do computador',
      thumb: 'Criar a miniatura',
      project: 'Montar o projeto'
    },
    status: { pending: 'Na fila', running: 'Em andamento', done: 'Pronto', skipped: 'Pulado', error: 'Falhou' }
  },

  bar: {
    label: 'Barra de gravação',
    recording: 'Gravando',
    paused: 'Pausada',
    stopping: 'Salvando…',
    pause: 'Pausar',
    resume: 'Continuar',
    stop: 'Parar e salvar',
    restart: 'Recomeçar',
    discard: 'Descartar',
    confirmRestart: 'Recomeçar do zero?',
    confirmDiscard: 'Descartar esta gravação?',
    yes: 'Sim',
    no: 'Não',
    mic: 'Nível do microfone',
    noMic: 'Sem microfone',
    shortcuts: (stop: string, pause: string): string => `Parar: ${stop} · Pausar: ${pause}`
  },

  countdown: { label: 'Contagem para começar a gravar', cancel: 'Esc para cancelar', go: 'Gravando' },

  bubble: { label: 'Bolha da câmera', error: 'Câmera indisponível' },

  settings: {
    title: 'Ajustes',
    projects: {
      title: 'Pasta dos projetos',
      help: 'Onde ficam as gravações. Cada projeto é uma pasta com o vídeo bruto, as edições e as exportações.',
      choose: 'Escolher pasta…',
      fromEnv: 'Definida pela variável TOMADA_PROJECTS_DIR (modo de teste). A escolha só vale quando a variável não estiver ligada.',
      saved: 'Pasta dos projetos atualizada.',
      saveFailed: 'Não consegui usar essa pasta'
    },
    ffmpeg: {
      title: 'ffmpeg',
      help: 'Programa que normaliza os vídeos, extrai o áudio e monta a exportação.',
      found: 'Detectado',
      missing: 'Não encontrado',
      brokenTitle: 'Encontrado, mas não executa',
      version: 'Versão',
      probeVersion: 'ffprobe',
      path: 'Caminho',
      origin: 'Origem',
      origins: {
        settings: 'Escolhido nos Ajustes',
        bundled: 'Instalado com o Tomada',
        path: 'PATH do Windows'
      },
      test: 'Testar',
      testing: 'Testando…',
      choose: 'Escolher o ffmpeg…',
      useSystem: 'Usar o do sistema',
      testOk: 'O ffmpeg passou no teste.',
      testFailed: 'O ffmpeg não passou no teste.',
      saved: 'Ajuste do ffmpeg atualizado.',
      saveFailed: 'Não consegui usar esse ffmpeg',
      nvencNote: 'A placa NVIDIA (NVENC) é opcional: sem ela o Tomada usa o processador.'
    },
    about: {
      title: 'Sobre',
      version: 'Versão do Tomada',
      electron: 'Electron',
      data: 'Pasta de dados',
      logs: 'Registros (logs)'
    }
  }
} as const

export type Dictionary = typeof ptBR

/** Dicionário em uso. Trocar de idioma = trocar este import. */
export const t: Dictionary = ptBR
