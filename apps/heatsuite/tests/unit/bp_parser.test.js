/* eslint-env node */
const assert = require("assert");
const loadBP = require("../helpers/load_bp");
const fakeBLE = require("../helpers/fake_ble");

function sfloat(raw) {
  return [raw & 0xFF, (raw >> 8) & 0xFF];
}

function packet(flags, fields) {
  let bytes = [flags];
  fields.forEach(field => {
    bytes = bytes.concat(field);
  });
  return fakeBLE.dataViewFromBytes(bytes);
}

function parse(bytes, deviceId) {
  const loaded = loadBP.create();
  return loaded.exports.parseBPMeasurement(bytes, deviceId || "bp-1");
}

module.exports = [
  {
    name: "decodes minimal mmHg measurement",
    fn() {
      const result = parse(packet(0x00, [
        sfloat(120),
        sfloat(80),
        sfloat(93)
      ]));
      assert.strictEqual(result.deviceId, "bp-1");
      assert.strictEqual(result.rawFlags, 0);
      assert.strictEqual(result.unit, "mmHg");
      assert.strictEqual(result.sbp, 120);
      assert.strictEqual(result.dbp, 80);
      assert.strictEqual(result.map, 93);
      assert.strictEqual(result.hr, null);
      assert.strictEqual(result.year, null);
    }
  },
  {
    name: "decodes kPa unit flag",
    fn() {
      const result = parse(packet(0x01, [
        sfloat(16),
        sfloat(10),
        sfloat(12)
      ]));
      assert.strictEqual(result.unit, "kPa");
      assert.strictEqual(result.sbp, 16);
    }
  },
  {
    name: "decodes timestamp",
    fn() {
      const result = parse(packet(0x02, [
        sfloat(120),
        sfloat(80),
        sfloat(93),
        [0xEA, 0x07, 6, 4, 15, 16, 17]
      ]));
      assert.strictEqual(result.year, 2026);
      assert.strictEqual(result.month, 6);
      assert.strictEqual(result.day, 4);
      assert.strictEqual(result.hour, 15);
      assert.strictEqual(result.minute, 16);
      assert.strictEqual(result.second, 17);
    }
  },
  {
    name: "decodes pulse rate",
    fn() {
      const result = parse(packet(0x04, [
        sfloat(120),
        sfloat(80),
        sfloat(93),
        sfloat(72)
      ]));
      assert.strictEqual(result.hr, 72);
    }
  },
  {
    name: "decodes user id",
    fn() {
      const result = parse(packet(0x08, [
        sfloat(120),
        sfloat(80),
        sfloat(93),
        [7]
      ]));
      assert.strictEqual(result.userId, 7);
    }
  },
  {
    name: "decodes measurement status flags",
    fn() {
      const result = parse(packet(0x10, [
        sfloat(120),
        sfloat(80),
        sfloat(93),
        [0x27, 0x00]
      ]));
      assert.strictEqual(result.moved, 1);
      assert.strictEqual(result.bodyMovementDetected, 1);
      assert.strictEqual(result.cuffLoose, 1);
      assert.strictEqual(result.irregularPulse, 1);
      assert.strictEqual(result.improperMeasure, 1);
      assert.strictEqual(result.measurementPositionImproper, 1);
    }
  },
  {
    name: "decodes all optional fields together",
    fn() {
      const result = parse(packet(0x1E, [
        sfloat(120),
        sfloat(80),
        sfloat(93),
        [0xEA, 0x07, 6, 4, 15, 16, 17],
        sfloat(70),
        [9],
        [0x02, 0x00]
      ]), "bp-abc");
      assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), {
        deviceId: "bp-abc",
        rawFlags: 0x1E,
        unit: "mmHg",
        sbp: 120,
        dbp: 80,
        map: 93,
        hr: 70,
        year: 2026,
        month: 6,
        day: 4,
        hour: 15,
        minute: 16,
        second: 17,
        userId: 9,
        moved: 0,
        cuffLoose: 1,
        irregularPulse: 0,
        improperMeasure: 0,
        bodyMovementDetected: 0,
        measurementPositionImproper: 0
      });
    }
  },
  {
    name: "decodes decimal and negative SFLOAT values",
    fn() {
      const loaded = loadBP.create();
      assert.strictEqual(loaded.exports.decodeSFloat16(0xF07B), 12.3);
      assert.strictEqual(loaded.exports.decodeSFloat16(0xFFCE), -5);
    }
  },
  {
    name: "handles special SFLOAT values deterministically",
    fn() {
      const loaded = loadBP.create();
      assert.strictEqual(loaded.exports.decodeSFloat16(0x07FE), Infinity);
      assert.strictEqual(loaded.exports.decodeSFloat16(0x0802), -Infinity);
      assert.strictEqual(loaded.exports.decodeSFloat16(0x07FF), null);
      assert.strictEqual(loaded.exports.decodeSFloat16(0x0800), null);
      assert.strictEqual(loaded.exports.decodeSFloat16(0x0801), null);
    }
  },
  {
    name: "throws on truncated packet",
    fn() {
      const loaded = loadBP.create();
      assert.throws(
        () => loaded.exports.parseBPMeasurement(fakeBLE.dataViewFromBytes([0x02, 120, 0, 80, 0, 93, 0, 0xEA])),
        /Truncated BP measurement: timestamp/
      );
    }
  },
  {
    name: "ignores trailing bytes",
    fn() {
      const result = parse(fakeBLE.dataViewFromBytes([0x00, 120, 0, 80, 0, 93, 0, 0xAA, 0xBB]));
      assert.strictEqual(result.sbp, 120);
      assert.strictEqual(result.dbp, 80);
      assert.strictEqual(result.map, 93);
    }
  }
];
