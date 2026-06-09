const assert = require("assert");
const loader = require("../helpers/module_loader");
const fakeStorage = require("../helpers/fake_storage");
const fakeControlPoint = require("../helpers/fake_controlpoint");
const protocol = loader.create().require("coretemp.protocol");

function loadHRM(cp, storage) {
  return loader.create({
    storage,
    overrides: {
      "coretemp.controlpoint": cp,
      "coretemp.store": { log() {}, init() {}, flush() {} }
    }
  }).require("coretemp.hrm");
}

module.exports = [
  {
    name: "pair verifies and persists selected plus recent",
    async fn() {
      const storage = fakeStorage.create();
      const cp = fakeControlPoint.create();
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_COUNT, [0]);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIR_ANT, []);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_COUNT, [1]);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_ANT_ENTRY, [0x34, 0x12, 0x56]);
      const hrm = loadHRM(cp, storage);
      hrm.init();
      const status = await hrm.pairANT({ antId: 0x1234, txType: 0x56 });
      assert.strictEqual(status.selected.antId, 0x1234);
      assert.strictEqual(storage.files["coretemp.hrm.json"].selected.antId, 0x1234);
      assert.strictEqual(storage.files["coretemp.hrm.json"].selected.txType, undefined);
      assert.strictEqual(storage.files["coretemp.hrm.json"].recent[0].txType, undefined);
      assert.deepStrictEqual(cp.calls.map(call => call.opcode), [0x04, 0x02, 0x04, 0x05]);
    }
  },
  {
    name: "manual ANT id pairs without persisted txType",
    async fn() {
      const storage = fakeStorage.create({
        "coretemp.hrm.json": {
          selected: { antId: 0x1234 },
          recent: [{ antId: 0x1234 }]
        }
      });
      const cp = fakeControlPoint.create();
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_COUNT, [0]);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIR_ANT, []);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_COUNT, [1]);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_ANT_ENTRY, [0x34, 0x12, 0]);
      const hrm = loadHRM(cp, storage);
      hrm.init();
      const status = await hrm.pairANT({ antId: 0x1234 });
      assert.strictEqual(status.selected.antId, 0x1234);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(cp.calls[1].params)), [0x34, 0x12, 0]);
      assert.deepStrictEqual(storage.files["coretemp.hrm.json"], {
        selected: { antId: 0x1234, transport: "ANT+" },
        recent: [{ antId: 0x1234, transport: "ANT+" }]
      });
    }
  },
  {
    name: "same HRM is idempotent",
    async fn() {
      const storage = fakeStorage.create();
      const cp = fakeControlPoint.create();
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_COUNT, [1]);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_ANT_ENTRY, [0x34, 0x12, 0x56]);
      const hrm = loadHRM(cp, storage);
      hrm.init();
      const status = await hrm.pairANT({ antId: 0x1234, txType: 0x56 });
      assert.strictEqual(status.selected.antId, 0x1234);
      assert.deepStrictEqual(cp.calls.map(call => call.opcode), [0x04, 0x05]);
    }
  },
  {
    name: "different paired HRM requires replace flag",
    async fn() {
      const cp = fakeControlPoint.create();
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_COUNT, [1]);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_ANT_ENTRY, [0x11, 0x11, 0]);
      const hrm = loadHRM(cp, fakeStorage.create());
      hrm.init();
      await assert.rejects(hrm.pairANT({ antId: 0x1234 }), /different HRM/);
    }
  },
  {
    name: "replace clears before pairing",
    async fn() {
      const cp = fakeControlPoint.create();
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_COUNT, [1]);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_ANT_ENTRY, [0x11, 0x11, 0]);
      cp.enqueueResponse(protocol.OPCODES.HRM_CLEAR_ANT, []);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIR_ANT, []);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_COUNT, [1]);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_ANT_ENTRY, [0x34, 0x12, 0]);
      const hrm = loadHRM(cp, fakeStorage.create());
      hrm.init();
      const status = await hrm.pairANT({ antId: 0x1234 }, true);
      assert.strictEqual(status.selected.antId, 0x1234);
      assert.deepStrictEqual(cp.calls.map(call => call.opcode), [0x04, 0x05, 0x01, 0x02, 0x04, 0x05]);
    }
  },
  {
    name: "multiple paired HRMs block pairing",
    async fn() {
      const cp = fakeControlPoint.create();
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_COUNT, [2]);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_ANT_ENTRY, [1, 0, 0]);
      cp.enqueueResponse(protocol.OPCODES.HRM_PAIRED_ANT_ENTRY, [2, 0, 0]);
      const hrm = loadHRM(cp, fakeStorage.create());
      hrm.init();
      await assert.rejects(hrm.pairANT({ antId: 0x1234 }, true), /Multiple HRMs/);
    }
  }
];
