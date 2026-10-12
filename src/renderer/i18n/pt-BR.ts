/**
 * TODO texto de interface mora aqui (pt-BR), para dar para traduzir depois.
 * Convenções: frase com inicial maiúscula só no começo; o botão diz o que acontece
 * (e a confirmação repete o mesmo verbo); erro explica o que houve e o que fazer.
 */
import { m5Settings } from './m5-settings'
import { audioQualityPtBR } from '@shared/audio-quality-messages'
export const ptBR = {
  audioQuality: audioQualityPtBR,
  /** Antes de gravar: qual microfone está em uso e se a voz entra baixa demais (volume de entrada do Windows). */
  micLevel: {
    using: 'Microfone em uso',
    windowsVolume: (percent: number): string => `Volume de entrada do Windows: ${percent}%`,
    tooLowTitle: 'Seu microfone está baixo demais: a voz vai sair com chiado.',
    mutedTitle: 'Seu microfone está mudo no Windows: a gravação sairia sem voz.',
    mutedHelp: 'Abra Configurações > Sistema > Som > Entrada, escolha este microfone e tire o mudo.',
    reasonWindowsMinimum: 'O volume de entrada do Windows deste aparelho está no mínimo (sem ganho nenhum).',
    reasonSpeech: (peak: string): string => `Sua fala chega em ${peak} dBFS de pico; o ideal é perto de -12 dBFS.`,
    why: 'Com a voz entrando baixa, a exportação precisa subir o volume depois, e o chiado sobe junto.',
    cannotRead: 'Não consegui ler o volume do Windows deste aparelho. Abra Configurações > Sistema > Som > Entrada, escolha este microfone e suba o volume.',
    cannotAdjustAtMax: 'O volume deste aparelho já está no máximo. Aproxime-se do microfone ou escolha outro.',
    adjust: 'Ajustar sozinho',
    cancel: 'Cancelar',
    running: (step: number, total: number): string => `Fale normalmente, como vai gravar, até aparecer "Pronto". Passo ${step} de ${total}.`,
    runningPeak: (peak: string): string => `Sua voz está chegando em ${peak} dBFS de pico.`,
    done: (percent: number, peak: string): string => `Pronto. O volume de entrada do Windows foi para ${percent}% e sua voz chega em ${peak} dBFS de pico.`,
    failed: {
      unsupported: 'Não consegui ler o volume do Windows deste aparelho. Abra Configurações > Sistema > Som > Entrada, escolha este microfone e suba o volume.',
      'no-speech': 'Não ouvi sua voz. Fale normalmente por alguns segundos e toque em "Ajustar sozinho" de novo.',
      'at-max': 'O volume deste aparelho chegou ao máximo e a voz continua baixa. Aproxime-se do microfone ou escolha outro.',
      'at-min': 'O volume deste aparelho já está no mínimo e a voz ainda chega alta: afaste-se do microfone.',
      rejected: 'O Windows não aceitou a mudança de volume deste aparelho. Ajuste em Configurações > Sistema > Som > Entrada.',
      'no-convergence': 'Não consegui acertar o volume em 6 passos. Ajuste em Configurações > Sistema > Som > Entrada e tente de novo.',
      cancelled: 'Ajuste cancelado.'
    } as Record<'unsupported' | 'no-speech' | 'at-max' | 'at-min' | 'rejected' | 'no-convergence' | 'cancelled', string>
  },
  m5Settings,
  diskSpace: {
    title: 'Espaço no disco', low: 'Pouco espaço para concluir', unknown: 'Não consegui medir o disco',
    estimate: (needed: string, duration: string) => `Estimativa para ${duration}: ${needed}.`,
    free: (free: string) => `${free} livres.`,
    recordingPeriod: 'A estimativa antes de gravar considera uma hora; o uso real varia com a duração e a atividade da tela.'
  },
  autopilot: {
    lowScore: 'Nota baixa: revise antes de postar',
    dictionaryCorrections: 'Grafia dos nomes de produtos', undoCorrection: 'Desfazer troca', correctionUndone: 'Troca desfeita',
    hasErrors:'Há etapas com problema. Confira os motivos e tente novamente.',
    decisionHelp: 'As escolhas seguem a atividade da tela e a fala. Desmarque uma decisão para restaurar o trecho ou o enquadramento.', enableAll: 'Ligar categoria', resetText: 'Restaurar texto sugerido', resetAllTexts: 'Restaurar todos os textos', discardAll: 'Descartar todos os cortes', styleSaved: 'Estilo salvo para as próximas gravações.',
    title: 'Piloto automático', mode: 'Ao parar de gravar', everything: 'Fazer tudo e exportar', prepare: 'Só preparar (sem exportar)', nothing: 'Nada',
    help: 'Grave, revise e poste. Cada decisão pode ser ajustada; o que você mudar à mão fica preservado.',
    steps: { transcribe: 'Transcrever localmente', dictionary: 'Conferir nomes do dicionário', clean: 'Limpar silêncio, hesitações e recomeços', zooms: 'Zooms automáticos', layouts: 'Layouts automáticos (16:9 e 9:16)', captions: 'Aplicar padrão de legendas', youtube: 'Exportar YouTube 1080p', clips: 'Sugerir os melhores cortes', clipExports: 'Exportar cortes verticais', publish: 'Preparar títulos e textos', notify: 'Avisar quando estiver pronto' },
    horizontalCaptions: 'Legenda no YouTube por padrão', youtubeResolution: 'Resolução do YouTube no piloto', youtubeResolutionOptions: { '1440p': '1440p (padrão: o YouTube dá codec melhor)', '1080p': '1080p (exporta mais rápido)' }, verticalCaptions: 'Legenda nos cortes por padrão', maxClips: 'Quantidade máxima de cortes', score: 'Nota mínima', saveStyle: 'Usar este estilo nas próximas gravações', savedStyle: 'Estilo salvo para novas gravações',
    review: 'Revisão', reviewing: 'Prepare para postar', running: 'Preparando sua gravação…', ready: 'Pronto para revisar', summary: 'O que o automático fez', approve: 'Aprovar', discard: 'Descartar', pending: 'A revisar', approved: 'Aprovado', discarded: 'Descartado',
    quick: 'Ajustes rápidos', editor: 'Abrir no editor', copy: 'Copiar texto', copied: 'Texto copiado', post: 'Abrir pasta para postar', postHelp: 'A pasta recebe os vídeos aprovados e um texto por plataforma.',
    start: 'Aparar começo', end: 'Aparar fim', layout: 'Layout', captions: 'Legenda', captionStyle: 'Estilo da legenda', titleLabel: 'Título', hook: 'Gancho', text: 'Texto para publicação (editável)', zoom: 'Zoom', softer: 'Mais suave', stronger: 'Mais forte', off: 'Desligado', auto: 'Automático',
    clean: 'Restaurar uma categoria neste vídeo', reasons: { silence: 'Silêncio', filler: 'Muletas e hesitações', retake: 'Recomeços', manual: 'Manuais', ai: 'Pedidos de edição' }, keepNe: 'Não cortar “né”',
    ask: 'Ajustar pedindo', askPlaceholder: 'Ex.: corta mais o começo ou troca o gancho', apply: 'Aplicar ajuste', confirm: 'Aplicar mesmo assim', confirmation: 'O ajuste remove mais de 20% do vídeo. Confira o resumo antes de aplicar.',
    retry: 'Tentar de novo', exporting: 'Reexportando só este vídeo…', noExport: 'Este vídeo ainda não foi exportado.', export: 'Exportar este vídeo', error: 'Não consegui concluir esta ação',
    note: (n: number) => `Nota ${n}/100`, duration: 'Duração', view: 'Ver e ajustar', restore: 'Restaurar', decide: 'Decisões de limpeza', restoreAll: 'Restaurar esta categoria',
    cutsCount: (n: number, reason: string, time: string) => `${n} ${reason.toLowerCase() === 'silêncio' && n !== 1 ? 'silêncios' : reason.toLowerCase()} · ${time} removidos`, zoomCount: (n: number) => `${n} ${n === 1 ? 'zoom automático' : 'zooms automáticos'}`, layoutCount: (n: number) => `${n} ${n === 1 ? 'layout automático' : 'layouts automáticos'}`, clipCount: (n: number) => `${n} ${n === 1 ? 'corte vertical' : 'cortes verticais'}`, texts: 'Títulos e textos de publicação', regenerate: 'Refazer automáticos', noAi: 'Sem IA: confira as escolhas da heurística.', youtube: 'YouTube · 16:9', vertical: 'Corte · 9:16'
  },
  app: { name: 'Tomada', tagline: 'Gravar e editar, tudo neste computador' },

  preparation: {
    faceChecks:{ok:'Rosto enquadrado', 'no-face':'Nenhum rosto visível: confira a câmera', 'off-center':'Rosto fora do enquadramento', dark:'Câmera escura: confira a iluminação', unknown:'Confira seu enquadramento na prévia'},
    script: 'Roteiro', topic: 'Sobre o que é o vídeo?', topicHint: 'Ex.: mostrar como agendar um cliente no meu sistema', generate: 'Preparar roteiro', generating: 'Preparando roteiro…', title: 'Título provisório', hook: 'Gancho de uma frase', topics: 'Tópicos (um por linha, de 3 a 6)', closing: 'Fechamento com chamada', invalid: 'Preencha todos os campos e mantenha de 3 a 6 tópicos.', failed: 'Não consegui preparar o roteiro', remove: 'Gravar sem roteiro', prompt: 'Abrir teleprompter', mode: 'Modo do teleprompter', scroll: 'Rolagem', topicMode: 'Tópicos', speed: 'Velocidade da rolagem', speedValue: (n: number): string => `${n} px/s`,
    promptHelp: 'Ctrl+Alt+Espaço pausa; Ctrl+Alt+→ avança; Ctrl+Alt+← volta. A janela fica fora da captura.',
    pause: 'Pausar roteiro', resume: 'Continuar roteiro', previous: 'Tópico anterior', next: 'Próximo tópico', faster: 'Rolagem mais rápida', slower: 'Rolagem mais lenta', close: 'Fechar teleprompter', protected: 'Teleprompter · fora da captura', progress: (current: number, total: number): string => `${current} de ${total}`,
    preflight: 'Antes de gravar', mic: { listening: 'Fale por 2 segundos para conferir o microfone.', low: 'Microfone baixo: aproxime-se ou aumente o ganho.', clipping: 'Microfone estourando: afaste-se ou reduza o ganho.', ok: 'Microfone com nível bom.' }, noMic: 'Sem microfone selecionado.', micValues: (rms: number, peak: number): string => `RMS ${rms.toFixed(0)} dBFS · pico ${peak.toFixed(0)} dBFS`, disk: (n: number): string => `${(n / 1e9).toFixed(1).replace('.', ',')} GB livres`, diskLow: 'Pouco espaço em disco.', diskUnknown: 'Não consegui medir o espaço em disco.', dnd: 'Lembrete: ligue o Não perturbe do Windows.', face: 'Confira o rosto e a iluminação na prévia da câmera.', anyway: 'Gravar mesmo assim', retake: 'Errei', marked: 'Errei marcado', marks: (n: number): string => `${n} marca${n === 1 ? '' : 's'}`, retakeShortcut: 'Atalho para marcar “errei”', shortcutHelp: 'Use Ctrl+Alt+letra, Ctrl+Shift+letra ou Alt+Shift+letra. Ctrl+Shift+R/P/Z ficam reservados.', shortcutInvalid: 'Atalho inválido ou reservado.'
  },

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
    search: 'Buscar gravação',
    searchPlaceholder: 'Digite parte do título',
    order: 'Ordenar por',
    orders: { newest: 'Mais recentes', oldest: 'Mais antigas', title: 'Título · A a Z', duration: 'Maior duração' },
    results: (n: number): string => n === 1 ? '1 gravação encontrada' : `${n} gravações encontradas`,
    noResults: 'Nenhuma gravação encontrada',
    noResultsHelp: 'Tente outro título ou limpe a busca.',
    clearSearch: 'Limpar busca',
    count: (n: number): string => (n === 1 ? '1 gravação' : `${n} gravações`),
    newRecording: 'Nova gravação',
    loadError: 'Não consegui abrir a biblioteca',
    empty: {
      title: 'Nenhuma gravação ainda',
      body: 'Grave sua tela e câmera. As gravações ficam neste computador.',
      cta: 'Gravar agora'
    },
    card: {
      progress: 'Preparação da gravação',
      transcribed: 'Transcrito',
      clipsReady: (n: number): string => n === 1 ? '1 corte pronto' : `${n} cortes prontos`,
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
      ratioTip: { horizontal: 'Editar o vídeo 16:9 (YouTube)', vertical: 'Editar o vídeo vertical 9:16 (TikTok, Reels, Shorts)' },
      safeGuide: 'Zonas',
      safeGuideTip: 'Mostrar a área segura e as zonas da interface do TikTok, Reels e Shorts (só na prévia: nunca vai para o vídeo)',
      safeGuideLabels: { box: 'Área segura', tiktok: 'TikTok', reels: 'Reels', shorts: 'Shorts' },
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

    tabs: { label: 'Painel do editor', style: 'Estilo', camera: 'Câmera', zoom: 'Zoom', layout: 'Layout', text: 'Texto', captions: 'Legendas', clips: 'Cortes', publish: 'Publicar', ai: 'IA', blur: 'Desfoque' },
    blur: {
      title: 'Proteger dado sensível', draw: 'Selecionar região na prévia', drawing: 'Arraste sobre o dado sensível',
      hint: 'A região acompanha a tela, o zoom e todos os cortes. Os pixels originais são removidos do vídeo exportado. O bruto continua no projeto.',
      limits: 'Fala, legenda e texto de publicação não são protegidos.',
      none: 'Nenhuma região protegida', region: 'Região', mode: 'Proteção', modes: { blur: 'Desfoque forte', pixelate: 'Pixelado', solid: 'Tarja sólida' },
      untilEnd: 'Desfocar até o fim', remove: 'Apagar região', start: 'Início (ms)', end: 'Fim (ms)',
      x: 'Esquerda', y: 'Topo', w: 'Largura', h: 'Altura', empty: 'Selecione uma região na prévia ou arraste nesta trilha.',
      selected: 'Região selecionada', move: 'Arraste para mover; use os cantos para redimensionar.'
    },

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

    crop: {
      title: 'Recorte da tela',
      modes: { auto: 'Automático', manual: 'Manual', off: 'Desligado' },
      autoHelp: 'Só a página do navegador: sem abas, barra de endereço nem favoritos. Acompanha o DevTools e a janela quando mudam.',
      autoScreenHelp: 'Só a página do navegador que estava na frente em cada momento (sem abas nem barra de endereço). Onde não havia navegador, a tela inteira.',
      autoMissingShort: 'O Tomada não mediu a página do navegador nesta gravação',
      offHelp: 'O vídeo mostra a tela inteira. Use Manual para escolher um pedaço dela.',
      geckoHelp: 'Gravação do Firefox: o Tomada não mede a página dele sozinho. Use Manual para tirar as abas e a barra de endereço.',
      offerWindow: 'O Tomada mediu a página do navegador nesta gravação. Escolha Automático para tirar as abas e a barra de endereço.',
      offerScreen: 'Havia um navegador na frente nesta gravação. Escolha Automático para recortar para a página dele.',
      manualHelp: 'Arraste o retângulo sobre a tela inteira.',
      suggest: 'Sugerir recorte',
      suggesting: 'Procurando a barra do navegador…',
      suggestNone: 'Não achei uma barra de navegador nesta gravação. Use o recorte manual.',
      suggestDone: 'Sugestão pronta: confira o retângulo na prévia e ajuste se precisar.',
      suggestFailed: 'Não consegui analisar a gravação',
      suggestHelp: 'Procura, nos quadros da gravação, onde acaba a barra do navegador.',
      adjust: 'Ajustar na prévia',
      adjustByHand: 'Ajustar à mão…',
      done: 'Pronto',
      backToAuto: 'Voltar ao automático',
      tooSmall: (w: number, h: number): string => `O retângulo ficou pequeno demais: o menor recorte é ${w}×${h} px. O recorte anterior foi mantido.`,
      manualInvalid: 'O recorte manual salvo neste projeto não vale (pequeno demais ou fora da tela), então o vídeo mostra a tela inteira. Ajuste o retângulo para recortar.',
      lockLabel: 'Proporção',
      locks: { free: 'Livre' },
      size: (w: number, h: number): string => `${w}×${h} px`,
      editorLabel: 'Recorte da tela: arraste o retângulo',
      editorHint: 'Arraste o retângulo ou as pontas. Enter ou Esc fecham; Ctrl+Z desfaz.',
      frameToggle: 'Moldura de navegador',
      frameHelp: 'Uma barra limpa no topo, com o endereço que você escrever, no lugar das abas.',
      domain: 'Endereço na barra',
      domainPlaceholder: 'ex.: meusistema.com.br',
      frameOnlyHorizontal: 'A moldura de navegador só aparece no vídeo 16:9.'
    },

    camera: {
      sync: {
        title: 'Sincronia da câmera',
        help: 'Se a boca aparece atrasada, aumente o valor. Só a imagem da câmera muda; a voz continua junto da tela.',
        manual: 'Ajuste manual',
        automatic: (value: number): string => `Automático: ${value > 0 ? '+' : ''}${value} ms`,
        reset: 'Voltar ao automático'
      },
      title: 'Câmera',
      none: 'Esta gravação não tem câmera.',
      show: 'Mostrar a câmera',
      shape: 'Forma',
      shapes: { circle: 'Círculo', rounded: 'Arredondada', square: 'Quadrada' },
      size: 'Tamanho',
      position: 'Posição',
      positionHelp: 'Ou arraste a câmera na prévia.',
      positionOnlyBubble: 'A posição vale para o layout "Tela e câmera".',
      positionVertical: 'No vertical a câmera fica dentro da área segura, longe da interface das plataformas.',
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
      shrink: 'Encolher durante o zoom',
      borderNote: 'No layout "Lado a lado" a câmera não leva borda: ela acompanha a tela.',
      framing: {
        title: 'Enquadramento do rosto',
        auto: 'Centralizar no rosto',
        autoHint: 'O app acha o rosto uma vez por gravação e o recorte da câmera o acompanha, devagar. Vale para a bolha, o lado a lado e o "Câmera + tela" do vertical.',
        zoom: 'Aproximação',
        zoomValue: (v: number): string => `${v.toFixed(2).replace('.', ',').replace(/,?0+$/, '')}×`,
        horizontal: 'Deslocar na horizontal',
        vertical: 'Deslocar na vertical',
        offset: (v: number): string => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`,
        reset: 'Restaurar o enquadramento',
        dragHint: 'Arraste dentro da câmera, na prévia, para mover o recorte (na bolha, segure Alt).',
        status: {
          queued: 'Na fila para procurar o rosto…',
          running: (pct: number): string => `Procurando o rosto… ${pct}%`,
          found: (pct: number): string => `Rosto achado em ${pct}% da gravação.`,
          none: 'Não achei um rosto nesta gravação. O recorte fica no centro; ajuste à mão.',
          failed: 'Não consegui procurar o rosto',
          retry: 'Procurar de novo',
          cancel: 'Cancelar',
          unreadable: 'Não consegui ler a análise do rosto',
          missing: 'O rosto ainda não foi procurado.'
        },
        needsPrepare: 'Para centralizar a câmera no seu rosto, o app precisa de um detector pequeno (OpenCV e um modelo de 230 KB). Roda neste computador e nada sai dele.'
      },
      presenter: {
        title: 'Você sem fundo (green screen)',
        help: 'Vale para os layouts em que você aparece sem o fundo da webcam, na frente da tela: "Você sem fundo" no 16:9 e "Green screen" no 9:16. O recorte é feito neste computador, na placa de vídeo, uma vez por gravação.',
        notActive: 'O layout atual não usa você sem fundo.',
        side: 'Canto',
        sides: { left: 'Esquerda', right: 'Direita' },
        height: 'Altura da pessoa',
        percent: (v: number): string => `${Math.round(v * 100)}%`,
        outline: 'Contorno branco',
        outlineHint: 'Um contorno de figurinha em volta de você: separa a pessoa de telas escuras ou da mesma cor.',
        outlineWidth: 'Espessura do contorno',
        shadow: 'Sombra',
        mirrorHint: 'Para as suas mãos apontarem para a tela, use "Espelhar a imagem" em Comportamento. Mostre o tronco e as mãos, com a luz de frente.',
        status: {
          queued: 'Na fila para recortar você do fundo…',
          running: (pct: number): string => `Recortando você do fundo: ${pct}%`,
          ready: 'Você já está recortado do fundo.',
          missing: 'Você ainda não foi recortado do fundo. Isso começa sozinho quando um layout usa você sem fundo; se não começou, use o botão abaixo.',
          start: 'Recortar você do fundo agora',
          redo: 'Recortar de novo',
          failed: 'Não consegui recortar você do fundo',
          retry: 'Tentar de novo',
          cancel: 'Cancelar'
        },
        needsPrepare: 'Para recortar o fundo, o app precisa baixar um modelo (107 MB) e a execução na placa de vídeo. Tudo roda neste computador e nada sai dele.',
        needsPrepareAbove: 'O recorte do fundo usa o mesmo preparo da análise do rosto, no começo desta aba: ele também baixa o modelo do recorte.'
      },
      side: {
        title: 'Câmera ao lado da tela',
        help: 'Vale para o layout "Lado a lado" do vídeo 16:9: a imagem normal da câmera, num cartão com os mesmos cantos e a mesma sombra da tela.',
        notActive: 'O layout atual não é o "Lado a lado".',
        side: 'Lado',
        sides: { left: 'Esquerda', right: 'Direita' },
        ratio: 'Formato do quadro',
        ratios: { portrait: 'Em pé 3:4', square: 'Quadrado 1:1' },
        width: 'Largura',
        gap: 'Espaço entre os dois',
        percent: (v: number): string => `${Math.round(v * 100)}%`
      }
    },

    zoom: {
      title: 'Zoom automático',
      off: 'Desligado',
      presets: { off: 'Desligado', subtle: 'Sutil', moderate: 'Moderado', intense: 'Intenso' },
      presetHelp: {
        off: 'Sem zoom nos cliques.',
        subtle: 'Aproxima pouco (1,3×) e raramente: até 3 por minuto.',
        moderate: 'Como nos vídeos publicados (1,5×, até 5 por minuto, um movimento de 1 s).',
        intense: 'Aproxima mais (1,8×) e com mais frequência, bom para telas pequenas: até 8 por minuto.'
      },
      presetHelpVertical: {
        off: 'Sem zoom nos cliques: só o recorte que segue o cursor.',
        subtle: 'Reforça pouco (1,2×) sobre o recorte que segue o cursor: até 2 por minuto.',
        moderate: 'Reforça (1,35×) como nos vídeos publicados: até 3 por minuto, um movimento de 0,6 s.',
        intense: 'Reforça bem (1,5×) e com mais frequência: o texto da tela fica legível no celular. Até 5 por minuto.'
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
      options: {
        bubble: 'Tela e câmera',
        'side-by-side': 'Lado a lado',
        screen: 'Só a tela',
        camera: 'Só a câmera',
        'screen-focus': 'Cursor',
        'screen-center': 'Tela ao centro',
        stack: 'Câmera + tela',
        'screen-wide': 'Tela na largura',
        presenter: 'Você sem fundo',
        greenscreen: 'Green screen',
        'greenscreen-corner': 'Green screen no canto'
      },
      optionHints: {
        'side-by-side': 'A câmera num quadro ao lado da tela, com a imagem normal da webcam. Lado, formato e largura ficam na aba Câmera.',
        'screen-focus': 'A tela recortada em tela cheia, seguindo o cursor, com a câmera numa bolha.',
        'screen-center': 'Uma janela da tela segue o cursor, entre o gancho e a legenda, com o zoom que deixa a letra legível (cerca de 30 px no vídeo).',
        stack: 'A tela em cima e a câmera embaixo, metade e metade, de ponta a ponta. A tela segue o cursor, com a letra legível.',
        'screen-wide': 'A tela inteira na largura, com o mesmo vídeo desfocado ao fundo. Para telas de letra grande.',
        camera: 'Só a câmera, em tela cheia.',
        presenter:
          'Você, sem o fundo da webcam, na frente da tela: do peito para cima e com as mãos, na borda de baixo. No 16:9 fica num canto; no vertical a tela vai em cima (seguindo o cursor) e você embaixo. O recorte do fundo é feito sozinho, na placa de vídeo (aba Câmera). Mostre o tronco e as mãos, com a luz de frente.',
        greenscreen:
          'Só no vertical. A página em tela cheia atrás, com a janela seguindo o que você mostra e a letra legível, e você sem o fundo embaixo, com cerca de metade da altura. É você explicando aquela página, como no TikTok. A legenda fica logo acima da sua cabeça.',
        'greenscreen-corner':
          'Só no vertical, e é o padrão quando você tem câmera: a página em tela cheia atrás e você aparece menor, num canto de baixo, sempre no lado oposto ao que está sendo mostrado. Troca de lado de tempos em tempos, só numa emenda ou num deslize curto.'
      },
      legibility: {
        warn: (px: number, where: string): string => `A letra da página fica com cerca de ${px} px no vídeo vertical (${where}), abaixo de 22 px: difícil de ler no celular. Troque o layout destes trechos.`,
        ok: (px: number): string => `Letra da página: cerca de ${px} px no vídeo vertical.`
      },
      matte: {
        queued: 'Na fila para recortar você do fundo…',
        running: (pct: number): string => `Recortando você do fundo: ${pct}%`,
        runningFallback: (pct: number): string => `Recortando você do fundo: ${pct}%. Até terminar, a prévia mostra o layout sem recorte.`,
        failed: 'Não consegui recortar você do fundo',
        retry: 'Tentar de novo',
        needsEngine: 'O green screen precisa do recorte do fundo, e o app ainda não está preparado para isso. Prepare na aba Câmera. Até lá a prévia mostra o layout sem recorte.',
        cancelled: 'O recorte do fundo foi cancelado, e o green screen só sai com ele.',
        start: 'Recortar agora'
      },
      quick: {
        title: 'Trocar o layout do vídeo',
        titleSegment: 'Trocar o layout do trecho selecionado',
        titleClip: 'Trocar o layout deste corte'
      },
      vertical: {
        video: 'Layout do vídeo vertical',
        videoHelp: 'Vale para todo o vídeo, menos nos trechos da trilha Layout.',
        auto: 'Escolher pelo que acontece',
        autoHelp:
          'Fala sem nada acontecendo na tela por 3 s ou mais vira "Câmera + tela" (ou "Você sem fundo", quando o recorte do fundo da câmera já existe). O resto fica no recorte do cursor. Nenhum layout fica menos de 6 s na tela antes de trocar.',
        cameraTop: 'Câmera em cima',
        cameraTopHint: 'No "Câmera + tela", põe a câmera em cima e a tela embaixo. O padrão é a tela em cima.',
        autoWarn: (n: number): string => (n === 1 ? 'Isto substitui o trecho de layout do vertical.' : `Isto substitui os ${n} trechos de layout do vertical.`),
        autoConfirm: 'Substituir',
        autoCancel: 'Cancelar',
        autoDone: (n: number): string => (n === 0 ? 'Nada pediu a câmera: o vídeo todo ficou no recorte do cursor.' : n === 1 ? '1 trecho com câmera + tela.' : `${n} trechos com câmera + tela.`),
        hook: 'Título de gancho',
        hookHelp: 'Aparece nos 4 primeiros segundos, no alto do vídeo vertical (a bolha da câmera desce enquanto ele está na tela). Diga o resultado em poucas palavras.',
        hookPlaceholder: 'Ex.: Grave sua tela em 1 clique',
        hookCount: (n: number, max: number): string => `${n} de ${max}`
      },
      needsCamera: 'Precisa de câmera',
      needsScreen: 'Precisa de tela',
      segment: 'Trecho selecionado',
      segmentHelp: 'Troca o layout só neste trecho.',
      none: 'Nenhum trecho selecionado',
      noneHelp: 'Arraste na trilha Layout para criar um trecho com outro layout, ou tecle S para dividir no ponto da reprodução.',
      remove: 'Apagar trecho',
      range: 'Trecho'
    },

    captions: {
      title: 'Legendas',
      show: 'Mostrar as legendas',
      seek: 'Ver numa fala',
      showHint: 'Usa as palavras da transcrição, no tempo do vídeo final. Cortes, silêncios e correções de texto valem.',
      forFormat: { horizontal: 'Estas escolhas valem para o vídeo 16:9.', vertical: 'Estas escolhas valem para o vídeo vertical 9:16.' },
      noTranscript: { title: 'Sem texto para legendar', body: 'A legenda usa as palavras da transcrição. Transcreva a voz na aba Texto e ela aparece aqui.' },
      style: 'Estilo',
      styles: {
        highlight: { name: 'Destaque', hint: 'Letra pesada, caixa-alta, a palavra falada acesa' },
        natural: { name: 'Natural', hint: 'Letra em caixa mista, sem caixa atrás no vertical; caixa escura no 16:9' },
        clean: { name: 'Limpa', hint: 'Caixa branca, texto escuro' },
        karaoke: { name: 'Karaokê', hint: 'A frase inteira, a palavra acesa avança' }
      },
      sample: ['Veja', 'como', 'fica'],
      adjust: 'Ajustes',
      size: 'Tamanho',
      position: 'Posição vertical',
      positionTop: 'No alto',
      positionBottom: 'Embaixo',
      wordsPerLine: 'Palavras por linha',
      positionAuto: 'Posição automática: 70% do alto e, no "Câmera + tela", na emenda das duas. Mexer no controle fixa a posição.',
      positionManual: 'Posição fixa, escolhida por você.',
      positionBack: 'Voltar ao automático',
      highlightWord: 'Palavra falada em destaque',
      highlightWordHint: 'A palavra que está sendo dita acende na cor de destaque. A Limpa mostra o que ainda não foi dito apagado.',
      uppercase: 'Maiúsculas',
      box: 'Caixa atrás do texto',
      colors: 'Cores',
      textColor: 'Texto',
      highlightColor: 'Palavra falada',
      resetColors: 'Cores do estilo',
      reset: 'Restaurar padrão do estilo',
      files: 'Arquivos de legenda',
      filesHelp: 'SRT e VTT no tempo do vídeo final (com os cortes). Vão para a pasta "exports" do projeto.',
      exportSrt: 'Exportar SRT',
      exportVtt: 'Exportar VTT',
      exporting: 'Salvando…',
      saved: (name: string): string => `Legenda salva: ${name}`,
      exportFailed: 'Não consegui salvar a legenda',
      reveal: 'Mostrar na pasta',
      fontsFailed: 'Não consegui carregar as fontes das legendas',
      safeNote: 'No vertical a legenda fica sempre dentro da área segura.'
    },

    clips: {
      title: 'Cortes verticais',
      help: 'Trechos de 30 a 60 s para TikTok, Reels e Shorts. Cada corte começa numa frase completa, abre com um gancho nos 3 primeiros segundos, termina fechando a ideia e herda a limpeza e a edição do vertical.',
      suggest: 'Sugerir cortes',
      suggestMore: 'Sugerir mais cortes',
      suggesting: 'Procurando os melhores trechos…',
      suggestNoAi: 'Sugerir sem IA',
      suggestNoAiHint: 'Escolhe pelas pausas, pelo ritmo da fala e pela atividade da tela.',
      noTranscript: { title: 'Sem transcrição', body: 'Os cortes saem da transcrição da voz. Transcreva o vídeo na aba Texto primeiro.', cta: 'Ir para a aba Texto' },
      aiOff: { title: 'Sem IA', body: 'A sugestão sem IA escolhe pelas pausas, pelo ritmo da fala e pela atividade da tela. Para ligar a IA, instale o programa da IA neste computador ou cole uma chave em Ajustes → IA.' },
      found: {
        ai: (n: number): string => `${n} ${n === 1 ? 'corte sugerido' : 'cortes sugeridos'} pela IA.`,
        heuristic: (n: number): string => `${n} ${n === 1 ? 'corte sugerido' : 'cortes sugeridos'} sem IA.`
      },
      none: 'Não achei nenhum corte bom neste vídeo.',
      noneNew: 'Nenhum corte novo.',
      skipped: (n: number): string => `${n} ${n === 1 ? 'já existia e não foi repetido' : 'já existiam e não foram repetidos'}.`,
      dropped: (n: number): string => `${n} ${n === 1 ? 'sugestão foi descartada' : 'sugestões foram descartadas'} por não passar na conferência.`,
      droppedShow: 'Ver os motivos',
      droppedHide: 'Esconder os motivos',
      failed: 'Não consegui sugerir cortes',
      empty: { title: 'Nenhum corte ainda', body: 'Peça as sugestões acima. Você escolhe, ajusta e exporta os que quiser.' },
      listTitle: (n: number): string => (n === 1 ? '1 corte' : `${n} cortes`),
      card: {
        select: (title: string): string => `Selecionar o corte «${title}» para exportar`,
        duration: (span: string): string => span,
        notes: (h: number, f: number, v: number): string => `Gancho ${h} · Fluxo ${f} · Valor ${v}`,
        score: (n: number): string => `Nota ${n}`,
        preview: 'Ver',
        stopPreview: 'Sair da prévia',
        edit: 'Editar',
        close: 'Fechar',
        remove: 'Apagar',
        source: { ai: 'IA', heuristic: 'Sem IA', manual: 'Ajustado' }
      },
      edit: {
        title: 'Título',
        hook: 'Gancho (aparece nos 2 primeiros segundos)',
        hookCount: (n: number, max: number): string => `${n} de ${max} palavras`,
        hookTooLong: 'O gancho passa de 8 palavras: o vídeo mostra todas, mas fica mais fraco.',
        layout: 'Layout',
        layouts: { auto: 'Automático', greenscreen: 'Green screen', 'greenscreen-corner': 'Green screen no canto', 'screen-center': 'Tela ao centro', 'screen-focus': 'Cursor', stack: 'Câmera + tela', presenter: 'Você sem fundo', 'screen-wide': 'Tela larga', camera: 'Só câmera' },
        layoutHint: 'Automático escolhe pela atividade da tela; os outros valem o corte todo.',
        captions: 'Legenda',
        captionsInherit: 'Como no vertical',
        ranges: 'Trechos',
        range: (n: number, from: string, to: string): string => `${n}. ${from} a ${to}`,
        startEarlier: 'Começar uma frase antes',
        startLater: 'Começar uma frase depois',
        endEarlier: 'Terminar uma frase antes',
        endLater: 'Terminar uma frase depois',
        cannotMove: 'Não há mais frase nesse sentido.',
        text: 'Texto do corte',
        outOfRange: (span: string): string => `Este corte sai com ${span}: fora dos 30 a 60 s ideais.`,
        reason: 'Por que este trecho'
      },
      export: {
        title: 'Exportar',
        help: 'Vertical 1080×1920 em exports/cortes, com um .txt de legenda e hashtags ao lado de cada vídeo.',
        selected: (n: number): string => (n === 0 ? 'Nenhum corte selecionado' : n === 1 ? '1 corte selecionado' : `${n} cortes selecionados`),
        selectAll: 'Selecionar todos',
        selectNone: 'Limpar seleção',
        button: (n: number): string => (n === 1 ? 'Exportar o selecionado' : `Exportar ${n} selecionados`),
        buttonNone: 'Exportar selecionados',
        busy: 'Já há uma exportação em andamento. Espere ela terminar.',
        noText: 'A legenda do vertical está ligada, mas este projeto não tem transcrição: os cortes saem sem legenda.'
      },
      queue: {
        title: 'Fila de exportação',
        state: { queued: 'Na fila', running: 'Exportando', done: 'Pronto', error: 'Falhou', cancelled: 'Cancelado' },
        cancel: 'Cancelar a fila',
        cancelling: 'Cancelando…',
        retry: 'Tentar de novo',
        retryAll: (n: number): string => (n === 1 ? 'Tentar de novo o que falhou' : `Tentar de novo os ${n} que não saíram`),
        reveal: 'Mostrar na pasta',
        open: 'Tocar',
        clear: 'Limpar a lista',
        summary: (done: number, failed: number, cancelled: number, total: number): string =>
          `${done} de ${total} ${total === 1 ? 'corte exportado' : 'cortes exportados'}${failed > 0 ? `, ${failed} ${failed === 1 ? 'falhou' : 'falharam'}` : ''}${cancelled > 0 ? `, ${cancelled} ${cancelled === 1 ? 'cancelado' : 'cancelados'}` : ''}.`,
        finishedOk: (n: number): string => (n === 1 ? 'Corte exportado' : `${n} cortes exportados`),
        finishedBad: 'A fila terminou com falhas',
        openFailed: 'Não consegui abrir o arquivo',
        revealFailed: 'Não consegui abrir a pasta'
      },
      preview: {
        banner: (title: string): string => `Prévia do corte «${title}»`,
        exit: 'Sair da prévia'
      }
    },

    publish: {
      title: 'Publicar',
      help: 'Textos prontos para copiar. O Tomada não publica nada sozinho.',
      generate: 'Gerar com IA',
      generating: 'Gerando…',
      generateFailed: 'Não consegui gerar os textos',
      aiOff: { title: 'IA indisponível', body: 'Os títulos, a descrição, as tags e as hashtags vêm da IA. Para ligar a IA, instale o programa da IA neste computador ou cole uma chave em Ajustes → IA. Os capítulos por pausas funcionam sem ela.' },
      noTranscript: { title: 'Sem transcrição', body: 'Os textos saem da transcrição da voz. Transcreva o vídeo na aba Texto primeiro.', cta: 'Ir para a aba Texto' },
      notes: (list: string): string => `Ajustes feitos nas respostas: ${list}.`,
      copy: 'Copiar',
      copied: 'Copiado.',
      copyFailed: 'Não consegui copiar',
      youtube: 'YouTube',
      titles: 'Títulos (escolha um)',
      titleOption: (n: number): string => `Opção ${n}`,
      useTitle: 'Usar como título do projeto',
      titleUsed: 'Título do projeto trocado.',
      noTitles: 'Ainda sem títulos.',
      description: 'Descrição',
      descriptionPlaceholder: 'O que o vídeo mostra, para quem serve…',
      copyDescription: 'Copiar descrição com capítulos',
      chapters: 'Capítulos',
      chaptersHelp: 'No tempo do vídeo final: o primeiro em 00:00, pelo menos 3, cada um com 10 s ou mais.',
      chaptersByPauses: 'Gerar pelas pausas (sem IA)',
      chaptersNone: 'Ainda sem capítulos.',
      chaptersOk: 'Capítulos válidos para o YouTube.',
      chaptersProblems: (list: string): string => `Ainda não valem para o YouTube: ${list}.`,
      chaptersPausesNote: 'Gerados pelas pausas, sem IA: confira os títulos.',
      chapterTitle: (time: string): string => `Título do capítulo das ${time}`,
      tags: 'Tags',
      tagsHelp: 'Separadas por vírgula.',
      perClip: 'Por corte vertical',
      noClips: 'Crie cortes na aba Cortes para ter a legenda e as hashtags de cada um.',
      clipCaption: 'Legenda do post',
      tiktok: 'TikTok',
      reels: 'Reels',
      shorts: 'Shorts',
      hashtagsHelp: 'Separadas por espaço.',
      clipFallback: 'Sem texto guardado: a exportação usa o gancho e as palavras que mais aparecem no corte.',
      copyClip: 'Copiar legenda e hashtags'
    },

    ai: {
      title: 'Editar pedindo',
      help: 'Escreva o que quer mudar. A IA propõe a edição e o Tomada aplica como UMA mudança só: o Ctrl+Z desfaz tudo.',
      placeholder: 'Ex.: tira a parte do preço · faz um corte de 40 s sobre o login',
      ask: 'Pedir',
      asking: 'A IA está pensando…',
      suggestions: 'Sugestões',
      history: 'Histórico',
      historyEmpty: 'Nada pedido ainda.',
      unavailable: { title: 'IA indisponível', body: 'Para pedir edições, instale o programa da IA neste computador ou cole uma chave em Ajustes → IA. Os cortes sem IA e os capítulos por pausas funcionam nas abas Cortes e Publicar.' },
      noTranscript: { title: 'Sem transcrição', body: 'A IA edita pelo texto da transcrição. Transcreva o vídeo na aba Texto primeiro.', cta: 'Ir para a aba Texto' },
      status: { applied: 'Aplicado', refused: 'Recusado', noop: 'Sem mudança', cancelled: 'Cancelado', error: 'Erro' },
      applied: (summary: string): string => `${summary} Ctrl+Z desfaz.`,
      failed: 'Não consegui fazer o pedido',
      confirm: {
        title: 'Isto tira muito do vídeo',
        body: (pct: number, span: string): string => `Esta mudança remove ${pct}% do vídeo (${span}). Aplicar mesmo assim?`,
        ok: 'Aplicar',
        cancel: 'Cancelar'
      },
      refusedLine: (why: string): string => `Recusei: ${why}`,
      showDetails: 'Ver o que foi recusado',
      hideDetails: 'Esconder',
      goToPublish: 'Os títulos, a descrição e os capítulos ficam na aba Publicar.',
      recheck: 'Verificar de novo',
      cancelledByYou: 'Você cancelou: nada foi mudado.'
    },

    text: {
      title: 'Texto',
      words: (n: number): string => (n === 1 ? '1 palavra' : `${n.toLocaleString('pt-BR')} palavras`),
      noVoice: { title: 'Sem voz para transcrever', body: 'Este projeto não tem voz gravada. Grave de novo com o microfone ligado.' },
      needsPrepare: {
        title: 'Falta preparar a transcrição',
        body: 'Na primeira vez o Tomada baixa o que precisa (cerca de 2,5 GB) e fica pronto para sempre. A transcrição roda neste computador: a voz não sai daqui.'
      },
      preparing: { title: 'Preparando a transcrição', body: 'Pode continuar editando. O texto aparece aqui quando terminar.' },
      none: { title: 'Este projeto ainda não tem texto', body: 'Transcreva a voz para editar o vídeo pelo texto: apagar uma frase corta o vídeo.', cta: 'Transcrever' },
      queued: 'Na fila para transcrever…',
      running: (pct: number): string => `Transcrevendo… ${pct}%`,
      failed: 'Não consegui transcrever',
      loadFailed: 'Não consegui ler a transcrição',
      retry: 'Tentar de novo',
      cancel: 'Cancelar',
      transcribeAgain: 'Transcrever de novo',
      emptyResult: { title: 'Não achei fala neste áudio', body: 'A transcrição terminou sem nenhuma palavra. Confira se o microfone estava ligado e transcreva de novo.' },
      view: { label: 'Transcrição', struck: 'cortada', crutch: 'muleta', lowConfidence: 'o motor não tem certeza desta palavra' },
      pause: (text: string): string => `⏸ ${text}`,
      pauseTip: { cut: 'Cortar esta pausa', restore: 'Restaurar esta pausa' },
      selection: {
        count: (n: number): string => (n === 1 ? '1 palavra selecionada' : `${n} palavras selecionadas`),
        cut: 'Apagar',
        restore: 'Restaurar',
        clear: 'Limpar seleção'
      },
      search: {
        label: 'Buscar no texto',
        placeholder: 'Buscar no texto',
        none: 'Nada encontrado',
        count: (at: number, total: number): string => `${at} de ${total}`,
        next: 'Próxima',
        prev: 'Anterior',
        close: 'Fechar busca'
      },
      fix: { label: 'Corrigir o texto da palavra', hint: 'Vale só para a legenda. O som não muda.', save: 'Salvar', cancel: 'Cancelar', revert: 'Voltar ao original' },
      stats: (struckWords: number, total: number): string => `${struckWords.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')} palavras cortadas`
    },

    clean: {
      title: 'Limpeza',
      help: 'Tira silêncios, hesitações e recomeços de uma vez. Dá para revisar cada corte e desfazer com Ctrl+Z.',
      silence: {
        label: 'Silêncios',
        off: 'Manter',
        tutorial: 'Aula',
        natural: 'Natural',
        fast: 'Rápido',
        faster: 'Mais rápido',
        hint: {
          tutorial: 'O padrão: corta pausas acima de 0,6 s e deixa 0,28 s, nunca em cima de clique ou de página mudando, e no máximo 6 emendas por minuto.',
          natural: 'Corta pausas acima de 0,7 s e deixa 0,25 s.',
          fast: 'Corta pausas acima de 0,4 s e deixa 0,15 s (teto de 12 emendas por minuto).',
          faster: 'Corta pausas acima de 0,25 s e deixa 0,1 s (teto de 12 emendas por minuto).'
        }
      },
      hesitations: { label: 'Hesitações', hint: 'hã, hum, ahn e fala sem palavra' },
      crutches: { label: 'Muletas', hint: 'né, tipo, então… só as que o contexto mostra que sobram', count: (n: number): string => (n === 0 ? 'nenhuma por aqui' : n === 1 ? '1 sugestão' : `${n} sugestões`) },
      mode: { label: 'O que fazer com elas', cut: 'Cortar', mute: 'Silenciar', mixed: 'Misto', hint: 'Silenciar mantém a imagem e o tempo, só a voz some. Misto corta as hesitações e só silencia as muletas.' },
      retakes: {
        label: 'Recomeços',
        hint: 'Trechos que você disse errado e repetiu. A IA lê só o texto e aponta o que cortar.',
        find: 'Procurar recomeços',
        finding: 'Procurando…',
        found: (n: number): string => (n === 0 ? 'Nenhum recomeço encontrado' : n === 1 ? '1 recomeço encontrado' : `${n} recomeços encontrados`),
        dropped: (n: number): string => (n === 1 ? '1 sugestão sem sentido foi descartada.' : `${n} sugestões sem sentido foram descartadas.`),
        failed: 'Não consegui procurar os recomeços',
        unavailable: 'A IA não está disponível. Veja nos Ajustes como ligar.',
        include: 'Cortar os recomeços',
        confirm: {
          title: 'Isso corta muito do vídeo',
          body: (pct: number): string => `Os recomeços somam ${pct}% do vídeo. Confira a lista antes de aplicar: dá para restaurar cada um depois.`,
          ok: 'Aplicar mesmo assim'
        }
      },
      levelsLoading: 'Medindo o volume do áudio…',
      levelsFailed: 'Não consegui medir o volume do áudio: os silêncios usam só a transcrição.',
      preview: {
        none: 'Nada para limpar com estas escolhas.',
        back: (returned: string, from: string, to: string): string => `Volta ${returned} · de ${from} para ${to}`,
        cut: (removed: string, from: string, to: string): string => `Sai ${removed} · de ${from} para ${to}`,
        mute: (muted: string): string => `Voz silenciada: ${muted}`
      },
      counts: { silence: 'silêncios', hesitation: 'hesitações', 'gap-speech': 'falas sem palavra', crutch: 'muletas', retake: 'recomeços' },
      apply: 'Aplicar limpeza',
      appliedSaved: (removed: string): string => `Limpeza aplicada: sai ${removed}. Ctrl+Z desfaz.`,
      appliedMuteOnly: 'Limpeza aplicada: só silenciei trechos da voz. Ctrl+Z desfaz.',
      nothingToApply: 'Nada mudou: o documento já está assim.',
      auto: { label: 'Aplicar sozinho depois de transcrever', hint: 'Silêncio no ritmo de aula e hesitações, uma vez por gravação. Dá para desfazer.' },
      autoDone: (removed: string): string => `Limpeza automática aplicada: sai ${removed}. Ctrl+Z desfaz.`,
      review: {
        title: 'Cortes automáticos',
        none: 'Nenhum corte automático neste projeto.',
        reasons: { silence: 'Silêncios', filler: 'Hesitações e muletas', retake: 'Recomeços' },
        mutes: 'Voz silenciada',
        restore: 'Restaurar',
        enable: 'Cortar de novo',
        disabled: 'restaurado',
        goTo: 'Ver este trecho',
        more: (n: number): string => `Mostrar mais ${n}`,
        restoreAll: 'Restaurar todos',
        enableAll: 'Cortar todos de novo',
        pause: (text: string): string => `pausa de ${text}`,
        item: (n: number): string => (n === 1 ? '1 corte' : `${n} cortes`)
      }
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
      cutWords: 'Na aba Texto: apagar as palavras selecionadas',
      search: 'Na aba Texto: buscar uma palavra ou frase',
      split: 'Dividir o layout no ponto da reprodução',
      zoom: 'Criar zoom no intervalo marcado',
      blur: 'Desfocar até o fim (região selecionada)',
      undo: 'Desfazer',
      redo: 'Refazer',
      timelineZoom: 'Aproximar / afastar a linha do tempo',
      scroll: 'Rolar a linha do tempo',
      escape: 'Limpar a seleção'
    },

    export: {
      saveFailed: 'Não consegui salvar o projeto; nada foi exportado',
      title: 'Exportar vídeo',
      subtitle: 'MP4 para o YouTube, feito neste computador.',
      subtitleVertical: 'MP4 vertical para TikTok, Reels e Shorts, feito neste computador.',
      formatLabel: 'Formato',
      formats: { horizontal: 'YouTube 16:9', vertical: 'Vertical 9:16' },
      verticalCard: { name: 'Vertical 1080×1920', detail: '16 Mbps · áudio 192 kbps' },
      captionsNoText: 'A legenda está ligada, mas este projeto não tem transcrição: o vídeo sai sem legenda.',
      matteMissing: 'Este layout usa você sem fundo, e o recorte ainda não existe. Espere ele terminar (aba Câmera) ou escolha "Câmera + tela" na aba Layout para exportar já.',
      matteRunning: (pct: number): string => `Recortando você do fundo: ${pct}%. A exportação libera quando terminar.`,
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
      textSaved: (name: string): string => `Texto para publicar: ${name}`,
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
      browserHint: 'Escolha a janela do navegador para mostrar seu sistema. As abas e a barra de endereço são recortadas automaticamente.',
      browserBadge: 'Navegador · só a página',
      browserBadgeOther: 'Navegador',
      missing: 'A fonte escolhida da última vez não está mais aberta. Escolha outra.',
      size: (w: number, h: number): string => `${w}×${h}`
    },
    camera: {
      title: 'Câmera',
      none: 'Sem câmera',
      previewLabel: 'Prévia da câmera',
      guideLabel: 'Moldura-guia do enquadramento',
      guideTip: 'Mostre o tronco e as mãos; luz de frente.',
      loading: 'Abrindo a câmera…',
      off: 'Sem câmera: só a tela e o som.',
      noDevices: 'Nenhuma câmera encontrada.'
    },
    cameraStyle: {
      title: 'Estilo da câmera',
      'side-by-side': 'Quadro ao lado',
      presenter: 'Você sem fundo (green screen)',
      help: {
        'side-by-side': 'Sua câmera em um quadro ao lado da tela, com o fundo original.',
        presenter: 'Você na frente da tela, sem o fundo (no 16:9). O vertical usa o green screen no canto em qualquer escolha. Mostre o tronco e as mãos com luz de frente.'
      }
    },
    mic: {
      title: 'Microfone',
      none: 'Sem microfone',
      level: 'Nível do microfone',
      noDevices: 'Nenhum microfone encontrado.',
      default: 'Microfone padrão'
    },
    system: { title: 'Som do computador', help: 'Grava o que toca nos alto-falantes (vídeos, música, avisos).', on: 'Ligado', off: 'Desligado' },
    quality: { title: 'Quadros por segundo', fps30: '30', fps60: '60', help: '30 é suficiente para a maioria dos vídeos. 60 suaviza o movimento e usa mais espaço.' },
    advanced: {
      title: 'Ajustes do som e da bolha',
      noiseSuppression: 'Reduzir ruído do microfone',
      echoCancellation: 'Cancelar eco',
      bubble: 'Mostrar a bolha da câmera durante a gravação (não aparece no vídeo)',
      framingGuide: 'Mostrar a moldura-guia na prévia da câmera (não aparece no vídeo)'
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

  transcription: {
    steps: {
      python: 'Ambiente do Python',
      packages: 'Pacotes de transcrição',
      binary: 'Programa de transcrição',
      model: 'Modelo de voz',
      check: 'Teste final',
      // só a câmera usa estes (o recorte do fundo); estão aqui para o mapa cobrir todos os passos
      'matte-packages': 'Pacotes do recorte do fundo',
      'matte-model': 'Modelo do recorte do fundo',
      'matte-check': 'Teste do recorte do fundo'
    },
    state: { ready: 'Pronta', missing: 'Falta preparar', preparing: 'Preparando…', error: 'Com problema' },
    prepare: 'Preparar transcrição',
    preparing: 'Preparando…',
    cancel: 'Cancelar',
    retry: 'Tentar de novo',
    cancelled: 'Preparação cancelada. O que já foi baixado fica guardado e a próxima tentativa continua de onde parou.',
    failed: (message: string): string => `A preparação parou: ${message}`,
    failedStep: (step: string): string => `Parou em: ${step}`,
    done: 'Tudo pronto. A transcrição roda neste computador.',
    stepStatus: { pending: 'Na fila', running: 'Em andamento', done: 'Pronto', error: 'Erro' },
    chip: { queued: 'Na fila para transcrever', running: (pct: number): string => `Transcrevendo ${pct}%` }
  },

  /** A preparação da análise da câmera (M4c): pacotes e o detector de rosto. */
  cameraTools: {
    steps: {
      python: 'Ambiente do Python',
      packages: 'Pacotes do rosto',
      binary: 'Programa',
      model: 'Modelo do rosto',
      check: 'Teste do rosto',
      'matte-packages': 'Pacotes do recorte do fundo',
      'matte-model': 'Modelo do recorte do fundo',
      'matte-check': 'Teste do recorte do fundo'
    },
    stepStatus: { pending: 'Na fila', running: 'Em andamento', done: 'Pronto', error: 'Erro' },
    state: { ready: 'Pronta', missing: 'Falta preparar', preparing: 'Preparando…', error: 'Com problema' },
    prepare: 'Preparar a análise da câmera',
    preparing: 'Preparando…',
    cancel: 'Cancelar',
    retry: 'Tentar de novo',
    cancelled: 'Preparação cancelada. O que já foi baixado fica guardado e a próxima tentativa continua de onde parou.',
    failed: (message: string): string => `A preparação parou: ${message}`,
    failedStep: (step: string): string => `Parou em: ${step}`
  },

  bubble: { label: 'Bolha da câmera', error: 'Câmera indisponível' },

  settings: {
    cameraQuality: {
      title: 'Qualidade da câmera',
      help: 'Quanto da câmera o arquivo gravado guarda. O rosto é ampliado nos layouts Apresentador e lado a lado, e em 4K ele continua nítido.',
      max: 'Máxima',
      high: 'Alta (1080p)',
      help2: {
        max: 'Grava em 4K quando a câmera consegue 30 quadros por segundo com a luz de agora; senão grava em 1080p e avisa. O arquivo da câmera fica bem maior (cerca de 340 MB por minuto em 4K).',
        high: 'Grava sempre em 1080p (cerca de 120 MB por minuto): menos disco e menos esforço do computador.'
      }
    },
    cameraStyle: {
      title: 'Estilo da câmera',
      help: 'O estilo que a tela Gravar usa quando você grava a tela com a câmera. Você escolhe de novo a cada gravação.'
    },
    cameraSync: {
      unresolvedDevice: 'Não consegui identificar o aparelho físico. Escolha a câmera e o microfone pelo nome, em vez do dispositivo padrão, e tente novamente.',
      title: 'Calibrar sincronia',
      help: 'Compensa a latência da imagem para este par de câmera e microfone nas próximas gravações.',
      instructions: 'Grave 5 segundos e bata UMA palma no meio da gravação. De frente para a câmera, com o rosto à mostra, mostre as duas mãos abaixo do rosto: aproxime, encoste e afaste. Só as mãos se mexem. Fique em silêncio antes e depois da palma.',
      camera: 'Câmera', mic: 'Microfone',
      cameraName: (i: number): string => `Câmera ${i}`, micName: (i: number): string => `Microfone ${i}`,
      start: 'Calibrar sincronia', retry: 'Tentar novamente',
      recording: (seconds: number): string => `Gravando: ${seconds} s — bata uma palma`, analyzing: 'Medindo a palma…',
      saved: (offset: number): string => `Calibração salva: ${offset > 0 ? '+' : ''}${Math.round(offset)} ms. Será usada quando a medição automática não tiver confiança.`,
      failed: 'Não consegui calibrar a sincronia', captureFailed: 'A captura da calibração falhou. Tente novamente.', tooLarge: 'A captura ultrapassou o limite de 32 MB. Tente novamente.'
    },
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
    transcription: {
      title: 'Transcrição',
      help: 'O texto do que você diz, palavra por palavra, feito neste computador. Nada sai daqui.',
      status: 'Estado',
      device: 'Placa',
      cpu: 'Processador',
      auto: { label: 'Transcrever sozinho depois de cada gravação', hint: 'Se estiver pronta, começa assim que a gravação termina.' },
      autoClean: { label: 'Aplicar a limpeza sozinho', hint: 'Silêncio no ritmo de aula e hesitações, uma vez por gravação, desfazível.' },
      prefsFailed: 'Não consegui salvar esta escolha',
      dictionary: {
        label: 'Dicionário',
        help: 'Nomes próprios e termos que a transcrição deve acertar (um por linha). Vale para as próximas transcrições.',
        placeholder: 'Tomada\nKubernetes\nDra. Fulana',
        save: 'Salvar dicionário',
        saved: 'Dicionário salvo.',
        saveFailed: 'Não consegui salvar o dicionário',
        count: (n: number, max: number): string => `${n} de ${max} termos`
      }
    },
    ai: {
      title: 'IA',
      help: 'Usada só para achar recomeços no texto. Vai o texto da transcrição, nunca o áudio nem o vídeo.',
      status: { ready: 'Disponível', missing: 'Nada configurado' },
      preference: {
        label: 'Como usar',
        auto: 'Automático',
        cli: 'Programa deste computador',
        api: 'Chave de acesso'
      },
      key: {
        label: 'Chave de acesso',
        placeholder: 'Cole a chave aqui',
        save: 'Guardar chave',
        clear: 'Apagar a chave',
        saved: 'Chave guardada com segurança neste computador.',
        cleared: 'Chave apagada.',
        has: 'Há uma chave guardada (ela nunca é mostrada de novo).',
        none: 'Nenhuma chave guardada.',
        failed: 'Não consegui guardar a chave',
        help: 'Fica cifrada pelo cofre do Windows e só o Tomada a usa.'
      },
      cli: { found: 'Programa deste computador encontrado', missing: 'Programa deste computador não encontrado' },
      test: 'Testar',
      testing: 'Testando…',
      testOk: 'A IA respondeu.',
      testFailed: 'A IA não respondeu',
      prefsFailed: 'Não consegui salvar esta escolha'
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
