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
    provisional: 'Visualização provisória. O editor chega na próxima etapa.',
    files: 'Arquivos',
    folder: 'Pasta',
    created: 'Criada em',
    noMedia: 'Este projeto não tem vídeo da tela nem da câmera.',
    missingFile: 'O arquivo não foi encontrado na pasta do projeto.',
    videoError: 'O vídeo não abriu. Veja o arquivo na pasta do projeto.',
    revealFolder: 'Mostrar na pasta',
    fileLine: (w: number, h: number, fps: number): string => `${w}×${h}, ${Math.round(fps)} quadros por segundo`
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
