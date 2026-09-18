// Tiny ZIP writer (STORE method, UTF-8 names). No compression keeps it dependency-free and fast;
// Markdown/JSON archives are small enough that this is fine.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, day };
}

/**
 * @param {Array<{ name: string, data: string|Uint8Array, date?: Date }>} files
 * @returns {Uint8Array}
 */
export function createZip(files) {
  const enc = new TextEncoder();
  const entries = files.map((f) => {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    return { name: enc.encode(f.name.replace(/\\/g, '/')), data, crc: crc32(data), ...dosDateTime(f.date) };
  });
  let size = 0;
  for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
  size += 22;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let offset = 0;
  const offsets = [];
  const u16 = (v) => {
    view.setUint16(offset, v, true);
    offset += 2;
  };
  const u32 = (v) => {
    view.setUint32(offset, v >>> 0, true);
    offset += 4;
  };
  const bytes = (b) => {
    out.set(b, offset);
    offset += b.length;
  };
  for (const e of entries) {
    offsets.push(offset);
    u32(0x04034b50); // local file header
    u16(20); // version needed
    u16(0x0800); // flags: UTF-8 names
    u16(0); // method: store
    u16(e.time);
    u16(e.day);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0);
    bytes(e.name);
    bytes(e.data);
  }
  const cdStart = offset;
  entries.forEach((e, i) => {
    u32(0x02014b50); // central directory header
    u16(20);
    u16(20);
    u16(0x0800);
    u16(0);
    u16(e.time);
    u16(e.day);
    u32(e.crc);
    u32(e.data.length);
    u32(e.data.length);
    u16(e.name.length);
    u16(0);
    u16(0);
    u16(0);
    u16(0);
    u32(0);
    u32(offsets[i]);
    bytes(e.name);
  });
  const cdSize = offset - cdStart;
  u32(0x06054b50); // end of central directory
  u16(0);
  u16(0);
  u16(entries.length);
  u16(entries.length);
  u32(cdSize);
  u32(cdStart);
  u16(0);
  return out;
}
