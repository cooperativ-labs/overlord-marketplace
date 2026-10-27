#!/usr/bin/env python3
import json, pathlib, shutil, sys
root, expected = map(pathlib.Path, sys.argv[1:])
fixture = root / 'unrelated'
for host in ('codex', 'claude-code'):
    p = fixture / 'plugins' / host / 'unrelated'
    (p / 'skills' / 'unrelated').mkdir(parents=True)
    (p / 'skills' / 'unrelated' / 'SKILL.md').write_text('---\nname: unrelated\ndescription: A smoke fixture skill\n---\nUnrelated fixture.\n')
    manifest = {'name': 'unrelated', 'version': '1.0.0', 'description': 'Unrelated smoke fixture'}
    if host == 'codex':
        manifest['$schema'] = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
        (p / 'plugin.json').write_text(json.dumps(manifest))
        mcp = {'$schema': 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', 'mcpServers': {'fixture-plugin': {'type': 'streamable-http', 'url': 'https://fixture.invalid/mcp'}}}
        (p / 'mcp.json').write_text(json.dumps(mcp))
    else:
        (p / '.claude-plugin').mkdir()
        (p / '.claude-plugin' / 'plugin.json').write_text(json.dumps(manifest))
        (p / '.mcp.json').write_text(json.dumps({'mcpServers': {'fixture-plugin': {'type': 'http', 'url': 'https://fixture.invalid/mcp'}}}))
for directory in ('.agents/plugins', '.claude-plugin'):
    (fixture / directory).mkdir(parents=True)
(fixture / '.agents/plugins/marketplace.json').write_text(json.dumps({'name': 'Unrelated', 'plugins': [{'name': 'unrelated', 'source': {'source': 'local', 'path': './plugins/codex/unrelated'}, 'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_USE'}}]}))
(fixture / '.claude-plugin/marketplace.json').write_text(json.dumps({'name': 'Unrelated', 'owner': {'name': 'Fixture'}, 'plugins': [{'name': 'unrelated', 'source': './plugins/claude-code/unrelated'}]}))
legacy = root / 'legacy'
shutil.copytree(expected, legacy)
for host, path in [('codex', '.agents/plugins/marketplace.json'), ('claude-code', '.claude-plugin/marketplace.json')]:
    f = legacy / path
    data = json.loads(f.read_text())
    data['name'] = 'overlord-local' if host == 'codex' else 'knowledgebase'
    f.write_text(json.dumps(data))
