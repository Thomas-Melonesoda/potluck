// potluck: whether a GitHub Actions workflow runs on a given pull request, read
// from the workflow file's on: value. The merge gate waits for every workflow
// this says runs, so anything it cannot read counts as running.

const PR_EVENTS = ["pull_request", "pull_request_target"];
// A head push is a pull request's opened, synchronize, or reopened event, the
// types GitHub uses when a trigger names none.
const PUSH_TYPES = new Set(["opened", "synchronize", "reopened"]);
// GitHub runs a paths-filtered workflow for any diff over 300 files.
const PATHS_LIMIT = 300;

// Whether the workflow in `text` runs on a PR into `base` that changes `changed`.
export function prTrigger(text, { base, changed }) {
  let on;
  try {
    on = onValue(text);
  } catch {
    // YAML outside the subset read here: an event must be named literally,
    // so only a file that names a pull request event counts as running.
    return /\bpull_request/.test(text);
  }
  if (on === undefined) return true;
  const events = typeof on === "string" ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((e) => [e, null])) : on;
  if (events === null || typeof events !== "object") return true;
  return PR_EVENTS.filter((e) => e in events).some((e) => runs(events[e], base, changed));
}

function runs(config, base, changed) {
  if (config === null || config === "") return true;
  if (typeof config !== "object" || Array.isArray(config)) return true;
  const list = (key) => (config[key] === undefined ? null : [config[key]].flat().map(String));
  const types = list("types");
  if (types && !types.some((t) => PUSH_TYPES.has(t))) return false;
  const branches = list("branches"), ignoreBranches = list("branches-ignore");
  if (branches && !matches(branches, base)) return false;
  if (ignoreBranches && matches(ignoreBranches, base)) return false;
  if (changed.length >= PATHS_LIMIT) return true;
  const paths = list("paths"), ignorePaths = list("paths-ignore");
  if (paths && !changed.some((f) => matches(paths, f))) return false;
  if (ignorePaths && changed.every((f) => matches(ignorePaths, f))) return false;
  return true;
}

// GitHub's filter patterns, in order, a leading ! excluding; the last match wins.
function matches(patterns, name) {
  let hit = false;
  for (const p of patterns) {
    const negated = p.startsWith("!");
    if (glob(negated ? p.slice(1) : p).test(name)) hit = !negated;
  }
  return hit;
}

function glob(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?" || c === "+") re += c;
    else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else re += c.replace(/[.^$|(){}\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// The workflow's top-level on: value (or "on" quoted, or YAML 1.1's true),
// undefined when there is none. Throws on YAML outside the subset read here.
export function onValue(text) {
  const lines = text.replace(/\r/g, "").split("\n").map(stripComment).filter((l) => l.trim() && !/^\s*(---|\.\.\.)\s*$/.test(l));
  const at = lines.findIndex((l) => /^(["']?)(on|true)\1\s*:/.test(l));
  if (at < 0) return undefined;
  const rest = lines[at].replace(/^(["']?)(on|true)\1\s*:/, "").trim();
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (!/^\s/.test(line) && depth([rest, ...body].join("\n")) <= 0) break;
    body.push(line);
  }
  if (rest) return flow([rest, ...body].join(" "));
  return body.length ? block(body) : null;
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

const indentOf = (line) => line.search(/\S/);

// How many flow brackets the text leaves open, outside quotes.
function depth(text) {
  let open = 0, quote = null;
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "[" || c === "{") open++;
    else if (c === "]" || c === "}") open--;
  }
  return open;
}
const ENTRY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:"'[{][^:]*?)\s*:(?:\s+(.*)|$)/;

// A block map or list made of these lines, all at least as deep as the first.
function block(lines) {
  const indent = indentOf(lines[0]);
  const items = [];
  for (const line of lines) {
    const last = items.at(-1);
    // A flow value runs on until its brackets close, at any indent, and a
    // map key's list may sit at the key's own indent.
    if (last && (depth([last.head, ...last.body].join("\n")) > 0 || (indentOf(line) === indent && /^-( |$)/.test(line.trim()) && !/^-( |$)/.test(last.head) && /:$/.test(last.head)))) last.body.push(line);
    else if (indentOf(line) < indent) throw new Error("bad indent");
    else if (indentOf(line) === indent) items.push({ head: line.trim(), body: [] });
    else last.body.push(line);
  }
  const lines2 = (body) => body.map((l) => l.trim());
  const value = (rest, body) => {
    if (/^[|>][+-]?\d*$/.test(rest)) return lines2(body).join("\n");
    if (/^[[{"']/.test(rest)) return flow([rest, ...lines2(body)].join(" "));
    // A plain value is text to the end of its line, continued on deeper ones.
    if (rest) return scalar([rest, ...lines2(body)].join(" "));
    return body.length ? block(body) : null;
  };
  // A list item that is itself a map, such as - cron: "...", reads as a block one level in.
  const item = (rest, body) => (ENTRY.test(rest) ? block([`${" ".repeat(indent + 2)}${rest}`, ...body]) : value(rest, body));
  if (items.every((i) => i.head.startsWith("- ") || i.head === "-")) return items.map((i) => item(i.head.slice(1).trim(), i.body));
  const map = {};
  for (const { head, body } of items) {
    const m = head.match(ENTRY);
    if (!m) throw new Error(`not a map entry: ${head}`);
    map[scalar(m[1])] = value((m[2] ?? "").trim(), body);
  }
  return map;
}

function scalar(s) {
  if (s.startsWith('"')) return JSON.parse(s);
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s === "~" || s === "null") return null;
  return s;
}

// A flow value: [a, b], {k: v}, a quoted string, or a plain one.
function flow(text) {
  let i = 0;
  const space = () => {
    while (/\s/.test(text[i] ?? "")) i++;
  };
  const value = () => {
    space();
    const c = text[i];
    if (c === "[" || c === "{") {
      const close = c === "[" ? "]" : "}";
      const out = c === "[" ? [] : {};
      i++;
      for (space(); text[i] !== close; space()) {
        if (i >= text.length) throw new Error("unclosed flow collection");
        if (c === "[") out.push(value());
        else {
          const key = value();
          space();
          if (text[i] === ":") {
            i++;
            out[key] = value();
          } else out[key] = null;
        }
        space();
        if (text[i] === ",") i++;
        else if (text[i] !== close) throw new Error("expected , in flow collection");
      }
      i++;
      return out;
    }
    if (c === '"' || c === "'") {
      const m = text.slice(i).match(c === '"' ? /^"(?:[^"\\]|\\.)*"/ : /^'(?:[^']|'')*'/);
      if (!m) throw new Error("unclosed quote");
      i += m[0].length;
      return scalar(m[0]);
    }
    const m = text.slice(i).match(/^(?:[^,[\]{}:\s]|:(?=\S)|\s+(?=[^,[\]{}:\s]))*/);
    i += m[0].length;
    return scalar(m[0].trim());
  };
  const out = value();
  space();
  if (i < text.length) throw new Error("trailing text after a flow value");
  return out;
}
