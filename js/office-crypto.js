// Password-protected Office files (OOXML in an OLE container).
//
// An encrypted .docx/.xlsx is NOT a zip: it is an OLE/CFB container holding an
// "EncryptionInfo" stream (how it was locked) and an "EncryptedPackage" stream
// (the AES-encrypted zip). This module reads that container and decrypts it in
// the browser, so the normal handlers can work on the plain zip afterwards.
//
// Only ECMA-376 "agile" encryption (Office 2013+ default: AES-256 + SHA-512,
// 100000 spins) is supported. Older "standard" protection and legacy
// Word 97-2003 / Excel 97-2003 RC4 encryption are detected and reported so the
// UI can explain them in plain English.
//
// Everything here is pure logic with no DOM access, so node can import it for
// unit tests. Hashing (the 100000-round SHA-512 spin) and AES come from the
// vendored synchronous @noble builds (MIT): WebCrypto cannot be used because
// its AES-CBC always validates PKCS#7 padding while agile blocks are stored
// unpadded, and its async digest would turn the spin loop into minutes of
// promise overhead.

// WHY a regex, not DOMParser: the agile descriptor is a fixed-shape XML blob
// and this keeps the module DOM-free (unit-testable in node).
import { sha512 as nobleSha512, cbc } from "../vendor/noble-crypto.min.mjs";

const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isOleFile(bytes) {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== OLE_SIG[i]) return false;
  return true;
}

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b, o) => Number(new DataView(b.buffer, b.byteOffset + o, 8).getBigUint64(0, true));

