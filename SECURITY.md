# Segurança

Não publique tokens, senhas, arquivos de autenticação, backups ou dumps reais de sessões em commits, issues e PRs. O runtime de projetos atendidos pode conter tokens internos e IDs de sessões: mantenha .sdlc-codex fora do versionamento.

Este repositório contém fontes, documentação e fixtures sintéticas. Não carrega histórico de desenvolvimento privado ou evidências operacionais brutas.

Antes de enviar alterações, revise git diff --cached e execute Gitleaks com valores redigidos:

```powershell
gitleaks git . --log-opts="--all" --ignore-gitleaks-allow --redact=100
gitleaks dir . --redact=100
```

O workflow Secret scan verifica o histórico nas alterações. Não use dados reais para substituir exemplos de testes. Nunca anexe uma credencial para demonstrar um problema; compartilhe passos de reprodução com valores fictícios.
