#!/usr/bin/env python3
"""Inspect signed runtime archives without extracting or executing their contents."""
import json,pathlib,posixpath,sys,tarfile

def safe_path(name):
    if '\\' in name or name.startswith('/') or '\x00' in name: raise ValueError('Unsafe archive path')
    value=posixpath.normpath(name)
    if value=='..' or value.startswith('../'): raise ValueError('Archive path escapes package')
    return value

def inspect(path,package):
    members={};total=0
    with tarfile.open(path,'r:gz') as archive:
        for item in archive:
            name=safe_path(item.name)
            if name in members: raise ValueError('Duplicate archive member')
            if not (item.isfile() or item.isdir() or item.issym() or item.islnk()): raise ValueError('Special archive member')
            if item.issym() or item.islnk():
                link=item.linkname
                safe_path(link) if item.islnk() else safe_path(posixpath.join(posixpath.dirname(name),link))
                if link.startswith('/') or '\\' in link: raise ValueError('Unsafe archive link')
            members[name]=item;total+=item.size
            if total>1024**3 or len(members)>150000: raise ValueError('Expanded package too large')
        entry='bin/satuwork-manager.mjs' if package['kind']=='manager' else 'bin/satuwork.mjs'
        required=[entry,'VERSION','package.json']
        if package['kind']=='manager': required+=['bin/satuwork-worker.mjs','src/seat/deploy-seat.sh','src/seat/manager-confirm.sh']
        for name in required:
            if name not in members or not members[name].isfile(): raise ValueError('Missing runtime entry '+name)
        if members['VERSION'].size>128 or archive.extractfile(members['VERSION']).read().decode().strip()!=package['version']: raise ValueError('Archive VERSION mismatch')
        if not any('/tsx/' in name for name in members): raise ValueError('Missing deployed TypeScript runtime')
    return True

if __name__=='__main__':
    root=pathlib.Path(sys.argv[1])
    for package in json.loads(sys.argv[2]): inspect(root/package['file'],package)
    print('Archive contents verified')
