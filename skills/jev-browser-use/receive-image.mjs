import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, realpath, lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const IMAGE_MAX_BYTES = 10_000_000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = reason => Object.assign(new Error(reason), { reason });
const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]]) blocked.addSubnet(address, prefix, 'ipv4');
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
blocked.addSubnet('2001::', 32, 'ipv6');

export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && global6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
function imageUrl(value) {
  let url; try { url = new URL(value); } catch { throw failure('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('invalid_url');
  url.hash = '';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !publicAddress(host)) throw failure('non_public_address');
  return url;
}
function sourceUrl(url) { const safe = new URL(url); safe.search = ''; safe.hash = ''; return safe.href; }

// A fresh anonymous request: no browser cookies, credentials, redirects or environment proxy.
export function publicImageResponse(url, { resolveHost = lookup, requestFor = url.protocol === 'https:' ? httpsRequest : httpRequest } = {}) {
  return new Promise((resolve, reject) => {
    const request = requestFor(url, {
      agent: false,
      headers: { Accept: 'image/png,image/jpeg,image/gif,image/webp', 'Accept-Encoding': 'identity' },
      lookup(host, options, done) {
        resolveHost(host, { all: true, verbatim: true }).then(addresses => {
          if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw failure('non_public_address');
          // Return the already checked address to the socket; do not resolve the name a second time.
          if (options.all) done(null, [addresses[0]]);
          else done(null, addresses[0].address, addresses[0].family);
        }).catch(done);
      },
    });
    const timer = setTimeout(() => request.destroy(failure('timeout')), 30_000);
    request.once('error', error => { clearTimeout(timer); reject(error); });
    request.once('response', response => {
      response.once('close', () => clearTimeout(timer));
      resolve(response);
    });
    request.end();
  });
}

// Check complete image containers as well as signatures. Never treat an HTML response as an image.
export function imageFormat(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    let offset = 8, header = false, data = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), end = offset + length + 12;
      if (end > bytes.length) break;
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (!header) { if (type !== 'IHDR' || length !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12)) break; header = true; }
      if (type === 'IDAT' && length) data = true;
      if (type === 'IEND') return length === 0 && end === bytes.length && data ? 'png' : null;
      offset = end;
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    let offset = 2, frame = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) return null;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++], length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) frame = true;
      if (marker === 0xda) return frame && offset + length < bytes.length - 2 ? 'jpg' : null;
      offset += length;
    }
    return null;
  }
  if (bytes.length >= 14 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) && bytes.at(-1) === 0x3b
    && bytes.readUInt16LE(6) && bytes.readUInt16LE(8) && bytes.includes(0x2c, 13)) return 'gif';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === bytes.length - 8) {
    let offset = 12, pixels = false;
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
      offset += 8 + length + (length % 2);
      if (offset > bytes.length) return null;
      if (['VP8 ', 'VP8L', 'ANMF'].includes(type) && length) pixels = true;
    }
    return offset === bytes.length && pixels ? 'webp' : null;
  }
  return null;
}
const media = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
async function writeOnce(path, bytes) {
  let file;
  try { file = await open(path, 'wx', 0o600); await file.writeFile(bytes); await file.sync(); return true; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length || !(await readFile(path)).equals(bytes)) throw failure('existing_file_mismatch');
    return false;
  } finally { await file?.close(); }
}
const saving = new Map();
export async function receivePublicImage({ url: input, room, responseFor = publicImageResponse, now = () => new Date().toISOString() }) {
  let response, stage = 'network';
  try {
    const url = imageUrl(input);
    response = await responseFor(url);
    if (response.statusCode >= 300 && response.statusCode < 400) throw failure('direct_image_url_required');
    if ([401,403].includes(response.statusCode)) throw failure('authentication_required');
    if (response.statusCode !== 200) throw failure('http_error');
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw failure('encoded_response_unsupported');
    const declared = response.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || +declared > IMAGE_MAX_BYTES)) throw failure('image_too_large');
    const received = Buffer.allocUnsafe(IMAGE_MAX_BYTES); let size = 0;
    for await (const chunk of response) {
      if (size + chunk.length > IMAGE_MAX_BYTES) throw failure('image_too_large');
      chunk.copy(received, size); size += chunk.length;
    }
    if (response.complete === false || declared !== undefined && +declared !== size) throw failure('incomplete_response');
    const bytes = received.subarray(0, size), format = imageFormat(bytes);
    if (!format) throw failure('invalid_or_incomplete_image');
    const mime = String(response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (mime && ![media[format], 'application/octet-stream', ...(format === 'jpg' ? ['image/jpg'] : [])].includes(mime)) throw failure('image_type_mismatch');
    stage = 'storage';
    const root = await realpath(room), directory = join(root, 'received');
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory) throw failure('invalid_receive_directory');
    const hash = sha256(bytes), source = sourceUrl(url), path = join(directory, `${hash}.${format}`);
    const metadataPath = `${path}.${sha256(source)}.json`;
    const previous = saving.get(path) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const created = await writeOnce(path, bytes);
      let metadata;
      try {
        const info = await lstat(metadataPath);
        if (!info.isFile() || info.isSymbolicLink()) throw failure('existing_file_mismatch');
        metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
        if (metadata.sha256 !== hash || metadata.size !== size || metadata.format !== format || metadata.source !== source || typeof metadata.receivedAt !== 'string') throw failure('existing_file_mismatch');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        metadata = { source, receivedAt: now(), format, mediaType: media[format], size, sha256: hash };
        await writeOnce(metadataPath, Buffer.from(JSON.stringify(metadata, null, 2) + '\n'));
      }
      return { status: created ? 'saved' : 'already_exists', path, metadataPath, ...metadata };
    });
    saving.set(path, pending);
    try { return await pending; } finally { if (saving.get(path) === pending) saving.delete(path); }
  } catch (error) {
    return { status: 'failed', reason: error.reason ?? (stage === 'storage' ? 'storage_failed' : 'network_failed') };
  } finally { response?.destroy?.(); }
}
