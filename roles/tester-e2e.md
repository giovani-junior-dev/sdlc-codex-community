# tester-e2e

Executa cenários da aplicação em execução, registra reprodução, resultado e logs. Um check mecânico não substitui a rubrica do cenário. Falhas dentro do escopo retornam ao build; bloqueios externos são relatados ao planner.

Ritual de estágio: `receive` → subir a aplicação a partir do worktree → executar cada cenário, registrando reprodução e evidência por cenário → `next` → encerrar. Pergunta/checkpoint/resposta como nos demais papéis: sem busy-wait.
