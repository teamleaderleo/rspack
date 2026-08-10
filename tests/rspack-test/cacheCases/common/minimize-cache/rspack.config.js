const fs = require('node:fs');
const path = require('node:path');
const rspack = require('@rspack/core');

const PLUGIN_NAME = 'rspack.SwcJsMinimizerRspackPlugin';
const cacheDirectory = path.join(__dirname, '.rspack-cache');
const scope = 'occasion_minimize';
const mask = 0xffffffffffffffffn;
const hashMultiplier = 0xf1357aea2e62a9c5n;
const hashSeed1 = 0x243f6a8885a308d3n;
const hashSeed2 = 0x13198a2e03707344n;
const zeroCollapseGuard = 0xa4093822299f31d0n;

let updateIndex = 0;
let didCorrupt = false;

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(file) : [file];
  });
}

function addToHash(hash, value) {
  return ((hash + value) * hashMultiplier) & mask;
}

function multiplyMix(left, right) {
  const full = left * right;
  return ((full & mask) ^ (full >> 64n)) & mask;
}

function hashBytes(bytes) {
  const length = bytes.length;
  let first = hashSeed1;
  let second = hashSeed2;
  if (length <= 16) {
    if (length >= 8) {
      first ^= bytes.readBigUInt64LE(0);
      second ^= bytes.readBigUInt64LE(length - 8);
    } else if (length >= 4) {
      first ^= BigInt(bytes.readUInt32LE(0));
      second ^= BigInt(bytes.readUInt32LE(length - 4));
    } else if (length > 0) {
      first ^= BigInt(bytes[0]);
      second ^=
        (BigInt(bytes[length - 1]) << 8n) |
        BigInt(bytes[Math.floor(length / 2)]);
    }
  } else {
    for (let offset = 0; offset + 16 <= length - 1; offset += 16) {
      const left = bytes.readBigUInt64LE(offset);
      const right = bytes.readBigUInt64LE(offset + 8);
      const mixed = multiplyMix(first ^ left, zeroCollapseGuard ^ right);
      first = second;
      second = mixed;
    }
    const suffix = bytes.subarray(length - 16);
    first ^= suffix.readBigUInt64LE(0);
    second ^= suffix.readBigUInt64LE(8);
  }
  return (multiplyMix(first, second) ^ BigInt(length)) & mask;
}

function parsePackRecords(buffer) {
  const records = [];
  let offset = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) throw new Error('truncated pack record header');
    const [keyLength, valueLength] = buffer
      .toString('utf8', offset, newline)
      .split(' ')
      .map(Number);
    const keyStart = newline + 1;
    const valueStart = keyStart + keyLength;
    const end = valueStart + valueLength;
    if (
      !Number.isInteger(keyLength) ||
      !Number.isInteger(valueLength) ||
      end > buffer.length
    ) {
      throw new Error('invalid pack record lengths');
    }
    records.push({ keyStart, keyEnd: valueStart, end, keyLength });
    offset = end;
  }
  return records;
}

function hashPack(buffer) {
  let hash = 0n;
  for (const record of parsePackRecords(buffer)) {
    const key = buffer.subarray(record.keyStart, record.keyEnd);
    const value = buffer.subarray(record.keyEnd, record.end);
    hash = addToHash(hash, BigInt(key.length));
    hash = addToHash(hash, hashBytes(key));
    hash = addToHash(hash, BigInt(value.length));
    hash = addToHash(hash, hashBytes(value));
  }
  return (((hash << 26n) | (hash >> 38n)) & mask).toString();
}

