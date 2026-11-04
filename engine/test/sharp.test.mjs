// The sharp stand-in against real sharp, which the host has, and the upstream
// attachment store running on top of it. Needs a host build of the addon
// (scripts/build-image-addon.sh); skipped without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installModuleRedirects } from '../runtime/module-redirects.mjs';

const require = createRequire(import.meta.url);
// The redirect goes in first: the store's own require must see it. Real sharp
// comes by path, which the redirect does not match.
installModuleRedirects();
const stand = require('sharp');
const real = require(new URL('../node_modules/sharp/./dist/index.cjs', import.meta.url).pathname);
const { prepareImageFile, readRequestImageFile } = await import('@deepseek-ai/dsh-attachment-local');

const addon = fileURLToPath(new URL('../../vendor/image/dsh_image.node', import.meta.url));
const skip = fs.existsSync(addon) ? false : 'image addon not built (scripts/build-image-addon.sh)';

// Four colour quadrants, so a wrong rotation shows up in the pixels.
function quadrants(width, height, channels = 3) {
  const data = Buffer.alloc(width * height * channels, 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * channels;
      data[at] = x < width / 2 ? 220 : 20;
      data[at + 1] = y < height / 2 ? 200 : 40;
      data[at + 2] = 90;
    }
  }
  return real(data, { raw: { width, height, channels } });
}

const fixtures = {
  'jpeg': () => quadrants(300, 200).jpeg().toBuffer(),
  'jpeg, orientation 6': () => quadrants(300, 200).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
  'jpeg, display p3': () => quadrants(300, 200).withIccProfile('p3').jpeg().toBuffer(),
  'jpeg, grey': () => quadrants(300, 200).greyscale().jpeg().toBuffer(),
  'jpeg, progressive': () => quadrants(300, 200).jpeg({ progressive: true }).toBuffer(),
  'png': () => quadrants(300, 200).png().toBuffer(),
  'png, alpha': () => quadrants(300, 200, 4).png().toBuffer(),
  'png, palette': () => quadrants(300, 200).png({ palette: true }).toBuffer(),
  'png, 16 bit': () => quadrants(300, 200).toColourspace('rgb16').png().toBuffer(),
  'png, profile': () => quadrants(300, 200).withIccProfile('p3').png().toBuffer(),
  'webp': () => quadrants(300, 200).webp().toBuffer(),
  'webp, lossless': () => quadrants(300, 200).webp({ lossless: true }).toBuffer(),
  'webp, alpha': () => quadrants(300, 200, 4).webp().toBuffer(),
  'webp, profile': () => quadrants(300, 200).withIccProfile('p3').webp().toBuffer(),
  'gif': () => quadrants(300, 200).gif().toBuffer(),
};

async function animated(format) {
  // Identical frames would merge into one.
  const frames = await Promise.all([0, 120, 240].map((hue) => quadrants(100, 100).modulate({ hue }).png().toBuffer()));
  return real(frames, { join: { animated: true } })[format]().toBuffer();
}

const summary = (m) => ({
  format: m.format, width: m.width, height: m.height, depth: m.depth, space: m.space, orientation: m.orientation,
  pages: m.pages, exif: m.exif !== undefined, icc: m.icc !== undefined, hasProfile: m.hasProfile,
});

test('require finds the stand-in, not sharp', () => {
  assert.notEqual(stand, real);
  assert.throws(() => stand.versions, /not supported on iOS/);
});

for (const [name, fixture] of Object.entries(fixtures)) {
  test(`metadata matches sharp: ${name}`, async () => {
    const data = await fixture();
    assert.deepEqual(summary(await stand(data).metadata()), summary(await real(data).metadata()));
  });
}

for (const format of ['gif', 'webp']) {
  test(`metadata matches sharp: animated ${format}`, async () => {
    const data = await animated(format);
    const { pages } = await real(data).metadata();
    assert.equal(pages, 3);
    assert.equal((await stand(data).metadata()).pages, pages);
  });
}

test('every image reports no alpha, which keeps the store on JPEG', async () => {
  assert.equal((await stand(await fixtures['png, alpha']()).metadata()).hasAlpha, false);
});

test('metadata refuses what is not an image', async () => {
  await assert.rejects(stand(Buffer.from('not an image at all')).metadata(), /unsupported image format/);
});

