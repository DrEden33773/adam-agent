import { decode as decodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";

export const imageInputLimitsV1 = Object.freeze({
  maximumImagesPerRun: 1,
  maximumBytesPerImage: 8 * 1024 * 1024,
  maximumAggregateBytesPerRun: 8 * 1024 * 1024,
  maximumWidth: 4_096,
  maximumHeight: 4_096,
  maximumPixels: 16_777_216,
});

const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type ImageInspection =
  | { readonly status: "not_image" }
  | { readonly status: "invalid" }
  | {
      readonly status: "limit_exceeded";
      readonly mediaType: "image/jpeg" | "image/png";
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly status: "valid";
      readonly mediaType: "image/jpeg" | "image/png";
      readonly width: number;
      readonly height: number;
    };

export function inspectExplicitUserImageV1(bytes: Uint8Array): ImageInspection {
  const mediaType = sniffExplicitUserImageMediaTypeV1(bytes);
  if (mediaType === "image/png") {
    return inspectPng(bytes);
  }
  if (mediaType === "image/jpeg") {
    return inspectJpeg(bytes);
  }
  return { status: "not_image" };
}

export function sniffExplicitUserImageMediaTypeV1(
  bytes: Uint8Array,
): "image/jpeg" | "image/png" | undefined {
  if (startsWith(bytes, pngSignature)) {
    return "image/png";
  }
  return bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : undefined;
}

function inspectPng(bytes: Uint8Array): ImageInspection {
  const dimensions = inspectPngContainer(bytes);
  if (dimensions === undefined) {
    return { status: "invalid" };
  }
  if (exceedsDimensionLimits(dimensions)) {
    return { status: "limit_exceeded", mediaType: "image/png", ...dimensions };
  }
  try {
    const decoded = PNG.sync.read(Buffer.from(bytes), { checkCRC: true });
    if (
      decoded.width !== dimensions.width ||
      decoded.height !== dimensions.height ||
      decoded.data.byteLength !== dimensions.width * dimensions.height * 4
    ) {
      return { status: "invalid" };
    }
  } catch {
    return { status: "invalid" };
  }
  return { status: "valid", mediaType: "image/png", ...dimensions };
}

function inspectJpeg(bytes: Uint8Array): ImageInspection {
  const dimensions = inspectJpegContainer(bytes);
  if (dimensions === undefined) {
    return { status: "invalid" };
  }
  if (exceedsDimensionLimits(dimensions)) {
    return { status: "limit_exceeded", mediaType: "image/jpeg", ...dimensions };
  }
  try {
    const decoded = decodeJpeg(bytes, {
      useTArray: true,
      formatAsRGBA: false,
      tolerantDecoding: false,
      maxResolutionInMP: imageInputLimitsV1.maximumPixels / 1_000_000,
      maxMemoryUsageInMB: 96,
    });
    if (
      decoded.width !== dimensions.width ||
      decoded.height !== dimensions.height ||
      decoded.data.byteLength !== dimensions.width * dimensions.height * 3
    ) {
      return { status: "invalid" };
    }
  } catch {
    return { status: "invalid" };
  }
  return { status: "valid", mediaType: "image/jpeg", ...dimensions };
}

function inspectPngContainer(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  let offset = pngSignature.byteLength;
  let width: number | undefined;
  let height: number | undefined;
  let sawImageData = false;
  let chunkIndex = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) {
      return undefined;
    }
    const length = readUint32(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (length > bytes.byteLength || chunkEnd > bytes.byteLength) {
      return undefined;
    }
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    if (readUint32(bytes, dataEnd) !== pngCrc32(bytes.subarray(offset + 4, dataEnd))) {
      return undefined;
    }
    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) {
        return undefined;
      }
      width = readUint32(bytes, dataStart);
      height = readUint32(bytes, dataStart + 4);
      if (width === 0 || height === 0) {
        return undefined;
      }
    } else if (type === "IHDR") {
      return undefined;
    }
    if (type === "IDAT") {
      sawImageData = true;
    }
    if (type === "IEND") {
      if (
        length !== 0 ||
        !sawImageData ||
        width === undefined ||
        height === undefined ||
        chunkEnd !== bytes.byteLength
      ) {
        return undefined;
      }
      return { width, height };
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  return undefined;
}

function inspectJpegContainer(
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined {
  let offset = 2;
  let width: number | undefined;
  let height: number | undefined;
  let sawScan = false;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      return undefined;
    }
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset];
    if (marker === undefined || marker === 0x00) {
      return undefined;
    }
    offset += 1;
    if (marker === 0xd9) {
      return sawScan && width !== undefined && height !== undefined && offset === bytes.byteLength
        ? { width, height }
        : undefined;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue;
    }
    if (bytes.byteLength - offset < 2) {
      return undefined;
    }
    const length = readUint16(bytes, offset);
    const segmentEnd = offset + length;
    if (length < 2 || segmentEnd > bytes.byteLength) {
      return undefined;
    }
    if (isJpegStartOfFrame(marker)) {
      if (length < 8) {
        return undefined;
      }
      height = readUint16(bytes, offset + 3);
      width = readUint16(bytes, offset + 5);
      if (width === 0 || height === 0) {
        return undefined;
      }
    }
    offset = segmentEnd;
    if (marker !== 0xda) {
      continue;
    }
    sawScan = true;
    while (offset < bytes.byteLength) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const markerStart = offset;
      while (bytes[offset] === 0xff) {
        offset += 1;
      }
      const scanMarker = bytes[offset];
      if (scanMarker === 0x00) {
        offset += 1;
        continue;
      }
      if (scanMarker !== undefined && scanMarker >= 0xd0 && scanMarker <= 0xd7) {
        offset += 1;
        continue;
      }
      offset = markerStart;
      break;
    }
  }
  return undefined;
}

function exceedsDimensionLimits(input: {
  readonly width: number;
  readonly height: number;
}): boolean {
  return (
    input.width > imageInputLimitsV1.maximumWidth ||
    input.height > imageInputLimitsV1.maximumHeight ||
    input.width > Math.floor(imageInputLimitsV1.maximumPixels / input.height)
  );
}

function isJpegStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return (
    bytes.byteLength >= prefix.byteLength && prefix.every((byte, index) => bytes[index] === byte)
  );
}
