#!/usr/bin/env python3
"""Check active host records and package bytes against one expected snapshot."""
import hashlib, json, pathlib, sys
root, expected = map(pathlib.Path, sys.argv[1:])
lock = json.loads((expected / 'sources/knowledgebase.lock.json').read_text())
version = lock['version']
codex = json.loads((root / 'codex-list.json').read_text())['installed']
entries = [x for x in codex if x['pluginId'] == 'knowledgebase@Overlord']
assert len(entries) == 1 and entries[0]['enabled'] and entries[0]['installed'] and entries[0]['version'] == version
mcp = json.loads((root / 'codex-mcp.json').read_text())
assert sum(x['enabled'] and x['transport'].get('url') == 'https://knowledge.chaselubitz.com/mcp' for x in mcp) == 1
claude = json.loads((root / 'claude-list.json').read_text())
entries = [x for x in claude if x['id'] == 'knowledgebase@Overlord']
assert len(entries) == 1 and entries[0]['enabled'] and entries[0]['version'] == version
assert entries[0]['mcpServers']['knowledgebase']['url'] == 'https://knowledge.chaselubitz.com/mcp'
paths = {'codex': root / 'home/.codex/plugins/cache/Overlord/knowledgebase' / version, 'claude-code': pathlib.Path(entries[0]['installPath'])}
for host, cache in paths.items():
    package = expected / 'plugins' / host / 'knowledgebase'
    for skill in package.glob('skills/*/SKILL.md'):
        assert (cache / skill.relative_to(package)).read_bytes() == skill.read_bytes(), f'{host}: {skill}'
    assert len(list(package.glob('skills/*/SKILL.md'))) == 3
    # Confirm the installed full tree, not merely the marketplace's copy.
    files = sorted(x for x in cache.rglob('*') if x.is_file())
    digest = hashlib.sha256()
    for f in files:
        digest.update(f.relative_to(cache).as_posix().encode() + b'\0' + hashlib.sha256(f.read_bytes()).hexdigest().encode() + b'\n')
    assert digest.hexdigest() == lock['hosts'][host]['treeSha256'], (host, digest.hexdigest())
details = (root / 'claude-details.txt').read_text()
assert all(x in details for x in ('feature-handoff', 'feature-ranking', 'knowledgebase', 'MCP servers'))
print('Verified active version, package trees, skills, and endpoint:', version)
