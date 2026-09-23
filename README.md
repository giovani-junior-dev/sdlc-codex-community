# SDLC Codex Community

CLI local para organizar equipes de sessões independentes do Codex, com comunicação bidirecional, estado persistente, worktree por demanda, evidências verificáveis e um pipeline de entrega determinístico.

O SDLC Codex coordena cinco papéis:

- `planner`: prepara e supervisiona o trabalho aprovado;
- `dev`: implementa e corrige o código;
- `reviewer`: revisa requisitos, diff e evidências de forma independente;
- `tester-e2e`: executa e documenta cenários de ponta a ponta;
- `document`: atualiza a documentação da entrega.

As sessões são sessões principais do Codex, abertas em abas do Herdr. Cada uma mantém seu próprio contexto e conversa com as demais por `codex queue`. O estado fica no projeto atendido, em `.sdlc-codex/`, permitindo retomar mensagens, claims e etapas depois de interrupções.

> **Versão atual:** `v0.1.0`, edição Community com histórico próprio. Base do produto validada no Windows com Node.js 22, Codex CLI e Herdr. O CI executa typecheck, 603 testes padrão e a suíte live em modo isolado. A validação live completa usou cinco sessões, comunicação nos dois sentidos, recuperação, revisão com correção e criação de PR real sem merge ou deploy.

## O que o produto faz

- abre ou reutiliza sessões Codex por papel;
- cria um worktree Git isolado para o desenvolvedor;
- encaminha tarefas, perguntas, respostas e notificações entre sessões;
- mantém IDs de mensagem, geração e execução para evitar duplicidade;
- persiste checkpoints e permite retomar trabalho interrompido;
- executa checks configurados pelo projeto;
- exige evidências ligadas ao estado atual do código;
- conduz workflows de feature, hotfix e revisão;
- cria ou reutiliza PR, sem fazer merge ou deploy;
- protege arquivos operacionais e branches configuradas por hooks locais;
- oferece diagnóstico somente leitura por `doctor` e `status`.

O produto não cria um daemon próprio, não usa banco interno do Codex como API e não altera a configuração global do Codex ou do Herdr.

## Requisitos

| Componente | Requisito |
|---|---|
| Sistema | Windows nativo |
| Node.js | 22 ou superior |
| npm | compatível com Node.js 22 |
| Git | instalado e disponível no `PATH` |
| Codex CLI | instalado, autenticado e com suporte a `codex queue` e hooks |
| Herdr | `0.7.5-preview` compatível, disponível no `PATH` |
| GitHub CLI (`gh`) | necessário para baixar a release pública e para os estágios de PR |

Verifique o ambiente:

```powershell
node --version
npm --version
git --version
codex --version
herdr --version
gh --version
gh auth status
```

O projeto atendido precisa ser um repositório Git. Para workflows `feature` e `hotfix`, configure um remoto GitHub e autentique o `gh` na conta que pode consultar, publicar a branch e criar a PR.

## Instalação da release pública

Autentique o GitHub CLI na conta com acesso ao repositório:

```powershell
gh auth login
gh auth status
```

Baixe e instale a release:

```powershell
$installDir = Join-Path $env:TEMP "sdlc-codex-v0.1.0"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

gh release download v0.1.0 `
  --repo giovani-junior-dev/sdlc-codex-community `
  --pattern "sdlc-codex-0.1.0.tgz" `
  --dir $installDir `
  --clobber

npm install --global (Join-Path $installDir "sdlc-codex-0.1.0.tgz")
```

Confirme a instalação:

```powershell
Get-Command sdlc-codex
npm ls --global --depth=0 sdlc-codex
sdlc-codex --help
```

No Windows, o npm normalmente cria os shims em `%APPDATA%\npm`. Se o PowerShell bloquear o arquivo `.ps1` pela política de execução, use:

```powershell
sdlc-codex.cmd --help
```

Se o comando não for encontrado, confira se a pasta global do npm está no `PATH`:

```powershell
npm prefix --global
$env:PATH -split ';'
```

## Instalação a partir do código-fonte

