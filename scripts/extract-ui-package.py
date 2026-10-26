"""Extract regular npm package files only; never follow tar links or paths outside target."""
import pathlib
import shutil
import sys
import tarfile

destination = pathlib.Path(sys.argv[2]).resolve()
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    total = 0
    for item in archive:
        parts = pathlib.PurePosixPath(item.name).parts
        if not parts or parts[0] != 'package' or any(p in ('.', '..') or '\\' in p or ':' in p for p in parts) or item.name.startswith('/'):
            raise ValueError('Unsafe npm archive path')
        if not (item.isfile() or item.isdir()):
            raise ValueError('Links and special files are not UI assets')
        target = destination.joinpath(*parts[1:])
        if item.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            total += item.size
            if total > 256 * 1024 * 1024:
                raise ValueError('UI package too large')
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(item) as source, target.open('wb') as out:
                shutil.copyfileobj(source, out)
