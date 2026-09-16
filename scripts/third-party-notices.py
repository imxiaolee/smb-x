"""Collect declared licenses and bundled notices from the locked dependency sources."""
import json
import os
import re
import subprocess
import tarfile
import urllib.request
from functools import lru_cache
from pathlib import Path, PurePosixPath

def license_name(name):
    return re.match(r'^(licen[cs]e|copying|copyright|notice|authors)', name, re.I)

@lru_cache(maxsize=None)
def read_url(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'SMB-X-license-review'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode('utf-8')

@lru_cache(maxsize=None)
def upstream_tree(repo, commit):
    return json.loads(subprocess.check_output(
        ['gh', 'api', f'repos/{repo}/git/trees/{commit}?recursive=1'], encoding='utf-8'))

@lru_cache(maxsize=None)
def upstream_licenses(repository, commit, package_path):
    match = re.match(r'https://github.com/([^/]+/[^/#]+)', repository or '')
    if not match:
        raise RuntimeError(f'Cannot locate missing license in {repository}')
    repo = match[1].removesuffix('.git')
    # Use the exact crate publication commit, never a changing default branch.
    tree = upstream_tree(repo, commit)
    if tree.get('truncated'):
        raise RuntimeError(f'Incomplete license tree for {repo}')
    parents = {'.', str(PurePosixPath(package_path))}
    parents.update(str(p) for p in PurePosixPath(package_path).parents)
    result = []
    for item in tree['tree']:
        path = PurePosixPath(item['path'])
        if item['type'] != 'blob' or not license_name(path.name):
            continue
        if str(path.parent) not in parents and not any(
                license_name(p.name) and str(p.parent) in parents for p in path.parents):
            continue
        url = f'https://raw.githubusercontent.com/{repo}/{commit}/{item["path"]}'
        result.append((url, read_url(url)))
    if not result:
        raise RuntimeError(f'No upstream license found for {repo}@{commit}:{package_path}')
    return result

root = Path(__file__).resolve().parent.parent
target = os.environ.get('BUILD_TARGET')
if not target:
    rustc = subprocess.check_output(['rustc', '-vV'], encoding='utf-8')
    target = re.search(r'^host: (.+)$', rustc, re.M)[1]
metadata = json.loads(subprocess.check_output(
    ['cargo', 'metadata', '--locked', '--format-version', '1', '--filter-platform', target, '--manifest-path',
     str(root / 'src-tauri/Cargo.toml')], cwd=root, encoding='utf-8'))
resolved = {node['id'] for node in metadata['resolve']['nodes']}
packages = []
mpl_sources = []
for p in metadata['packages']:
    if p['source'] is not None and p['id'] in resolved:
        directory = Path(p['manifest_path']).parent
        if 'MPL-2.0' in (p.get('license') or ''):
            mpl_sources.append((p, directory))
        packages.append((f"Rust: {p['name']} {p['version']}", p.get('license'),
                         directory, p.get('license_file'), p))
lock = json.loads((root / 'package-lock.json').read_text(encoding='utf-8'))
for path, info in lock['packages'].items():
    directory = root / path
    if not path or info.get('dev') or not directory.is_dir():
        continue
    manifest = json.loads((directory / 'package.json').read_text(encoding='utf-8'))
    packages.append((f"npm: {manifest['name']} {manifest['version']}",
                     manifest.get('license') or info.get('license'), directory, None, None))
out = ['SMB X — Third-party notices',
       'Inventory includes Rust build/test and target-specific dependencies plus production npm packages.',
       'Licenses apply to their respective components; original notices follow.',
       'Unmodified MPL-2.0 component sources are included in THIRD_PARTY_SOURCES.tar.gz.',
       'Source archives are also available at the version-specific crates.io URLs below.\n']
missing = []
errors = []
expressions = set()
for name, license_id, directory, explicit, crate in sorted(packages):
    if not license_id and not explicit:
        raise RuntimeError(f'License not declared: {name}')
    expressions.add(str(license_id))
    out += ['\n' + '=' * 78, name, f'Declared license: {license_id or explicit}']
    if crate:
        out.append(f'Source: https://crates.io/api/v1/crates/{crate["name"]}/{crate["version"]}/download')
    files = set()
    for f in directory.iterdir():
        if license_name(f.name):
            if f.is_file():
                files.add(f)
            elif f.is_dir():
                files.update(x for x in f.rglob('*') if x.is_file())
    if explicit:
        files.add(directory / explicit)
    if not files and license_id == 'MPL-2.0':
        # MPL uses source-file notices. Preserve those sources in the accompanying
        # archive and include the standard license text supplied by another MPL crate.
        for other, other_dir in mpl_sources:
            alternatives = [f for f in other_dir.iterdir() if f.is_file() and license_name(f.name)]
            if alternatives:
                for f in alternatives:
                    out += [f'Standard MPL text from {other["name"]}/{f.name}:', f.read_text(encoding='utf-8')]
                out.append('Original source-file notices are preserved in THIRD_PARTY_SOURCES.tar.gz.')
                break
        else:
            raise RuntimeError(f'MPL text unavailable: {name}')
        continue
    if not files:
        try:
            print(f'Recovering license: {name}', flush=True)
            vcs_file = directory / '.cargo_vcs_info.json'
            if not crate or not vcs_file.exists():
                raise RuntimeError(f'License text unavailable: {name}')
            vcs = json.loads(vcs_file.read_text(encoding='utf-8'))
            repository = crate.get('repository')
            if not repository:
                info = json.loads(read_url(f'https://crates.io/api/v1/crates/{crate["name"]}/{crate["version"]}'))
                repository = info['version'].get('repository') or info['version'].get('homepage')
            for url, text in upstream_licenses(repository, vcs['git']['sha1'], vcs.get('path_in_vcs', '')):
                out += [f'\n--- Upstream license: {url} ---', text]
            missing.append(name)
        except Exception as exc:
            errors.append(f'{name}: {exc}')
    for f in sorted(files):
        out += [f'\n--- {f.relative_to(directory).as_posix()} ---',
                f.read_text(encoding='utf-8', errors='replace')]
if errors:
    raise RuntimeError('Unresolved license notices:\n' + '\n'.join(errors))
(root / 'THIRD_PARTY_NOTICES.txt').write_text('\n'.join(out) + '\n', encoding='utf-8')
with tarfile.open(root / 'THIRD_PARTY_SOURCES.tar.gz', 'w:gz') as archive:
    for p, directory in mpl_sources:
        archive.add(directory, arcname=f'{p["name"]}-{p["version"]}')
print(f'Collected {len(packages)} packages. License expressions: {sorted(expressions)}')
print(f'Upstream license text recovered for: {missing}')
print(f'MPL sources included: {[p["name"] for p, _ in mpl_sources]}')
