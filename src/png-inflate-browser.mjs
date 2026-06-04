import { unzlibSync } from "fflate";

/** PNG IDAT uses zlib-wrapped deflate; fflate's unzlibSync matches Node inflateSync. */
export function inflateSync(bytes) {
  return unzlibSync(bytes);
}
