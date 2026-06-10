/* eslint-env node */

function dataViewFromBytes(bytes) {
  const arr = Uint8Array.from(bytes);
  return new DataView(arr.buffer);
}

function bytesFromPayload(payload) {
  if (payload instanceof DataView) {
    const arr = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    return Array.from(arr);
  }
  if (payload instanceof ArrayBuffer) return Array.from(new Uint8Array(payload));
  if (ArrayBuffer.isView(payload)) return Array.from(payload);
  return Array.from(payload || []);
}

function createCharacteristic(uuid, options) {
  options = options || {};
  const handlers = {};
  let notifyAttempts = 0;
  const characteristic = {
    uuid,
    notificationsStarted: false,
    writes: [],
    on(name, handler) {
      handlers[name] = handler;
    },
    writeValue(payload) {
      if (options.writeReject) return Promise.reject(options.writeReject);
      this.writes.push(bytesFromPayload(payload));
      return Promise.resolve();
    },
    startNotifications() {
      notifyAttempts++;
      if (options.notifyRejectCount !== undefined) {
        if (notifyAttempts <= options.notifyRejectCount) {
          return Promise.reject(options.notifyReject || new Error("notify rejected"));
        }
      } else if (options.notifyReject) {
        return Promise.reject(options.notifyReject || new Error("notify rejected"));
      }
      this.notificationsStarted = true;
      return Promise.resolve();
    },
    emitValue(bytes) {
      if (!handlers.characteristicvaluechanged) {
        throw new Error("No characteristicvaluechanged handler registered");
      }
      handlers.characteristicvaluechanged({
        target: {
          value: dataViewFromBytes(bytes)
        }
      });
    }
  };
  return characteristic;
}

function createService(options) {
  options = options || {};
  const measurementChar = options.measurementChar === false ? undefined :
    createCharacteristic("2A35", {
      notifyReject: options.notifyReject,
      notifyRejectCount: options.notifyRejectCount
    });
  const dateTimeChar = options.dateTimeChar === false ? undefined :
    createCharacteristic("2A08", {
      writeReject: options.dateTimeWriteReject
    });
  return {
    measurementChar,
    dateTimeChar,
    getCharacteristic(uuid) {
      if (options.characteristicRejects && options.characteristicRejects[uuid]) {
        return Promise.reject(options.characteristicRejects[uuid]);
      }
      if (uuid === "2A35" && measurementChar) return Promise.resolve(measurementChar);
      if (uuid === "2A08" && dateTimeChar) return Promise.resolve(dateTimeChar);
      return Promise.reject(new Error("Missing characteristic " + uuid));
    }
  };
}

function create(options) {
  options = options || {};
  const service = options.service || createService(options);
  const disconnectHandlers = [];
  const deviceEventTarget = {
    on(name, handler) {
      if (name === "gattserverdisconnected") disconnectHandlers.push(handler);
    }
  };
  const device = {
    id: options.id || "bp-1",
    connected: true,
    device: deviceEventTarget,
    bondCalls: 0,
    disconnectCalls: 0,
    getSecurityStatus() {
      return { bonded: !!options.bonded };
    },
    startBonding() {
      this.bondCalls++;
      if (options.bondReject) return Promise.reject(options.bondReject);
      options.bonded = true;
      return Promise.resolve(true);
    },
    getPrimaryService(uuid) {
      if (options.serviceReject) return Promise.reject(options.serviceReject);
      if (uuid !== "1810") return Promise.reject(new Error("Unexpected service " + uuid));
      return Promise.resolve(service);
    },
    disconnect() {
      this.connected = false;
      this.disconnectCalls++;
    },
    emitDisconnect(reason) {
      this.connected = false;
      disconnectHandlers.forEach(handler => handler(reason));
    }
  };
  const NRF = {
    connectCalls: [],
    scanStopped: false,
    setScan() {
      this.scanStopped = true;
    },
    connect(id) {
      this.connectCalls.push(id);
      if (options.connectRejectCount && this.connectCalls.length <= options.connectRejectCount) {
        return Promise.reject(new Error("connect failed"));
      }
      if (options.connectReject) return Promise.reject(options.connectReject);
      device.connected = true;
      return Promise.resolve(device);
    }
  };

  return {
    NRF,
    device,
    service,
    measurementChar: service.measurementChar,
    dateTimeChar: service.dateTimeChar
  };
}

module.exports = {
  create,
  createCharacteristic,
  createService,
  bytesFromPayload,
  dataViewFromBytes
};
