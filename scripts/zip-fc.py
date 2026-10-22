"""Package the prepared FC directory and retain the Linux runtime executable bit."""
from pathlib import Path
import sys
import zipfile

source = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
if destination.is_relative_to(source):
    raise ValueError("ZIP output must be outside the package directory")
with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(source.rglob("*")):
        if not file.is_file() or file.is_symlink() or ".bin" in file.parts:
            continue
        name = file.relative_to(source).as_posix()
        info = zipfile.ZipInfo.from_file(file, name)
        info.create_system = 3
        info.external_attr = (0o100755 if name == "runtime/node" else 0o100644) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, file.read_bytes())
