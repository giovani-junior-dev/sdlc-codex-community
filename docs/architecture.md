# Arquitetura

SDLC Codex é um CLI local em Node.js e TypeScript. Mantém o estado da demanda fora do contexto dos agentes e endereça sessões por UUID. Nomes de sessões são rótulos, não endereços de transporte.

## Módulos

| Responsabilidade | Código |
| --- | --- |
| Contratos, configuração e validação | src/contracts.ts, src/project/ |
| Estado transacional, revisão, locks e backup | src/state/ |
| Máquina de estados e identidade das operações | src/pipeline/ |
| Outbox, mensagens, confirmações e correlação | src/messages/ |
| Registro de geração, readiness e lançamento | src/sessions/ |
| Processos, Git, Codex e Herdr | src/adapters/ |
| Evidências, execução de checks e snapshots | src/evidence/ |
| Contexto, eventos e política de hooks | src/hooks/ |
| Comandos e composição das dependências | src/cli.ts |

## Execução

1. adopt prepara configuração, instruções, hooks e exclusões, preservando arquivos existentes.
2. up prepara o time, worktree e identidade de cada geração. Readiness e registro são verificações distintas.
3. O planner produz intent, plano e manifesto. start exige os artefatos e hashes de aprovação válidos.
4. A transição e a outbox são persistidas antes de qualquer envio. O despacho externo ocorre fora do lock.
5. Cada agente recebe sua tarefa, persiste evidências e entrega a rubrica. O motor verifica os gates antes de avançar.
6. A recuperação usa estado persistido e geração vigente; operações identificadas não devem repetir efeitos já confirmados.

## Papéis e workflows

- planner: escopo, aprovação e supervisão.
- dev: implementação e correções no worktree.
- reviewer: revisão independente do código e da PR.
- tester-e2e: validação executável da aplicação.
- document: documentação do comportamento entregue.

Feature: build → review → e2e → pr → pr-review → document.
Hotfix: build → review → pr → pr-review.
Review-only: review.

Há um pipeline ativo por projeto. Conclusão técnica não faz merge ou deploy. Evidências precisam corresponder à execução, etapa e commit/snapshot verificados. Retries e correções têm limites; estados terminais não executam novas tarefas.

## Armazenamento e limites

O diretório .sdlc-codex do projeto atendido contém estado, evidências, hooks e worktrees. Runtime pode conter tokens internos de registro e identificadores de sessões: não deve ser publicado. Os adaptadores não usam o banco interno do Codex como API.

O produto não oferece comunicação entre máquinas, daemon próprio ou dashboard operacional web. A landing page em site/ é somente documentação/apresentação. Consulte [compatibilidade](compatibility.md) e [testes](testing.md).
