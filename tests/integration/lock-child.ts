/**
 * M1-F2 — Processo-filho REAL usado pelos testes de exclusão mútua do estado.
 * Não é um arquivo de teste (o node --test ignora): é o par de processo que os
 * cenários de crash/concorrência precisam, porque liveness só é honesta quando o
 * detentor realmente morre.
 *
 * Uso: node lock-child.js <root> <modo> [logFile] [holdMs]
 * Modos:
 *   hold             adquire e permanece na seção crítica (imprime LOCKED)
 *   hold-before-info adquire a AUTORIDADE e para antes de gravar a informação (AUTHORITY)
 *   hold-temp        para com o runtime.json.<uuid>.tmp já gravado, antes do rename (TEMP <path>)
 *   write            uma mutação e sai (DONE)
 *   write-slow       mutação com ENTER/EXIT no logFile e espera de holdMs dentro da seção crítica
 *   recover          recoverStaleLocks com ENTER/EXIT no logFile (RECOVER <json>)
 */
import { appendFile } from 'node:fs/promises';
import { StateStore, lockTestHooks } from '../../src/state/store.js';
import type { Runtime } from '../../src/contracts.js';

const [root, mode, logFile, holdMsRaw] = process.argv.slice(2);
if (!root || !mode) throw new Error('uso: lock-child.js <root> <modo> [logFile] [holdMs]');
const holdMs = Number(holdMsRaw ?? 200);
const store = new StateStore(root, { lockWaitMs: 30_000 });
/**
 * Espera para sempre MANTENDO o processo vivo. O servidor do lock é `unref`ado de
 * propósito (segurar o lock não pode impedir o processo de sair), então quem quer
 * segurar a seção crítica precisa do próprio handle ativo.
 */
const never = (): Promise<void> => new Promise<void>(() => { setInterval(() => undefined, 1_000); });
const delay = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const mark = async (event: string): Promise<void> => {
  if (logFile) await appendFile(logFile, `${event} ${process.pid} ${process.hrtime.bigint()}\n`, 'utf8');
};
const append = (kind: string) => (s: Runtime): { state: Runtime; result: undefined } => ({
  state: { ...s, events: [...s.events, { at: new Date().toISOString(), kind, detail: String(process.pid) }] },
  result: undefined,
});

switch (mode) {
  case 'hold':
    await store.mutate(async s => {
      console.log('LOCKED');
      await never();
      return { state: s, result: undefined };
    });
    break;

  case 'hold-before-info':
    lockTestHooks.afterAuthorityAcquired = async () => { console.log('AUTHORITY'); await never(); };
    await store.mutate(s => ({ state: s, result: undefined }));
    break;

  case 'hold-temp':
    lockTestHooks.beforeRuntimeRename = async temp => { console.log(`TEMP ${temp}`); await never(); };
    await store.mutate(append('tmp'));
    break;

  case 'write':
    await store.mutate(append('w'));
    console.log('DONE');
    break;

  case 'write-slow':
    // Revisão A/T1: mede a seção crítica quase INTEIRA — ENTER no primeiro ponto com a autoridade detida e EXIT em
    // `beforeRelease` (início do release, com o pipe AINDA aberto: depois de writeUnlocked/rename; a janela até o close é exclusiva).
    lockTestHooks.afterAuthorityAcquired = async () => { await mark('ENTER'); };
    lockTestHooks.beforeRelease = async () => { await mark('EXIT'); };
    await store.mutate(async s => {
      await delay(holdMs);
      return append('w')(s);
    });
    console.log('DONE');
    break;

  case 'recover': {
    // ENTER no primeiro ponto com a autoridade detida; EXIT no último (beforeRelease): seção crítica inteira.
    lockTestHooks.afterAuthorityAcquired = async () => { await mark('ENTER'); };
    lockTestHooks.beforeRelease = async () => { await mark('EXIT'); };
    lockTestHooks.afterLeftoversObserved = async () => { await delay(holdMs); };
    const result = await store.recoverStaleLocks();
    console.log(`RECOVER ${JSON.stringify(result)}`);
    break;
  }

  default:
    throw new Error(`modo desconhecido: ${mode}`);
}