Use esta opção para desenvolver o próprio SDLC Codex:

```powershell
git clone https://github.com/giovani-junior-dev/sdlc-codex-community.git
cd sdlc-codex-community
npm ci
npm run typecheck
npm test
npm link
sdlc-codex --help
```

O repositório é público e pode ser clonado sem convite. O binário compilado é `dist/src/cli.js`.

## Atualização

Para atualizar, baixe a versão desejada e instale o pacote sobre a instalação atual:

```powershell
gh release list --repo giovani-junior-dev/sdlc-codex-community

# Substitua a versão e o arquivo quando houver uma release mais nova.
npm install --global .\sdlc-codex-0.1.0.tgz
```

Depois da atualização:

```powershell
sdlc-codex --help
sdlc-codex doctor --project C:\caminho\do\projeto --json
```

Execute novamente `adopt` em cada projeto para atualizar, de forma idempotente, o shim e os hooks gerenciados:

```powershell
sdlc-codex adopt --config C:\caminho\do\project-config.json --project C:\caminho\do\projeto
sdlc-codex adopt --config C:\caminho\do\project-config.json --project C:\caminho\do\projeto --apply
```

## Desinstalação

```powershell
npm uninstall --global sdlc-codex
```

A desinstalação global não remove `.sdlc-codex/`, hooks ou blocos gerenciados dos projetos adotados. Preserve o estado enquanto existirem execuções ou mensagens pendentes. Confira `status` e `doctor` antes de remover a integração de um projeto.

## Início rápido em um projeto

### 1. Entre na raiz do projeto

```powershell
cd C:\caminho\do\meu-projeto
git status
```

Use a raiz do checkout principal. O SDLC Codex pode localizar essa raiz a partir de subdiretórios e worktrees, mas `--project` explícito deixa scripts e diagnósticos mais claros.

### 2. Crie a configuração

Gere um UUID exclusivo:

```powershell
[guid]::NewGuid().ToString()
```

Crie `project-config.json`:

```json
{
  "schemaVersion": 1,
  "projectId": "11111111-2222-3333-4444-555555555599",
  "projectName": "Meu Projeto",
  "prBase": "main",
  "checks": {
    "build": { "executable": "npm", "args": ["run", "build"] },
    "lint": { "executable": "npm", "args": ["run", "lint"] },
    "unit": { "executable": "npm", "args": ["test"] },
    "e2e": { "executable": "npm", "args": ["run", "test:e2e"] }
  },
  "models": {},
  "protectedPaths": [".sdlc-codex", ".git", "AGENTS.md"]
}
```

| Campo | Uso |
|---|---|
| `schemaVersion` | Deve ser `1` nesta versão. |
| `projectId` | UUID estável e exclusivo. Não reutilize em outro projeto. |
| `projectName` | Nome humano usado na identificação do time. |
| `prBase` | Branch base das PRs e worktrees, por exemplo `main`. |
| `checks` | Comandos permitidos: `build`, `lint`, `unit` e `e2e`. |
| `models` | Modelo e esforço opcionais por papel. |
| `protectedPaths` | Caminhos protegidos contra escrita pelos agentes. |

Os argumentos de checks são vetores, não uma linha de shell. Um check também pode declarar `cwd` e `shell`, embora a forma sem shell seja preferível.

Para escolher modelos por papel, use identificadores aceitos pela instalação atual do Codex:

```json
{
  "models": {
    "planner": { "model": "MODELO_DISPONIVEL", "effort": "high" },
    "dev": { "model": "MODELO_DISPONIVEL", "effort": "xhigh" },
    "reviewer": { "model": "MODELO_DISPONIVEL", "effort": "high" }
  }
}
```

Esforços aceitos: `minimal`, `low`, `medium`, `high` e `xhigh`. A configuração encaminha o identificador ao Codex; ela não instala modelos nem comprova compatibilidade com provedores externos.

### 3. Faça a adoção em duas etapas

Veja primeiro os arquivos que seriam alterados:

```powershell
sdlc-codex adopt --config .\project-config.json --project . --json
```

