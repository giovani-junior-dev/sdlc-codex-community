import test from 'node:test';
import assert from 'node:assert/strict';
import { HerdrProcessAdapter } from '../../src/adapters/herdr.js';
import { FakeProcessRunner, type ProcessResult } from '../../src/adapters/process.js';

const ok = (value: unknown): ProcessResult => ({
  exitCode: 0,
  stdout: JSON.stringify(value),
  stderr: '',
  timedOut: false,
  acceptedBeforeTimeout: false,
});

test('Herdr 0.7.5: extrai recursos dos envelopes reais e nunca usa o id de correlação', async () => {
  const calls: string[][] = [];
  const runner = new FakeProcessRunner((_exe, args) => {
    calls.push(args);
    if (args[0] === 'workspace' && args[1] === 'list') return ok({
      id: 'cli:workspace:list',
      result: {
        type: 'workspace_list',
        workspaces: [{ active_tab_id: 'wP:t1', agent_status: 'unknown', focused: false, label: 'outro', number: 8, pane_count: 1, tab_count: 1, workspace_id: 'wP' }],
      },
    });
    if (args[0] === 'workspace' && args[1] === 'create') return ok({
      id: 'cli:workspace:create',
      result: {
        root_pane: { agent_status: 'unknown', cwd: 'C:\\fixture', focused: false, pane_id: 'wQ:p1', revision: 0, scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 50 }, tab_id: 'wQ:t1', terminal_id: 'term-1', workspace_id: 'wQ' },
        tab: { agent_status: 'unknown', focused: false, label: '1', number: 1, pane_count: 1, tab_id: 'wQ:t1', workspace_id: 'wQ' },
        type: 'workspace_created',
        workspace: { active_tab_id: 'wQ:t1', agent_status: 'unknown', focused: false, label: 'project-a', number: 8, pane_count: 1, tab_count: 1, workspace_id: 'wQ' },
      },
    });
    if (args[0] === 'tab' && args[1] === 'create') return ok({
      id: 'cli:tab:create',
      result: {
        root_pane: { agent_status: 'unknown', cwd: 'C:\\fixture', focused: false, pane_id: 'wQ:p2', revision: 0, scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 50 }, tab_id: 'wQ:t2', terminal_id: 'term-2', workspace_id: 'wQ' },
        tab: { agent_status: 'unknown', focused: false, label: 'planner', number: 2, pane_count: 1, tab_id: 'wQ:t2', workspace_id: 'wQ' },
        type: 'tab_created',
      },
    });
    throw new Error(`chamada inesperada: ${args.join(' ')}`);
  });
  const herdr = new HerdrProcessAdapter(runner);

  const workspace = await herdr.ensureWorkspace('project-a', 'C:\\fixture');
  assert.equal(workspace.workspaceId, 'wQ');
  assert.notEqual(workspace.workspaceId, 'cli:workspace:create');

  const tab = await herdr.createTab(workspace.workspaceId, 'planner', 'C:\\fixture', {});
  assert.equal(tab.tabId, 'wQ:t2');
  assert.equal(tab.paneId, 'wQ:p2');
  assert.deepEqual(calls.at(-1)?.slice(0, 4), ['tab', 'create', '--workspace', 'wQ']);
});

test('Herdr 0.7.5: lista panes e agentes a partir do result envelopado', async () => {
  const runner = new FakeProcessRunner((_exe, args) => {
    if (args[0] === 'pane') return ok({ id: 'cli:pane:list', result: { type: 'pane_list', panes: [
      { agent_status: 'idle', cwd: 'C:\\fixture', focused: false, pane_id: 'wQ:p2', revision: 1, scroll: { max_offset_from_bottom: 0, offset_from_bottom: 0, viewport_rows: 50 }, tab_id: 'wQ:t2', terminal_id: 'term-2', workspace_id: 'wQ' },
    ] } });
    return ok({ id: 'cli:agent:list', result: { type: 'agent_list', agents: [
      { agent: 'codex', agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: 'thread-1' }, agent_status: 'idle', cwd: 'C:\\fixture', focused: false, interactive_ready: true, name: 'project-a-planner', pane_id: 'wQ:p2', revision: 1, state_change_seq: 1, tab_id: 'wQ:t2', terminal_id: 'term-2', terminal_title: 'planner', terminal_title_stripped: 'planner', workspace_id: 'wQ' },
    ] } });
  });
  const herdr = new HerdrProcessAdapter(runner);
  const panes = await herdr.listPanes();
  assert.equal(panes.length, 1);
  assert.equal(panes[0].paneId, 'wQ:p2');
  assert.equal(panes[0].workspaceId, 'wQ');
  assert.equal(panes[0].ready, true);
  const agents = await herdr.listAgents();
  assert.equal(agents[0].name, 'project-a-planner');
  assert.equal(agents[0].paneId, 'wQ:p2');
  assert.equal(agents[0].kind, 'codex');
  assert.equal(agents[0].state, 'idle');
});
