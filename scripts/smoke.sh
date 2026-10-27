#!/usr/bin/env bash
set -euo pipefail
if [[ ${OVERLORD_SMOKE_CLEAN:-} != 1 ]]; then
  exec env -i PATH="$PATH" OVERLORD_SMOKE_CLEAN=1 /bin/bash "$0" "$@"
fi
if [[ $# -ne 1 && ! ( $# -eq 3 && $2 == --upgrade-from ) ]]; then
  echo 'usage: smoke.sh <repo-dir> [--upgrade-from <commit>]' >&2; exit 2
fi
repo=$(cd "$1" && pwd -P)
scriptdir=$(cd "$(dirname "$0")" && pwd -P)
root=$(mktemp -d /tmp/overlord-smoke.XXXXXXXX)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/home" "$root/work" "$root/candidate" "$root/base" "$root/snapshot" "$root/home/.config" "$root/home/.cache" "$root/home/.local/share"
export HOME="$root/home" CODEX_HOME="$root/home/.codex" CLAUDE_CONFIG_DIR="$root/home/.claude"
export XDG_CONFIG_HOME="$root/home/.config" XDG_CACHE_HOME="$root/home/.cache" XDG_DATA_HOME="$root/home/.local/share"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$root/gitconfig" GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=file
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
: > "$GIT_CONFIG_GLOBAL"
mkdir -p "$CODEX_HOME" "$CLAUDE_CONFIG_DIR"
# Fixed distribution allowlist; reject symlinks rather than copying external content.
copy_candidate() {
  python3 - "$1" "$2" <<'PY'
import pathlib, shutil, sys
src,dst=map(pathlib.Path,sys.argv[1:])
for name in ('.agents/plugins/marketplace.json','.claude-plugin/marketplace.json','plugins','sources','policy','schemas','docs','scripts','test','package.json','README.md','RELEASING.md','.gitignore'):
    p=src/name
    if not p.exists(): continue
    if p.is_symlink() or (p.is_dir() and any(x.is_symlink() for x in p.rglob('*'))): raise SystemExit('symlink in distribution snapshot: '+str(p))
    q=dst/name; q.parent.mkdir(parents=True,exist_ok=True)
    if p.is_dir(): shutil.copytree(p,q)
    else: shutil.copy2(p,q)
PY
}
copy_candidate "$repo" "$root/candidate"
test -f "$root/candidate/sources/knowledgebase.lock.json" || { echo 'candidate has no Knowledgebase release' >&2; exit 2; }
base_present=0
if [[ $# -eq 3 ]]; then
  # Resolve a commit and archive it without using the caller's working tree.
  base=$(git -C "$repo" rev-parse --verify "$3^{commit}")
  mkdir "$root/archive"
  git -C "$repo" archive "$base" | tar -xf - -C "$root/archive"
  copy_candidate "$root/archive" "$root/base"
  if [[ -f "$root/base/sources/knowledgebase.lock.json" ]]; then base_present=1; fi
fi
if [[ $base_present == 1 ]]; then cp -R "$root/base/." "$root/snapshot/"; else cp -R "$root/candidate/." "$root/snapshot/"; fi
(cd "$root/snapshot" && git init -q -b main && git add . && git -c user.name=Smoke -c user.email=smoke@example.invalid commit -qm initial)
git clone -q --bare "$root/snapshot" "$root/remote.git"
if [[ $base_present == 1 ]]; then
  # Candidate B is committed only after the bare remote is created at A.
  for path in .agents .claude-plugin plugins sources policy schemas docs scripts test package.json README.md RELEASING.md .gitignore; do rm -rf "$root/snapshot/$path"; done
  cp -R "$root/candidate/." "$root/snapshot/"
  (cd "$root/snapshot" && git add -A && if ! git diff --cached --quiet; then git -c user.name=Smoke -c user.email=smoke@example.invalid commit -qm candidate; fi)
fi
git config --global protocol.file.allow always
git config --global credential.helper ''
git config --global 'url.file://'"$root"'/remote.git.insteadOf' https://github.com/cooperativ-labs/overlord-marketplace.git
cd "$root/work"
if [[ $base_present == 1 ]]; then expected="$root/base"; else expected="$root/candidate"; fi
python3 "$scriptdir/smoke-fixtures.py" "$root" "$expected"
mkdir -p "$HOME/.agents/plugins"
cat > "$HOME/.agents/plugins/marketplace.json" <<'JSON'
{"name":"overlord-local","plugins":[{"name":"overlord","source":{"source":"local","path":"./overlord"}},{"name":"scribe","source":{"source":"local","path":"./scribe"}}]}
JSON
cp "$HOME/.agents/plugins/marketplace.json" "$root/personal-before.json"
printf '[mcp_servers.unrelated]\nurl = "https://unrelated.invalid/mcp"\n' > "$CODEX_HOME/config.toml"
printf '{"env":{"SMOKE_UNRELATED":"preserved"}}\n' > "$CLAUDE_CONFIG_DIR/settings.json"
codex --version
claude --version
codex plugin marketplace add "$root/unrelated" --json
codex plugin add unrelated@Unrelated
claude plugin marketplace add "$root/unrelated"
claude plugin install unrelated@Unrelated
claude mcp add --scope user --transport http unrelated https://unrelated.invalid/mcp
codex plugin list --json > "$root/unrelated-codex-before.json"
claude plugin list --json > "$root/unrelated-claude-before.json"
codex plugin marketplace list --json > "$root/codex-marketplaces-before.json"
claude plugin marketplace list --json > "$root/claude-marketplaces-before.json"
cp "$CLAUDE_CONFIG_DIR/settings.json" "$root/settings-before.json"
cp "$CLAUDE_CONFIG_DIR/.claude.json" "$root/claude-config-before.json"
codex plugin marketplace add https://github.com/cooperativ-labs/overlord-marketplace.git --json
codex plugin add knowledgebase@Overlord
claude plugin marketplace add https://github.com/cooperativ-labs/overlord-marketplace.git
claude plugin install knowledgebase@Overlord
check() {
  codex plugin list --json > "$root/codex-list.json"
  codex mcp list --json > "$root/codex-mcp.json"
  claude plugin list --json > "$root/claude-list.json"
  claude plugin details knowledgebase > "$root/claude-details.txt"
  python3 "$scriptdir/smoke-verify.py" "$root" "$1"
}
check "$expected"
claude plugin validate "$expected"
cache=$(python3 - "$root/claude-list.json" <<'PY'
import json,sys
print(next(x['installPath'] for x in json.load(open(sys.argv[1])) if x['id']=='knowledgebase@Overlord'))
PY
)
claude plugin validate "$cache"
if [[ $base_present == 1 ]]; then
  # Advance the remote only after both clients have installed and checked A.
  git -C "$root/snapshot" push -q "$root/remote.git" main
  check "$root/base"
fi
codex plugin marketplace upgrade Overlord
claude plugin marketplace update Overlord
claude plugin update knowledgebase@Overlord
check "$root/candidate"
python3 - "$root" <<'PY'
import pathlib,sys
r=pathlib.Path(sys.argv[1])
for host,path in [('Codex',r/'home/.codex/plugins/cache/Overlord/knowledgebase'),('Claude',r/'home/.claude/plugins/cache/Overlord/knowledgebase')]:
    print(f'{host} cache directories (not active registration counts):', sorted(x.name for x in path.iterdir() if x.is_dir()))
PY
# Repeating refresh must leave the same active version and content.
cp "$root/codex-list.json" "$root/codex-first-refresh.json"
cp "$root/codex-mcp.json" "$root/codex-mcp-first-refresh.json"
cp "$root/claude-list.json" "$root/claude-first-refresh.json"
cp "$CLAUDE_CONFIG_DIR/settings.json" "$root/settings-first-refresh.json"
codex plugin marketplace upgrade Overlord
claude plugin marketplace update Overlord
claude plugin update knowledgebase@Overlord
check "$root/candidate"
python3 - "$root" <<'PY'
import json,pathlib,sys
r=pathlib.Path(sys.argv[1])
for first,second in [('codex-first-refresh.json','codex-list.json'),('codex-mcp-first-refresh.json','codex-mcp.json'),('claude-first-refresh.json','claude-list.json'),('settings-first-refresh.json','home/.claude/settings.json')]:
    assert json.loads((r/first).read_text())==json.loads((r/second).read_text()), f'repeat refresh changed {second}'
print('Repeat refresh left active records and settings unchanged')
PY
cmp "$root/personal-before.json" "$HOME/.agents/plugins/marketplace.json"
codex plugin marketplace list --json > "$root/codex-marketplaces-after.json"
claude plugin marketplace list --json > "$root/claude-marketplaces-after.json"
python3 - "$root" <<'PY'
import json, pathlib, sys
r=pathlib.Path(sys.argv[1]); home=r/'home'
servers=json.loads((r/'codex-mcp.json').read_text())
assert any(x['name']=='unrelated' and x['enabled'] and x['transport'].get('url')=='https://unrelated.invalid/mcp' for x in servers)
before=json.loads((r/'settings-before.json').read_text()); after=json.loads((home/'.claude/settings.json').read_text())
assert after['env']==before['env'] and after['enabledPlugins']['unrelated@Unrelated'] is True
before=json.loads((r/'claude-config-before.json').read_text()); after=json.loads((home/'.claude/.claude.json').read_text())
assert before['mcpServers']['unrelated']==after['mcpServers']['unrelated']
for host in ('codex','claude'):
    before=json.loads((r/f'unrelated-{host}-before.json').read_text()); after=json.loads((r/f'{host}-list.json').read_text())
    if host=='codex': before=before['installed']; after=after['installed']; key='pluginId'
    else: key='id'
    b=next(x for x in before if x[key]=='unrelated@Unrelated'); a=next(x for x in after if x[key]=='unrelated@Unrelated')
    assert b==a and a['enabled']
print('Unrelated installed plugins, config and personal catalog preserved')
def select(value):
    if isinstance(value, dict):
        found = []
        if value.get('name') == 'Unrelated' or value.get('marketplaceName') == 'Unrelated': found.append(value)
        if 'Unrelated' in value: found.append(value['Unrelated'])
        for item in value.values(): found.extend(select(item))
        return found
    if isinstance(value, list): return [x for item in value for x in select(item)]
    return []
for host in ('codex','claude'):
    before=select(json.loads((r/f'{host}-marketplaces-before.json').read_text()))
    after=select(json.loads((r/f'{host}-marketplaces-after.json').read_text()))
    assert before and before==after, f'{host} unrelated marketplace changed'
print('Unrelated marketplace registrations preserved')
PY
claude mcp get unrelated | grep -F 'https://unrelated.invalid/mcp'
# Migration has its own profiles so the preservation fixture stays independent.
export HOME="$root/migration" CODEX_HOME="$root/migration/.codex" CLAUDE_CONFIG_DIR="$root/migration/.claude"
export XDG_CONFIG_HOME="$root/migration/.config" XDG_CACHE_HOME="$root/migration/.cache" XDG_DATA_HOME="$root/migration/.local/share"
mkdir -p "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$root/migration-work"
cd "$root/migration-work"
# Seed static configuration; `codex mcp add` may initiate an OAuth flow.
cat > "$CODEX_HOME/config.toml" <<'TOML'
[mcp_servers.standalone]
url = "https://knowledge.chaselubitz.com/mcp"
[mcp_servers.unrelated]
url = "https://unrelated.invalid/mcp"
TOML
codex plugin marketplace add "$root/legacy" --json
codex plugin add knowledgebase@overlord-local
codex plugin marketplace add https://github.com/cooperativ-labs/overlord-marketplace.git --json
codex plugin add knowledgebase@Overlord
codex plugin list --json > "$root/codex-duplicates.json"
codex mcp list --json > "$root/codex-duplicate-mcp.json"
python3 - "$root/codex-duplicates.json" "$CODEX_HOME" <<'PY'
import json,pathlib,sys
items=json.load(open(sys.argv[1]))['installed']; home=pathlib.Path(sys.argv[2])
for name in ('knowledgebase@overlord-local','knowledgebase@Overlord'):
    matches=[x for x in items if x['pluginId']==name and x['enabled']]
    assert len(matches)==1
    market=name.split('@')[1]; path=home/'plugins/cache'/market/'knowledgebase'/matches[0]['version']/'mcp.json'
    assert json.loads(path.read_text())['mcpServers']['knowledgebase']['url']=='https://knowledge.chaselubitz.com/mcp'
print('Codex legacy and new enabled records both own the endpoint')
PY
python3 - "$root/codex-duplicate-mcp.json" <<'PY'
import json,sys
items=json.load(open(sys.argv[1]))
matches=[x for x in items if x['enabled'] and x['transport'].get('url')=='https://knowledge.chaselubitz.com/mcp']
assert any(x['name']=='standalone' for x in matches) and len(matches)>=2
print('Codex effective endpoint entries with standalone:', [x['name'] for x in matches])
PY
codex plugin remove knowledgebase@overlord-local
codex mcp remove standalone
codex plugin list --json > "$root/codex-migrated.json"
codex mcp list --json > "$root/codex-migrated-mcp.json"
python3 - "$root" <<'PY'
import json,pathlib,sys
r=pathlib.Path(sys.argv[1]); entries=json.loads((r/'codex-migrated.json').read_text())['installed']
assert [x['pluginId'] for x in entries if x['name']=='knowledgebase' and x['enabled']]==['knowledgebase@Overlord']
servers=json.loads((r/'codex-migrated-mcp.json').read_text())
assert sum(x['enabled'] and x['transport'].get('url')=='https://knowledge.chaselubitz.com/mcp' for x in servers)==1
assert any(x['name']=='unrelated' and x['transport'].get('url')=='https://unrelated.invalid/mcp' for x in servers)
PY
claude mcp add --scope user --transport http standalone https://knowledge.chaselubitz.com/mcp
claude mcp add --scope user --transport http unrelated https://unrelated.invalid/mcp
claude plugin marketplace add "$root/legacy"
claude plugin install knowledgebase@knowledgebase
claude plugin marketplace add https://github.com/cooperativ-labs/overlord-marketplace.git
claude plugin install knowledgebase@Overlord
claude plugin list --json > "$root/claude-duplicates.json"
python3 - "$root/claude-duplicates.json" <<'PY'
import json,sys
items=json.load(open(sys.argv[1]))
for name in ('knowledgebase@knowledgebase','knowledgebase@Overlord'):
    matches=[x for x in items if x['id']==name and x['enabled']]
    assert len(matches)==1 and matches[0]['mcpServers']['knowledgebase']['url']=='https://knowledge.chaselubitz.com/mcp'
print('Claude legacy and new plugin records both supply the endpoint')
PY
claude plugin uninstall knowledgebase@knowledgebase --scope user
claude mcp remove --scope user standalone
claude plugin list --json > "$root/claude-migrated.json"
python3 - "$root/claude-migrated.json" <<'PY'
import json,sys
items=json.load(open(sys.argv[1]))
matches=[x for x in items if x['enabled'] and any(s.get('url')=='https://knowledge.chaselubitz.com/mcp' for s in x.get('mcpServers',{}).values())]
assert len(matches)==1 and matches[0]['id']=='knowledgebase@Overlord'
PY
claude mcp get unrelated | grep -F 'https://unrelated.invalid/mcp'
# The legacy plugin and standalone server can also live in project or local scope.
for scope in project local; do
  claude plugin install knowledgebase@knowledgebase --scope "$scope"
  claude mcp add --scope "$scope" --transport http standalone https://knowledge.chaselubitz.com/mcp
  claude plugin list --json > "$root/claude-scoped.json"
  python3 - "$root/claude-scoped.json" "$scope" <<'PY'
import json,sys
matches=[x for x in json.load(open(sys.argv[1])) if x['id']=='knowledgebase@knowledgebase' and x['scope']==sys.argv[2] and x['enabled']]
assert len(matches)==1 and matches[0]['mcpServers']['knowledgebase']['url']=='https://knowledge.chaselubitz.com/mcp'
PY
  claude plugin uninstall knowledgebase@knowledgebase --scope "$scope"
  claude mcp remove --scope "$scope" standalone
  claude mcp get unrelated | grep -F 'https://unrelated.invalid/mcp'
done
claude plugin list --json > "$root/claude-migrated.json"
python3 - "$root/claude-migrated.json" <<'PY'
import json,sys
items=json.load(open(sys.argv[1]))
matches=[x for x in items if x['enabled'] and any(s.get('url')=='https://knowledge.chaselubitz.com/mcp' for s in x.get('mcpServers',{}).values())]
assert len(matches)==1 and matches[0]['id']=='knowledgebase@Overlord'
PY
echo 'smoke: first install, refresh, preservation, and isolated migration checks passed'
