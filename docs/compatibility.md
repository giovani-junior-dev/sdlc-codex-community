# Compatibilidade e limites

Base do produto previamente validada: Windows nativo, Node.js 22.20.0, Codex CLI 0.155.1 e Herdr 0.7.5-preview. São versões observadas, não uma garantia para toda versão posterior. O pacote requer Node.js >=22.

Antes de usar, confira node/npm/git/codex/herdr/gh no PATH, codex queue --help, codex features list, codex login status e gh auth status. Após instalar, execute sdlc-codex doctor --project . --json. O doctor é somente leitura; um projeto ainda não adotado pode apresentar configuração ausente.

Instaladores oficiais: [Node.js](https://nodejs.org/en/download), [Git](https://git-scm.com/install/windows), [GitHub CLI](https://cli.github.com/), [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), [Herdr](https://herdr.dev/docs/install/).

## O que os testes demonstram

Os testes padrão verificam contratos, isolamento, armazenamento, concorrência, mensagens, launcher, gates, evidências e CLI com adaptadores falsos. Na base do produto também houve validação live de cinco papéis, comunicação bidirecional, recuperação por checkpoint e fluxo feature com PR real, sem merge/deploy.

Este repositório não publica dumps reais, UUIDs de sessões, tokens nem logs privados dessas execuções. CI padrão não substitui uma nova validação live no seu ambiente.

## Limitações conhecidas

- Windows é o alvo principal. Outras plataformas não têm a mesma cobertura live.
- Provedores externos como DeepSeek e GLM continuam em pesquisa.
- Walkthrough em máquina limpa, dois projetos simultâneos e falha live entre persistência e envio exigem validação adicional.
- Atualizações do Codex/Herdr podem mudar contratos. Compare a ajuda instalada com os requisitos do CLI.
- Instalação no Windows pode exigir reabrir o terminal para atualizar PATH. Use shims .cmd quando o PowerShell bloquear .ps1, sem mudar políticas globais automaticamente.
