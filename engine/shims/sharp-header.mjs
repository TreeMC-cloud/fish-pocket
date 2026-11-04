// What sharp's metadata() reports, read from the file itself. ImageIO cannot
// supply this: it invents an sRGB profile for plain JPEGs and accepts truncated
// files, and the attachment store relies on both facts. `complete` says the
// file reaches its end marker; sharp only finds that out when it decodes.

const ascii = (data, start, end) => data.toString('latin1', start, end);

function readExif(tiff, facts) {
  facts.exif = tiff;
  if (tiff.length < 8) return;
  const little = ascii(tiff, 0, 2) === 'II';
  const u16 = (at) => (little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at));
  const u32 = (at) => (little ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at));
  const table = u32(4);
  if (table + 2 > tiff.length) return;
  const count = u16(table);
  for (let i = 0; i < count && table + 14 + i * 12 <= tiff.length; i++) {
    if (u16(table + 2 + i * 12) === 0x0112) facts.orientation = u16(table + 10 + i * 12);
  }
}

function jpeg(data) {
  const facts = { format: 'jpeg', depth: 'uchar', comments: undefined };
  let at = 2;
  while (at + 4 <= data.length) {
    if (data[at] !== 0xff) break;
    const marker = data[at + 1];
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const length = data.readUInt16BE(at + 2);
    const body = data.subarray(at + 4, at + 2 + length);
    if (marker === 0xe1 && ascii(body, 0, 6) === 'Exif\0\0') readExif(body.subarray(6), facts);
    else if (marker === 0xe1 && ascii(body, 0, 4) === 'http') facts.xmp = body;
    else if (marker === 0xe2 && ascii(body, 0, 12) === 'ICC_PROFILE\0') facts.icc = body;
    else if (marker === 0xed && ascii(body, 0, 13) === 'Photoshop 3.0') facts.iptc = body;
    else if (marker === 0xfe) facts.comments = [{ keyword: 'comment', text: body.toString('latin1') }];
    else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      facts.height = data.readUInt16BE(at + 5);
      facts.width = data.readUInt16BE(at + 7);
      facts.space = { 1: 'b-w', 3: 'srgb', 4: 'cmyk' }[data[at + 9]] ?? 'srgb';
    } else if (marker === 0xda) {
      facts.complete = data.lastIndexOf(Buffer.from([0xff, 0xd9])) > at;
      return facts;
    }
    at += 2 + length;
  }
  return facts;
}

function png(data) {
  const facts = { format: 'png', comments: undefined };
  let at = 8;
  while (at + 12 <= data.length) {
    const length = data.readUInt32BE(at);
    const type = ascii(data, at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      facts.width = body.readUInt32BE(0);
      facts.height = body.readUInt32BE(4);
      const wide = body[8] === 16;
      const grey = body[9] === 0 || body[9] === 4;
      facts.depth = wide ? 'ushort' : 'uchar';
      facts.space = grey ? (wide ? 'grey16' : 'b-w') : (wide ? 'rgb16' : 'srgb');
    } else if (type === 'iCCP') facts.icc = body;
    else if (type === 'eXIf') readExif(body, facts);
    else if (type === 'iTXt' && ascii(body, 0, 18) === 'XML:com.adobe.xmp\0') facts.xmp = body;
    else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') (facts.comments ??= []).push({ keyword: type, text: '' });
    else if (type === 'IEND') facts.complete = true;
    at += 12 + length;
  }
  return facts;
}

function webp(data) {
  const facts = { format: 'webp', depth: 'uchar', space: 'srgb' };
  facts.complete = data.readUInt32LE(4) + 8 <= data.length;
  let at = 12;
  let frames = 0;
  while (at + 8 <= data.length) {
    const type = ascii(data, at, at + 4);
    const length = data.readUInt32LE(at + 4);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === 'VP8 ' && facts.width === undefined && body.length >= 10) {
      facts.width = body.readUInt16LE(6) & 0x3fff;
      facts.height = body.readUInt16LE(8) & 0x3fff;
    } else if (type === 'VP8L' && facts.width === undefined && body.length >= 5) {
      const bits = body.readUInt32LE(1);
      facts.width = (bits & 0x3fff) + 1;
      facts.height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (type === 'VP8X' && body.length >= 10) {
      facts.width = body.readUIntLE(4, 3) + 1;
      facts.height = body.readUIntLE(7, 3) + 1;
    } else if (type === 'ICCP') facts.icc = body;
    else if (type === 'EXIF') readExif(ascii(body, 0, 6) === 'Exif\0\0' ? body.subarray(6) : body, facts);
    else if (type === 'XMP ') facts.xmp = body;
    else if (type === 'ANMF') frames += 1;
    at += 8 + length + (length & 1);
  }
  if (frames > 1) facts.pages = frames;
  return facts;
}

function gif(data) {
  const facts = { format: 'gif', depth: 'uchar', space: 'srgb', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  const table = (flags) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);
  const blocks = (start) => {
    let at = start;
    while (at < data.length && data[at] !== 0) at += data[at] + 1;
    return at + 1;
  };
  let at = 13 + table(data[10]);
  let frames = 0;
  while (at < data.length) {
    if (data[at] === 0x3b) {
      facts.complete = true;
      break;
    }
    if (data[at] === 0x21) at = blocks(at + 2);
    else if (data[at] === 0x2c) {
      frames += 1;
      at = blocks(at + 11 + table(data[at + 9]));
    } else break;
  }
  facts.pages = frames;
  return facts;
}

/** Read one image's facts; undefined when the bytes are not an image we know, or lost their size. */
export function readHeader(data) {
  let facts;
  if (data.length >= 12 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) facts = jpeg(data);
  else if (data.length >= 24 && ascii(data, 0, 8) === '\x89PNG\r\n\x1a\n') facts = png(data);
  else if (data.length >= 16 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') facts = webp(data);
  else if (data.length >= 13 && /^GIF8[79]a$/.test(ascii(data, 0, 6))) facts = gif(data);
  return facts?.width > 0 && facts.height > 0 ? facts : undefined;
}

/** Drop everything but pixels from JPEG bytes ImageIO wrote: it adds Exif that the store refuses. */
export function stripJpeg(data) {
  const kept = [data.subarray(0, 2)];
  let at = 2;
  while (at + 4 <= data.length && data[at] === 0xff && data[at + 1] !== 0xda) {
    const marker = data[at + 1];
    const end = at + 2 + data.readUInt16BE(at + 2);
    if (marker !== 0xe1 && marker !== 0xe2 && marker !== 0xed && marker !== 0xfe) kept.push(data.subarray(at, end));
    at = end;
  }
  kept.push(data.subarray(at));
  return Buffer.concat(kept);
}
