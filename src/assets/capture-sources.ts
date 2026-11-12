/** ABOUTME: Captures staged source files and their local imports beside a run's diff. */
import { script } from './script';

export const SOURCE_FILE_LIMIT = 64;
export const SOURCE_FILE_BYTES = 64 * 1024;
export const SOURCE_ARTIFACT_BYTES = 512 * 1024;

export const CAPTURE_SOURCES_PY =
  script`import json, posixpath, re, subprocess, sys

MAX_FILES = __MAX_FILES__
MAX_FILE_BYTES = __MAX_FILE_BYTES__
MAX_BYTES = __MAX_BYTES__
EXT = re.compile(r'\.(?:[cm]?[jt]sx?|svelte|vue|astro)$', re.I)
IMPORT = re.compile(r'''(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\r\n]+)['"]''')

def git(*args):
    return subprocess.check_output(['git', *args])

def stem(path):
    return re.sub(r'/index$', '', EXT.sub('', path))

def resolve(target, paths, alias=False):
    base, extension = posixpath.splitext(target)
    source_extensions = {'.js': ('.ts', '.tsx'), '.mjs': ('.mts',), '.cjs': ('.cts',)}
    candidates = [target, *(base + ext for ext in source_extensions.get(extension, ()))]
    for candidate in candidates:
        matches = [path for path in paths if path == candidate or (alias and path.endswith('/' + candidate))]
        if matches:
            return matches
    return paths

entries = {}
for entry in git('ls-files', '--stage', '-z').decode().split('\0'):
    if not entry:
        continue
    meta, path = entry.split('\t', 1)
    mode, oid, stage = meta.split()
    if mode in ('100644', '100755') and stage == '0' and EXT.search(path) and 'node_modules' not in path.split('/'):
        entries[path] = oid
stems = {}
aliases = {}
for path in sorted(entries):
    key = stem(path)
    stems.setdefault(key, []).append(path)
    parts = key.split('/')
    for index in range(len(parts)):
        aliases.setdefault('/'.join(parts[index:]), []).append(path)
queue = [p for p in git('diff', '--cached', '--name-only', '-z', sys.argv[1]).decode().split('\0') if p in entries]
seen = set()
sources = {}
while queue and len(sources) < MAX_FILES:
    path = queue.pop(0)
    if path in seen:
        continue
    seen.add(path)
    oid = entries[path]
    if int(git('cat-file', '-s', oid)) > MAX_FILE_BYTES:
        continue
    raw = git('cat-file', 'blob', oid)
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError:
        continue
    sources[path] = text
    if len(json.dumps(sources, ensure_ascii=False).encode()) > MAX_BYTES:
        del sources[path]
        break
    for specifier in IMPORT.findall(text):
        if specifier.startswith('.'):
            target = posixpath.normpath(posixpath.join(posixpath.dirname(path), specifier))
            queue.extend(resolve(target, stems.get(stem(target), [])))
        else:
            alias = re.match(r'^(?:[@~]/|[#$](?=\w+/))(.+)$', specifier)
            if alias:
                target = alias[1]
                queue.extend(resolve(target, aliases.get(stem(target), []), alias=True))
sys.stdout.write(json.dumps(sources, ensure_ascii=False))
`
    .replace('__MAX_FILES__', String(SOURCE_FILE_LIMIT))
    .replace('__MAX_FILE_BYTES__', String(SOURCE_FILE_BYTES))
    .replace('__MAX_BYTES__', String(SOURCE_ARTIFACT_BYTES));
