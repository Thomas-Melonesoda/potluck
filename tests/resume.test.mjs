import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../plugins/pstack/skills/poteto-mode/scripts/resume.mjs', import.meta.url));
function fixture(body) {
  // resume.mjs reports resolved paths; macOS tmpdir() sits behind the /var symlink.
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'resume-project-')));
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const run = (...args) => {
    const result = spawnSync('node', [cli, ...args, '--project', project], { encoding: 'utf8' });
    return { status: result.status, value: JSON.parse(result.stdout) };
  };
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('commit', '--allow-empty', '-m', 'Initial');
    body({ project, run, git });
  } finally { rmSync(project, { recursive: true, force: true }); }
}
function note(run, text = '1. Who owns retries?\n2. What survives restart?\n') {
  const { value } = run('begin');
  const artifact = join(value.directory, 'questions.md');
  const note = join(value.directory, 'resume.md');
  writeFileSync(artifact, text);
  writeFileSync(note, 'Start with [the questions](questions.md).\n');
  return { note, artifact, text };
}

test('a cold process finds all ordered artifacts using only project identity', () => fixture(({ run }) => {
  const questions = Array.from({ length: 10 }, (_, i) => `${i + 1}. Question ${i + 1}?`).join('\n') + '\n';
  const saved = note(run, questions);
  assert.equal(run('publish', '--note', saved.note, '--artifact', saved.artifact).status, 0);
  const cold = run('read');
  assert.equal(cold.status, 0);
  assert.equal(cold.value.kind, 'checkpoint');
  assert.equal(readFileSync(cold.value.checkpoint.artifacts[0].path, 'utf8'), questions);
  assert.equal(readFileSync(cold.value.checkpoint.note.path, 'utf8'), 'Start with [the questions](questions.md).\n');
}));

test('publishes a note linking an artifact with a parenthesized angle-bracket destination', () => fixture(({ run }) => {
  const directory = run('begin').value.directory;
  const artifact = join(directory, 'questions (draft).md');
  const resume = join(directory, 'resume.md');
  writeFileSync(artifact, 'Which question is still open?\n');
  writeFileSync(resume, '[Questions](<questions (draft).md>)\n');

  const published = run('publish', '--note', resume, '--artifact', artifact);
  assert.equal(published.status, 0, published.value.detail);
  assert.equal(run('read').value.checkpoint.artifacts[0].path, artifact);
}));

const storage = readFileSync(new URL('../plugins/pstack/skills/poteto-mode/references/resume-storage.md', import.meta.url), 'utf8');
function publishNote(run, text, artifacts, unregistered = []) {
  const directory = run('begin').value.directory;
  const resume = join(directory, 'resume.md');
  for (const name of [...artifacts, ...unregistered]) writeFileSync(join(directory, name), 'Which question is still open?\n');
  writeFileSync(resume, text);
  return run('publish', '--note', resume, ...artifacts.flatMap(name => ['--artifact', join(directory, name)]));
}

for (const [form, text, artifacts, unregistered, names] of [
  ['balanced parentheses', '[A](a(b).md)\n', ['a(b).md'], [], '[A](a(b)'],
  ['a link title', '[Q](q.md "Questions")\n', ['q.md'], [], '[Q](q.md "Questions")'],
  ['a literal % in angle brackets', '[D](<100% done.md>)\n', ['100% done.md'], [], '[D](<100% done.md>)'],
  ['an unregistered link', '[Q](q.md) and [O](other.md)\n', ['q.md'], ['other.md'], '[O](other.md)'],
  ['a reference link', '[Q][q]\n\n[q]: q.md\n', ['q.md'], [], 'q.md'],
  ['nested brackets in the link text', '[see [the] list](q.md)\n', ['q.md'], [], 'q.md'],
  ['a drive-letter path that does not resolve', '[Q](q.md) and [W](C:/w.md)\n', ['q.md'], [], '[W](C:/w.md)'],
]) test(`rejects ${form} by naming it and stating the documented link rule`, () => fixture(({ run }) => {
  const result = publishNote(run, text, artifacts, unregistered);
  assert.equal(result.status, 1);
  assert.ok(result.value.detail.includes(names), result.value.detail);
  const rule = result.value.detail.slice(result.value.detail.indexOf('Link each local file'));
  assert.ok(rule.startsWith('Link each local file') && storage.includes(rule), result.value.detail);
}));

