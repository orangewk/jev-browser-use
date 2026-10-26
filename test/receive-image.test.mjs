import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { IMAGE_MAX_BYTES, imageFormat, publicAddress, publicImageResponse, receivePublicImage } from '../skills/jev-browser-use/receive-image.mjs';

const root = await mkdtemp(join(tmpdir(), 'public-image-receipt-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHfcAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// Synthetic complete JPEG marker stream and WebP container; no private images or external requests.
const jpg = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,1,255,217]);
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const url = 'https://images.example/original.png?token=synthetic-secret#fragment';
let requests = 0;
const response = (bytes, { statusCode = 200, headers = {}, complete = true, chunks = [bytes] } = {}) =>
  Object.assign(Readable.from(chunks), { statusCode, headers, complete });
const get = bytes => async target => { requests++; assert.equal(target.username, ''); return response(bytes); };
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
try {
  await check('four containers preserve original bytes, hash, MIME and sanitized provenance', async () => {
    for (const [format, bytes] of Object.entries({ png, jpg, gif, webp })) {
      assert.equal(imageFormat(bytes), format);
      const room = join(root, format); await mkdir(room);
      const result = await receivePublicImage({ url, room, responseFor: get(bytes), now: () => '2026-01-01T00:00:00.000Z' });
      assert.equal(result.status, 'saved', JSON.stringify(result));
      assert.deepEqual(await readFile(result.path), bytes); assert.equal(result.sha256, hash(bytes));
      const metadata = JSON.parse(await readFile(result.metadataPath, 'utf8'));
      assert.equal(metadata.source, 'https://images.example/original.png');
      assert.equal(metadata.size, bytes.length); assert.equal(metadata.format, format);
      assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
    }
  });
  await check('repeat and concurrent receipt never overwrite and preserve each source', async () => {
    const room = join(root, 'dedup'); await mkdir(room);
    const results = await Promise.all([1,2].map(() => receivePublicImage({ url, room, responseFor: get(png) })));
    assert.deepEqual(results.map(r => r.status).sort(), ['already_exists','saved']);
    assert.equal(results[0].path, results[1].path);
    const originalMetadata = await readFile(results[0].metadataPath);
    const other = await receivePublicImage({ url: 'https://other.example/source.png?secret=hidden', room, responseFor: get(png) });
    assert.equal(other.path, results[0].path); assert.notEqual(other.metadataPath, results[0].metadataPath);
    assert.deepEqual(await readFile(results[0].metadataPath), originalMetadata);
  });
  await check('HTML, mismatched MIME, truncation and failed streams never save success', async () => {
    const room = join(root, 'reject'); await mkdir(room);
    const samples = [response(Buffer.from('<html>login</html>')), response(png,{headers:{'content-type':'text/html'}}),
      response(png.subarray(0,-1)), response(png,{complete:false}), response(png,{headers:{'content-length':String(png.length+1)}}),
      response(png,{headers:{'content-encoding':'gzip'}}),
      Object.assign(Readable.from((async function*(){yield png; throw new Error('synthetic URL secret');})()),{statusCode:200,headers:{}})];
    for (const sample of samples) {
      const result = await receivePublicImage({ url, room, responseFor: async () => sample });
      assert.equal(result.status, 'failed'); assert.ok(!JSON.stringify(result).includes('URL secret'));
    }
    assert.deepEqual(await readdir(room), []);
  });
  await check('10,000,000-byte limit applies to declared and streamed bytes', async () => {
    const room = join(root, 'size'); await mkdir(room);
    for (const sample of [response(png,{headers:{'content-length':String(IMAGE_MAX_BYTES+1)}}),
      response(png,{chunks:[Buffer.alloc(IMAGE_MAX_BYTES),Buffer.from([1])]})]) {
      assert.equal((await receivePublicImage({ url, room, responseFor:async()=>sample })).reason,'image_too_large');
    }
    assert.deepEqual(await readdir(room), []);
    // Pad a real one-pixel PNG with a complete ancillary chunk to test the inclusive boundary.
    const chunk=Buffer.alloc(IMAGE_MAX_BYTES-png.length);chunk.writeUInt32BE(chunk.length-12);chunk.write('tEXt',4);chunk.write('padding\0',8);
    let crc=0xffffffff;
    for(const byte of chunk.subarray(4,-4)) {crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    chunk.writeUInt32BE((crc^0xffffffff)>>>0,chunk.length-4);
    const exact=Buffer.concat([png.subarray(0,-12),chunk,png.subarray(-12)]);
    const accepted=await receivePublicImage({url,room,responseFor:get(exact)});
    assert.equal(accepted.status,'saved');assert.equal(accepted.size,IMAGE_MAX_BYTES);
  });
  await check('redirect, login and server errors are distinct failures without publication', async () => {
    for (const [statusCode, reason] of [[302,'direct_image_url_required'],[401,'authentication_required'],[403,'authentication_required'],[500,'http_error']]) {
      const result = await receivePublicImage({url,room:root,responseFor:async()=>response(png,{statusCode})});
      assert.equal(result.reason,reason); assert.equal(result.path,undefined);
    }
  });
  await check('private literal URLs and credential URLs fail before any request', async () => {
    const before = requests;
    for (const value of ['file:///secret','http://127.0.0.1/a','http://[::1]/a','http://[::ffff:127.0.0.1]/a','https://user:secret@images.example/a']) {
      assert.equal((await receivePublicImage({url:value,room:root,responseFor:get(png)})).status,'failed');
    }
    assert.equal(requests,before);
    for (const address of ['10.0.0.1','100.64.0.1','169.254.169.254','192.168.0.1','224.0.0.1','::1','fc00::1','fe80::1','2001:db8::1','::ffff:8.8.8.8']) assert.equal(publicAddress(address),false,address);
    assert.equal(publicAddress('8.8.8.8'),true); assert.equal(publicAddress('2606:4700:4700::1111'),true);
  });
  await check('DNS is checked once and pinned into the socket; anonymous headers only', async () => {
    for (const addresses of [[{address:'127.0.0.1',family:4}],[{address:'8.8.8.8',family:4}]]) {
      let resolved = 0;
      const promise = publicImageResponse(new URL('https://images.example/a'), {
        resolveHost:async()=>{resolved++;return addresses;},
        requestFor(_url, options) {
          assert.equal(options.agent,false);
          assert.equal(options.headers.Authorization,undefined); assert.equal(options.headers.Cookie,undefined);
          const request = new EventEmitter(); request.destroy=error=>request.emit('error',error);
          request.end=()=>options.lookup('images.example',{all:true},(error,checked)=>{
            if(error)request.emit('error',error);
            else {assert.deepEqual(checked,addresses); const value=response(png);request.emit('response',value);value.destroy();}
          });
          return request;
        },
      });
      if(addresses[0].family===4 && addresses[0].address==='127.0.0.1') await assert.rejects(promise,/non_public_address/);
      else await promise;
      assert.equal(resolved,1);
    }
  });
  await check('an existing damaged file is preserved and never reported as a receipt', async () => {
    const room=join(root,'existing');await mkdir(room);await mkdir(join(room,'received'));
    const path=join(room,'received',`${hash(png)}.png`);await writeFile(path,'damaged');
    const result=await receivePublicImage({url,room,responseFor:get(png)});
    assert.equal(result.status,'failed');assert.equal(await readFile(path,'utf8'),'damaged');
  });
  await check('metadata write failure leaves no successful receipt or overwritten file', async()=>{
    const room=join(root,'metadata-error');await mkdir(room);await mkdir(join(room,'received'));
    const path=join(room,'received',`${hash(png)}.png`),metadataPath=`${path}.${hash('https://images.example/original.png')}.json`;
    await mkdir(metadataPath);
    const result=await receivePublicImage({url,room,responseFor:get(png)});
    assert.equal(result.status,'failed');assert.equal(result.path,undefined);assert.deepEqual(await readFile(path),png);
    assert.deepEqual(await readdir(metadataPath),[]);
  });
  await check('received directory links cannot redirect writes outside the room', async () => {
    const room=join(root,'link'),outside=join(root,'outside');await mkdir(room);await mkdir(outside);
    await symlink(outside,join(room,'received'),process.platform==='win32'?'junction':'dir');
    assert.equal((await receivePublicImage({url,room,responseFor:get(png)})).reason,'invalid_receive_directory');
    assert.deepEqual(await readdir(outside),[]);
  });
  console.log(`Public image receipt: ${checks} synthetic checks passed; external requests/browser/model calls 0`);
} finally { await rm(root,{recursive:true,force:true}); }