const resizes = [
  { width: 100 },
  { height: 100 },
  { width: 111, height: 77, fit: 'inside' },
  { width: 77, height: 111, fit: 'inside', withoutEnlargement: true },
  { width: 900, withoutEnlargement: true },
  { width: 900, height: 900, fit: 'inside', withoutEnlargement: true },
  { width: 1512, withoutEnlargement: true },
];

for (const options of resizes) {
  test(`resize picks sharp's size: ${JSON.stringify(options)}`, { skip }, async () => {
    const data = await fixtures.jpeg();
    const run = (lib) => lib(data).rotate().resize(options).jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
    const [mine, theirs] = await Promise.all([run(stand), run(real)]);
    assert.deepEqual([mine.info.width, mine.info.height], [theirs.info.width, theirs.info.height]);
  });
}

test('rotate() turns pixels the way sharp does', { skip }, async () => {
  const data = await fixtures['jpeg, orientation 6']();
  const size = { width: 20, height: 30 };
  const mine = await stand(data).rotate().resize({ ...size, fit: 'inside' }).raw().toBuffer();
  const theirs = await real(data).rotate().resize(size.width, size.height, { fit: 'inside' }).raw().toBuffer();
  assert.equal(mine.length, theirs.length);
  for (let i = 0; i < mine.length; i++) assert.ok(Math.abs(mine[i] - theirs[i]) < 48, `byte ${i}: ${mine[i]} vs ${theirs[i]}`);
});

test('without rotate() the stored orientation is ignored', { skip }, async () => {
  const data = await fixtures['jpeg, orientation 6']();
  const { info } = await stand(data).raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels], [300, 200, 3]);
});

test('JPEG output carries nothing the store refuses', { skip }, async () => {
  const data = await fixtures['jpeg, display p3']();
  const { data: out, info } = await stand(data).toColourspace('srgb').jpeg({ quality: 75 }).toBuffer({ resolveWithObject: true });
  for (const meta of [await real(out).metadata(), await stand(out).metadata()]) {
    assert.equal(meta.format, 'jpeg');
    assert.deepEqual([meta.width, meta.height, meta.space, meta.depth], [info.width, info.height, 'srgb', 'uchar']);
    assert.deepEqual([meta.exif, meta.icc, meta.xmp, meta.orientation], [undefined, undefined, undefined, undefined]);
  }
});