test('publishes a note that also links URLs and an anchor', () => fixture(({ run }) => {
  const text = '[Q](q.md), [site](https://example.com/a), [feed](ws://example.com/b) and [top](#top)\n';
  const published = publishNote(run, text, ['q.md']);
  assert.equal(published.status, 0, published.value.detail);
}));

test('ignores links inside code spans and fenced code blocks', () => fixture(({ run }) => {
  const text = 'Start with [Q](q.md). Quote `[x](missing.md)` literally.\n\n```markdown\n[y](absent.md)\n```\n\n~~~\n[z](gone.md)\n~~~\n';
  const published = publishNote(run, text, ['q.md']);
  assert.equal(published.status, 0, published.value.detail);
  assert.equal(run('read').status, 0);
}));

test('ignores links inside fenced code blocks of a note with CRLF line endings', () => fixture(({ run }) => {
  const text = 'Start with [Q](q.md).\r\n\r\n```markdown\r\n[y](absent.md)\r\n```\r\n\r\n~~~\r\n[z](gone.md)\r\n~~~\r\n';
  const published = publishNote(run, text, ['q.md']);
  assert.equal(published.status, 0, published.value.detail);
  assert.equal(run('read').status, 0);
}));

test('ignores links inside a fenced code block that opens a note with a byte order mark', () => fixture(({ run }) => {
  const text = '\uFEFF~~~\r\n[z](gone.md)\r\n~~~\r\n\r\nStart with [Q](q.md).\r\n';
  const published = publishNote(run, text, ['q.md']);
  assert.equal(published.status, 0, published.value.detail);
  assert.equal(run('read').status, 0);
}));

test('failed publication leaves the last complete pointer intact', () => fixture(({ run }) => {
  const first = note(run);
  assert.equal(run('publish', '--note', first.note, '--artifact', first.artifact).status, 0);
  const second = note(run);
  rmSync(second.artifact);
  assert.equal(run('publish', '--note', second.note, '--artifact', second.artifact).status, 1);
  assert.equal(run('read').value.checkpoint.note.path, first.note);
}));

test('changed or missing artifacts are errors, not a transcript fallback', () => fixture(({ run }) => {
  const saved = note(run);
  run('publish', '--note', saved.note, '--artifact', saved.artifact);
  writeFileSync(saved.artifact, 'truncated');
  const changed = run('read');
  assert.equal(changed.status, 1);
  assert.match(changed.value.detail, /changed/);
  rmSync(saved.artifact);
  assert.equal(run('read').status, 1);
}));

test('a project with no checkpoint reports missing separately', () => fixture(({ run }) => {
  const cold = run('read');
  assert.equal(cold.status, 2);
  assert.deepEqual(cold.value, { kind: 'missing' });
}));

test('a different worktree locates the same checkpoint without its path', () => fixture(({ project, run, git }) => {
  const saved = note(run);
  run('publish', '--note', saved.note, '--artifact', saved.artifact);
  const worktree = join(project, 'other-worktree');
  git('worktree', 'add', '-b', 'other', worktree);
  const cold = JSON.parse(execFileSync('node', [cli, 'read', '--project', worktree], { encoding: 'utf8' }));
  assert.equal(cold.checkpoint.note.path, saved.note);
  assert.equal(readFileSync(cold.checkpoint.artifacts[0].path, 'utf8'), saved.text);
}));

