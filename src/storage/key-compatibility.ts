const SIGN_BIT = 0x8000000000000000n;
const EXPONENT_BITS = 0x7ff0000000000000n;
const FRACTION_BITS = 0x000fffffffffffffn;
const U64_MASK = 0xffffffffffffffffn;

/** Reject legacy tuple keys whose numeric identity JavaScriptCore cannot retain. */
export const assertPortableKvKeyBytes = (key: Uint8Array): void => {
  if (!key.length) throw new TypeError("A stored KV key cannot be empty");
  let offset = 0;
  while (offset < key.length) {
    const tag = key[offset++];
    if (tag === 0x01 || tag === 0x02) {
      let terminated = false;
      while (offset < key.length) {
        const byte = key[offset++];
        if (byte !== 0) continue;
        if (key[offset] === 0xff) {
          offset += 1;
          continue;
        }
        terminated = true;
        break;
      }
      if (!terminated) throw new TypeError("Truncated KV bytes or string part");
      continue;
    }
    if (tag >= 0x0b && tag <= 0x1d) {
      let length = Math.abs(tag - 0x14);
      if (tag === 0x0b || tag === 0x1d) {
        if (offset >= key.length) throw new TypeError("Truncated KV bigint length");
        length = tag === 0x0b ? 0xff - key[offset++] : key[offset++];
      }
      offset += length;
    } else if (tag === 0x21) {
      if (offset + 8 > key.length) throw new TypeError("Truncated KV number part");
      let bits = 0n;
      for (let index = 0; index < 8; index += 1) bits = (bits << 8n) | BigInt(key[offset++]);
      bits ^= bits & SIGN_BIT ? SIGN_BIT : U64_MASK;
      if ((bits & SIGN_BIT) !== 0n && (bits & EXPONENT_BITS) === EXPONENT_BITS && (bits & FRACTION_BITS) !== 0n) {
        throw new TypeError("Negative NaN KV key parts cannot retain their identity in Bun; the source database was not converted");
      }
    } else if (tag !== 0x26 && tag !== 0x27) {
      throw new TypeError(`Unsupported KV key part tag ${tag}`);
    }
    if (offset > key.length) throw new TypeError("Truncated KV key part");
  }
};
