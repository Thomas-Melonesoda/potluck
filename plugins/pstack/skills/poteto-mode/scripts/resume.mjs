#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, dirname } from 'node:path';
import { parseArgs } from 'node:util';

function git(project, ...args) {
  return execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function identity(projectPath) {
  let toplevel;
  try {
    toplevel = execFileSync('git', ['-C', projectPath, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
    }).trim();
  } catch (error) {
    if (error.code === 'ENOENT' || /not a git repository/.test(error.stderr ?? ''))
      return { gitDir: null, worktree: realpathSync(projectPath), folder: '' };
    throw error;
  }
  const worktree = realpathSync(toplevel);
  const gitDir = realpathSync(git(projectPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const folder = relative(worktree, realpathSync(projectPath)).split(sep).join('/');
  return { gitDir, worktree, folder };
}
function headOf(worktree) {
  try { return git(worktree, 'rev-parse', '--verify', '-q', 'HEAD'); } catch { return null; }
}
function inside(root, file) {
  const path = relative(root, file);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}
function existingRealpath(path) {
  try { return realpathSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
function string(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`missing ${name}`);
  return value;
}
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${name}`);
  return value;
}
function fileInfo(path, roots) {
  const canonical = realpathSync(path);
  if (!roots.some(root => inside(root, canonical)) || !statSync(canonical).isFile())
    throw new Error(`checkpoint file must belong to this project: ${path}`);
  return { path: canonical, sha256: createHash('sha256').update(readFileSync(canonical)).digest('hex') };
}
function verifyFile(value, roots) {
  const record = object(value, 'file record');
  const file = fileInfo(string(record.path, 'file path'), roots);
  if (file.sha256 !== string(record.sha256, 'file digest')) throw new Error(`checkpoint file changed: ${file.path}`);
  return file;
}
const linkRule = 'Link each local file with an inline Markdown link whose destination is the path, written bare or as `<path>`, with no square brackets in the link text and no title after the path. Reference-style links are not read. The path is relative to the note or absolute, and it is percent-decoded, so write a literal `%` as `%25`. Wrap a path that contains spaces or parentheses in angle brackets, or percent-encode it. Links inside code spans and fenced code blocks are ignored.';
function resolveLink(note, link, target) {
  let decoded;
  try { decoded = decodeURIComponent(target.split('#')[0]); }
  catch { throw new Error(`link ${link} has malformed percent-encoding. ${linkRule}`); }
  try { return realpathSync(resolve(dirname(note.path), decoded)); }
  catch (error) { throw new Error(`link ${link} does not resolve (${error.code}). ${linkRule}`); }
}
function verifyLinks(note, artifacts) {
  const prose = readFileSync(note.path, 'utf8')
    .replace(/^﻿/, '')
    .replaceAll('\r\n', '\n')
    .replace(/^ {0,3}((`|~)\2{2,}).*\n[\s\S]*?(?:^ {0,3}\1\2*[ \t]*$|(?![\s\S]))/gm, ' ')
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ' ');
  const links = [...prose.matchAll(/\[[^\]]*\]\((?:<([^<>]+)>|([^)]+))\)/g)]
    .filter(([, angled, bare]) => !/^(?:[a-z]{2,}:|#)/i.test(angled ?? bare))
    .map(([link, angled, bare]) => ({ link, path: resolveLink(note, link, angled ?? bare) }));
  for (const artifact of artifacts)
    if (!links.some(({ path }) => path === artifact.path))
      throw new Error(`note must link requested artifact: ${artifact.path}. ${linkRule}`);
  for (const { link, path } of links)
    if (path !== note.path && !artifacts.some(artifact => artifact.path === path))
      throw new Error(`register every local note link with --artifact: ${link} resolves to ${path}. ${linkRule}`);
}

function pointerPath(store, root, folder, task) {
  const hash = createHash('sha256').update(JSON.stringify([root, folder, task])).digest('hex');
  return join(store, 'pointers', `${hash}.json`);
}
function storeRaw(values, project) {
  return values.store !== undefined
    ? resolve(values.store)
    : project.gitDir ? join(project.gitDir, 'pstack', 'resume') : join(project.worktree, '.pstack', 'resume');
}
function readRecord(store, project, key) {
  const pointer = pointerPath(store, project.gitDir ?? project.worktree, key.folder, key.task);
  let path = existsAsFile(pointer);
  if (path === null && key.folder === '' && key.task === null) path = existsAsFile(join(store, 'latest.json'));
  if (path === null) return null;
  const file = fileInfo(path, [store]);
  const raw = object(JSON.parse(readFileSync(file.path, 'utf8')), 'checkpoint');
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) throw new Error('checkpoint project mismatch');
  const v2 = raw.schemaVersion === 2;
  if (v2 && typeof raw.folder !== 'string') throw new Error('invalid folder');
  const folder = v2 ? raw.folder : '';
  const task = v2 ? (raw.task === null ? null : string(raw.task, 'task')) : null;
  const head = v2 ? (raw.head === null ? null : string(raw.head, 'head')) : null;
  const gitDir = raw.gitDir === null ? null : string(raw.gitDir, 'gitDir');
  const worktree = string(raw.worktree, 'worktree');
  if (gitDir !== project.gitDir) throw new Error('checkpoint project mismatch');
  if (project.gitDir === null && worktree !== project.worktree) throw new Error('checkpoint project mismatch');
  if (folder !== key.folder || task !== key.task) throw new Error('checkpoint project mismatch');
  const roots = [store, project.worktree];
  if (worktree !== project.worktree) {
    try { if (identity(worktree).gitDir === project.gitDir) roots.push(realpathSync(worktree)); }
    catch { /* Removed worktrees cannot supply artifacts; store files remain readable. */ }
  }
  const note = verifyFile(raw.note, [store]);
  if (!Array.isArray(raw.artifacts)) throw new Error('invalid artifact list');
  const artifacts = raw.artifacts.map(value => verifyFile(value, roots));
  const branch = raw.branch === null ? null : string(raw.branch, 'branch');
  const createdAt = string(raw.createdAt, 'timestamp');
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error('invalid checkpoint timestamp');
  verifyLinks(note, artifacts);
  return { schemaVersion: 2, gitDir, worktree, folder, task, branch, head, createdAt, note, artifacts };
}
function existsAsFile(path) {
  try { lstatSync(path); return path; } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
function computeHeadNow(project, record) {
  if (project.gitDir === null) return null;
  try {
    return record.branch
      ? git(project.worktree, 'rev-parse', '--verify', '-q', `refs/heads/${record.branch}`)
      : git(project.worktree, 'rev-parse', '--verify', '-q', 'HEAD');
  } catch { return null; }
}
function respond(store, project, key) {
  const record = readRecord(store, project, key);
  if (record === null) return null;
  const headNow = computeHeadNow(project, record);
  const moved = record.head === null ? null : headNow !== record.head;
  return { kind: 'checkpoint', checkpoint: record, headNow, moved };
}
function summarize(record) {
  const v2 = record.schemaVersion === 2;
  return {
    folder: v2 ? record.folder : '',
    task: v2 ? (record.task ?? null) : null,
    worktree: record.worktree,
    branch: record.branch ?? null,
    head: v2 ? (record.head ?? null) : null,
    createdAt: record.createdAt,
    note: record.note && record.note.path,
  };
}
function listStore(store) {
  const pointers = join(store, 'pointers');
  let names = [];
  try { names = readdirSync(pointers).filter(name => name.endsWith('.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = names.map(name => join(pointers, name));
  if (existsAsFile(join(store, 'latest.json'))) files.push(join(store, 'latest.json'));
  const checkpoints = files.map(file => {
    let record;
    try { record = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error(`invalid checkpoint pointer: ${file}`); }
    return summarize(record);
  });
  checkpoints.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { kind: 'list', checkpoints };
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string', default: '.' },
      store: { type: 'string' },
      task: { type: 'string' },
      note: { type: 'string' },
      artifact: { type: 'string', multiple: true, default: [] },
    },
  });
  const [operation] = positionals;
  if (positionals.length !== 1 || !['begin', 'publish', 'read', 'list'].includes(operation))
    throw new Error('usage: resume.mjs begin|publish|read|list --project <directory> [--store <dir>] [--task <name>] [--note <file> --artifact <file> ...]');
  if (operation !== 'publish' && (values.note !== undefined || values.artifact.length)) throw new Error('only publish accepts files');
  if (!['publish', 'read'].includes(operation) && values.task !== undefined) throw new Error('only publish and read accept --task');
  if (values.task === '') throw new Error('empty --task');
  const task = values.task === undefined ? null : values.task;

  const project = identity(values.project);

  if (operation === 'begin' || operation === 'publish') {
    mkdirSync(storeRaw(values, project), { recursive: true, mode: 0o700 });
    const store = realpathSync(storeRaw(values, project));
    if (values.store === undefined && !inside(project.gitDir ?? project.worktree, store))
      throw new Error('resume store escapes the project directory');

    if (operation === 'begin') {
      const directory = join(store, randomUUID());
      mkdirSync(directory, { mode: 0o700 });
      console.log(JSON.stringify({ kind: 'directory', directory }));
    } else {
      mkdirSync(join(store, 'pointers'), { recursive: true, mode: 0o700 });
      const note = fileInfo(string(values.note, '--note'), [store]);
      const artifacts = values.artifact.map(path => fileInfo(path, [store, project.worktree]));
      if (new Set(artifacts.map(file => file.path)).size !== artifacts.length) throw new Error('duplicate artifact');
      verifyLinks(note, artifacts);
      const branch = project.gitDir ? (git(project.worktree, 'branch', '--show-current') || null) : null;
      const head = project.gitDir ? headOf(project.worktree) : null;
      const record = {
        schemaVersion: 2, gitDir: project.gitDir, worktree: project.worktree, folder: project.folder, task,
        branch, head, createdAt: new Date().toISOString(), note, artifacts,
      };
      const pointer = pointerPath(store, project.gitDir ?? project.worktree, project.folder, task);
      const temporary = join(store, 'pointers', `.pointer-${randomUUID()}.json`);
      try {
        writeFileSync(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
        renameSync(temporary, pointer);
      } finally { rmSync(temporary, { force: true }); }
      console.log(JSON.stringify(respond(store, project, { folder: project.folder, task })));
    }
  } else if (operation === 'read') {
    const store = existingRealpath(storeRaw(values, project));
    const result = store === null ? null : respond(store, project, { folder: project.folder, task });
    if (result === null) { console.log(JSON.stringify({ kind: 'missing' })); process.exit(2); }
    console.log(JSON.stringify(result));
  } else {
    const store = existingRealpath(storeRaw(values, project));
    console.log(JSON.stringify(store === null ? { kind: 'list', checkpoints: [] } : listStore(store)));
  }
} catch (error) {
  console.log(JSON.stringify({ kind: 'unavailable', detail: error.message }));
  process.exitCode = 1;
}
