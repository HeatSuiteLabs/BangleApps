const assert = require("assert");
const loader = require("../helpers/module_loader");
const fakeStorage = require("../helpers/fake_storage");
const fakeBLE = require("../helpers/fake_ble");

function tick() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function createTimers(options) {
  const reconnectTimers = [];
  options = options || {};
  return {
    setTimeout(fn, ms) {
      if (ms === 2000 || ms === 3000) {
        Promise.resolve().then(fn);
        return -1;
      }
      if (options.manualReconnect && (ms === 5000 || ms === 10000 || ms === 30000)) {
        const timer = { fn, active: true };
        reconnectTimers.push(timer);
        return timer;
      }
      return setTimeout(fn, ms);
    },
    clearTimeout(id) {
      if (id && id.fn) {
        id.active = false;
        return;
      }
      if (id !== -1) clearTimeout(id);
    },
    runNextReconnect() {
      const timer = reconnectTimers.shift();
      if (timer && timer.active) Promise.resolve().then(timer.fn);
    },
    hasReconnect() {
      return reconnectTimers.some(timer => timer.active);
    }
  };
}

function createLoadedBLE(options) {
  options = options || {};
  const protocol = loader.create().require("coretemp.protocol");
  const env = fakeBLE.create(protocol, options.fakeBLE);
  const emitted = [];
  const Bangle = {
    _PWR: {
      CORESensor: ["test"]
    },
    emit(name, data) {
      emitted.push({ name, data });
    }
  };
  const timers = createTimers(options.timers);
  const storage = fakeStorage.create({
    "coretemp.json": {
      btid: "core-1"
    }
  });
  const loaded = loader.create({
    storage,
    globals: {
      Bangle,
      NRF: env.NRF,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    }
  });
  return {
    ble: loaded.require("coretemp.ble"),
    protocol,
    env,
    Bangle,
    emitted,
    timers
  };
}

async function drain() {
  for (let i = 0; i < 20; i++) await tick();
}

module.exports = [
  {
    name: "connect discovers control point and write wrapper resolves indication",
    async fn() {
      const { ble, protocol, env } = createLoadedBLE();
      ble.init();
      await ble.connect();
      assert.strictEqual(env.controlPointChar.notificationsStarted, true);

      const response = ble.writeControlPoint(protocol.OPCODES.HRM_SCAN_ANT_COUNT, [], {
        timeoutMs: 200
      });
      await tick();
      assert.deepStrictEqual(env.controlPointChar.writes, [[protocol.OPCODES.HRM_SCAN_ANT_COUNT]]);
      env.controlPointChar.emitValue([0x80, protocol.OPCODES.HRM_SCAN_ANT_COUNT, 0x01, 3]);
      const result = await response;
      assert.strictEqual(result.requestOpCode, protocol.OPCODES.HRM_SCAN_ANT_COUNT);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(result.payload)), [3]);
    }
  },
  {
    name: "connect accepts normalized uppercase CORE UUIDs",
    async fn() {
      const { ble, protocol, env } = createLoadedBLE({
        fakeBLE: { uppercaseUuids: true }
      });
      ble.init();
      await ble.connect();
      assert.strictEqual(env.controlPointChar.notificationsStarted, true);

      const response = ble.writeControlPoint(protocol.OPCODES.HRM_PAIRED_COUNT, [], {
        timeoutMs: 200
      });
      await tick();
      env.controlPointChar.emitValue([0x80, protocol.OPCODES.HRM_PAIRED_COUNT, 0x01, 0]);
      assert.strictEqual((await response).requestOpCode, protocol.OPCODES.HRM_PAIRED_COUNT);
    }
  },
  {
    name: "connect accepts standard health thermometer temperature without control point",
    async fn() {
      const { ble, protocol, env, emitted } = createLoadedBLE({
        fakeBLE: { healthThermometerOnly: true }
      });
      ble.init();
      await ble.connect();
      assert.strictEqual(ble.getStatus().connected, true);
      await assert.rejects(
        ble.writeControlPoint(protocol.OPCODES.HRM_PAIRED_COUNT, [], { timeoutMs: 20 }),
        /not connected/
      );

      env.healthThermometerChar.emitValue([0x00, 0x77, 0x01, 0x00, 0xFF]);

      assert.strictEqual(emitted.length, 1);
      assert.strictEqual(emitted[0].name, "CORESensor");
      assert.strictEqual(emitted[0].data.core, 37.5);
      assert.strictEqual(emitted[0].data.profile, "health_thermometer");
    }
  },
  {
    name: "connect prefers custom CORE temperature when both profiles are present",
    async fn() {
      const { ble, env } = createLoadedBLE({
        fakeBLE: { includeHealthThermometer: true }
      });
      ble.init();
      await ble.connect();

      assert.strictEqual(env.tempChar.notificationsStarted, true);
      assert.strictEqual(env.healthThermometerChar.notificationsStarted, undefined);
    }
  },
  {
    name: "discovery mismatch keeps background reconnect scheduled",
    async fn() {
      const { ble, timers } = createLoadedBLE({
        fakeBLE: { includeCoreCharacteristics: false },
        timers: { manualReconnect: true }
      });
      ble.init();
      await assert.rejects(
        ble.connect(),
        /Runtime discovery missing required CORE characteristics: missing/
      );
      assert.strictEqual(ble.getStatus().reconnectScheduled, true);

      timers.runNextReconnect();
      await drain();

      const status = ble.getStatus();
      assert.strictEqual(status.reconnectScheduled, true);
      assert.strictEqual(status.desiredConnected, true);
      assert.strictEqual(status.state, "reconnect_wait");
    }
  },
  {
    name: "mismatched indication is discarded until matching opcode arrives",
    async fn() {
      const { ble, protocol, env } = createLoadedBLE();
      ble.init();
      await ble.connect();
      const response = ble.writeControlPoint(protocol.OPCODES.HRM_PAIRED_COUNT, [], {
        timeoutMs: 200
      });
      await tick();
      env.controlPointChar.emitValue([0x80, protocol.OPCODES.HRM_SCAN_ANT_COUNT, 0x01, 7]);
      await tick();
      env.controlPointChar.emitValue([0x80, protocol.OPCODES.HRM_PAIRED_COUNT, 0x01, 1]);
      assert.strictEqual((await response).payload[0], 1);
    }
  },
  {
    name: "disconnect cancels active control point request",
    async fn() {
      const { ble, protocol, env, Bangle } = createLoadedBLE();
      ble.init();
      await ble.connect();
      const response = ble.writeControlPoint(protocol.OPCODES.HRM_PAIRED_COUNT, [], {
        timeoutMs: 500
      });
      await tick();
      Bangle._PWR.CORESensor = [];
      env.device.emitDisconnect("drop");
      await assert.rejects(response, /CORE transport closed: disconnect/);
    }
  },
  {
    name: "write wrapper rejects when control point is not connected",
    async fn() {
      const { ble, protocol } = createLoadedBLE();
      ble.init();
      await assert.rejects(
        ble.writeControlPoint(protocol.OPCODES.HRM_PAIRED_COUNT, [], { timeoutMs: 20 }),
        /not connected/
      );
    }
  }
];
