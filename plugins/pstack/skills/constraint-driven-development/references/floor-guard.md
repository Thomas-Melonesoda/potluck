# Floor guard: reference implementation

Every numbered dimension in `CONSTRAINTS.md` maps to a de facto tool (Step 4). The **floor** does not: it is a diff-scoped check for the five moves in Step 6, and without a shipped reference every agent invents its own, so two runs (or a Python repo and a Go one) produce two different guards. That is the exact non-determinism this skill exists to remove.

This is the reference. Adapt the patterns to your stack; keep the contract identical.

## Contract

- **Input:** the diff between the merge base and the working tree (added *and* removed lines, plus untracked files). A guard that reads only `git diff` misses new files and staged-but-uncommitted work.
- **Detects the five Step 6 moves:** a weakened threshold in `CONSTRAINTS.md`, a test made easier (`.skip`, a deleted test file, an assertion removed from a test that stayed), a silenced checker (a new suppression comment), unfinished work (a stub or empty `catch`), a new Exceptions row.
- **Exit codes:** `0` clean, `1` at least one floor violation (block the change), `2` the guard could not run (no merge base, not a git repo). Never let a `2` read as a `0`.
- **Reports the rule and the location, never the matched secret value.** Redaction is not optional (Step 4).
- **Tightening is silent, loosening is loud:** only surfaces moves that lower the bar.

## Reference (Node, ~stack-agnostic patterns)

