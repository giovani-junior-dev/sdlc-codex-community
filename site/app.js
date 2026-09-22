const steps = [
  {
    title: 'Confira as ferramentas instaladas',
    terminal: 'node --version\nnpm --version\ngit --version\ngh --version\nherdr --version\ncodex --version\ncodex login status\ncodex queue --help\ncodex features list\ngh auth status',
    prompt: 'Confira se esta máquina Windows está pronta para usar o SDLC Codex. Verifique Node.js 22+, npm, Git, GitHub CLI, Herdr e Codex CLI no PATH. Consulte codex login status, codex queue --help, codex features list e gh auth status.\n\nCompare as versões com o registro de compatibilidade do SDLC Codex. Se algo faltar, indique o link oficial e o passo de instalação. Herdr: https://herdr.dev/docs/install/. Não instale nem atualize ferramentas nesta verificação. Não altere credenciais ou configurações globais. Informe o que está pronto e o que ainda precisa de ação humana.',
    summary: 'Cada comando deve ser reconhecido antes de continuar.',
    note: 'Instale os componentes pelos links acima. Se necessário, faça login com codex login e gh auth login. Confirme que queue está disponível e que hooks está habilitado; em caso de divergência, consulte a compatibilidade antes de prosseguir.'
  },
  {
    title: 'Instale a release pública',
    terminal: '# Autentique a conta com acesso ao repositório\ngh auth login\ngh auth status\n\n# Baixe em uma pasta temporária exclusiva\n$installDir = Join-Path $env:TEMP ("sdlc-codex-" + [guid]::NewGuid())\nNew-Item -ItemType Directory -Path $installDir | Out-Null\ngh release download v0.1.0 --repo giovani-junior-dev/sdlc-codex-community --pattern "sdlc-codex-0.1.0.tgz" --dir $installDir\nnpm install --global (Join-Path $installDir "sdlc-codex-0.1.0.tgz")\n\n# Confirme que o CLI está disponível\nGet-Command sdlc-codex\nsdlc-codex --help',
    prompt: 'Prepare esta máquina Windows para usar o SDLC Codex.\n\nVerifique Node.js 22+, Git, GitHub CLI, Codex CLI autenticado e Herdr. Consulte o repositório público giovani-junior-dev/sdlc-codex-community.\n\nLeia o README e instale a release v0.1.0 em uma pasta temporária nova. Valide com sdlc-codex --help. Se faltar autenticação ou algum pré-requisito, explique o passo necessário e aguarde minha ação. Não altere credenciais nem configurações globais do Codex.',
    summary: 'O pacote instala o SDLC Codex; os requisitos são instalados separadamente.',
    note: 'A release é pública e pode ser baixada pelos alunos. Após instalar, abra o terminal na raiz do projeto que será atendido e siga a etapa 03. Não execute adopt dentro da pasta temporária de instalação.'
  },
  {
    title: 'Adote o projeto com os checks reais',
    terminal: '# Na raiz do projeto, prepare project-config.json\n# seguindo o schema e o exemplo do README.\nsdlc-codex doctor --project . --json\n\n# Primeiro, confira a prévia:\nsdlc-codex adopt --config .\\project-config.json --project . --json\n\n# Depois, aplique a configuração conferida:\nsdlc-codex adopt --config .\\project-config.json --project . --apply --json',
    prompt: 'Prepare este repositório para o SDLC Codex. Leia as instruções locais e o README de giovani-junior-dev/sdlc-codex-community.\n\nExecute doctor e identifique os comandos reais de build, lint, testes unitários e e2e. Crie project-config.json válido em UTF-8 sem BOM, com projectId UUID, branch base e caminhos protegidos corretos. Não invente checks nem use comandos que sempre passam.\n\nConfira a prévia de adopt, preserve as configurações existentes e aplique a adoção quando estiver válida. Se faltar uma decisão do projeto, pergunte. Não inicie uma demanda nem faça commit, push, merge ou deploy nesta preparação.',
    summary: 'A adoção configura o projeto; ainda não executa a demanda.',
    note: 'project-config.json deve existir antes de adopt. Use o prompt para gerar a configuração com os checks do seu projeto ou siga o schema do README. JSON deve estar em UTF-8 sem BOM.'
  },
  {
    title: 'Abra as cinco sessões do time',
    terminal: '# Na raiz do projeto já adotado:\nsdlc-codex up primeira-demanda --workflow feature --project . --json\n\n# Confira as sessões e o estado:\nsdlc-codex status --project . --json\n\n# Continue no planner para definir a demanda.\n# start exige plano e artefatos de aprovação válidos.',
    prompt: 'Neste projeto já adotado, abra o time SDLC Codex para a demanda primeira-demanda, com workflow feature. Confira que planner, dev, reviewer, tester-e2e e document estão prontos.\n\nNo planner, esclareça comigo o objetivo e os critérios de aceite. Prepare intent, plano, manifesto de requisitos e os artefatos exigidos pelo método.\n\nAguarde minha aprovação explícita antes de start. Não fabrique hashes ou evidências de aprovação. Durante a execução aprovada, exija revisão independente, testes e documentação. Merge, deploy e ampliação do escopo continuam dependentes de decisão humana.',
    summary: 'Time aberto. O próximo passo é aprovar o plano com o planner.',
    note: 'Abrir sessões pode consumir a cota do seu Codex. up prepara o time; start é uma etapa separada, condicionada à aprovação válida. A conclusão técnica não realiza merge nem deploy.'
  }
];

