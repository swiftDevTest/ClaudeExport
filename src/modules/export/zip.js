// 历史问题：createZip 所有 setUint16/setUint32 调用未校验上限，
// 文件数 > 65535、单文件 > 4GB、文件名 > 65535 字节时静默溢出，
// 生成的 ZIP 文件损坏且无错误提示。修复：写前显式校验，超出时抛错。
// 注意：当前实现仅支持 ZIP32（无 ZIP64 扩展），保留原有约束。

export const ZIP_LIMITS = Object.freeze({
  MAX_FILE_COUNT: 0xffff,        // 65535
  MAX_NAME_BYTES: 0xffff,        // 65535
  MAX_FILE_BYTES: 0xffffffff,    // 4GB - 1
  MAX_OFFSET: 0xffffffff,        // 4GB - 1
  MAX_CENTRAL_SIZE: 0xffffffff   // 4GB - 1
});

export function utf8Bytes(value) {
  return new TextEncoder().encode(String(value));
}

function assertZipLimit(condition, message) {
  if (!condition) {
    const error = new Error(message || "ZIP archive limit exceeded.");
    error.code = "zip_limit_exceeded";
    throw error;
  }
}

export function createZip(files) {
  var fileCount = files.length;
  assertZipLimit(
    fileCount <= ZIP_LIMITS.MAX_FILE_COUNT,
    `ZIP archive cannot contain more than ${ZIP_LIMITS.MAX_FILE_COUNT} files (received ${fileCount}).`
  );

  var localParts = [];
  var centralParts = [];
  var offset = 0;

  files.forEach(function (file, index) {
    var nameBytes = utf8Bytes(file.path);
    assertZipLimit(
      nameBytes.length <= ZIP_LIMITS.MAX_NAME_BYTES,
      `ZIP entry name too long at index ${index}: ${nameBytes.length} bytes (limit ${ZIP_LIMITS.MAX_NAME_BYTES}).`
    );

    var data = file.content instanceof Uint8Array ? file.content : utf8Bytes(file.content);
    assertZipLimit(
      data.length <= ZIP_LIMITS.MAX_FILE_BYTES,
      `ZIP entry too large at index ${index} ("${file.path}"): ${data.length} bytes (limit ${ZIP_LIMITS.MAX_FILE_BYTES}).`
    );

    var crc = crc32(data);

    // 校验累计 offset 不会溢出 UINT32
    var localHeaderSize = 30 + nameBytes.length;
    assertZipLimit(
      offset + localHeaderSize + data.length <= ZIP_LIMITS.MAX_OFFSET,
      `ZIP archive offset overflow at index ${index}: cumulative size exceeds 4GB.`
    );

    var local = new Uint8Array(localHeaderSize);
    var view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, 0, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    localParts.push(local, data);

    var central = new Uint8Array(46 + nameBytes.length);
    var cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);
    offset += localHeaderSize + data.length;
  });

  var centralOffset = offset;
  var centralSize = centralParts.reduce(function (sum, part) { return sum + part.length; }, 0);
  assertZipLimit(
    centralSize <= ZIP_LIMITS.MAX_CENTRAL_SIZE,
    `ZIP central directory too large: ${centralSize} bytes (limit ${ZIP_LIMITS.MAX_CENTRAL_SIZE}).`
  );
  assertZipLimit(
    centralOffset <= ZIP_LIMITS.MAX_OFFSET,
    `ZIP central directory offset too large: ${centralOffset} bytes (limit ${ZIP_LIMITS.MAX_OFFSET}).`
  );

  var eocd = new Uint8Array(22);
  var ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, fileCount, true);
  ev.setUint16(10, fileCount, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);

  return concatBytes(localParts.concat(centralParts, [eocd]));
}

var crcTable = null;
export function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  var crc = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function concatBytes(parts) {
  var total = parts.reduce(function (sum, part) { return sum + part.length; }, 0);
  var out = new Uint8Array(total);
  var offset = 0;
  parts.forEach(function (part) {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}
