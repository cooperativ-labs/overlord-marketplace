#!/usr/bin/env python3
"""Extract a ZIP into a new staging directory with strict resource and path limits."""
import argparse
import os
import shutil
import stat
import sys
import unicodedata
import zipfile


def extract(archive, destination, root, limits):
    if os.path.getsize(archive) > limits['artifact']:
        raise ValueError('artifact size limit exceeded')
    if os.path.lexists(destination):
        raise ValueError('destination must not exist')
    if root and (not root.endswith('/') or '/' in root[:-1] or root[:-1] in ('.', '..')):
        raise ValueError('invalid ZIP root')
    created = False
    try:
        with zipfile.ZipFile(archive) as z:
            entries = z.infolist()
            if len(entries) > limits['entries']:
                raise ValueError('entry limit exceeded')
            seen = {}
            spelling = {}
            total = 0
            prepared = []
            for info in entries:
                name = info.orig_filename
                if name != info.filename or not name or '\\' in name or any(ord(c) < 32 or ord(c) == 127 for c in name):
                    raise ValueError('unsafe entry name')
                if name.startswith('/') or (len(name) >= 2 and name[1] == ':'):
                    raise ValueError('absolute entry name')
                parts = name.rstrip('/').split('/')
                if any(p in ('', '.', '..') for p in parts):
                    raise ValueError('unsafe path segment')
                if root and name == root and info.is_dir():
                    continue
                if not name.startswith(root):
                    raise ValueError('entry outside ZIP root')
                rel = name[len(root):].rstrip('/')
                if not rel:
                    raise ValueError('empty entry')
                if info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise ValueError('encrypted or unsupported compression')
                mode = info.external_attr >> 16
                kind = stat.S_IFMT(mode)
                if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or (kind == stat.S_IFDIR) != info.is_dir() and kind != 0:
                    raise ValueError('special file or inconsistent mode')
                components = rel.split('/')
                for i in range(1, len(components) + 1):
                    original = '/'.join(components[:i])
                    normalized = unicodedata.normalize('NFC', original).casefold()
                    if normalized in spelling and spelling[normalized] != original:
                        raise ValueError('normalized path collision')
                    spelling[normalized] = original
                key = unicodedata.normalize('NFC', rel).casefold()
                if key in seen:
                    raise ValueError('duplicate or normalized collision')
                seen[key] = 'dir' if info.is_dir() else 'file'
                if info.file_size > limits['file']:
                    raise ValueError('file size limit exceeded')
                total += info.file_size
                if total > limits['expanded']:
                    raise ValueError('expanded size limit exceeded')
                prepared.append((info, rel))
            for key in seen:
                components = key.split('/')
                for i in range(1, len(components)):
                    if seen.get('/'.join(components[:i])) == 'file':
                        raise ValueError('file/directory collision')
            os.mkdir(destination, 0o755)
            created = True
            os.chmod(destination, 0o755)
            actual_total = 0
            for info, rel in prepared:
                target = os.path.join(destination, *rel.split('/'))
                if info.is_dir():
                    os.makedirs(target, mode=0o755, exist_ok=True)
                    os.chmod(target, 0o755)
                    continue
                os.makedirs(os.path.dirname(target), mode=0o755, exist_ok=True)
                parent = os.path.dirname(target)
                while parent != destination:
                    os.chmod(parent, 0o755)
                    parent = os.path.dirname(parent)
                count = 0
                with z.open(info) as src, open(target, 'xb') as dst:
                    while chunk := src.read(65536):
                        count += len(chunk)
                        actual_total += len(chunk)
                        if count > limits['file'] or actual_total > limits['expanded']:
                            raise ValueError('actual output limit exceeded')
                        dst.write(chunk)
                if count != info.file_size:
                    raise ValueError('entry size mismatch')
                os.chmod(target, 0o644)
    except Exception:
        if created:
            shutil.rmtree(destination)
        raise


def main():
    p = argparse.ArgumentParser()
    p.add_argument('archive'); p.add_argument('destination'); p.add_argument('--root', default='')
    for name in ('artifact', 'expanded', 'file', 'entries'):
        p.add_argument('--max-' + name, type=int, required=True)
    a = p.parse_args()
    limits = {x: getattr(a, 'max_' + x) for x in ('artifact', 'expanded', 'file', 'entries')}
    if min(limits.values()) < 1:
        p.error('limits must be positive')
    try:
        extract(a.archive, a.destination, a.root, limits)
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, EOFError) as e:
        print('zip: ' + str(e), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
