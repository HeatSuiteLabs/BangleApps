/* eslint-env node */
const assert = require("assert");
const loadBP = require("../helpers/load_bp");
const fakeBLE = require("../helpers/fake_ble");

function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function flushMany() {
  for (let i = 0; i < 8; i++) await flush();
}

function sfloat(raw) {
  return [raw & 0xFF, (raw >> 8) & 0xFF];
}

function measurementPacket() {
  return [
    0x1E,
    ...sfloat(120),
    ...sfloat(80),
    ...sfloat(93),
    0xEA, 0x07, 6, 4, 15, 16, 17,
    ...sfloat(70),
    9,
    0x02, 0x00
  ];
}

class FixedDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(2026, 5, 10, 12, 34, 56);
  }
}

function labelsFromLayout(def) {
  const labels = [];
  function walk(node) {
    if (!node) return;
    if (Object.prototype.hasOwnProperty.call(node, "label")) labels.push(String(node.label));
    if (node.c) node.c.forEach(walk);
  }
  walk(def);
  return labels;
}

async function setupCollector(bleOptions, loadOptions) {
  const ble = fakeBLE.create(bleOptions || {});
  const loaded = loadBP.create(Object.assign({
    settings: { DEBUG: true, bt_bloodPressure_id: "bp-1" },
    NRF: ble.NRF
  }, loadOptions || {}));
  loaded.context.BP_CONNECT_SETTLE_MS = 1000;
  loaded.context.BP_INDICATION_IDLE_EXIT_MS = 1;
  const ready = loaded.exports.getBP("bp-1");
  for (let i = 0; i < 6; i++) {
    await flushMany();
    loaded.timers.runByMs(1000);
  }
  await ready;
  await flushMany();
  return { ble, loaded };
}

