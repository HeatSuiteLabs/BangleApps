/* eslint-env node */
const assert = require("assert");
const loadBP = require("../helpers/load_bp");
const fakeBLE = require("../helpers/fake_ble");

module.exports = [
  {
    name: "builds seven-byte Date Time payload",
    fn() {
      const loaded = loadBP.create();
      const payload = loaded.exports.buildDateTimePayload(new Date(2026, 5, 4, 15, 16, 17));
      assert.strictEqual(payload.length, 7);
      assert.deepStrictEqual(Array.prototype.slice.call(payload), [
        0xEA, 0x07, 6, 4, 15, 16, 17
      ]);
    }
  },
  {
    name: "writes year little-endian and preserves minute and second",
    fn() {
      const loaded = loadBP.create();
      const payload = loaded.exports.buildDateTimePayload(new Date(2031, 11, 31, 23, 58, 59));
      assert.strictEqual(payload[0], 0xEF);
      assert.strictEqual(payload[1], 0x07);
      assert.strictEqual(payload[5], 58);
      assert.strictEqual(payload[6], 59);
    }
  },
  {
    name: "payload can be passed directly to writeValue",
    async fn() {
      const ble = fakeBLE.create();
      const loaded = loadBP.create({
        Date: class extends Date {
          constructor() {
            super(2026, 5, 4, 15, 16, 17);
          }
        }
      });
      const synced = await loaded.exports.trySyncDeviceTime(ble.service);
      assert.strictEqual(synced, true);
      assert.deepStrictEqual(ble.timeChar.writes, [[0xEA, 0x07, 6, 4, 15, 16, 17]]);
    }
  },
  {
    name: "time sync resolves false when characteristic is unavailable",
    async fn() {
      const ble = fakeBLE.create({ timeChar: false });
      const loaded = loadBP.create();
      const synced = await loaded.exports.trySyncDeviceTime(ble.service);
      assert.strictEqual(synced, false);
    }
  }
];
