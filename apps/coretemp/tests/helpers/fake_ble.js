const dataview = require("./dataview");

function createCharacteristic(uuid, properties) {
  const handlers = {};
  const writes = [];
  return {
    uuid,
    properties: properties || {},
    writes,
    on(name, handler) {
      handlers[name] = handler;
    },
    startNotifications() {
      this.notificationsStarted = true;
      return Promise.resolve();
    },
    readValue() {
      return Promise.resolve(dataview.fromBytes([90]));
    },
    writeValue(value) {
      writes.push(Array.prototype.slice.call(value));
      return Promise.resolve();
    },
    emitValue(bytes) {
      handlers.characteristicvaluechanged({
        target: {
          value: dataview.fromBytes(bytes)
        }
      });
    }
  };
}

exports.create = function createFakeBLE(protocol) {
  const disconnectHandlers = [];
  const tempChar = createCharacteristic(protocol.CORE_TEMP_UUID, { notify: true });
  const controlPointChar = createCharacteristic(protocol.CORE_CONTROL_POINT_UUID, {
    indicate: true,
    write: true
  });
  const gatt = {
    connected: false,
    connect() {
      this.connected = true;
      return Promise.resolve();
    },
    disconnect() {
      this.connected = false;
    },
    getPrimaryServices() {
      return Promise.resolve([{
        uuid: protocol.CORE_SERVICE_UUID,
        getCharacteristics() {
          return Promise.resolve([tempChar, controlPointChar]);
        }
      }]);
    }
  };
  const device = {
    id: "core-1",
    name: "CORE",
    gatt,
    on(name, handler) {
      if (name === "gattserverdisconnected") disconnectHandlers.push(handler);
    },
    emitDisconnect(reason) {
      disconnectHandlers.forEach(handler => handler(reason));
    }
  };
  const NRF = {
    setScan() {},
    requestDevice() {
      return Promise.resolve(device);
    }
  };

  return {
    NRF,
    device,
    gatt,
    tempChar,
    controlPointChar
  };
};