test('reuses a project artifact without making a competing copy', () => fixture(({ project, run }) => {
  const directory = run('begin').value.directory;
  const artifact = join(project, 'questions.md');
  const resume = join(directory, 'resume.md');
  writeFileSync(artifact, 'Which errors are final?\n');
  writeFileSync(resume, `[Questions](${artifact})\n`);
  assert.equal(run('publish', '--note', resume, '--artifact', artifact).status, 0);
  assert.equal(run('read').value.checkpoint.artifacts[0].path, artifact);
}));

test('rejects symlink artifacts outside the project', () => fixture(({ run }) => {
  const saved = note(run);
  rmSync(saved.artifact);
  symlinkSync('/etc/hosts', saved.artifact);
  const result = run('publish', '--note', saved.note, '--artifact', saved.artifact);
  assert.equal(result.status, 1);
  assert.match(result.value.detail, /must belong to this project/);
}));

// Stage 5 issue 11: one pointer per folder and task, plain folders, and the head recorded at pause.
function resume(...args) {
  const result = spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  return { status: result.status, value: JSON.parse(result.stdout) };
}
function scratch(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
function plain(body) {
  const folders = [scratch('resume-plain-'), scratch('resume-plain-'), scratch('resume-store-')];
  try { body(...folders); } finally { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); }
}
function save(project, text, ...flags) {
  const store = flags.includes('--store') ? flags.slice(flags.indexOf('--store'), flags.indexOf('--store') + 2) : [];
  const begun = resume('begin', '--project', project, ...store);
  assert.equal(begun.status, 0, begun.value.detail);
  const note = join(begun.value.directory, 'resume.md');
  writeFileSync(note, text);
  const published = resume('publish', '--project', project, '--note', note, ...flags);
  assert.equal(published.status, 0, published.value.detail);
  return note;
}
function savedText(result) {
  assert.equal(result.status, 0, result.value.detail);
  return readFileSync(result.value.checkpoint.note.path, 'utf8');
}

test('two folders of one repository keep separate checkpoints', () => fixture(({ project }) => {
  for (const name of ['notes-a', 'notes-b']) mkdirSync(join(project, name));
  save(join(project, 'notes-a'), 'Folder a.\n');
  save(join(project, 'notes-b'), 'Folder b.\n');
  assert.equal(savedText(resume('read', '--project', join(project, 'notes-a'))), 'Folder a.\n');
  assert.equal(savedText(resume('read', '--project', join(project, 'notes-b'))), 'Folder b.\n');
  assert.deepEqual(resume('read', '--project', project), { status: 2, value: { kind: 'missing' } });
}));

test('two tasks in one folder keep separate checkpoints', () => fixture(({ project }) => {
  save(project, 'Task alpha.\n', '--task', 'alpha');
  save(project, 'Task beta.\n', '--task', 'beta');
  assert.equal(savedText(resume('read', '--project', project, '--task', 'alpha')), 'Task alpha.\n');
  assert.equal(savedText(resume('read', '--project', project, '--task', 'beta')), 'Task beta.\n');
  assert.equal(resume('read', '--project', project).status, 2);
}));

test('list names every folder and task in the store, newest first', () => fixture(({ project }) => {
  mkdirSync(join(project, 'notes-a'));
  save(join(project, 'notes-a'), 'Folder a.\n');
  save(project, 'Task beta.\n', '--task', 'beta');
  const listed = resume('list', '--project', project);
  assert.equal(listed.status, 0, listed.value.detail);
  assert.equal(listed.value.kind, 'list');
  assert.deepEqual(listed.value.checkpoints.map(({ folder, task }) => ({ folder, task })), [
    { folder: '', task: 'beta' },
    { folder: 'notes-a', task: null },
  ]);
}));

