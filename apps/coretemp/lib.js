exports.enable = () => {
  var settings = require("Storage").readJSON("coretemp.json", 1) || {};
  let log = function () { };//print
  let logBuffer = [];
  let logFlushInterval;
  const LOG_MAX_LINES = 200;

  let flushLog = function () {
    if (logBuffer.length === 0) return;
    while (logBuffer.length > LOG_MAX_LINES) logBuffer.shift();
    var lines = logBuffer.join("\n") + "\n";
    try {
      var f = require("Storage").open("coretemp.log", "a");
      f.write(lines);
    } catch (e) {
      // silently ignore write errors
    }
    logBuffer = [];
  };

  Bangle.enableCORESensorLog = function () {
    log = function (text, param) {
      let logline = new Date().toISOString() + " - " + text;
      if (param) logline += ": " + JSON.stringify(param);
      print(logline);
      logBuffer.push(logline);
    };
    if (!logFlushInterval) {
      logFlushInterval = setInterval(flushLog, 30000);
    }
  };
  let gatt;
  let device;
  let characteristics;
  let blockInit = false;
  let waitingPromise = function (timeout) {
    return new Promise(function (resolve) {
      log("Start waiting for " + timeout);
      setTimeout(() => {
        log("Done waiting for " + timeout);
        resolve();
      }, timeout);
    });
  };


  let addNotificationHandler = function (characteristic) {
      log("Setting notification handler"/*supportedCharacteristics[characteristic.uuid].handler*/);
      characteristic.on('characteristicvaluechanged', (ev) => supportedCharacteristics[characteristic.uuid].handler(ev.target.value));
    };
    let characteristicsFromCache = function (device) {
      let service = { device: device }; // fake a BluetoothRemoteGATTService
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
        r.service = service;
        addNotificationHandler(r);
        log("Restored characteristic: ", r);
        restored.push(r);
      }
      return restored;
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
          let coreReserved = dv.getInt16(index, true); //caleraGT only with firmware decryption provided by Greenteg
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
          log(dv);//just log the response, handle write and responses in another Promise Function (Bangle.CORESensorSendOpCode)
        }
      },
      "0x2a19": {
        //Battery
        handler: function (dv) {
          if (!lastReceivedData["0x180f"]) lastReceivedData["0x180f"] = {};
          log("Got battery", dv);
          lastReceivedData["0x180f"]["0x2a19"] = dv.getUint8(0);
        }
      }
    };
    let lastReceivedData = {
    };

    Bangle.isCORESensorOn = function () {
      return (Bangle._PWR && Bangle._PWR.CORESensor && Bangle._PWR.CORESensor.length > 0);
    };

    Bangle.isCORESensorConnected = function () {
      return gatt && gatt.connected;
    };

    let cleanupGatt = function () {
      flushLog();
      try {
        if (gatt && gatt.connected) gatt.disconnect();
      } catch (e) {}
      gatt = null;
      device = undefined;
      characteristics = [];
    };

    };

    let supportedServices = [
      "00002100-5b1e-4347-b07c-97b514dae121",
      "0x180f",
      "0x1809",
    ];

    let supportedCharacteristicUUIDs = [
      "00002101-5b1e-4347-b07c-97b514dae121",
      "00002102-5b1e-4347-b07c-97b514dae121",
      "0x2a19",
    ];

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
      require("Storage").writeJSON("coretemp.json", s);
    };

    let hasRequiredCoreCharacteristics = function (chars) {
      var uuids = chars.map(function (c) { return c.uuid; });
      return uuids.indexOf("00002101-5b1e-4347-b07c-97b514dae121") >= 0 &&
             uuids.indexOf("00002102-5b1e-4347-b07c-97b514dae121") >= 0;
    };

    let discoverCharacteristics = function (g) {
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
                var cr = Promise.resolve();
                for (var ci = 0; ci < chars.length; ci++) {
                  var c = chars[ci];
                  if (supportedCharacteristicUUIDs.indexOf(c.uuid) < 0) continue;
                  log("Runtime discovery: supporting characteristic", c.uuid);
                  characteristics.push(c);
                  addNotificationHandler(c);
                  cr = attachCharacteristicPromise(cr, c);
                }
                return cr;
              });
            });
          })(service);
        }
        return result;
      }).then(function () {
        log("Runtime discovery: complete, saving cache");
        if (!hasRequiredCoreCharacteristics(characteristics)) {
          throw new Error("Runtime discovery missing required CORE characteristics");
        }
        saveCache(characteristics);
      });
    };

    let reconnectTimer;

    let scheduleReconnect = function () {
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(function () {
        reconnectTimer = undefined;
        initCORESensor();
      }, 5000);
    };

    let onDisconnect = function (reason) {
      blockInit = false;
      log("Disconnect: " + reason);
      if (Bangle.isCORESensorOn()) {
        scheduleReconnect();
      }
    };
    let createCharacteristicPromise = function (newCharacteristic) {
      log("Create characteristic promise", newCharacteristic);
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
          let startPromise = newCharacteristic.startNotifications().then(() => log("Notifications started", newCharacteristic));
          startPromise = startPromise.then(() => {
            return waitingPromise(3000);
          });
          return startPromise;
        });
      }
      return result.then(() => log("Handled characteristic", newCharacteristic));
    };

    let attachCharacteristicPromise = function (promise, characteristic) {
      return promise.then(() => {
        log("Handling characteristic:", characteristic);
        return createCharacteristicPromise(characteristic);
      });
    };
    let initCORESensor = function () {
      settings = require("Storage").readJSON("coretemp.json", 1) || {};
      if (!settings.btid) {
        log("CORESensor not paired, quitting");
        return;
      }
      if (blockInit) {
        log("CORESensor already turned on by another app, quitting");
        return;
      }
      blockInit = true;
      NRF.setScan();
      let promise;
      let filters;
      let rebuildAttempted = false;

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
        if (!gatt.connected) {
          log("Connecting...");
          let connectPromise = gatt.connect().then(function () {
            log("Connected.");
          });
          connectPromise = connectPromise.then(() => {
            log("Wait after connect");
            return waitingPromise(2000);
          });
          return connectPromise;
        } else {
          return Promise.resolve();
        }
      });

      promise = promise.then(() => {
        if (!characteristics || characteristics.length == 0) {
          characteristics = characteristicsFromCache(device);
        }
        if (!characteristics || characteristics.length == 0) {
          if (rebuildAttempted) {
            log("Cache already rebuilt this cycle, not retrying discovery");
            return;
          }
          log("No cached characteristics, performing runtime discovery");
          rebuildAttempted = true;
          return discoverCharacteristics(gatt).then(function () {
            log("Runtime discovery succeeded, now have " + (characteristics ? characteristics.length : 0) + " characteristics");
          });
        }
        let characteristicsPromise = Promise.resolve();
        for (let characteristic of characteristics) {
          characteristicsPromise = attachCharacteristicPromise(characteristicsPromise, characteristic, true);
        }

        return characteristicsPromise.then(() => {
          if (characteristics && characteristics.length > 0) {
            log("Connection established, waiting for notifications");
          } else {
            log("Connection established but no cached characteristics loaded");
          }
        });
      }).catch((e) => {
        log("Error:", e);
        if (rebuildAttempted) {
          var s = require("Storage").readJSON("coretemp.json", 1) || {};
          delete s.cache;
          require("Storage").writeJSON("coretemp.json", s);
        }
        cleanupGatt();
        onDisconnect(e);
      });
    };
    Bangle.setCORESensorPower = function (isOn, app) {
      // Do app power handling
      if (!app) app = "?";
      log("setCORESensorPower ->", isOn, app);
      if (Bangle._PWR === undefined) Bangle._PWR = {};
      if (Bangle._PWR.CORESensor === undefined) Bangle._PWR.CORESensor = [];
      if (isOn && !Bangle._PWR.CORESensor.includes(app)) Bangle._PWR.CORESensor.push(app);
      if (!isOn && Bangle._PWR.CORESensor.includes(app)) Bangle._PWR.CORESensor = Bangle._PWR.CORESensor.filter(a => a != app);
      isOn = Bangle._PWR.CORESensor.length;
      // so now we know if we're really on
      if (isOn) {
        log("setCORESensorPower on" + app);
        if (!Bangle.isCORESensorConnected()) initCORESensor();
      } else { // being turned off!
        log("setCORESensorPower turning off ", app);
        if (gatt) {
          if (gatt.connected) {
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
      }
    };

    // disconnect when swapping apps
    E.on("kill", function () {
      flushLog();
      if (logFlushInterval) { clearInterval(logFlushInterval); logFlushInterval = null; }
      if (gatt) {
        log("CORESensor connected - disconnecting");
        try { gatt.disconnect(); } catch (e) {
          log("CORESensor disconnect error", e);
        }
        gatt = undefined;
      }
    });
};