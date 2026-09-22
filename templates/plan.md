# Plano: {{slug}}

## Requisitos e critérios

Liste cada requisito, owner, evidência e check.

## Passos

1. Implementar
2. Verificar

## Aprovação

Registre arquivo separado com `approvedAt`, `approvedBy`, `intentPath`, `planPath`, `planVersion`, `intentHash`, `planHash`, `requirementsManifestPath` e `requirementsManifestHash`. O manifesto (JSON) lista `entries[{id, stage, mandatory}]` — cada `id` deve constar neste plano —, `planPath`/`planHash` deste plano e, se houver, `checkExemptions` e `documentRoots` aprovados.