test('a plain folder outside Git keeps its checkpoint inside the folder', () => plain(folder => {
  writeFileSync(join(folder, 'questions.md'), 'Which errors are final?\n');
  const begun = resume('begin', '--project', folder);
  assert.equal(begun.status, 0, begun.value.detail);
  assert.ok(begun.value.directory.startsWith(join(folder, '.pstack', 'resume') + sep), begun.value.directory);
  const note = join(begun.value.directory, 'resume.md');
  writeFileSync(note, `[Questions](${join(folder, 'questions.md')})\n`);
  const published = resume('publish', '--project', folder, '--note', note, '--artifact', join(folder, 'questions.md'));
  assert.equal(published.status, 0, published.value.detail);
  const cold = resume('read', '--project', folder);
  assert.equal(cold.status, 0, cold.value.detail);
  assert.equal(cold.value.checkpoint.note.path, note);
  assert.equal(readFileSync(cold.value.checkpoint.artifacts[0].path, 'utf8'), 'Which errors are final?\n');
  assert.equal(cold.value.moved, null);
  assert.equal(existsSync(join(folder, '.git')), false);
}));

test('plain folders can share a given store without overwriting each other', () => plain((first, second, store) => {
  save(first, 'First folder.\n', '--store', store);
  save(second, 'Second folder.\n', '--store', store);
  assert.equal(savedText(resume('read', '--project', first, '--store', store)), 'First folder.\n');
  assert.equal(savedText(resume('read', '--project', second, '--store', store)), 'Second folder.\n');
  assert.equal(resume('list', '--project', first, '--store', store).value.checkpoints.length, 2);
  assert.equal(existsSync(join(first, '.pstack')), false);
}));

test('publish records the head and read reports when it has moved', () => fixture(({ project, git }) => {
  save(project, 'Paused.\n');
  const paused = git('rev-parse', 'HEAD');
  const same = resume('read', '--project', project);
  assert.equal(same.status, 0, same.value.detail);
  assert.equal(same.value.checkpoint.head, paused);
  assert.equal(same.value.moved, false);
  git('commit', '--allow-empty', '-m', 'Landed after the pause');
  const later = resume('read', '--project', project);
  assert.equal(later.value.checkpoint.head, paused);
  assert.equal(later.value.headNow, git('rev-parse', 'HEAD'));
  assert.equal(later.value.moved, true);
}));

function storeOf(git) {
  return join(realpathSync(git('rev-parse', '--path-format=absolute', '--git-common-dir')), 'pstack', 'resume');
}
// Writes latest.json the way resume.mjs did before pointers were per folder and task.
function legacyPointer(project, git, text) {
  const store = storeOf(git);
  const directory = join(store, `legacy-${Date.now()}`);
  mkdirSync(directory, { recursive: true });
  const legacy = join(directory, 'resume.md');
  writeFileSync(legacy, text);
  const note = { path: legacy, sha256: createHash('sha256').update(text).digest('hex') };
  writeFileSync(join(store, 'latest.json'), JSON.stringify({
    schemaVersion: 1, gitDir: dirname(dirname(store)), worktree: project, branch: 'main', createdAt: new Date().toISOString(), note, artifacts: [],
  }) + '\n');
  return legacy;
}

test('a checkpoint published in the single-pointer format still reads and lists until the folder publishes again', () => fixture(({ project, git }) => {
  const legacy = legacyPointer(project, git, 'Old pause.\n');
  const old = resume('read', '--project', project);
  assert.equal(savedText(old), 'Old pause.\n');
  assert.equal(old.value.moved, null);
  assert.deepEqual(resume('list', '--project', project).value.checkpoints.map(({ folder, task, note }) => ({ folder, task, note })), [
    { folder: '', task: null, note: legacy },
  ]);
  save(project, 'New pause.\n');
  assert.equal(savedText(resume('read', '--project', project)), 'New pause.\n');
  assert.equal(resume('list', '--project', project).value.checkpoints.length, 1);
}));