module.exports = [
  {
    name: "missing configured device id does not connect",
    async fn() {
      const ble = fakeBLE.create();
      const loaded = loadBP.create({
        settings: {},
        NRF: ble.NRF
      });
      loaded.timers.runByMs(2000);
      await flushMany();
      assert.strictEqual(ble.NRF.connectCalls.length, 0);
      const labels = labelsFromLayout(loaded.layouts[loaded.layouts.length - 1]);
      assert.ok(labels.includes("ERROR!"));
      assert.ok(labels.includes("No BP device paired"));
    }
  },
  {
    name: "disconnect during connect settle does not attempt service discovery",
    async fn() {
      const ble = fakeBLE.create({ bonded: false });
      const loaded = loadBP.create({
        settings: { DEBUG: true, bt_bloodPressure_id: "bp-1" },
        NRF: ble.NRF
      });
      loaded.context.BP_CONNECT_SETTLE_MS = 1000;
      const ready = loaded.exports.getBP("bp-1");
      await flushMany();
      ble.device.emitDisconnect(19);
      loaded.timers.runByMs(1000);
      await ready;
      await flushMany();
      assert.strictEqual(ble.device.disconnectCalls, 0);
      assert.strictEqual(ble.measurementChar.notificationsStarted, false);
      const labels = labelsFromLayout(loaded.layouts[loaded.layouts.length - 1]);
      assert.ok(labels.includes("ERROR!"));
      assert.ok(labels.includes("Disconnected"));
    }
  },
  {
    name: "unbonded device is rejected during measurement",
    async fn() {
      const { ble, loaded } = await setupCollector({ bonded: false });
      assert.strictEqual(ble.device.bondCalls, 0);
      assert.strictEqual(ble.NRF.connectCalls.length, 1);
      assert.strictEqual(ble.measurementChar.notificationsStarted, false);
      const labels = labelsFromLayout(loaded.layouts[loaded.layouts.length - 1]);
      assert.ok(labels.includes("ERROR!"));
      assert.ok(labels.includes("BP cuff is not paired. Pair in Settings with START held until PR."));
    }
  },
  {
    name: "bonded device skips bonding",
    async fn() {
      const { ble } = await setupCollector({ bonded: true });
      assert.strictEqual(ble.device.bondCalls, 0);
      assert.strictEqual(ble.measurementChar.notificationsStarted, true);
    }
  },
  {
    name: "syncs BP device time before measurement notifications",
    async fn() {
      const { ble, loaded } = await setupCollector({ bonded: true }, {
        Date: FixedDate
      });
      assert.deepStrictEqual(ble.dateTimeChar.writes, [[0xEA, 0x07, 6, 10, 12, 34, 56]]);
      assert.strictEqual(ble.measurementChar.notificationsStarted, true);
      assert.ok(loaded.logs.includes("BP time sync complete"));
    }
  },
  {
    name: "missing BP time characteristic does not block measurement setup",
    async fn() {
      const { ble, loaded } = await setupCollector({ bonded: true, dateTimeChar: false });
      assert.strictEqual(ble.measurementChar.notificationsStarted, true);
      assert.ok(loaded.logs.some(log => /BP time sync skipped/.test(log)));
    }
  },
  {
    name: "security failure tells user to pair in settings",
    async fn() {
      const { ble, loaded } = await setupCollector({
        bonded: true,
        notifyRejectCount: 1,
        notifyReject: new Error("Insufficient authentication")
      });
      assert.strictEqual(ble.device.bondCalls, 0);
      assert.strictEqual(ble.NRF.connectCalls.length, 1);
      assert.strictEqual(ble.measurementChar.notificationsStarted, false);
      const labels = labelsFromLayout(loaded.layouts[loaded.layouts.length - 1]);
      assert.ok(labels.includes("ERROR!"));
      assert.ok(labels.includes("BP cuff is not paired. Pair in Settings with START held until PR."));
    }
  },
  {
    name: "successful notification saves stable schema once",
    async fn() {
      const { ble, loaded } = await setupCollector({ bonded: true });
      ble.measurementChar.emitValue(measurementPacket());
      assert.strictEqual(loaded.saved.length, 1);
      assert.strictEqual(loaded.saved[0].type, "bpres");
      assert.strictEqual(loaded.saved[0].task, "bloodPressure");
      assert.deepStrictEqual(Object.keys(loaded.saved[0].data), [
        "deviceId",
        "rawFlags",
        "unit",
        "sbp",
        "dbp",
        "map",
        "hr",
        "year",
        "month",
        "day",
        "hour",
        "minute",
        "second",
        "userId",
        "moved",
        "cuffLoose",
        "irregularPulse",
        "improperMeasure",
        "bodyMovementDetected",
        "measurementPositionImproper"
      ]);
      assert.strictEqual(loaded.saved[0].data.deviceId, "bp-1");
      assert.strictEqual(loaded.saved[0].data.sbp, 120);
      assert.strictEqual(loaded.saved[0].data.dbp, 80);
      assert.strictEqual(loaded.saved[0].data.hr, 70);
      assert.ok(loaded.logs.includes("BP payload raw 1e 78 00 50 00 5d 00 ea 07 06 04 0f 10 11 46 00 09 02 00"));
      assert.ok(loaded.logs.some(log => /BP payload parsed/.test(log) && /"sbp":120/.test(log)));
      assert.strictEqual(ble.device.disconnectCalls, 0);
      loaded.timers.runByMs(1);
      assert.strictEqual(ble.device.disconnectCalls, 1);
      const labels = labelsFromLayout(loaded.layouts[loaded.layouts.length - 1]);
      assert.ok(labels.includes("Saved!"));
    }
  },
  {
    name: "save debug mode emits measurement payload logs",
    async fn() {
      const { ble, loaded } = await setupCollector({ bonded: true }, {
        settings: { SAVE_DEBUG: true, bt_bloodPressure_id: "bp-1" }
      });
      ble.measurementChar.emitValue(measurementPacket());
      assert.ok(loaded.logs.includes("BP payload raw 1e 78 00 50 00 5d 00 ea 07 06 04 0f 10 11 46 00 09 02 00"));
    }
  },
  {
    name: "stored measurement burst saves each indication before idle exit",
    async fn() {
      const { ble, loaded } = await setupCollector({ bonded: true });
      ble.measurementChar.emitValue(measurementPacket());
      ble.measurementChar.emitValue(measurementPacket());
      assert.strictEqual(loaded.saved.length, 2);
      assert.strictEqual(ble.device.disconnectCalls, 0);
      const labels = labelsFromLayout(loaded.layouts[loaded.layouts.length - 1]);
      assert.ok(labels.includes("Saved x2"));
      loaded.timers.runByMs(1);
      assert.strictEqual(ble.device.disconnectCalls, 1);
    }
  },
  {
    name: "success path schedules exit",
    async fn() {
      const { ble, loaded } = await setupCollector({ bonded: true });
      ble.measurementChar.emitValue(measurementPacket());
      assert.strictEqual(loaded.loads.length, 0);
      loaded.timers.runByMs(1);
      assert.strictEqual(loaded.loads.length, 0);
      loaded.timers.runByMs(10000);
      assert.strictEqual(loaded.loads.length, 1);
    }
  },
  {
    name: "connection failure exits without retrying",
    async fn() {
      const ble = fakeBLE.create({ connectRejectCount: 99 });
      const loaded = loadBP.create({
        settings: { bt_bloodPressure_id: "bp-1" },
        NRF: ble.NRF
      });
      const ready = loaded.exports.getBP("bp-1");
      await ready;
      await flushMany();
      assert.strictEqual(ble.NRF.connectCalls.length, 1);
      loaded.timers.runByMs(5000);
      await flushMany();
      assert.strictEqual(ble.NRF.connectCalls.length, 1);
      const labels = labelsFromLayout(loaded.layouts[loaded.layouts.length - 1]);
      assert.ok(labels.includes("ERROR!"));
      assert.ok(labels.includes("connect failed"));
    }
  },
  {
    name: "measurement timeout disconnects and does not save",
    async fn() {
      const { ble, loaded } = await setupCollector({ bonded: true });
      loaded.timers.runByMs(120000);
      await flushMany();
      assert.strictEqual(loaded.saved.length, 0);
      assert.strictEqual(ble.device.disconnectCalls, 1);
      const labels = labelsFromLayout(loaded.layouts[loaded.layouts.length - 1]);
      assert.ok(labels.includes("ERROR!"));
      assert.ok(labels.includes("BP measurement timeout"));
    }
  },
  {
    name: "parse failure disconnects and does not save",
    async fn() {
      const { ble, loaded } = await setupCollector({ bonded: true });
      ble.measurementChar.emitValue([0x02, 120, 0, 80, 0, 93, 0, 0xEA]);
      assert.strictEqual(loaded.saved.length, 0);
      assert.strictEqual(ble.device.disconnectCalls, 1);
      const labels = labelsFromLayout(loaded.layouts[loaded.layouts.length - 1]);
      assert.ok(labels.includes("ERROR!"));
      assert.ok(labels.some(label => /Truncated BP measurement/.test(label)));
    }
  },
  {
    name: "unexpected disconnect before measurement exits cleanly",
    async fn() {
      const { ble, loaded } = await setupCollector({ bonded: true });
      ble.device.emitDisconnect("link loss");
      assert.strictEqual(loaded.saved.length, 0);
      const labels = labelsFromLayout(loaded.layouts[loaded.layouts.length - 1]);
      assert.ok(labels.includes("ERROR!"));
      assert.ok(labels.includes("BP disconnected"));
      loaded.timers.runByMs(3000);
      assert.strictEqual(loaded.loads.length, 1);
    }
  }
];