function swapMinimizeKeys() {
  const packPath = listFiles(cacheDirectory).find((file) =>
    file.endsWith(`${scope}${path.sep}0.pack`),
  );
  if (!packPath) throw new Error(`could not find ${scope}/0.pack`);

  const original = fs.readFileSync(packPath);
  const records = parsePackRecords(original);
  if (
    records.length !== 2 ||
    records.some((record) => record.keyLength !== 8)
  ) {
    throw new Error(
      `expected two 8-byte minimize records, found ${records.length}`,
    );
  }

  const metaPath = path.join(path.dirname(packPath), '_meta');
  const meta = fs.readFileSync(metaPath, 'utf8').trim().split('\n');
  const metaFields = meta[1].split(' ');
  if (metaFields[1] !== hashPack(original)) {
    throw new Error('minimize pack hash mismatch before corruption');
  }

  const swapped = Buffer.from(original);
  const firstKey = original.subarray(records[0].keyStart, records[0].keyEnd);
  const secondKey = original.subarray(records[1].keyStart, records[1].keyEnd);
  secondKey.copy(swapped, records[0].keyStart);
  firstKey.copy(swapped, records[1].keyStart);
  fs.writeFileSync(packPath, swapped);

  metaFields[1] = hashPack(swapped);
  meta[1] = metaFields.join(' ');
  fs.writeFileSync(metaPath, `${meta.join('\n')}\n`);
}

/** @type {import("@rspack/core").Configuration} */
module.exports = {
  context: __dirname,
  mode: 'production',
  output: {
    chunkFilename: '[id].chunk.js',
  },
  optimization: {
    minimize: true,
    minimizer: [new rspack.SwcJsMinimizerRspackPlugin()],
  },
  cache: {
    type: 'persistent',
    storage: {
      type: 'filesystem',
      directory: cacheDirectory,
    },
  },
  plugins: [
    {
      apply(compiler) {
        const close = compiler.close.bind(compiler);
        compiler.close = (callback) => {
          close((error) => {
            if (!error && updateIndex === 1 && !didCorrupt) {
              swapMinimizeKeys();
              didCorrupt = true;
            }
            callback(error);
          });
        };

        compiler.hooks.done.tap('MinimizePersistentCacheTest', (stats) => {
          const s = stats.toJson({
            all: false,
            assets: true,
            logging: 'verbose',
          });

          const jsAssets = s.assets.filter((a) => a.name?.endsWith('.js'));
          for (const asset of jsAssets) {
            expect(asset.info.minimized).toBe(true);
          }

          const logEntries = s.logging[PLUGIN_NAME]?.entries ?? [];
          const cacheLogEntry = logEntries.find(
            (e) =>
              e.type === 'cache' &&
              e.message &&
              e.message.startsWith('minimize persistent cache:'),
          );

          if (updateIndex === 5) {
            // HMR update with changed file content
            // Minimize persistent cache is not shared across in-memory rebuilds, so both assets are processed as new → all misses.
            expect(cacheLogEntry).toBeUndefined();
            return;
          }

          expect(cacheLogEntry).toBeTruthy();

          const match = cacheLogEntry.message.match(
            /minimize persistent cache: [\d.]+% \((\d+)\/(\d+)\)/,
          );
          expect(match).toBeTruthy();

          const hits = parseInt(match[1], 10);
          const total = parseInt(match[2], 10);
          const misses = total - hits;

          if (updateIndex === 0) {
            // Cold build, cache is empty → all misses.
            expect(hits).toBe(0);
            expect(misses).toBe(2);
          }
          if (updateIndex === 1) {
            // The previous compiler closed cleanly, then the two physical cache
            // keys were swapped while retaining a valid pack integrity hash.
            // Recovery must reject both mismatched entries and recompute them.
            expect(hits).toBe(0);
            expect(misses).toBe(2);
          }
          if (updateIndex === 2) {
            // The rejected entries were rewritten with their correct keys.
            expect(hits).toBe(2);
            expect(misses).toBe(0);
          }
          if (updateIndex === 3) {
            // Third cold build with changed file content.
            // Async chunk unchanged → hit; entry chunk changed → miss.
            expect(hits).toBe(1);
            expect(misses).toBe(1);
          }
          if (updateIndex === 4) {
            // Cold restart. Async chunk still unchanged → hit.
            expect(hits).toBe(1);
            expect(misses).toBe(1);
          }

          updateIndex++;
        });
      },
    },
  ],
};