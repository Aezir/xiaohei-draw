'use strict';

// Minimal MessagePack encoder for tests only (maps, arrays, strings, integers,
// floats, booleans, null, binary). Replaces the @msgpack/msgpack dev dependency
// so `node --test tests/` runs without npm install.

function encodeValue(value, out) {
    if (value === null || value === undefined) {
        out.push(Buffer.from([0xc0]));
    } else if (value === true || value === false) {
        out.push(Buffer.from([value ? 0xc3 : 0xc2]));
    } else if (typeof value === 'number') {
        if (Number.isInteger(value) && value >= 0) {
            if (value < 0x80) out.push(Buffer.from([value]));
            else if (value < 0x100) out.push(Buffer.from([0xcc, value]));
            else if (value < 0x10000) { const b = Buffer.alloc(3); b[0] = 0xcd; b.writeUInt16BE(value, 1); out.push(b); }
            else { const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(value, 1); out.push(b); }
        } else if (Number.isInteger(value) && value >= -0x80000000) {
            const b = Buffer.alloc(5); b[0] = 0xd2; b.writeInt32BE(value, 1); out.push(b);
        } else {
            const b = Buffer.alloc(9); b[0] = 0xcb; b.writeDoubleBE(value, 1); out.push(b);
        }
    } else if (typeof value === 'string') {
        const bytes = Buffer.from(value, 'utf8');
        const n = bytes.length;
        if (n < 32) out.push(Buffer.from([0xa0 | n]));
        else if (n < 0x100) out.push(Buffer.from([0xd9, n]));
        else if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = 0xda; b.writeUInt16BE(n, 1); out.push(b); }
        else { const b = Buffer.alloc(5); b[0] = 0xdb; b.writeUInt32BE(n, 1); out.push(b); }
        out.push(bytes);
    } else if (value instanceof Uint8Array) {
        const n = value.length;
        if (n < 0x100) out.push(Buffer.from([0xc4, n]));
        else if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = 0xc5; b.writeUInt16BE(n, 1); out.push(b); }
        else { const b = Buffer.alloc(5); b[0] = 0xc6; b.writeUInt32BE(n, 1); out.push(b); }
        out.push(Buffer.from(value));
    } else if (Array.isArray(value)) {
        const n = value.length;
        if (n < 16) out.push(Buffer.from([0x90 | n]));
        else { const b = Buffer.alloc(5); b[0] = 0xdd; b.writeUInt32BE(n, 1); out.push(b); }
        value.forEach(item => encodeValue(item, out));
    } else if (typeof value === 'object') {
        const entries = Object.entries(value).filter(([, v]) => v !== undefined);
        const n = entries.length;
        if (n < 16) out.push(Buffer.from([0x80 | n]));
        else { const b = Buffer.alloc(5); b[0] = 0xdf; b.writeUInt32BE(n, 1); out.push(b); }
        for (const [k, v] of entries) {
            encodeValue(k, out);
            encodeValue(v, out);
        }
    } else {
        throw new TypeError(`Unsupported msgpack test value: ${typeof value}`);
    }
}

function encode(value) {
    const out = [];
    encodeValue(value, out);
    return Buffer.concat(out);
}

module.exports = { encode };