Aplique depois da revisão:

```powershell
sdlc-codex adopt --config .\project-config.json --project . --apply --json
```

A adoção:

- grava `.sdlc-codex/config.json`;
- cria `.sdlc-codex/evidence/` e `.sdlc-codex/worktrees/`;
- instala um shim local em `.sdlc-codex/bin/`;
- acrescenta um bloco gerenciado ao `AGENTS.md`;
- mescla hooks em `.codex/hooks.json`;
- acrescenta exclusões ao `.gitignore`;
- cria `.bak` antes de modificar arquivos preexistentes.

Hooks e conteúdo externos são preservados. Um `.codex/hooks.json` malformado interrompe a adoção antes da gravação. A operação é idempotente, não altera configuração global e não copia credenciais.

### 4. Rode o diagnóstico

```powershell
sdlc-codex doctor --project .
sdlc-codex doctor --project . --json
```

`doctor` é somente leitura. Ele verifica Node.js, Codex, Herdr, queue, hooks, configuração, runtime, locks, sessões e entregas incertas. Nunca abre sessões, recupera mensagens, remove locks ou altera estado.

No `doctor`, exit code `1` significa aviso, item desconhecido ou recurso indisponível; não significa necessariamente corrupção. Leia os checks retornados.

### 5. Prepare os artefatos aprovados

Cada execução exige:

1. `intent.md`: problema, resultado esperado, escopo e itens fora do escopo;
2. `plan.md`: requisitos identificáveis, critérios, responsáveis e verificações;
3. `requirements.json`: manifesto estruturado dos requisitos;
4. `approval.json`: aprovação humana vinculada por hash aos três arquivos.

Exemplo de `intent.md`:

```markdown
# Intent: cadastro-cliente

## Problema

Permitir o cadastro de clientes com validação de e-mail.

## Escopo aprovado

- REQ-001 — criar o fluxo de cadastro.
- REQ-002 — validar e-mail duplicado.
- REQ-003 — cobrir o cenário principal em e2e.

## Fora do escopo

- Migração de clientes antigos.
```

Exemplo de `plan.md`:

```markdown
# Plano: cadastro-cliente

- REQ-001 — implementar endpoint e persistência.
- REQ-002 — rejeitar e-mail já cadastrado.
- REQ-003 — validar cadastro e duplicidade em e2e.

## Evidências esperadas

- build e testes unitários para REQ-001 e REQ-002;
- revisão independente para todos os requisitos;
- execução e2e para REQ-003.
```

Depois de calcular o SHA-256 de `plan.md`, crie `requirements.json`:

```json
{
  "schemaVersion": 1,
  "manifestPath": "requirements.json",
  "planPath": "plan.md",
  "planHash": "SHA256_DO_PLANO",
  "entries": [
    { "id": "REQ-001", "stage": "any", "mandatory": true },
    { "id": "REQ-002", "stage": "review", "mandatory": true },
    { "id": "REQ-003", "stage": "e2e", "mandatory": true }
  ],
  "documentRoots": ["docs"]
}
```

Cada ID deve aparecer literalmente no plano. `documentRoots` define os únicos caminhos que `document` pode alterar depois da revisão final. Não coloque código nessas raízes.

Uma dispensa de check precisa ser decidida antes da aprovação e registrada no manifesto:

```json
{
  "checkExemptions": [
    {
      "workflow": "feature",
      "stage": "e2e",
      "check": "e2e",
      "reason": "Projeto sem interface executável"
    }
  ]
}
```

`checks: {}` não representa dispensa. Um check obrigatório ausente reprova o gate, salvo quando existe uma dispensa válida no manifesto aprovado.

Depois da revisão e aprovação humana, calcule os hashes e grave `approval.json`:

