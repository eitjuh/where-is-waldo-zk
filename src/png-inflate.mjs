import { inflateSync as nodeInflate } from "node:zlib";

export function inflateSync(bytes) {
  return nodeInflate(bytes);
}