function utf16Name(bytes, off) {
  // 64 UTF-16LE chars max, NUL-terminated.
  let s = "";
  for (let i = 0; i < 32; i++) {
    const c = bytes[off + i * 2] | (bytes[off + i * 2 + 1] << 8);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// Minimal CFB reader: follows FAT chains and returns named streams.
export function readCfb(bytes) {
  const view = (o, n) => bytes.subarray(o, o + n);
  if (!isOleFile(bytes) || bytes.length < 512) throw new Error("not an OLE container");
  const sectorShift = u16(bytes, 30);
  if (sectorShift !== 9 && sectorShift !== 12) throw new Error("unsupported OLE sector size");
  const sectorSize = 1 << sectorShift;
  const numFatSectors = u32(bytes, 44);
  const firstDirSector = u32(bytes, 48);
  const miniSectorCutoff = u32(bytes, 56);
  const firstMiniFatSector = u32(bytes, 60);
  const numMiniFatSectors = u32(bytes, 64);
  const firstDifatSector = u32(bytes, 68);
  const numDifatSectors = u32(bytes, 72);

  const sector = (n) => view(512 + n * sectorSize, sectorSize);
  const chain = (start, fat) => {
    const out = [];
    let s = start;
    const seen = new Set();
    while (s !== 0xfffffffe && s !== 0xffffffff) {
      if (seen.has(s)) throw new Error("OLE FAT loop");
      seen.add(s);
      out.push(s);
      s = fat[s];
      if (s === undefined) throw new Error("OLE FAT out of range");
    }
    return out;
  };

  // FAT sectors come from the DIFAT array (109 entries inline, then chained).
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = u32(bytes, 76 + i * 4);
    if (s === 0xfffffffe || s === 0xffffffff) break;
    fatSectors.push(s);
  }
  let difat = firstDifatSector;
  for (let i = 0; i < numDifatSectors; i++) {
    const sec = sector(difat);
    for (let j = 0; j < sectorSize / 4 - 1; j++) {
      const s = u32(sec, j * 4);
      if (s === 0xfffffffe || s === 0xffffffff) break;
      fatSectors.push(s);
    }
    difat = u32(sec, sectorSize - 4);
  }
  if (fatSectors.length < numFatSectors) throw new Error("OLE DIFAT truncated");
  const fat = new Uint32Array((numFatSectors * sectorSize) / 4);
  fatSectors.slice(0, numFatSectors).forEach((sn, i) => {
    const sec = sector(sn);
    for (let j = 0; j < sectorSize / 4; j++) fat[i * (sectorSize / 4) + j] = u32(sec, j * 4);
  });

  // Directory entries, 128 bytes each.
  const entries = [];
  for (const sn of chain(firstDirSector, fat)) {
    const sec = sector(sn);
    for (let off = 0; off + 128 <= sec.length; off += 128) {
      const name = utf16Name(sec, off);
      const type = sec[off + 66];
      if (type === 0) continue; // unallocated
      entries.push({
        name,
        type, // 1 = storage, 2 = stream, 5 = root
        start: u32(sec, off + 116),
        size: u64(sec, off + 120),
      });
    }
  }
  const root = entries.find((e) => e.type === 5);
  const dataOf = (start, size) => {
    const secs = chain(start, fat);
    const out = new Uint8Array(size);
    let pos = 0;
    for (const sn of secs) {
      const sec = sector(sn);
      const n = Math.min(sec.length, size - pos);
      out.set(sec.subarray(0, n), pos);
      pos += n;
      if (pos >= size) break;
    }
    return out;
  };
  // Streams below the cutoff live in the MiniFAT inside the root's stream.
  let miniFat = null;
  let miniStream = null;
  const readMini = (e) => {
    const miniSectorSize = 64;
    const out = new Uint8Array(Number(e.size));
    let s = e.start;
    let pos = 0;
    const seen = new Set();
    while (pos < out.length) {
      if (s === 0xfffffffe || s === 0xffffffff || s === undefined || s >= miniFat.length) {
        throw new Error("OLE mini stream ended early");
      }
      if (seen.has(s)) throw new Error("OLE MiniFAT loop");
      seen.add(s);
      const chunk = miniStream.subarray(s * miniSectorSize, s * miniSectorSize + miniSectorSize);
      const n = Math.min(chunk.length, out.length - pos);
      out.set(chunk.subarray(0, n), pos);
      pos += n;
      s = miniFat[s];
    }
    return out;
  };
  const streams = new Map();
  for (const e of entries) {
    if (e.type !== 2) continue;
    if (e.size < miniSectorCutoff && e.size > 0) {
      if (!miniFat) {
        // MiniFAT sectors are laid out in the order of their FAT chain.
        const mchain = chain(firstMiniFatSector, fat);
        const mf = new Uint32Array((mchain.length * sectorSize) / 4);
        mchain.forEach((sn, i) => {
          const sec = sector(sn);
          for (let j = 0; j < sectorSize / 4; j++) mf[i * (sectorSize / 4) + j] = u32(sec, j * 4);
        });
        miniFat = mf;
        miniStream = root ? dataOf(root.start, Number(root.size ?? 0)) : new Uint8Array(0);
      }
      // WHY the fallback: a few writers store small streams in regular sectors
      // even though the cutoff says "mini". The mini read then ends early;
      // the regular chain is the stream's real home in that case.
      try {
        streams.set(e.name.toLowerCase(), readMini(e));
      } catch (err) {
        if (/mini stream ended early|MiniFAT loop/.test(err.message)) {
          streams.set(e.name.toLowerCase(), dataOf(e.start, Number(e.size)));
        } else {
          throw err;
        }
      }
    } else if (e.size === 0) {
      streams.set(e.name.toLowerCase(), new Uint8Array(0));
    } else {
      streams.set(e.name.toLowerCase(), dataOf(e.start, Number(e.size)));
    }
  }
  return streams;
}

// What kind of protection (if any) does this file have?
// Returns 'open' | 'agile' | 'standard' | 'extensible' | 'legacy' | 'unknown'.
export function detectOfficeEncryption(bytes, ext) {
  if (!isOleFile(bytes)) return "open";
  let streams;
  try {
    streams = readCfb(bytes);
  } catch {
    return "unknown";
  }
  if (streams.has("encryptedpackage") && streams.has("encryptioninfo")) {
    const info = streams.get("encryptioninfo");
    if (info.length < 4) return "unknown";
    const major = u16(info, 0);
    const minor = u16(info, 2);
    if (major === 4 && minor === 4) return "agile";
    if (minor === 2 && major >= 2 && major <= 4) return "standard";
    if (minor === 3 && major >= 3 && major <= 4) return "extensible";
    return "unknown";
  }
  // No package streams: either a plain legacy-format file or legacy RC4
  // encryption. Tell them apart so plain .xls files keep working.
  if (ext === "xls") {
    const wb = streams.get("workbook") || streams.get("book");
    // BIFF: BOF record (0x0809) first; an encrypted file has FILEPASS (0x002F) next.
    if (wb && wb.length > 8 && u16(wb, 0) === 0x0809) {
      const second = u16(wb, 4 + u16(wb, 2));
      if (second === 0x002f) return "legacy";
    }
    return "open";
  }
  if (ext === "doc") {
    const fib = streams.get("worddocument");
    // FIB flags at 0x0A; bit 8 (0x0100) is fEncrypted.
    if (fib && fib.length > 12 && (u16(fib, 10) & 0x0100)) return "legacy";
    return "open";
  }
  return "open";
}

function attr(xml, tag, name) {
  // Finds name="..." inside the first <tag ...> occurrence (namespace-agnostic).
  const m = xml.match(new RegExp(`<[^>]*:?${tag}\\b([^>]*)>`, "s"));
  if (!m) throw new Error(`encryption descriptor has no ${tag}`);
  const a = m[1].match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`));
  if (!a) throw new Error(`encryption descriptor ${tag} has no ${name}`);
  return a[1];
}

const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function parseAgileInfo(infoBytes) {
  const xml = new TextDecoder("utf-8").decode(infoBytes.subarray(8));
  const info = {
    keyDataSalt: b64ToBytes(attr(xml, "keyData", "saltValue")),
    keyDataHash: attr(xml, "keyData", "hashAlgorithm"),
    keyDataBits: parseInt(attr(xml, "keyData", "keyBits"), 10),
    encSalt: b64ToBytes(attr(xml, "encryptedKey", "saltValue")),
    encHash: attr(xml, "encryptedKey", "hashAlgorithm"),
    encBits: parseInt(attr(xml, "encryptedKey", "keyBits"), 10),
    spin: parseInt(attr(xml, "encryptedKey", "spinCount"), 10),
    verifierInput: b64ToBytes(attr(xml, "encryptedKey", "encryptedVerifierHashInput")),
    verifierValue: b64ToBytes(attr(xml, "encryptedKey", "encryptedVerifierHashValue")),
    encryptedKey: b64ToBytes(attr(xml, "encryptedKey", "encryptedKeyValue")),
  };
  for (const [k, want] of [["keyDataHash", "SHA512"], ["encHash", "SHA512"]]) {
    if (info[k] !== want) throw new UnsupportedEncryptionError(`hash ${info[k]}`);
  }
  if (info.keyDataBits !== 256 || info.encBits !== 256) {
    throw new UnsupportedEncryptionError("key size");
  }
  if (!Number.isFinite(info.spin) || info.spin < 1 || info.spin > 50_000_000) {
    throw new UnsupportedEncryptionError("spin count");
  }
  return info;
}

const BLOCK_KEYS = {
  verifierInput: [0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79],
  verifierValue: [0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e],
  encKey: [0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6],
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const sha512 = (data) => nobleSha512(data);
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Raw AES-CBC without padding: agile encrypts full blocks and stores them
// as-is, so there is no PKCS#7 to strip (and WebCrypto would refuse these).
function aesCbcDecrypt(key, iv, data) {
  return Uint8Array.from(cbc(key, iv, { disablePadding: true }).decrypt(data));
}

// WHY sync hashing here: 100k SHA-512 rounds through WebCrypto's promise API
// takes ~20x longer; noble does it in well under a second.
function iteratedHash(password, salt, spin) {
  // UTF-16LE encode without a DOM dependency.
  const utf16 = new Uint8Array(password.length * 2);
  for (let i = 0; i < password.length; i++) {
    const c = password.charCodeAt(i);
    utf16[i * 2] = c & 0xff;
    utf16[i * 2 + 1] = (c >> 8) & 0xff;
  }
  let h = sha512(concat(salt, utf16));
  const ctr = new Uint8Array(4);
  const dv = new DataView(ctr.buffer);
  for (let i = 0; i < spin; i++) {
    dv.setUint32(0, i, true);
    h = sha512(concat(ctr, h));
  }
  return h;
}

// Verifies the password, then unwraps the secret key that locks the package.
// Throws WrongPasswordError when the password does not fit.
export function agileSecretFromPassword(password, info) {
  const h = iteratedHash(password, info.encSalt, info.spin);
  const finalKey = (blockKey) => sha512(concat(h, Uint8Array.from(blockKey))).subarray(0, 32);
  const input = aesCbcDecrypt(finalKey(BLOCK_KEYS.verifierInput), info.encSalt, info.verifierInput);
  const expected = aesCbcDecrypt(finalKey(BLOCK_KEYS.verifierValue), info.encSalt, info.verifierValue);
  if (!eq(sha512(input), expected)) throw new WrongPasswordError();
  return aesCbcDecrypt(finalKey(BLOCK_KEYS.encKey), info.encSalt, info.encryptedKey);
}

export function decryptAgilePackage(pkgBytes, secret, keyDataSalt) {
  const dv = new DataView(pkgBytes.buffer, pkgBytes.byteOffset, Math.min(8, pkgBytes.length));
  const total = Number(dv.getBigUint64(0, true));
  const SEG = 4096;
  const out = new Uint8Array(total);
  let pos = 0;
  let seg = 0;
  for (let off = 8; off < pkgBytes.length && pos < total; off += SEG, seg++) {
    const ctr = new Uint8Array(4);
    new DataView(ctr.buffer).setUint32(0, seg, true);
    const iv = sha512(concat(keyDataSalt, ctr)).subarray(0, 16);
    const chunk = pkgBytes.subarray(off, Math.min(off + SEG, pkgBytes.length));
    const dec = aesCbcDecrypt(secret, iv, chunk);
    const n = Math.min(dec.length, total - pos);
    out.set(dec.subarray(0, n), pos);
    pos += n;
  }
  if (pos !== total) throw new Error("Office file ended early (damaged?)");
  return out;
}

// Top-level: OLE bytes + user password -> the plain OOXML zip bytes.
export function unlockOffice(bytes, password) {
  const streams = readCfb(bytes);
  const pkg = streams.get("encryptedpackage");
  const infoBytes = streams.get("encryptioninfo");
  if (!pkg || !infoBytes) throw new Error("not an encrypted Office file");
  const info = parseAgileInfo(infoBytes);
  const secret = agileSecretFromPassword(password, info);
  const zip = decryptAgilePackage(pkg, secret, info.keyDataSalt);
  if (zip[0] !== 0x50 || zip[1] !== 0x4b) throw new WrongPasswordError();
  return zip;
}

export class WrongPasswordError extends Error {
  constructor() {
    super("wrong password");
    this.name = "WrongPasswordError";
  }
}

export class UnsupportedEncryptionError extends Error {
  constructor(detail) {
    super(`unsupported: ${detail}`);
    this.name = "UnsupportedEncryptionError";
  }
}
