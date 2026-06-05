/* eslint-env node */

function dataViewFromBytes(bytes) {
  const arr = Uint8Array.from(bytes);
  return new DataView(arr.buffer);
}

function createCharacteristic(uuid, options) {
  options = options || {};
  const handlers = {};
  let notifyAttempts = 0;
  const characteristic = {
    uuid,
    writes: [],
    notificationsStarted: false,
    on(name, handler) {
      handlers[name] = handler;
    },
    writeValue(value) {
      if (options.writeReject) return Promise.reject(options.writeReject);
      this.writes.push(Array.prototype.slice.call(value));
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
  const timeChar = options.timeChar === false ? undefined :
    createCharacteristic("2A08", { writeReject: options.timeWriteReject });
  const measurementChar = options.measurementChar === false ? undefined :
    createCharacteristic("2A35", {
      notifyReject: options.notifyReject,
      notifyRejectCount: options.notifyRejectCount
    });
  return {
    timeChar,
    measurementChar,
    getCharacteristic(uuid) {
      if (options.characteristicRejects && options.characteristicRejects[uuid]) {
        return Promise.reject(options.characteristicRejects[uuid]);
      }
      if (uuid === "2A08" && timeChar) return Promise.resolve(timeChar);
      if (uuid === "2A35" && measurementChar) return Promise.resolve(measurementChar);
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
      disconnectHandlers.forEach(handler => handler(reason));
    }
  };
  const NRF = {
    connectCalls: [],
    connect(id) {
      this.connectCalls.push(id);
      if (options.connectRejectCount && this.connectCalls.length <= options.connectRejectCount) {
        return Promise.reject(new Error("connect failed"));
      }
      if (options.connectReject) return Promise.reject(options.connectReject);
      return Promise.resolve(device);
    }
  };

  return {
    NRF,
    device,
    service,
    timeChar: service.timeChar,
    measurementChar: service.measurementChar
  };
}

module.exports = {
  create,
  createCharacteristic,
  createService,
  dataViewFromBytes
};
