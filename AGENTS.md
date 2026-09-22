# SDLC Codex Community

CLI local para coordenar sessões independentes do Codex em cinco papéis: planner, dev, reviewer, tester-e2e e document. Este repositório público tem histórico próprio e apenas dados sintéticos de teste.

## Desenvolvimento

- Leia README.md e docs/architecture.md antes de alterar contratos, persistência, hooks ou pipeline.
- Mantenha método, adaptadores de processo e armazenamento separados. Preserve argumentos estruturados ao iniciar processos.
- Use adaptadores falsos e diretórios temporários nos testes padrão. Testes live são opt-in e precisam de autorização explícita e alvo descartável.
- Antes de entregar, execute npm run typecheck, npm test e npm run test:live sem opt-in. Registre resultados reais e limitações.
- Não inclua runtime, credenciais, dumps reais de sessões, backups ou dados de usuários. Consulte SECURITY.md.
- Preserve mudanças existentes. Publicar este projeto não autoriza merge ou deploy dos projetos atendidos por ele.

## Método

O planner esclarece requisitos e obtém aprovação. O dev implementa; reviewer e tester-e2e verificam independentemente; document registra o resultado. O motor determina a próxima etapa com base em evidências verificáveis. Merge, deploy e mudança de escopo dependem de decisão humana.

Suporte principal: Windows nativo, Node.js 22+, Codex CLI com queue/hooks e Herdr compatível. Não alegue compatibilidade live com versões que não foram verificadas.