```powershell
$intentHash = (Get-FileHash .\intent.md -Algorithm SHA256).Hash.ToLowerInvariant()
$planHash = (Get-FileHash .\plan.md -Algorithm SHA256).Hash.ToLowerInvariant()
$manifestHash = (Get-FileHash .\requirements.json -Algorithm SHA256).Hash.ToLowerInvariant()

$approval = [ordered]@{
  intentPath = "intent.md"
  planPath = "plan.md"
  approvedAt = (Get-Date).ToUniversalTime().ToString("o")
  approvedBy = "NOME_DA_PESSOA"
  planVersion = "cadastro-cliente-v1"
  intentHash = $intentHash
  planHash = $planHash
  requirementsManifestPath = "requirements.json"
  requirementsManifestHash = $manifestHash
}

$utf8SemBom = New-Object System.Text.UTF8Encoding($false)
$approvalJson = $approval | ConvertTo-Json
$approvalPath = Join-Path (Get-Location) "approval.json"
[System.IO.File]::WriteAllText($approvalPath, $approvalJson, $utf8SemBom)
```

O `planHash` de `requirements.json` deve ser igual ao hash atual de `plan.md` antes de calcular `requirementsManifestHash`. Alterações posteriores em intent, plano, manifesto ou configuração exigem nova aprovação e novo `start`.

Grave os arquivos JSON em UTF-8 sem BOM. No Windows PowerShell 5.1, `Set-Content -Encoding utf8` adiciona BOM; por isso o exemplo usa `WriteAllText` com `UTF8Encoding($false)`.

### 6. Abra o time

```powershell
sdlc-codex up cadastro-cliente --workflow feature --project . --json
```

| Workflow | Sequência |
|---|---|
| `feature` | `build → review → e2e → pr → pr-review → document` |
| `hotfix` | `build → review → pr → pr-review` |
| `review-only` | `review` |

O `planner` é incluído no time padrão. Uma abertura parcial impede o início da execução.

No Windows, escolha o sandbox apenas para as novas sessões abertas pelo comando:

```powershell
sdlc-codex up cadastro-cliente --workflow feature --project . --windows-sandbox elevated
```

Se o setup elevado falhar, use o fallback oficial:

```powershell
sdlc-codex up cadastro-cliente --workflow feature --project . --windows-sandbox unelevated
```

O sandbox continua ativo em `unelevated`; nenhuma configuração global é alterada.

### 7. Inicie a execução

```powershell
sdlc-codex start cadastro-cliente `
  --intent .\intent.md `
  --plan .\plan.md `
  --approval .\approval.json `
  --workflow feature `
  --project . `
  --json
```

O `start` valida time, hashes, manifesto, configuração e ausência de outra execução ativa. Em sucesso, persiste a execução e a entrega inicial na mesma transação e envia o kickoff.

Cada sessão então recebe a mensagem, trabalha, produz evidências, chama `next` e encerra o turno. O motor escolhe o próximo estágio e notifica o planner.

### 8. Acompanhe o trabalho

```powershell
sdlc-codex status --project .
sdlc-codex status cadastro-cliente --project . --json
```

`status` é somente leitura e mostra etapa, responsável, revisão, tentativas, mensagens e pendências. Silêncio não é interpretado automaticamente como morte da sessão.

## Referência de comandos

Todos aceitam `--project <raiz>`. Use `--json` para scripts.

### `doctor`

```powershell
sdlc-codex doctor --project . --json
```

Diagnóstico somente leitura do ambiente e do projeto.

### `adopt`

```powershell
sdlc-codex adopt --config .\project-config.json --project .
sdlc-codex adopt --config .\project-config.json --project . --apply
```

Sem `--apply`, calcula as alterações. Com `--apply`, instala ou atualiza os arquivos gerenciados.

### `up`

```powershell
sdlc-codex up <slug> --workflow feature --project .
sdlc-codex up <slug> --roles planner,reviewer --project .
```

Abre ou reutiliza sessões. `--roles` seleciona explicitamente papéis a relançar.

Se uma geração estiver `unknown` e o Herdr não puder provar que morreu, a substituição exige decisão humana:

```powershell
sdlc-codex up <slug> --roles reviewer --replace-unknown --project .
```

### `start`

```powershell
sdlc-codex start <slug> --intent intent.md --plan plan.md --approval approval.json --workflow feature --project .
```

