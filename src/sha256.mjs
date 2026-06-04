import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

/** Synchronous SHA-256 for Node and browser bundles. */
export function sha256Bytes(bytes) {
  return nobleSha256(bytes);
}
