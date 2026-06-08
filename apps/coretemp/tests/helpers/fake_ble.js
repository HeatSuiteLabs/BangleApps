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

exports.create = function createFakeBLE(protocol, options) {
  options = options || {};
  const disconnectHandlers = [];
  let getPrimaryServicesCalls = 0;
  const coreServiceUuid = options.uppercaseUuids ? protocol.CORE_SERVICE_UUID.toUpperCase() : protocol.CORE_SERVICE_UUID;
  const tempUuid = options.uppercaseUuids ? protocol.CORE_TEMP_UUID.toUpperCase() : protocol.CORE_TEMP_UUID;
  const controlPointUuid = options.uppercaseUuids ? protocol.CORE_CONTROL_POINT_UUID.toUpperCase() : protocol.CORE_CONTROL_POINT_UUID;
  const tempChar = createCharacteristic(tempUuid, { notify: true });
  const controlPointChar = createCharacteristic(controlPointUuid, {
    indicate: true,
    write: true
  });
  const batteryChar = createCharacteristic("0x2a19", { read: true });
  const healthThermometerChar = createCharacteristic("00002a1c-0000-1000-8000-00805f9b34fb", {
    indicate: true
  });
  const coreCharacteristics = options.includeCoreCharacteristics === false ?
    [batteryChar] :
    [tempChar, controlPointChar];
  const services = options.healthThermometerOnly ? [{
    uuid: "00001809-0000-1000-8000-00805f9b34fb",
    getCharacteristics() {
      return Promise.resolve([healthThermometerChar, batteryChar]);
    }
  }] : options.includeHealthThermometer ? [{
    uuid: "00001809-0000-1000-8000-00805f9b34fb",
    getCharacteristics() {
      return Promise.resolve([healthThermometerChar]);
    }
  }, {
    uuid: coreServiceUuid,
    getCharacteristics() {
      return Promise.resolve(coreCharacteristics);
    }
  }] : [{
    uuid: coreServiceUuid,
    getCharacteristics() {
      return Promise.resolve(coreCharacteristics);
    }
  }];
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
      getPrimaryServicesCalls++;
      return Promise.resolve(services);
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
    eraseBonds(callback) {
      options.eraseBondsCalls = (options.eraseBondsCalls || 0) + 1;
      if (options.eraseBondsError) throw options.eraseBondsError;
      if (callback) callback();
    },
    setScan() {},
    requestDevice() {
      return Promise.resolve(device);
    }
  };

  return {
    NRF,
    device,
    gatt,
    eraseBondsCalls() {
      return options.eraseBondsCalls || 0;
    },
    getPrimaryServicesCalls() {
      return getPrimaryServicesCalls;
    },
    tempChar,
    controlPointChar,
    healthThermometerChar
  };
};