test('transparency flattens onto white', { skip }, async () => {
  const clear = await real(Buffer.alloc(8 * 8 * 4), { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
  const pixels = await stand(clear).raw().toBuffer();
  assert.deepEqual([...pixels.subarray(0, 3)], [255, 255, 255]);
});

for (const name of ['jpeg', 'png', 'webp', 'gif']) {
  test(`a truncated ${name} fails like sharp, not as a half image`, { skip }, async () => {
    const data = await fixtures[name]();
    const cut = data.subarray(0, data.length >> 1);
    await assert.rejects(real(cut, { failOn: 'error' }).raw().toBuffer());
    await assert.rejects(stand(cut, { failOn: 'error' }).raw().toBuffer(), /Premature end/);
  });
}

test('corrupt pixels behind a good header fail', { skip }, async () => {
  const data = Buffer.from(await fixtures.png());
  data.fill(0, 60, data.length - 12);
  await assert.rejects(stand(data).raw().toBuffer());
});

test('what is not implemented says so by name', async () => {
  const data = await fixtures.jpeg();
  assert.throws(() => stand(data).blur(3), /sharp: blur is not supported on iOS/);
  assert.throws(() => stand(data).webp(), /sharp: webp is not supported on iOS/);
  assert.throws(() => stand.cache(false), /sharp: cache is not supported on iOS/);
  assert.throws(() => stand('/tmp/a.png'), /input other than/);
  assert.throws(() => stand(data, { animated: true }), /option "animated"/);
  assert.throws(() => stand(data).resize(100), /options object/);
  assert.throws(() => stand(data).resize({ width: 9, height: 9 }), /fit "cover"/);
  assert.throws(() => stand(data).rotate(90), /rotate\(\) with arguments/);
  assert.throws(() => stand(data).toColourspace('lab'), /toColourspace/);
  assert.throws(() => stand(data).jpeg({ mozjpeg: true }), /option "mozjpeg"/);
  await assert.rejects(stand(data).toBuffer(), /without jpeg/);
});

test('clone() leaves the original pipeline alone', { skip }, async () => {
  const base = stand(await fixtures.jpeg()).resize({ width: 100 });
  const [one, two] = await Promise.all([85, 60].map((quality) => base.clone().jpeg({ quality }).toBuffer()));
  assert.ok(one.length > two.length);
  await assert.rejects(base.toBuffer(), /without jpeg/);
});

// ---- the upstream store on the stand-in ------------------------------------

const limits = { maxImageBytes: 20971520, maxImagePixels: 64e6, maxImageDimension: 8192 };
const policy = { maxPixels: 4194304, maxDimension: 8192, maxBytes: 4194304 };
const prepare = (data, mediaType) => prepareImageFile({ data: new Uint8Array(data), mediaType }, limits, policy);

test('store: a clean image passes through byte for byte', { skip }, async () => {
  const data = await fixtures.jpeg();
  const prepared = await prepare(data, 'image/jpeg');
  assert.deepEqual(Buffer.from(prepared.data), data);
  assert.deepEqual([prepared.ref.width, prepared.ref.height], [300, 200]);
});

test('store: the composer\'s wide-gamut, oriented photo is normalized', { skip }, async () => {
  const data = await quadrants(3000, 2000).withIccProfile('p3').withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const prepared = await prepare(data, 'image/jpeg');
  assert.equal(prepared.ref.mediaType, 'image/jpeg');
  assert.ok(prepared.ref.height > prepared.ref.width, 'orientation applied');
  assert.ok(prepared.ref.width * prepared.ref.height <= policy.maxPixels);
  assert.deepEqual(prepared.ref.originalDimensions, { width: 2000, height: 3000 });
  const meta = await real(Buffer.from(prepared.data)).metadata();
  assert.deepEqual([meta.exif, meta.icc, meta.space], [undefined, undefined, 'srgb']);
});

test('store: a large transparent PNG becomes a JPEG', { skip }, async () => {
  const prepared = await prepare(await quadrants(3000, 2000, 4).png().toBuffer(), 'image/png');
  assert.equal(prepared.ref.mediaType, 'image/jpeg');
});

test('store: a small transparent PNG stays as it is', { skip }, async () => {
  const data = await fixtures['png, alpha']();
  assert.deepEqual(Buffer.from((await prepare(data, 'image/png')).data), data);
});

test('store: an animated GIF keeps its first frame', { skip }, async () => {
  const prepared = await prepare(await animated('gif'), 'image/gif');
  assert.deepEqual([prepared.ref.mediaType, prepared.ref.width, prepared.ref.height], ['image/jpeg', 100, 100]);
});

test('store: a mislabelled or broken image gets its proper refusal', { skip }, async () => {
  await assert.rejects(prepare(await fixtures.png(), 'image/jpeg'), { code: 'IMAGE_TYPE_MISMATCH' });
  await assert.rejects(prepare(Buffer.from('nope, not an image at all'), 'image/jpeg'), { code: 'INVALID_IMAGE' });
  const data = await fixtures.jpeg();
  await assert.rejects(prepare(data.subarray(0, data.length >> 1), 'image/jpeg'), { code: 'INVALID_IMAGE' });
});

test('store: the request image is scaled to the route\'s size and cached', { skip }, async () => {
  const root = fs.mkdtempSync(`${process.env.TMPDIR ?? '/tmp/'}dsh-ios-image-`);
  const prepared = await prepare(await quadrants(2048, 1536).jpeg().toBuffer(), 'image/jpeg');
  const attachment = { ref: prepared.ref, data: prepared.data };
  const target = { width: 1512, height: 1134, maxBytes: 2 * 1024 * 1024 };
  const first = await readRequestImageFile(root, attachment, target);
  assert.deepEqual([first.width, first.height, first.mediaType, first.depth, first.space], [1512, 1134, 'image/jpeg', 'uchar', 'srgb']);
  const second = await readRequestImageFile(root, attachment, target);
  assert.deepEqual(Buffer.from(second.data), Buffer.from(first.data));
  fs.rmSync(root, { recursive: true });
});