Inicia uma execução aprovada. Existe no máximo uma execução ativa por projeto.

### `send`

O corpo vem de arquivo para preservar múltiplas linhas, Unicode e caracteres especiais:

```powershell
sdlc-codex send `
  --from dev --to planner --type question `
  --body-file .\pergunta.md --run RUN_ID `
  --project . --json
```

Uma resposta aponta para a pergunta original:

```powershell
sdlc-codex send `
  --from planner --to dev --type answer `
  --body-file .\resposta.md --run RUN_ID `
  --reply-to MESSAGE_ID_DA_PERGUNTA `
  --project . --json
```

Tipos permitidos: `question`, `answer` e `notify`.

### `receive`

```powershell
sdlc-codex receive MESSAGE_ID `
  --role dev --thread THREAD_UUID --generation GENERATION_ID `
  --checkpoint .\checkpoint.json --project . --json
```

O resultado pode ser `execute`, `duplicate`, `stale` ou `resume`. Papel, thread e geração precisam corresponder à sessão vigente.

### `finish-message`

```powershell
sdlc-codex finish-message MESSAGE_ID `
  --role planner --thread THREAD_UUID --generation GENERATION_ID `
  --project .
```

Finaliza conversas e notificações. Tarefas de estágio são concluídas por `next`.

### `check`

```powershell
sdlc-codex check cadastro-cliente `
  --stage build --thread THREAD_UUID --generation GENERATION_ID `
  --project . --json
```

Executa checks e grava logs e evidências. O payload contém o snapshot do código; evidências humanas devem copiar esse snapshot para `codeSnapshot`.

### `next`

```powershell
sdlc-codex next cadastro-cliente build pass `
  --revision 0 `
  --operation-id cadastro-cliente-build-0 `
  --evidence .\evidence-build.json `
  --commit COMMIT_SHA `
  --role dev --thread THREAD_UUID --generation GENERATION_ID `
  --project . --json
```

`operation-id` precisa ser estável para o mesmo efeito. Repetir a mesma operação é idempotente; reutilizar o ID com payload diferente causa conflito. Uma reprovação pode informar `--gap` e `--blocked`.

Um `pass` só é aceito quando todas as evidências pertencem ao projeto, execução, etapa, revisão, ator e estado atual do código.

### `recover`

```powershell
sdlc-codex recover cadastro-cliente --limit 100 --project . --json
```

Reconcilia e reenvia entregas pendentes, incertas ou falhas usando o mesmo ID. Uma entrega já confirmada como enfileirada não é reenviada cegamente.

Para liberar um claim interrompido e retomar o checkpoint:

```powershell
sdlc-codex recover cadastro-cliente `
  --claim MESSAGE_ID --role dev `
  --thread THREAD_UUID --generation GENERATION_ID `
  --project . --json
```

### `hook`

Os hooks são chamados pelo Codex após a adoção. Para um diagnóstico controlado:

```powershell
sdlc-codex hook SessionStart --payload-file .\payload.json --project . --json
```

Eventos gerenciados incluem `PreToolUse`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`, `UserPromptSubmit` e `Stop`.

## Códigos de saída

| Código | Significado |
|---|---|
| `0` | Sucesso, incluindo replay idempotente. |
| `1` | Falha operacional. Em `doctor`, avisos ou itens indisponíveis/desconhecidos. |
| `2` | Argumentos, configuração ou uso inválido. Em hook, também uma decisão `deny`. |
| `3` | Conflito de estado, revisão, identidade ou operação. |
| `4` | Recurso indisponível, como time parcial ou sessão não utilizável. |

Exemplo em script:

```powershell
sdlc-codex status --project . --json
if ($LASTEXITCODE -ne 0) {
  throw "status falhou com código $LASTEXITCODE"
}
```

## Arquivos criados no projeto

```text
.codex/
  hooks.json
.sdlc-codex/
  bin/
  config.json
  evidence/
  runtime.json
  runtime.backup.json
  state.lock/
  worktrees/