test('a single-pointer checkpoint written after a folder pointer wins, as from an older plugin in another runtime', () => fixture(({ project, git }) => {
  save(project, 'Newer plugin paused first.\n');
  legacyPointer(project, git, 'Older plugin paused later.\n');
  assert.equal(savedText(resume('read', '--project', project)), 'Older plugin paused later.\n');
  save(project, 'Newer plugin paused last.\n');
  assert.equal(savedText(resume('read', '--project', project)), 'Newer plugin paused last.\n');
  // An older plugin reads only latest.json; once retired it reports missing instead of a stale note.
  assert.equal(existsSync(join(storeOf(git), 'latest.json')), false);
}));

test('the head comparison follows the saved branch, not the checkout that reads it', () => fixture(({ project, git }) => {
  const worktree = join(project, 'feature-worktree');
  git('worktree', 'add', '-q', '-b', 'feature', worktree);
  save(worktree, 'Paused on the feature branch.\n');
  git('commit', '--allow-empty', '-m', 'main moves on');
  const fromMain = resume('read', '--project', project);
  assert.equal(fromMain.status, 0, fromMain.value.detail);
  assert.equal(fromMain.value.moved, false);
  assert.equal(fromMain.value.headNow, git('rev-parse', 'feature'));
  execFileSync('git', ['-C', worktree, 'commit', '--allow-empty', '-q', '-m', 'feature moves on']);
  assert.equal(resume('read', '--project', project).value.moved, true);
}));

test('list skips dot files in the pointer folder, where publications are written first', () => fixture(({ project, git }) => {
  save(project, 'Done.\n');
  writeFileSync(join(storeOf(git), 'pointers', '.unfinished.json'), '{"schemaVer');
  const listed = resume('list', '--project', project);
  assert.equal(listed.status, 0, listed.value.detail);
  assert.equal(listed.value.checkpoints.length, 1);
}));

test('a pointer holding another task\'s record is refused', () => fixture(({ project, git }) => {
  save(project, 'Task alpha.\n', '--task', 'alpha');
  save(project, 'Task beta.\n', '--task', 'beta');
  const pointers = join(storeOf(git), 'pointers');
  const [first, second] = readdirSync(pointers).map(name => join(pointers, name));
  writeFileSync(first, readFileSync(second));
  const reads = ['alpha', 'beta'].map(task => resume('read', '--project', project, '--task', task));
  assert.deepEqual(reads.map(({ status }) => status).sort(), [0, 1]);
  assert.match(reads.find(({ status }) => status === 1).value.detail, /mismatch/);
}));

test('a default store that a symlink sends outside the project is refused', () => fixture(({ project, git }) => {
  const outside = scratch('resume-outside-');
  try {
    symlinkSync(outside, dirname(storeOf(git)));
    for (const operation of ['begin', 'read']) {
      const result = resume(operation, '--project', project);
      assert.equal(result.status, 1, operation);
      assert.match(result.value.detail, /escapes/);
    }
  } finally { rmSync(outside, { recursive: true, force: true }); }
}));

const caseInsensitive = tmpdir() !== tmpdir().toUpperCase() && existsSync(tmpdir().toUpperCase());
test.skipIf(!caseInsensitive)('a project path typed in another letter case finds the same checkpoint', () => fixture(({ project }) => {
  save(project, 'Same folder.\n');
  const typed = join(dirname(project), basename(project).toUpperCase());
  assert.equal(savedText(resume('read', '--project', typed)), 'Same folder.\n');
  assert.equal(resume('list', '--project', typed).value.checkpoints[0].folder, '');
}));

test('a bare repository is an error, not a plain folder', () => plain(folder => {
  execFileSync('git', ['init', '--bare', '-q', folder]);
  const begun = resume('begin', '--project', folder);
  assert.equal(begun.status, 1);
  assert.equal(begun.value.kind, 'unavailable');
  assert.equal(existsSync(join(folder, '.pstack')), false);
}));
