#!/usr/bin/env python3
"""Export the SVG brand assets on macOS using Quick Look and sips."""
from pathlib import Path
import struct
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'public'

# Keep compatibility and browser paths synchronized with the master SVG.
master = (PUBLIC / 'brand/jeeves-icon.svg').read_text()
for name in ('logo.svg', 'favicon.svg'):
    (PUBLIC / name).write_text(master)

def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)

with tempfile.TemporaryDirectory(prefix='jeeves-brand-') as tmp:
    tmp = Path(tmp)
    # Touch/app icons use a full-bleed background; the OS applies its own mask.
    source = (PUBLIC / 'brand/jeeves-icon.svg').read_text().replace('rx="16"', 'rx="0"')
    (tmp / 'icon.svg').write_text(source)
    (tmp / 'maskable.svg').write_text((PUBLIC / 'brand/jeeves-maskable.svg').read_text())
    for name in ('icon', 'maskable'):
        run('qlmanage', '-t', '-s', '1024', '-o', str(tmp), str(tmp / f'{name}.svg'))
    exports = [(16, 'favicon-16.png'), (32, 'favicon-32.png'), (48, 'favicon-48.png'),
               (180, 'apple-touch-icon.png'), (192, 'icon-192.png'), (512, 'icon-512.png')]
    for size, name in exports:
        run('sips', '-z', str(size), str(size), str(tmp / 'icon.svg.png'), '--out', str(PUBLIC / name))
    run('sips', '-z', '512', '512', str(tmp / 'maskable.svg.png'), '--out', str(PUBLIC / 'icon-maskable-512.png'))
    # ICO directory with lossless PNG payloads for each supported size.
    sizes = (16, 32, 48)
    payloads = [(PUBLIC / f'favicon-{size}.png').read_bytes() for size in sizes]
    header = struct.pack('<HHH', 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    entries = b''
    for size, data in zip(sizes, payloads):
        entries += struct.pack('<BBBBHHII', size, size, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    (PUBLIC / 'favicon.ico').write_bytes(header + entries + b''.join(payloads))
