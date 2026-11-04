// iOS stand-in for sharp, whose libvips addon cannot load here. The attachment
// store is the only caller today, so this implements what it uses, over
// ImageIO (native/image), and refuses everything else by name: a plugin must
// hear that a method is missing, not get a wrong image.
//
// ImageIO cannot write WebP, so nothing here has an alpha channel: metadata()
// reports hasAlpha false, which sends the store to JPEG, and pixels are
// flattened onto white. A transparent image within the limits still reaches the
// model as it is, since the store passes it through unchanged.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readHeader, stripJpeg } from './sharp-header.mjs';

const HOST_BUILD = fileURLToPath(new URL('../../vendor/image/dsh_image.node', import.meta.url));

let cached;
function binding() {
  if (cached) return cached;
  try {
    cached = process._linkedBinding('dsh_image');
  } catch {
    const file = process.env.DSH_IMAGE_ADDON || HOST_BUILD;
    if (!fs.existsSync(file)) throw new Error('sharp: the dsh_image addon is not available');
    cached = createRequire(import.meta.url)(file);
  }
  return cached;
}

function unsupported(what) {
  return new Error(`sharp: ${what} is not supported on iOS`);
}

// Unknown names throw instead of reading as undefined, so `.blur()` says what is missing.
function strict(target) {
  return new Proxy(target, {
    get(object, key, receiver) {
      if (typeof key === 'symbol' || key === 'then' || key in object) return Reflect.get(object, key, receiver);
      throw unsupported(key);
    },
  });
}

function checkKeys(options, allowed, label) {
  for (const key of Object.keys(options ?? {})) {
    if (!allowed.includes(key)) throw unsupported(`${label} option "${key}"`);
  }
}

function resized({ width, height, fit, withoutEnlargement }, source) {
  const scale = Math.min(width ? width / source.width : Infinity, height ? height / source.height : Infinity);
  if (withoutEnlargement && scale >= 1) return source;
  return {
    width: width && scale === width / source.width ? width : Math.max(1, Math.round(source.width * scale)),
    height: height && scale === height / source.height ? height : Math.max(1, Math.round(source.height * scale)),
  };
}

class Sharp {
  input;
  facts;
  autoOrient = false;
  target;
  output;
  quality;

  constructor(input, options, state) {
    if (state) {
      Object.assign(this, state);
      return;
    }
    if (!(input instanceof Uint8Array)) throw unsupported('an input other than a Buffer or Uint8Array');
    checkKeys(options, ['failOn', 'limitInputPixels'], 'the constructor');
    this.input = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }

  header() {
    this.facts ??= readHeader(this.input);
    if (!this.facts) throw new Error('Input buffer contains unsupported image format');
    return this.facts;
  }

  clone() {
    return strict(new Sharp(undefined, undefined, { ...this }));
  }

  async metadata() {
    const { complete, ...facts } = this.header();
    return { ...facts, hasProfile: facts.icc !== undefined, hasAlpha: false };
  }

  rotate(...args) {
    if (args.length > 0) throw unsupported('rotate() with arguments');
    this.autoOrient = true;
    return this;
  }

  toColourspace(space) {
    if (space !== 'srgb') throw unsupported(`toColourspace("${space}")`);
    return this;
  }

  resize(...args) {
    const [options] = args;
    if (args.length !== 1 || typeof options !== 'object') throw unsupported('resize() without an options object');
    checkKeys(options, ['width', 'height', 'fit', 'withoutEnlargement'], 'resize()');
    if (options.width && options.height ? options.fit !== 'inside' : (options.fit ?? 'inside') !== 'inside') {
      throw unsupported(`resize() with fit "${options.fit ?? 'cover'}"`);
    }
    this.target = options;
    return this;
  }

  jpeg(options) {
    checkKeys(options, ['quality'], 'jpeg()');
    this.output = 'jpeg';
    this.quality = options?.quality ?? 80;
    return this;
  }

  raw(...args) {
    if (args.length > 0) throw unsupported('raw() with options');
    this.output = 'raw';
    return this;
  }

  async toBuffer(options) {
    checkKeys(options, ['resolveWithObject'], 'toBuffer()');
    if (!this.output) throw unsupported('toBuffer() without jpeg() or raw()');
    const facts = this.header();
    if (!facts.complete) throw new Error(`Premature end of ${facts.format} image`);
    const turned = this.autoOrient && facts.orientation >= 5;
    const source = { width: turned ? facts.height : facts.width, height: turned ? facts.width : facts.height };
    const { width, height } = this.target ? resized(this.target, source) : source;
    const jpeg = this.output === 'jpeg';
    const bytes = await binding().transform(this.input, width, height, this.autoOrient ? 1 : 0, jpeg ? this.quality : 0);
    const data = jpeg ? stripJpeg(bytes) : bytes;
    if (!options?.resolveWithObject) return data;
    return { data, info: { format: this.output, size: data.length, width, height, channels: 3 } };
  }
}

const sharp = strict(function sharp(input, options) {
  return strict(new Sharp(input, options));
});

export { sharp as default, sharp as 'module.exports' };
