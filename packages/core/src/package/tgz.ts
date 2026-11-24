import { gunzipSync } from 'node:zlib';

/**
 * The regular files of a .tgz (a gzip'ed tar, as FHIR packages are
 * published): path -> content. Handles ustar prefixes and the long names of
 * pax ('x') and GNU ('L') headers; links and other entries are skipped.
 */
export function readTgz(data: Uint8Array): Map<string, Buffer> {
  const tar = gunzipSync(data);
  const files = new Map<string, Buffer>();
  let offset = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;

  const str = (start: number, len: number) => {
    const b = tar.subarray(start, start + len);
    const end = b.indexOf(0);
    return b.subarray(0, end < 0 ? b.length : end).toString('utf8');
  };

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break; // end of archive
    const size = parseInt(str(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const magic = str(offset + 257, 6);
    let name = str(offset, 100);
    if (magic.startsWith('ustar')) {
      const prefix = str(offset + 345, 155);
      if (prefix) name = prefix + '/' + name;
    }
    const bodyStart = offset + 512;
    const body = tar.subarray(bodyStart, bodyStart + size);
    offset = bodyStart + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'));
      if (m) paxPath = m[1];
      continue;
    }
    if (type === 'g') continue;
    const path = paxPath ?? longName ?? name;
    longName = paxPath = undefined;
    if (type !== '0' && type !== '\0') continue;
    files.set(path, Buffer.from(body));
  }
  return files;
}
