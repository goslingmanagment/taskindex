#!/usr/bin/env python3
"""Materialize immutable v1 UI and fixture harness in /tmp; never run D1/vinext."""
from pathlib import Path
import argparse
import json
import subprocess

REVISION = '4b780e42292e8702eee0f906acb77d5aa34ab7c1'
DEFAULT_ROOT = '/tmp/taskindex-ui-reference-20260908'
parser = argparse.ArgumentParser()
parser.add_argument('--repo', type=Path, default=Path.cwd())
parser.add_argument('--root', type=Path, default=Path(DEFAULT_ROOT))
parser.add_argument('--deps', type=Path, help='Existing v1 node_modules; read-only reuse')
args = parser.parse_args()
root = args.root.absolute()
root.mkdir(parents=True, exist_ok=True)
archive = subprocess.check_output([
    'git', '-C', str(args.repo), 'archive', REVISION,
    'components', 'lib', 'hooks', 'app/globals.css',
])
subprocess.run(['tar', '-x', '-C', str(root)], input=archive, check=True)
deps_root = root / 'dependencies'
deps_root.mkdir(exist_ok=True)
for name in ('package.json', 'package-lock.json'):
    content = subprocess.check_output(['git', '-C', str(args.repo), 'show', f'{REVISION}:{name}'])
    (deps_root / name).write_bytes(content)
deps = args.deps.absolute() if args.deps else deps_root / 'node_modules'
link = root / 'node_modules'
if link.is_symlink():
    if link.readlink() != deps:
        raise SystemExit(f'{link} already links to another dependency tree; use a fresh --root')
elif link.exists():
    raise SystemExit(f'{link} already exists; use a fresh --root')
else:
    link.symlink_to(deps, target_is_directory=True)
source = Path(__file__).parent
for name in ('main.tsx', 'vite.config.ts', 'index.html', 'capture-desktop.js', 'capture-mobile.js'):
    (root / name).write_text((source / name).read_text().replace(DEFAULT_ROOT, str(root)))
(root / 'package.json').write_text(json.dumps({'private': True, 'type': 'module'}) + '\n')
print(f'Harness: {root}')
if not deps.exists():
    print(f'Install isolated v1 dependencies: npm ci --prefix {deps_root}')
print(f'Start: cd {root} && node node_modules/vite/bin/vite.js --config vite.config.ts --configLoader runner')