```js
#!/usr/bin/env node
// floor-guard.mjs — diff-scoped enforcement of the CONSTRAINTS.md floor.
// Usage: node floor-guard.mjs [--base <ref>]   (default base: origin/main)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const base = (() => {
  const i = process.argv.indexOf('--base');
  return i > -1 ? process.argv[i + 1] : 'origin/main';
})();

// `git diff --no-index` exits 1 whenever the two sides differ, which is the normal case for a
// new file, so that output is kept. Any other failure is null, and null never reads as clean.
const git = (args, { diffExit = false } = {}) => {
  try { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return diffExit && e.status === 1 && typeof e.stdout === 'string' ? e.stdout : null; }
};
const bail = (msg) => { console.error('floor-guard: ' + msg); process.exit(2); };

// Run from the top of the work tree. `git ls-files` lists only the current directory's subtree,
// relative to it, so a guard started in a subfolder would miss untracked files elsewhere and name
// the rest differently from `git diff`, which always covers the whole tree.
const top = git(['rev-parse', '--show-toplevel'])?.trim();
if (!top) bail('not inside a git work tree');
process.chdir(top);

// Merge base; bail to exit 2 rather than pretending a shallow/rootless clone is clean.
const mergeBase = git(['merge-base', base, 'HEAD'])?.trim();
if (!mergeBase) bail('no merge base against ' + base);

// Unified diff plus untracked files (git diff alone cannot see new files), without rename
// detection, so a renamed file reads as deleted and added. The two paths of a test file that was
// only renamed (below) are dropped from it by name.
const isCI = (f) => /^\.github\/(workflows|actions)\/.*\.ya?ml$|^\.(circleci|buildkite|woodpecker)\/.*\.ya?ml$|^ci_scripts\/|(^|\/)Jenkinsfile$|^(\.gitlab-ci|\.travis|\.drone|\.woodpecker|azure-pipelines|bitbucket-pipelines|appveyor|codemagic|bitrise)\.ya?ml$/.test(f);
// A test is only renamed when its blob is unchanged (git's similarity score alone is not enough: it
// rates reordered lines 100%), it stays in its folder with its extension and a plain name, it is not
// CI configuration, and the new name changes no listed runner's default discovery: every pattern
// below reads both names or neither. For Go, a name go test skips also fails, and a test whose
// snapshot is keyed by its old name (Jest, Vitest, Bun, node --test) is not only renamed: under the
// new name the runner writes a fresh snapshot.
const DISCOVERY = [
  /\.test\.[cm]?[jt]sx?$/, /\.spec\.[cm]?[jt]sx?$/, /_test\.[cm]?[jt]sx?$/, /-test\.[cm]?[jt]sx?$/, /_spec\.[cm]?[jt]sx?$/,
  /^test-.*\.[cm]?[jt]sx?$/, /^test\.[cm]?[jt]sx?$/, // Jest, Vitest, node --test, Bun, Deno, AVA
  /^test_.*\.py$/, /_test\.py$/, /^test.*\.py$/, // pytest, unittest
  /_test\.go$/, /Tests\.swift$/, // go test, XCTest
  /^test.*\.rb$/, /^test_.*\.rb$/, /^test[_-].+\.rb$/, /_test\.rb$/, /[_-]test\.rb$/, /_spec\.rb$/, // rake, minitest, test-unit, rails, RSpec
  /\.cy\.[cm]?[jt]sx?$/, // Cypress
];
const GO_SKIPPED = /^[._].*\.go$|_(aix|android|darwin|dragonfly|freebsd|hurd|illumos|ios|js|linux|nacl|netbsd|openbsd|plan9|solaris|wasip1|windows|zos|386|amd64|amd64p32|arm|armbe|arm64|arm64be|loong64|mips|mipsle|mips64|mips64le|mips64p32|mips64p32le|ppc|ppc64|ppc64le|riscv|riscv64|s390|s390x|sparc|sparc64|wasm)_test\.go$/;
const folderOf = (f) => f.slice(0, f.lastIndexOf('/') + 1);
const nameOf = (f) => f.slice(f.lastIndexOf('/') + 1);
const extOf = (f) => f.match(/\.[^./]+$/)?.[0] ?? '';
// A plain name: a letter or digit first, then letters, digits, _ and - (no - for Python, whose module
// names cannot hold one), and no dot beyond .test or .spec and the extension.
const plainName = (f) => {
  const stem = nameOf(f).slice(0, nameOf(f).length - extOf(f).length).replace(/\.(test|spec)$/, '');
  return extOf(f) === '.py' ? /^[A-Za-z_]\w*$/.test(stem) : /^[A-Za-z0-9][\w-]*$/.test(stem);
};
const keepsTest = (from, to) => !isCI(from) && !isCI(to) && folderOf(from) === folderOf(to) && extOf(from) === extOf(to)
  && plainName(to) && !GO_SKIPPED.test(nameOf(to))
  && DISCOVERY.some((r) => r.test(nameOf(from))) && DISCOVERY.every((r) => r.test(nameOf(from)) === r.test(nameOf(to)));
const untrackedFiles = git(['ls-files', '--others', '--exclude-standard']);
if (untrackedFiles === null) bail('could not list untracked files');
const raw = git(['diff', '--raw', '-M', '-z', '--no-abbrev', mergeBase, '--']);
if (raw === null) bail('could not diff against ' + mergeBase);
const kept = new Set();
for (let i = 0, t = raw.split('\0'); i < t.length - 1;) {
  const [, , blobFrom, blobTo, status] = t[i++].split(' ');
  if (!/^[RC]/.test(status)) { i++; continue; }
  const from = t[i++], to = t[i++];
  const snapshot = [folderOf(from) + '__snapshots__/' + nameOf(from) + '.snap', from + '.snapshot'].some((f) => git(['cat-file', '-e', mergeBase + ':' + f]) !== null);
  const reused = untrackedFiles.split('\n').includes(from);
  if (status[0] === 'R' && blobFrom === blobTo && !/^0+$/.test(blobTo) && keepsTest(from, to) && !snapshot && !reused) kept.add(from).add(to);
}
const tracked = git(['diff', '--unified=0', '--no-renames', mergeBase, '--']);
if (tracked === null) bail('could not diff against ' + mergeBase);
const untracked = untrackedFiles.split('\n').filter(Boolean).map((f) => {
  const d = git(['diff', '--no-index', '--unified=0', '/dev/null', f], { diffExit: true });
  if (d === null) bail('could not diff untracked file ' + f);
  return d;
}).join('\n');
const diff = tracked + '\n' + untracked;

// Walk the diff. `---` and `+++` are file headers only between a file's `diff` line and its first
// `@@` hunk; inside a hunk every line is content, so an added `++i` (shown as `+++i`) or a removed
// `-- comment` is a change, not a header. Both headers name the file, so a deletion
// (`+++ /dev/null`) keeps its name. git ends a name that holds a space with a tab.
const added = [], removed = [], deleted = [];
const pathOf = (s) => s.replace(/^[ab]\//, '').replace(/\t$/, '');
let file = '', oldFile = '', inHeader = false;
for (const line of diff.split('\n')) {
  if (line.startsWith('diff ')) inHeader = true;
  else if (line.startsWith('@@')) inHeader = false;
  else if (inHeader) {
    if (line.startsWith('--- ')) oldFile = pathOf(line.slice(4));
    else if (line.startsWith('+++ ')) {
      const newFile = pathOf(line.slice(4));
      file = newFile === '/dev/null' ? oldFile : newFile;
      if (newFile === '/dev/null' && !kept.has(file)) deleted.push(file);
    }
  }
  else if (kept.has(file)) continue;
  else if (line.startsWith('+')) added.push({ file, text: line.slice(1) });
  else if (line.startsWith('-')) removed.push({ file, text: line.slice(1) });
}

const findings = [];
const flag = (rule, f, text, max = 120) => findings.push({ rule, file: f, text: text.trim().slice(0, max) });
const isTest = (f) => /\.(test|spec)\.|_test\.|test_|Tests\.swift$/.test(f);
const isConstraints = (f) => /CONSTRAINTS\.md$/.test(f);
// Only plain Markdown goes unchecked: it describes these moves and runs none of them. Every other
// file runs somewhere (code, .mdx, notebooks, CI configuration), so the checks below read it.
// Widening this list loosens the floor. CONSTRAINTS.md is Markdown too, and its own checks
// (exceptions, rules, thresholds) never consult the list.
const UNCHECKED = ['.md'];
const checked = (f) => !UNCHECKED.some((x) => f.toLowerCase().endsWith(x));

// 1. Silenced checker — extend this list for your ecosystem.
const SUPPRESSIONS = /@ts-ignore|@ts-nocheck|eslint-disable|biome-ignore|# *noqa|# *type: *ignore|istanbul ignore|nosemgrep|gitleaks:allow|Stryker disable/;
// 4. Unfinished work.
const STUBS = /throw new (Error|NotImplemented).*[Nn]ot implemented|catch\s*\(\w*\)\s*\{\s*\}|catch\s*\{\s*\}|\bTODO\b|\bpass\s*# *stub/;
// 2. A test made easier (added skips).
const SKIPS = /\.(skip|todo)\b|\bxit\(|\bxdescribe\(|@pytest\.mark\.skip|t\.Skip\(|\bXCTSkip(?:If|Unless)?\s*\(/;

for (const { file, text } of added.filter((l) => checked(l.file))) {
  if (SUPPRESSIONS.test(text)) flag('silenced-checker', file, text);
  if (STUBS.test(text)) flag('unfinished-work', file, text);
  if (SKIPS.test(text)) flag('test-made-easier', file, text);
}
// 5. A new exception lowers a bar that already exists. The first CONSTRAINTS.md in a repository
// sets the bar, so its rows, exceptions included, are the bar itself. The bar exists if the branch
// point or the base it merges into has one, so a branch cut before main gained its first is not.
const hadBar = [mergeBase, base].some((rev) => {
  const files = git(['ls-tree', '-r', '-z', '--name-only', rev]);
  if (files === null) bail('could not list the files at ' + rev);
  return files.split('\0').some(isConstraints);
});
for (const { file, text } of added) if (hadBar && isConstraints(file) && /^\| *(W|E)\d+ *\|/.test(text)) flag('new-exception', file, text);

// 2b. A test file deleted (one renamed to a name its runner still reads is only renamed).
const ASSERTION = /\b(expect|assert|should)\b|\bXCTAssert|\bXCTFail\b|#require\b/;
const isTestFile = (f) => isTest(f) && checked(f);
for (const f of deleted) if (isTestFile(f)) flag('test-deleted', f, 'file deleted');

// An assertion removed from a test file that still exists, too. One added back unchanged in the
// same file moved, which can carry it into dead code. Otherwise it pairs, in order, with an
// assertion added in that file: it changed. Either needs evidence that the behavior changed and
// that the new form is no weaker. One with no assertion added in its place, or only a
// commented-out one, was removed.
const isComment = (t) => /^\s*(\/\/|#|\/\*|\*)/.test(t);
const inTest = (l) => isTestFile(l.file) && !deleted.includes(l.file) && ASSERTION.test(l.text);
const assertsAdded = added.filter(inTest);
const unmoved = removed.filter(inTest).filter((r) => {
  const i = assertsAdded.findIndex((a) => a.file === r.file && a.text.trim() === r.text.trim());
  if (i > -1) flag('assertion-moved', r.file, assertsAdded.splice(i, 1)[0].text);
  return i < 0;
});
for (const r of unmoved) {
  const i = assertsAdded.findIndex((a) => a.file === r.file && !isComment(a.text));
  if (i < 0) flag('assertion-removed', r.file, r.text);
  else flag('assertion-changed', r.file, r.text.trim().slice(0, 100) + '  ->  ' + assertsAdded.splice(i, 1)[0].text.trim().slice(0, 100), 210);
}

// 2d. A test step removed from CI configuration: a removed line that runs the tests, with no
// line running the same kind of test added back in any CI file, so a step that moved still pairs
// and one commented out does not. A step's name is not a step.
const TEST_RUN = /\b(?:(?:npm|pnpm|yarn|bun)(?: -\S+)*(?: run)?|swift|go|cargo|mvn|gradlew?|make|dotnet|mix|rake) test[\w:-]*|\bxcodebuild\b.*\btest(?:-without-building)?(?![\w-])|\b(?:python3? -m (?:pytest|unittest)|pytest|vitest|jest|rspec|phpunit|ctest|fastlane scan)(?![\w.-])/g;
const testRun = (t) => {
  if (/^\s*(#|\/\/)|^\s*(-\s+)?name:/.test(t)) return null;
  for (const m of t.matchAll(TEST_RUN)) {
    if (/\binstall\b/.test(t.slice(0, m.index).split(/&&|\|\||[;|]/).pop())) continue;
    return m[0].replace(/^(?:(?:npm|pnpm|yarn|bun)\b.*|vitest|jest)$/, 'js test').replace(/^xcodebuild\b.*/, 'xcodebuild test').replace(/ test[\w:-]*$/, ' test').replace(/\s+/g, ' ');
  }
  return null;
};
const runsAdded = added.filter((l) => isCI(l.file) && checked(l.file)).map((l) => testRun(l.text)).filter(Boolean);
for (const { file, text } of removed.filter((l) => isCI(l.file) && checked(l.file))) {
  const run = testRun(text);
  if (!run) continue;
  const i = runsAdded.indexOf(run);
  if (i < 0) flag('ci-test-removed', file, text);
  else runsAdded.splice(i, 1);
}

// 1b/2c. A rule in CONSTRAINTS.md weakened or removed. A rule is a floor bullet or a table row,
// identified by the bullet's text before its first colon or by the row's first cell. Each number
// carries a direction read from the words around it: a minimum (>=, at least, must not fall) is
// loosened by going down, a maximum (<=, at most, under, must not grow) by going up. A number whose
// direction cannot be read is reported whenever it changes, because the guard cannot tell
// tightening from loosening and staying quiet is the wrong default. Numbers are paired within
// their direction (the first minimum with the first minimum, and so on), so a number added
// elsewhere in the text does not shift the pairing; a threshold with no counterpart after the
// edit was removed, and an added one tightens.
const ruleKey = (t) => {
  const s = t.trim();
  if (s.startsWith('|')) return s.split('|').map((c) => c.trim()).filter(Boolean)[0] ?? '';
  if (/^[-*] /.test(s)) return s.slice(2).split(/[:：]/)[0].trim();
  return null; // prose, headings, dates: not a rule
};
const isException = (t) => /^\| *(W|E)\d+ *\|/.test(t.trim());
const MIN_BEFORE = /(>=|>|≥|at least|minimum|\bmin\b|no less than|not fall|not drop)\s*$/;
const MAX_BEFORE = /(<=|<|≤|at most|maximum|\bmax\b|no more than|under|below|not grow|not exceed)\s*$/;
const MIN_AFTER = /^\s*\S*\s*(?:\|\s*)?(or more|or higher|must not fall|must not drop)/;
const MAX_AFTER = /^\s*\S*\s*(?:\|\s*)?(or less|or lower|must not grow|must not exceed)/;
// The Chinese pass only adds findings: it gives a direction to a number the English words leave
// without one, from an unambiguous bar word before it (至少 or 不低于 for at least, 至多 or 不超过 for at
// most) or a whole direction cell after it (| 62.4% | 不得下降 |), so a bar flipped from 至少 to 至多,
// or stripped of its word, is reported. Words that disagree, and 以上, 以下 or 低于, which also mean
// "the above", "the following" or a failure condition, give none.
const ZH_MIN = /((?<!甚)至少|不低于|不少于|不得低于|不得下降到)\s*$/, ZH_MIN_CELL = /^\s*(?:%|[a-z]+)?\s*\|\s*不得下降\s*(?:\||$)/;
const ZH_MAX = /((?<!甚)至多|不超过|不高于|不得超过|不得高于|不得增长到)\s*$/, ZH_MAX_CELL = /^\s*(?:%|[a-z]+)?\s*\|\s*不得增长\s*(?:\||$)/;
const thresholds = (t, zh = false) => {
  const out = [], re = /\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(t))) {
    const before = t.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40).toLowerCase();
    const zhMin = zh && (ZH_MIN.test(before) || ZH_MIN_CELL.test(after)), zhMax = zh && (ZH_MAX.test(before) || ZH_MAX_CELL.test(after));
    const dir = MIN_BEFORE.test(before) || MIN_AFTER.test(after) ? 'min'
      : MAX_BEFORE.test(before) || MAX_AFTER.test(after) ? 'max'
      : zhMin && !zhMax ? 'min' : zhMax && !zhMin ? 'max' : null;
    out.push({ n: Number(m[0]), dir });
  }
  return out;
};
const compare = (r, a, zh) => {
  const before = thresholds(r, zh), after = thresholds(a, zh);
  let verdict = null;
  for (const dir of ['min', 'max', null]) {
    const was = before.filter((x) => x.dir === dir), now = after.filter((x) => x.dir === dir);
    was.forEach((b, i) => {
      const n = now[i];
      if (verdict) return;
      if (!n) verdict = 'threshold-removed';
      else if (n.n === b.n) return;
      else if (dir === 'min' ? n.n < b.n : dir === 'max' ? n.n > b.n : true) {
        verdict = dir ? 'threshold-loosened' : 'threshold-changed';
      }
    });
  }
  return verdict;
};
// 1c. Rule names are unique within each CONSTRAINTS.md this change touches, so a rule pairs with
// one line. Only top-level bullets and table rows count: a nested bullet, a fenced example, and a
// table's header and separator rows are not rules of their own.
const isSeparator = (t) => t.includes('|') && /^[\s|:-]*-[\s|:-]*$/.test(t);
for (const f of new Set([...added, ...removed].map((l) => l.file).filter(isConstraints))) {
  if (deleted.includes(f)) continue;
  let lines;
  try { lines = readFileSync(f, 'utf8').split('\n'); } catch { bail('could not read ' + f); }
  const at = new Map();
  let fenced = false;
  lines.forEach((t, i) => {
    if (/^\s*(```|~~~)/.test(t)) fenced = !fenced;
    const key = fenced || /^\s/.test(t) ? null : ruleKey(t);
    if (key && !isSeparator(t) && !(t.startsWith('|') && isSeparator(lines[i + 1] ?? ''))) at.set(key, [...(at.get(key) ?? []), i + 1]);
  });
  for (const [key, n] of at) if (n.length > 1) flag('duplicate-rule', f, `"${key}" names ${n.length} rules (lines ${n.join(', ')}); rule names must be unique`);
}
const removedRules = removed.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null);
const addedRules = added.filter((l) => isConstraints(l.file) && ruleKey(l.text) !== null);
const isRow = (t) => t.trim().startsWith('|');
const claimCounterpart = (r, { sameForm }) => {
  const i = addedRules.findIndex((x) => ruleKey(x.text) === ruleKey(r.text) && (!sameForm || isRow(x.text) === isRow(r.text)));
  return i < 0 ? undefined : addedRules.splice(i, 1)[0];
};
const pairs = removedRules.map((r) => ({ r, a: claimCounterpart(r, { sameForm: true }) }));
for (const p of pairs) p.a ??= claimCounterpart(p.r, { sameForm: false });
for (const { r, a } of pairs) {
  if (!a) {
    if (!isException(r.text)) flag('rule-removed', r.file, r.text); // dropping an exception tightens: silent
    continue;
  }
  // Every change the English reading reports is reported; the Chinese reading may add one.
  const verdict = compare(r.text, a.text, true) ?? compare(r.text, a.text, false);
  if (verdict) flag(verdict, r.file, r.text + '  ->  ' + a.text);
}

