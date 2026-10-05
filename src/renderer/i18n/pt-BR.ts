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
    headline: 'A gravação chega na próxima etapa',
    body: 'Aqui você vai escolher a tela ou a janela, a câmera e o microfone, e começar com Ctrl+Shift+R. Por enquanto, a biblioteca já mostra e toca o que estiver na pasta dos projetos.',
    cta: 'Ver a biblioteca'
  },

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
