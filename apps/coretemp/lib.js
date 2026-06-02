exports.enable = () => {
  var settings = require("Storage").readJSON("coretemp.json", 1) || {};
  let log = function () { };
  let logBuffer = [];
  let logFlushInterval;
  const LOG_MAX_LINES = 200;
  const CORE_SERVICE_UUID = "00002100-5b1e-4347-b07c-97b514dae121";
  const CORE_TEMP_UUID = "00002101-5b1e-4347-b07c-97b514dae121";
  const CORE_CONTROL_POINT_UUID = "00002102-5b1e-4347-b07c-97b514dae121";

  // Runtime BLE state. Keep these fields local to this module so apps only
  // interact through Bangle.setCORESensorPower and the exported helpers below.
  let gatt;
  let device;
  let characteristics = [];
  let controlPointChar;
  let initInProgress = false;
  let reconnectTimer;

  // Control point command state. Only one request can wait for a response at a
  // time, and controlPointQueue enforces that ordering.
  let controlPointQueue = Promise.resolve();
  let activeControlPointRequest;

  let flushLog = function () {
    if (logBuffer.length === 0) return;
    while (logBuffer.length > LOG_MAX_LINES) logBuffer.shift();
    var lines = logBuffer.join("\n") + "\n";
    try {
      var f = require("Storage").open("coretemp.log", "a");
      f.write(lines);
    } catch (e) {
      // ignore storage write failures
    }
    logBuffer = [];
  };

  Bangle.enableCORESensorLog = function () {
    log = function (text, param) {
      let logline = new Date().toISOString() + " - " + text;
      if (param !== undefined) logline += ": " + JSON.stringify(param);
      print(logline);
      logBuffer.push(logline);
    };
    if (!logFlushInterval) logFlushInterval = setInterval(flushLog, 30000);
  };

  let waitingPromise = function (timeout) {
    return new Promise(function (resolve) {
      log("Start waiting for " + timeout);
      setTimeout(() => {
        log("Done waiting for " + timeout);
        resolve();
      }, timeout);
    });
  };

  let supportedCharacteristics = {
    "00002101-5b1e-4347-b07c-97b514dae121": {
      handler: function (dv) {
        log(dv);
        let index = 0;
        let flags = dv.getUint8(index++);
        let coreTemp = dv.getInt16(index, true) / 100.0;
        index += 2;
        let skinTemp = dv.getInt16(index, true) / 100.0;
        index += 2;
        let coreReserved = dv.getInt16(index, true);
        index += 2;
        let qualityAndState = dv.getUint8(index++);
        let heartRate = dv.getUint8(index++);
        let heatStrainIndex = dv.getUint8(index) / 10.0;
        let dataQuality = qualityAndState & 0x07;
        let hrState = (qualityAndState >> 4) & 0x03;
        let data = {
          core: coreTemp,
          skin: skinTemp,
          unit: (flags & 0b00001000) ? "F" : "C",
          hr: heartRate,
          heatflux: coreReserved,
          hsi: heatStrainIndex,
          battery: 0,
          dataQuality: dataQuality,
          hrState: hrState
        };
        if (lastReceivedData.hasOwnProperty("0x180f")) {
          data.battery = lastReceivedData["0x180f"]["0x2a19"];
        }
        log("data", data);
        Bangle.emit("CORESensor", data);
      }
    },
    "00002102-5b1e-4347-b07c-97b514dae121": {
      handler: function (dv) {
        log("Control point response", dataViewToArray(dv));
        handleControlPointResponse(dv);
      }
    },
    "0x2a19": {
      handler: function (dv) {
        if (!lastReceivedData["0x180f"]) lastReceivedData["0x180f"] = {};
        log("Got battery", dv);
        lastReceivedData["0x180f"]["0x2a19"] = dv.getUint8(0);
      }
    }
  };

  let lastReceivedData = {};

  let supportedServices = [
    CORE_SERVICE_UUID,
    "0x180f",
    "0x1809"
  ];

  let supportedCharacteristicUUIDs = [
    CORE_TEMP_UUID,
    CORE_CONTROL_POINT_UUID,
    "0x2a19"
  ];

  Bangle.isCORESensorOn = function () {
    return (Bangle._PWR && Bangle._PWR.CORESensor && Bangle._PWR.CORESensor.length > 0);
  };

  Bangle.isCORESensorConnected = function () {
    return gatt && gatt.connected;
  };

  // Control point command/response handling

  let dataViewToArray = function (dv) {
    let response = [];
    for (let i = 0; i < dv.byteLength; i++) response.push(dv.getUint8(i));
    return response;
  };

  // Control Point responses are shared by all opcode writes. Keep one active
  // request and only resolve it when the response echoes the requested opcode.
  let handleControlPointResponse = function (dv) {
    if (!activeControlPointRequest || dv.byteLength < 3) return;
    let requestOpCode = dv.getUint8(1);
    if (requestOpCode !== activeControlPointRequest.opCode) return;
    let resultCode = dv.getUint8(2);
    let request = activeControlPointRequest;
    activeControlPointRequest = undefined;
    if (request.timeout) clearTimeout(request.timeout);
    if (resultCode === 0x01) {
      request.resolve(dataViewToArray(dv));
    } else {
      request.reject(new Error("Control point error code: " + resultCode));
    }
  };

  let addNotificationHandler = function (characteristic) {
    if (!supportedCharacteristics[characteristic.uuid]) return;
    if (characteristic._coretempHandlerAdded) return;
    log("Setting notification handler");
    characteristic._coretempHandlerAdded = true;
    characteristic.on('characteristicvaluechanged', (ev) => supportedCharacteristics[characteristic.uuid].handler(ev.target.value));
  };

  // Characteristic cache and attachment

  let characteristicsFromCache = function (device) {
    // Espruino permits restoring characteristics from saved handles, which
    // avoids a full GATT discovery on every boot. If these handles go stale,
    // initCORESensor deletes the cache and performs discovery once.
    let service = { device: device };
    log("Read cached characteristics");
    let cache = settings.cache;
    if (!cache || !cache.characteristics) return [];
    let restored = [];
    for (let c in cache.characteristics) {
      let cached = cache.characteristics[c];
      let r = new BluetoothRemoteGATTCharacteristic();
      log("Restoring characteristic ", cached);
      r.handle_value = cached.handle;
      r.uuid = cached.uuid;
      r.properties = {};
      r.properties.notify = cached.notify;
      r.properties.read = cached.read;
      r.properties.write = cached.write;
      r.service = service;
      addNotificationHandler(r);
      restored.push(r);
    }
    return restored;
  };

  let clearReconnectTimer = function () {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };

  let cleanupGatt = function () {
    flushLog();
    activeControlPointRequest = undefined;
    controlPointChar = undefined;
    try {
      if (gatt && gatt.connected) gatt.disconnect();
    } catch (e) { }
    gatt = null;
    device = undefined;
    characteristics = [];
  };

  let saveCache = function (chars) {
    var s = require("Storage").readJSON("coretemp.json", 1) || {};
    var cache = {};
    cache.characteristics = {};
    for (var c of chars) {
      cache.characteristics[c.uuid] = {
        handle: c.handle_value,
        uuid: c.uuid,
        notify: c.properties.notify,
        read: c.properties.read,
        write: c.properties.write
      };
    }
    s.cache = cache;
    settings.cache = cache;
    require("Storage").writeJSON("coretemp.json", s);
  };

  let deleteCache = function () {
    var s = require("Storage").readJSON("coretemp.json", 1) || {};
    delete s.cache;
    delete settings.cache;
    require("Storage").writeJSON("coretemp.json", s);
  };

  let hasRequiredCoreCharacteristics = function (chars) {
    var uuids = chars.map(function (c) { return c.uuid; });
    return uuids.indexOf(CORE_TEMP_UUID) >= 0 &&
      uuids.indexOf(CORE_CONTROL_POINT_UUID) >= 0;
  };

  let createCharacteristicPromise = function (newCharacteristic) {
    log("Create characteristic promise", newCharacteristic);
    if (newCharacteristic.uuid === CORE_CONTROL_POINT_UUID) controlPointChar = newCharacteristic;
    let result = Promise.resolve();
    if (newCharacteristic.properties && newCharacteristic.properties.read) {
      result = result.then(() => {
        log("Reading data", newCharacteristic);
        return newCharacteristic.readValue().then((data) => {
          if (supportedCharacteristics[newCharacteristic.uuid] && supportedCharacteristics[newCharacteristic.uuid].handler) {
            supportedCharacteristics[newCharacteristic.uuid].handler(data);
          }
        });
      });
    }
    if (newCharacteristic.properties && newCharacteristic.properties.notify) {
      result = result.then(() => {
        log("Starting notifications", newCharacteristic);
        return newCharacteristic.startNotifications()
          .then(() => log("Notifications started", newCharacteristic))
          .then(() => waitingPromise(3000));
      });
    }
    return result.then(() => log("Handled characteristic", newCharacteristic));
  };

  let attachCharacteristicPromise = function (promise, characteristic) {
    return promise.then(() => {
      log("Handling characteristic:", characteristic);
      addNotificationHandler(characteristic);
      return createCharacteristicPromise(characteristic);
    });
  };

  let attachCharacteristics = function () {
    // Attach notifications/read initial values serially. BLE stacks on small
    // devices are more reliable when we avoid overlapping GATT operations.
    let characteristicsPromise = Promise.resolve();
    for (let characteristic of characteristics) {
      characteristicsPromise = attachCharacteristicPromise(characteristicsPromise, characteristic);
    }
    return characteristicsPromise.then(() => {
      if (!hasRequiredCoreCharacteristics(characteristics)) {
        throw new Error("Missing required CORE characteristics");
      }
      log("Connection established, waiting for notifications");
    });
  };

  let discoverCharacteristics = function (g) {
    // Discovery is the fallback path for first pairing or stale cached handles.
    // The rebuilt handles are persisted only after notification setup succeeds.
    characteristics = [];
    controlPointChar = undefined;
    log("Runtime discovery: getting services");
    return g.getPrimaryServices().then(function (services) {
      log("Runtime discovery: got services", services.length);
      var result = Promise.resolve();
      for (var si = 0; si < services.length; si++) {
        var service = services[si];
        if (supportedServices.indexOf(service.uuid) < 0) continue;
        log("Runtime discovery: supporting service", service.uuid);
        (function (svc) {
          result = result.then(function () {
            return svc.getCharacteristics().then(function (chars) {
              for (var ci = 0; ci < chars.length; ci++) {
                var c = chars[ci];
                if (supportedCharacteristicUUIDs.indexOf(c.uuid) < 0) continue;
                log("Runtime discovery: supporting characteristic", c.uuid);
                characteristics.push(c);
              }
            });
          });
        })(service);
      }
      return result;
    }).then(function () {
      if (!hasRequiredCoreCharacteristics(characteristics)) {
        throw new Error("Runtime discovery missing required CORE characteristics");
      }
      return attachCharacteristics();
    }).then(function () {
      log("Runtime discovery: complete, saving cache");
      saveCache(characteristics);
    });
  };

  // Connection lifecycle

  let scheduleReconnect = function () {
    // Never let an old disconnect callback reconnect after every app has
    // released CORESensor power.
    if (reconnectTimer || !Bangle.isCORESensorOn()) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = undefined;
      if (Bangle.isCORESensorOn()) initCORESensor();
    }, 5000);
  };

  let onDisconnect = function (reason) {
    initInProgress = false;
    log("Disconnect: " + reason);
    if (Bangle.isCORESensorOn()) {
      scheduleReconnect();
    } else {
      clearReconnectTimer();
    }
  };

  let initCORESensor = function () {
    settings = require("Storage").readJSON("coretemp.json", 1) || {};
    // Runtime BLE should only start when an app/widget/recorder has explicitly
    // requested power via Bangle.setCORESensorPower.
    if (!Bangle.isCORESensorOn()) {
      log("CORESensor has no power request, quitting");
      return;
    }
    if (!settings.btid) {
      log("CORESensor not paired, quitting");
      return;
    }
    if (initInProgress) {
      log("CORESensor init already in progress, quitting");
      return;
    }
    initInProgress = true;
    NRF.setScan();
    let promise;
    let filters;
    let usedCache = false;

    if (!device) {
      log("Configured device id ", settings.btid);
      filters = [{ id: settings.btid }];
      log("Requesting device with filters", filters);
      try {
        promise = NRF.requestDevice({ filters: filters, active: true });
      } catch (e) {
        log("Error during initial request:", e);
        onDisconnect(e);
        return;
      }
      promise = promise.then((d) => {
        log("Wait after request");
        return waitingPromise(2000).then(() => Promise.resolve(d));
      });
      promise = promise.then((d) => {
        log("Got device", d);
        d.on('gattserverdisconnected', onDisconnect);
        device = d;
      });
    } else {
      promise = Promise.resolve();
      log("Reuse device", device);
    }

    promise = promise.then(() => {
      gatt = device.gatt;
      return Promise.resolve(gatt);
    });

    promise = promise.then((gatt) => {
      if (!Bangle.isCORESensorOn()) throw new Error("CORESensor power off before connect");
      if (!gatt.connected) {
        log("Connecting...");
        return gatt.connect()
          .then(function () { log("Connected."); })
          .then(() => {
            log("Wait after connect");
            return waitingPromise(2000);
          });
      }
    });

    promise.then(() => {
      if (!characteristics || characteristics.length === 0) {
        characteristics = characteristicsFromCache(device);
        usedCache = characteristics.length > 0;
      }
      if (characteristics && characteristics.length > 0) return attachCharacteristics();
      log("No cached characteristics, performing runtime discovery");
      return discoverCharacteristics(gatt);
    }).catch((e) => {
      // Cached handles can change after firmware/device updates. On the first
      // attach failure, throw away the cache and rebuild it from live services.
      if (!usedCache) throw e;
      log("Cached characteristics failed, rebuilding cache:", e);
      deleteCache();
      characteristics = [];
      controlPointChar = undefined;
      return discoverCharacteristics(gatt);
    }).then(() => {
      initInProgress = false;
    }).catch((e) => {
      log("Error:", e);
      cleanupGatt();
      onDisconnect(e);
    });
  };

  Bangle.CORESensorWriteControlPoint = function (opCode, params) {
    params = params || [];
    let write = function () {
      return new Promise(function (resolve, reject) {
        if (!controlPointChar || !gatt || !gatt.connected) {
          reject(new Error("CORE control point is not connected"));
          return;
        }
        let data = new Uint8Array([opCode].concat(params));
        let timeout = setTimeout(function () {
          if (activeControlPointRequest && activeControlPointRequest.opCode === opCode) {
            activeControlPointRequest = undefined;
          }
          reject(new Error("CORE control point timeout for opcode " + opCode));
        }, 10000);
        activeControlPointRequest = {
          opCode: opCode,
          resolve: resolve,
          reject: reject,
          timeout: timeout
        };
        controlPointChar.writeValue(data).then(function () {
          log("Sent control point opcode", opCode);
        }).catch(function (e) {
          if (activeControlPointRequest && activeControlPointRequest.opCode === opCode) {
            activeControlPointRequest = undefined;
          }
          clearTimeout(timeout);
          reject(e);
        });
      });
    };
    // The CORE control point accepts command/response traffic on one
    // characteristic, so serialize writes to keep responses attributable.
    controlPointQueue = controlPointQueue.then(write, write);
    return controlPointQueue;
  };

  Bangle.setCORESensorPower = function (isOn, app) {
    if (!app) app = "?";
    log("setCORESensorPower ->", isOn, app);
    if (Bangle._PWR === undefined) Bangle._PWR = {};
    if (Bangle._PWR.CORESensor === undefined) Bangle._PWR.CORESensor = [];
    if (isOn && !Bangle._PWR.CORESensor.includes(app)) Bangle._PWR.CORESensor.push(app);
    if (!isOn && Bangle._PWR.CORESensor.includes(app)) Bangle._PWR.CORESensor = Bangle._PWR.CORESensor.filter(a => a != app);
    isOn = Bangle._PWR.CORESensor.length;
    if (isOn) {
      log("setCORESensorPower on" + app);
      if (!Bangle.isCORESensorConnected()) initCORESensor();
    } else {
      log("setCORESensorPower turning off ", app);
      clearReconnectTimer();
      initInProgress = false;
      if (gatt && gatt.connected) {
        log("CORESensor: Disconnect with gatt", gatt);
        try {
          gatt.disconnect().then(() => {
            log("CORESensor: Successful disconnect");
          }).catch((e) => {
            log("CORESensor: Error during disconnect promise", e);
          });
        } catch (e) {
          log("CORESensor: Error during disconnect attempt", e);
        }
      }
    }
  };

  E.on("kill", function () {
    flushLog();
    clearReconnectTimer();
    if (logFlushInterval) {
      clearInterval(logFlushInterval);
      logFlushInterval = null;
    }
    if (gatt) {
      log("CORESensor connected - disconnecting");
      try { gatt.disconnect(); } catch (e) {
        log("CORESensor disconnect error", e);
      }
      gatt = undefined;
    }
  });
};