let selectedStep = 0;
let selectedMode = 'terminal';
const code = document.querySelector('#tutorial-code');
const status = document.querySelector('#copy-status');
const copyButton = document.querySelector('#copy-code');

function renderTutorial() {
  const step = steps[selectedStep];
  code.textContent = step[selectedMode];
  document.querySelector('#code-title').textContent = step.title;
  document.querySelector('#code-language').textContent = selectedMode === 'terminal' ? 'POWERSHELL' : 'CODEX';
  document.querySelector('#step-summary').textContent = step.summary;
  document.querySelector('#tutorial-note').textContent = step.note;
  document.querySelectorAll('[data-step]').forEach(button => {
    const active = Number(button.dataset.step) === selectedStep;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('[data-mode]').forEach(button => {
    const active = button.dataset.mode === selectedMode;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
  status.textContent = '';
  copyButton.setAttribute('aria-label', selectedMode === 'terminal' ? 'Copiar comandos' : 'Copiar prompt');
}

document.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => {
  selectedStep = Number(button.dataset.step);
  renderTutorial();
}));
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
  selectedMode = button.dataset.mode;
  renderTutorial();
}));
copyButton.addEventListener('click', async () => {
  const text = code.textContent;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    status.textContent = 'Copiado. Cole no terminal ou na sessão do Codex.';
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = 'Cópia automática indisponível. O texto foi selecionado: pressione Ctrl+C ou use Copiar no seu dispositivo.';
  }
});

const menuToggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
function closeMenu() {
  menuToggle.setAttribute('aria-expanded', 'false');
  navigation.classList.remove('open');
}
menuToggle.addEventListener('click', () => {
  const open = menuToggle.getAttribute('aria-expanded') !== 'true';
  menuToggle.setAttribute('aria-expanded', String(open));
  navigation.classList.toggle('open', open);
});
navigation.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menuToggle.getAttribute('aria-expanded') === 'true') {
    closeMenu();
    menuToggle.focus();
  }
});
window.matchMedia('(max-width: 760px)').addEventListener('change', closeMenu);
renderTutorial();

const header = document.querySelector('.header');
function updateHeaderGlass() {
  header.classList.toggle('is-scrolled', window.scrollY > 16);
}
window.addEventListener('scroll', updateHeaderGlass, { passive: true });
window.addEventListener('pageshow', updateHeaderGlass);
updateHeaderGlass();

// Decorative motion is optional; the poster works without JS or autoplay.
const heroVideo = document.querySelector('#hero-video');
const motionToggle = document.querySelector('#motion-toggle');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let userPaused = false;
let heroVisible = true;
let videoFailed = false;
function updateMotionControl() {
  const paused = heroVideo.paused;
  motionToggle.textContent = paused ? 'Reproduzir animação ▷' : 'Pausar animação Ⅱ';
  motionToggle.setAttribute('aria-label', paused ? 'Reproduzir animação' : 'Pausar animação');
}
async function syncHeroMotion() {
  if (reducedMotion.matches || videoFailed) {
    heroVideo.pause();
    heroVideo.classList.remove('is-playing');
    motionToggle.hidden = true;
    return;
  }
  if (!heroVideo.src) {
    heroVideo.src = heroVideo.dataset.src;
    heroVideo.muted = true;
  }
  motionToggle.hidden = false;
  if (userPaused || !heroVisible || document.hidden) {
    heroVideo.pause();
  } else {
    try { await heroVideo.play(); } catch { /* Browser may require the play button. */ }
  }
  updateMotionControl();
}
heroVideo.addEventListener('playing', () => {
  heroVideo.classList.add('is-playing');
  updateMotionControl();
});
heroVideo.addEventListener('pause', updateMotionControl);
heroVideo.addEventListener('error', () => {
  videoFailed = true;
  syncHeroMotion();
});
motionToggle.addEventListener('click', () => {
  userPaused = !heroVideo.paused;
  syncHeroMotion();
});
reducedMotion.addEventListener('change', syncHeroMotion);
document.addEventListener('visibilitychange', syncHeroMotion);
new IntersectionObserver(([entry]) => {
  heroVisible = entry.isIntersecting;
  syncHeroMotion();
}, { threshold: 0.05 }).observe(document.querySelector('.hero'));
