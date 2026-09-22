import { runCli } from '../dist/src/cli.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../dist/src/state/store.js';
import { SessionRegistry } from '../dist/src/sessions/registry.js';
import { FakeProcessRunner } from '../dist/src/adapters/process.js';

function io() {
  const out = [];
  const err = [];
  return { out, err, value: { stdout: (v) => out.push(v), stderr: (v) => err.push(v) } };
}

const CONFIG = { schemaVersion: 1, projectId: 'proj-feat', projectName: 'Feat', prBase: 'main', checks: {}, models: {}, protectedPaths: ['.git'] };
function gitFake() {
  return new FakeProcessRunner((_, args) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { exitCode: 0, stdout: 'abc123\n', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'cat-file') return { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'worktree') return { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    if (args[0] === 'show-ref') return { exitCode: 1, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, acceptedBeforeTimeout: false };
  });
}
class InstantHerdr {
  constructor(root) { this.root = root; }
  registry() { return new SessionRegistry(new StateStore(join(this.root, '.sdlc-codex'), { projectId: 'proj-feat' })); }
  async ensureWorkspace(projectId, path) { return { workspaceId: 'w', projectId, path }; }
  async createTab(workspaceId, label, cwd, env) {
    const role = env.SDLC_CODEX_ROLE;
    await this.registry().register({ event: 'SessionStart', session_id: `thread-${role}`, cwd, project_id: env.SDLC_CODEX_PROJECT_ID, role, token: env.SDLC_CODEX_LAUNCH_TOKEN });
    return { tabId: 'tab-1' };
  }
  async listPanes() { return [{ paneId: 'pane-1', ready: true }]; }
  async startAgent() { return; }
  async waitAgent() { return true; }
  async listAgents() { return []; }
}

const root = await mkdtemp(join(tmpdir(), 'sdlc-dbg-'));
const cfg = join(root, 'incoming.json');
await writeFile(cfg, JSON.stringify(CONFIG));
const deps = { runner: gitFake(), herdr: new InstantHerdr(root) };
const store = () => new StateStore(join(root, '.sdlc-codex'), { projectId: 'proj-feat' });
const actor = async (role) => {
  const s = (await store().read()).sessions.find(x => x.role === role);
  if (!s) throw new Error(`sessão ${role} não encontrada`);
  return s;
};

let x = io();
console.log('adopt:', await runCli(['adopt', '--config', cfg, '--project', root, '--apply'], x.value, deps), x.err);
x = io();
console.log('up:', await runCli(['up', 'feat-1', '--workflow', 'feature', '--project', root, '--json'], x.value, deps), x.out, x.err);
await writeFile(join(root, 'intent.md'), '# intent\nobjetivo aprovado\n');
await writeFile(join(root, 'plan.md'), '# plano\nREQ-1: implementar\n');
await writeFile(join(root, 'approval.json'), JSON.stringify({ intentPath: 'intent.md', planPath: 'plan.md', approvedBy: 'humano', approvedAt: '2026-09-19T00:00:00Z' }));
x = io();
console.log('start:', await runCli(['start', 'feat-1', '--intent', 'intent.md', '--plan', 'plan.md', '--approval', 'approval.json', '--workflow', 'feature', '--project', root, '--json'], x.value, deps), x.out, x.err);