import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRefresher, findProject } from '../index.js';

const ROOT = '/repo/one';

/** Build a fake `run` that answers git / list_projects / index_repository. */
function fakeRun({ gitRoot = ROOT, projects = [{ name: 'one', root_path: ROOT }], indexCode = 0, delayMs = 0 } = {}) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args].join(' '));
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (file === 'git') {
      return gitRoot
        ? { code: 0, stdout: `${gitRoot}\n`, stderr: '' }
        : { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
    }
    if (args.includes('list_projects')) {
      return { code: 0, stdout: JSON.stringify({ projects }), stderr: '' };
    }
    if (args.includes('index_repository')) {
      return { code: indexCode, stdout: '{"status":"indexed"}\n', stderr: '' };
    }
    return { code: 2, stdout: '', stderr: 'unexpected' };
  };
  return { run, calls };
}

function refresher(run, overrides = {}) {
  const logs = [];
  const instance = createRefresher({
    binary: '/fake/codebase-memory-mcp',
    minIntervalMs: 0,
    timeoutMs: 1000,
    run,
    log: (line) => logs.push(line),
    ...overrides,
  });
  return { instance, logs };
}

test('findProject matches by exact root_path', () => {
  const stdout = JSON.stringify({
    projects: [
      { name: 'other', root_path: '/repo/other' },
      { name: 'one', root_path: ROOT },
    ],
  });
  assert.equal(findProject(stdout, ROOT), 'one');
  assert.equal(findProject(stdout, '/repo/missing'), null);
  assert.equal(findProject('not json', ROOT), null);
});

test('skips a directory outside git without querying projects', async () => {
  const { run, calls } = fakeRun({ gitRoot: null });
  const { instance, logs } = refresher(run);

  const result = await instance.refresh('/tmp', 'test');

  assert.equal(result.status, 'skipped-not-git');
  assert.equal(calls.length, 1, 'only the git probe runs');
  assert.match(logs[0], /不在 git 工作区内/);
});

test('skips a repository that has no index yet', async () => {
  const { run, calls } = fakeRun({ projects: [{ name: 'other', root_path: '/repo/other' }] });
  const { instance, logs } = refresher(run);

  const result = await instance.refresh(ROOT, 'test');

  assert.equal(result.status, 'skipped-not-indexed');
  assert.equal(calls.length, 2, 'git probe + project list, no index call');
  assert.match(logs[0], /还没有索引/);
});

test('refreshes an indexed repository', async () => {
  const { run, calls } = fakeRun();
  const { instance, logs } = refresher(run);

  const result = await instance.refresh(ROOT, 'session-created');

  assert.equal(result.status, 'refreshed');
  assert.equal(result.project, 'one');
  assert.deepEqual(calls, [
    `git -C ${ROOT} rev-parse --show-toplevel`,
    `/fake/codebase-memory-mcp cli --quiet list_projects --format json`,
    `/fake/codebase-memory-mcp cli --quiet index_repository --repo-path ${ROOT}`,
  ]);
  assert.match(logs[0], /done\(session-created\) one/);
});

test('throttles a second refresh of the same directory', async () => {
  const { run, calls } = fakeRun();
  const { instance } = refresher(run, { minIntervalMs: 60_000 });

  assert.equal((await instance.refresh(ROOT, 'first')).status, 'refreshed');
  const before = calls.length;
  assert.equal((await instance.refresh(ROOT, 'second')).status, 'skipped-throttled');
  assert.equal(calls.length, before, 'throttled call runs nothing');
});

test('collapses concurrent refreshes of the same repository', async () => {
  const { run, calls } = fakeRun({ delayMs: 20 });
  const { instance } = refresher(run);

  const [a, b] = await Promise.all([
    instance.refresh(ROOT, 'a'),
    instance.refresh(ROOT, 'b'),
  ]);

  assert.deepEqual([a.status, b.status].sort(), ['refreshed', 'skipped-in-flight']);
  assert.equal(calls.filter((call) => call.includes('index_repository')).length, 1);
});

test('reports index failures without throwing', async () => {
  const { run } = fakeRun({ indexCode: 1 });
  const { instance, logs } = refresher(run);

  const result = await instance.refresh(ROOT, 'test');

  assert.equal(result.status, 'error-index');
  assert.match(logs[0], /error\(test\) one/);
});