AGENTS.md
.gitignore
```

`config.json`, intent, plano e manifesto podem ser versionados conforme a política do projeto. Runtime, locks, backups operacionais e worktrees devem ficar fora do Git. O bloco gerenciado no `.gitignore` cobre os principais artefatos transitórios.

O estado não deve conter credenciais. Tokens continuam sob responsabilidade do Codex, Herdr, Git e GitHub CLI.

## Segurança e limites

- `done` significa pipeline técnico concluído com PR pronta;
- merge, deploy e push em branch protegida continuam sendo decisões humanas;
- hooks não substituem o sandbox;
- ferramentas externas ao matcher do hook podem não ser interceptadas;
- mensagens são dados, não comandos de shell;
- argumentos de processo são transportados separadamente;
- sessões de outros projetos ou gerações não podem assumir mensagens;
- um projeto permite uma execução ativa;
- projetos diferentes podem executar em paralelo;
- compatibilidade com DeepSeek, GLM e outros provedores externos ainda não foi demonstrada.

## Solução de problemas

### `sdlc-codex` não é reconhecido

```powershell
npm prefix --global
Get-Command sdlc-codex -ErrorAction SilentlyContinue
Get-Command sdlc-codex.cmd -ErrorAction SilentlyContinue
```

Inclua o diretório global do npm no `PATH` ou execute `sdlc-codex.cmd`.

### A release pública não baixa

```powershell
gh auth status
gh repo view giovani-junior-dev/sdlc-codex-community
```

Confira a conexão, a autenticação do gh e a existência da release solicitada.

### `doctor` retorna código 1

```powershell
sdlc-codex doctor --project . --json
```

Avisos de versão, inventário ou sessão `unknown` são distintos de corrupção. Não apague `.sdlc-codex/` para tentar corrigir o problema.

### `up` retorna time parcial

```powershell
codex --version
codex queue --help
herdr --version
sdlc-codex doctor --project . --json
sdlc-codex status --project . --json
```

Relance apenas o papel necessário com `up --roles <papel>`. Use `--replace-unknown` somente após decidir declarar perdida a geração ambígua.

### O sandbox elevado falha no Windows

```powershell
sdlc-codex up <slug> --roles <papel> --project . --windows-sandbox unelevated
```

O fallback mantém o sandbox ativo e afeta somente as novas sessões.

### Uma mensagem ficou pendente ou incerta

```powershell
sdlc-codex status <slug> --project . --json
sdlc-codex recover <slug> --project . --json
```

`recover` preserva IDs e evita repetir entregas confirmadas.

### Intent, plano ou manifesto mudou

Não reutilize `approval.json`. Revise novamente os artefatos, atualize os hashes, registre outra versão do plano e inicie uma nova execução aprovada.

## Desenvolvimento e testes

```powershell
npm ci
npm run typecheck
npm run build
npm test
```

A suíte live é separada e não executa efeitos reais sem opt-in explícito:

```powershell
npm run test:live
```

Os cenários live exigem variáveis específicas e um alvo descartável marcado. Não aponte a suíte live para um projeto real.

## Documentação técnica

- [Testes e limites de validação](docs/testing.md)
- [Segurança](SECURITY.md)

- [Arquitetura](docs/architecture.md)
- [Operação local](docs/operations.md)
- [Compatibilidade e limites](docs/compatibility.md)

## Release atual

- Repositório: <https://github.com/giovani-junior-dev/sdlc-codex-community>
- Release: <https://github.com/giovani-junior-dev/sdlc-codex-community/releases/tag/v0.1.0>
- Pacote: `sdlc-codex-0.1.0.tgz`
- SHA-256: consulte `SHA256SUMS.txt` nos assets da release.

O pacote inclui o CLI compilado, papéis, templates e o guia de instalação da versão. Código-fonte, testes, logs, estado local e credenciais não fazem parte do artefato instalado.

## Licença

Disponível sob a [licença MIT](LICENSE). Você pode usar, modificar e redistribuir o projeto, inclusive comercialmente, preservando o aviso de copyright e a licença.