if (findings.length === 0) { console.log('floor-guard: clean'); process.exit(0); }
console.error('floor-guard: ' + findings.length + ' floor violation(s):');
for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`);
if (findings.some((f) => f.rule === 'rule-removed')) {
  console.error('\nA rule-removed finding can also mean the rule\'s label changed: rename a rule in one commit and change its thresholds in another.');
}
if (findings.some((f) => f.rule === 'assertion-changed' || f.rule === 'assertion-moved')) {
  console.error('\nAn assertion-changed or assertion-moved finding is a test assertion replaced or moved. It is a fix only if the behavior really changed and the new form is no weaker: have someone who did not write the change check the evidence before it ships.');
}
if (findings.some((f) => f.rule === 'threshold-removed')) {
  console.error('\nA threshold-removed finding can also mean a number gained or lost its direction words (">= 80%" becoming "80%", or the reverse): compare the two lines before assuming a threshold was deleted.');
}
console.error('\nEach is a move that lowers the bar. Fix the code, or route it through a tracked exception.');
process.exit(1);
```

## Adapting it

- **Patterns are the only stack-specific part.** Add your language's suppression and stub forms to the three regexes; the diff plumbing, the CONSTRAINTS.md checks, and the exit codes stay as-is.
- **A `.constraintsignore`** (one glob per line) lets you exempt a path the guard would otherwise flag; check each added line's file against it before flagging, so a genuine exception is a tracked file rather than a loosened rule.
- **This is a starting point, not a finished tool.** It is deliberately regex-shallow: it catches the cheap-road-to-green moves agents actually make, not a determined human hiding a change. That is the right trade for a check that runs on every diff. Once you outgrow it, move to a real runner (Escalation Path level 3).
