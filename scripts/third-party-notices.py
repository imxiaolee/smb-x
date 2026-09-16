"""Collect declared licenses and bundled notices from the locked dependency sources."""
import json
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parent.parent
metadata = json.loads(subprocess.check_output(
    ['cargo', 'metadata', '--locked', '--format-version', '1', '--manifest-path',
     str(root / 'src-tauri/Cargo.toml')], cwd=root, encoding='utf-8'))
packages = []
for p in metadata['packages']:
    if p['source'] is not None:
        packages.append((f"Rust: {p['name']} {p['version']}", p.get('license'),
                         Path(p['manifest_path']).parent, p.get('license_file')))
lock = json.loads((root / 'package-lock.json').read_text(encoding='utf-8'))
for path, info in lock['packages'].items():
    directory = root / path
    if not path or not directory.is_dir():
        continue
    manifest = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
    packages.append((f"npm: {manifest['name']} {manifest['version']}",
                     manifest.get('license') or info.get('license'), directory, None))
out = ['SMB X — Third-party notices',
       'Inventory includes build/test and target-specific dependencies, not all of which ship.',
       'Licenses apply to their respective components; original notices follow.\n']
missing = []
expressions = set()
for name, license_id, directory, explicit in sorted(packages):
    if not license_id and not explicit:
        raise RuntimeError(f'License not declared: {name}')
    expressions.add(str(license_id))
    out += ['\n' + '=' * 78, name, f'Declared license: {license_id or explicit}']
    files = set()
    for f in directory.iterdir():
        if re.match(r'^(licen[cs]e|copying|copyright|notice|authors)', f.name, re.I):
            if f.is_file():
                files.add(f)
            elif f.is_dir():
                files.update(x for x in f.rglob('*') if x.is_file())
    if explicit:
        files.add(directory / explicit)
    if not files:
        missing.append(name)
        out.append('No separate license file bundled by upstream; see declared license and source package.')
    for f in sorted(files):
        out += [f'\n--- {f.relative_to(directory).as_posix()} ---',
                f.read_text(encoding='utf-8', errors='replace')]
(root / 'THIRD_PARTY_NOTICES.txt').write_text('\n'.join(out) + '\n', encoding='utf-8')
print(f'Collected {len(packages)} packages. License expressions: {sorted(expressions)}')
print(f'Packages with no separate license file: {missing}')
