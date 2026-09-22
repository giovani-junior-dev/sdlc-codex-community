# Testes

```powershell
npm ci
npm run typecheck
npm test
npm run test:live
```

Sem opt-in, a suíte live deve pular os cenários com efeitos externos. Não configure SDLC_LIVE durante a validação padrão. A suíte padrão usa adaptadores falsos; o CLI real pode consumir cota, abrir sessões, criar branches e operar PRs quando autorizado em uma execução live.

Os testes residem em tests/unit, tests/integration e tests/live. Os fixtures são sintéticos. A base possui 603 testes padrão, incluindo um caso de permissões que é pulado no Windows.

Se a carga local causar timeout de readiness, investigue o cenário isolado e compare com concorrência limitada:

```powershell
node --test dist/tests/integration/launcher-readiness.test.js
node --test --test-concurrency=4 "dist/tests/unit/*.test.js" "dist/tests/integration/*.test.js"
```

Não trate um rerun aprovado como prova de que uma falha anterior não aconteceu. Registre ambas as execuções. Referências históricas em comentários de teste não significam que os logs originais sejam distribuídos neste repositório.
