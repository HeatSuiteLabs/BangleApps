var Layout = require("Layout");
const modHS = require('HSModule');
var layout;
var settings = modHS.getSettings();

var BP_SERVICE_UUID = "1810";
var BP_DATE_TIME_UUID = "2A08";
var BP_MEASUREMENT_UUID = "2A35";
var BP_MAX_ATTEMPTS = 3;
var BP_CONNECT_SETTLE_MS = 1000;
var BP_RETRY_DELAY_MS = 5000;
var BP_MEASUREMENT_TIMEOUT_MS = 120000;
var BP_INDICATION_IDLE_EXIT_MS = 2000;
var BP_EXIT_DELAY_MS = 3000;

function isBPSecurityError(e) {
  var msg = (e && e.message) ? e.message : String(e);
  msg = msg.toLowerCase();
  return msg.indexOf("security") >= 0 ||
    msg.indexOf("auth") >= 0 ||
    msg.indexOf("encrypt") >= 0 ||
    msg.indexOf("bond") >= 0 ||
    msg.indexOf("pair") >= 0 ||
    msg.indexOf("insufficient") >= 0;
}

function log() {
  if (!settings.DEBUG) return;
  var parts = [];
  for (var i = 0; i < arguments.length; i++) {
    parts.push(String(arguments[i]));
  }
  if (modHS.log) modHS.log(parts.join(" "));
  else console.log(parts.join(" "));
}

function showMessage(title, msg) {
  layout = new Layout({
    type: "v", c: [
      {
        type: "h", c: [
          { type: "txt", font: "6x8:2", label: title, fillx: 1, wrap: true },
        ]
      },
      {
        type: "h", c: [
          { type: "txt", font: "6x8:1", label: msg || "", fillx: 1, wrap: true },
        ]
      }
    ]
  });
  g.clear();
  layout.render();
}

function showWaiting(attempt) {
  var label = "Waiting...";
  if (attempt > 1) label = "Retry " + attempt + "/" + BP_MAX_ATTEMPTS;
  showMessage("Blood Pressure", label);
}

function showSavedResult(receivedData, savedCount) {
  var savedLabel = savedCount > 1 ? "Saved x" + savedCount : "Saved!";
  layout = new Layout({
    type: "v", c: [
      {
        type: "h", c: [
          { type: "txt", font: "12x20:2", label: receivedData.sbp, fillx: 1 },
          { type: "txt", font: "12x20:2", label: "/", fillx: 1 },
          { type: "txt", font: "12x20:2", label: receivedData.dbp, fillx: 1 }
        ]
      },
      {
        type: "h", c: [
          { type: "txt", font: "12x20:2", label: receivedData.hr === null ? "--" : receivedData.hr, fillx: 1 },
          { type: "txt", font: "12x20:2", label: "BPM", fillx: 1 },
        ]
      },
      {
        type: "h", c: [
          { type: "txt", font: "12x20:2", label: savedLabel, fillx: 1 }
        ]
      },
    ]
  });
  g.clear();
  layout.render();
}

function decodeSFloat16(raw) {
  raw = raw & 0xFFFF;
  if (raw === 0x07FE) return Infinity;
  if (raw === 0x0802) return -Infinity;
  if (raw === 0x07FF || raw === 0x0800 || raw === 0x0801) return null;

  var mantissa = raw & 0x0FFF;
  var exponent = raw >> 12;
  if (mantissa >= 0x0800) mantissa -= 0x1000;
  if (exponent >= 0x08) exponent -= 0x10;
  var value = mantissa * Math.pow(10, exponent);
  return Math.round(value * 1000000) / 1000000;
}

function requireBytes(data, index, count, label) {
  if (index + count > data.byteLength) {
    throw new Error("Truncated BP measurement: " + label);
  }
}

function readSFloat(data, index, label) {
  requireBytes(data, index, 2, label);
  return decodeSFloat16(data.getUint16(index, true));
}

function parseBPMeasurement(data, deviceId) {
  requireBytes(data, 0, 1, "flags");
  var flags = data.getUint8(0);
  var index = 1;
  var result = {
    "deviceId": deviceId || null,
    "rawFlags": flags,
    "unit": (flags & 0x01) ? "kPa" : "mmHg",
    "sbp": null,
    "dbp": null,
    "map": null,
    "hr": null,
    "year": null,
    "month": null,
    "day": null,
    "hour": null,
    "minute": null,
    "second": null,
    "userId": null,
    "moved": null,
    "cuffLoose": null,
    "irregularPulse": null,
    "improperMeasure": null,
    "bodyMovementDetected": null,
    "measurementPositionImproper": null
  };

  result.sbp = readSFloat(data, index, "systolic");
  index += 2;
  result.dbp = readSFloat(data, index, "diastolic");
  index += 2;
  result.map = readSFloat(data, index, "mean arterial pressure");
  index += 2;

  if (flags & 0x02) {
    requireBytes(data, index, 7, "timestamp");
    result.year = data.getUint16(index, true);
    result.month = data.getUint8(index + 2);
    result.day = data.getUint8(index + 3);
    result.hour = data.getUint8(index + 4);
    result.minute = data.getUint8(index + 5);
    result.second = data.getUint8(index + 6);
    index += 7;
  }
  if (flags & 0x04) {
    result.hr = readSFloat(data, index, "pulse rate");
    index += 2;
  }
  if (flags & 0x08) {
    requireBytes(data, index, 1, "user id");
    result.userId = data.getUint8(index);
    index += 1;
  }
  if (flags & 0x10) {
    requireBytes(data, index, 2, "measurement status");
    var status = data.getUint16(index, true);
    result.moved = (status & 0x0001) ? 1 : 0;
    result.bodyMovementDetected = result.moved;
    result.cuffLoose = (status & 0x0002) ? 1 : 0;
    result.irregularPulse = (status & 0x0004) ? 1 : 0;
    result.improperMeasure = (status & 0x0020) ? 1 : 0;
    result.measurementPositionImproper = result.improperMeasure;
    index += 2;
  }

  return result;
}

function buildDateTimePayload(date) {
  var arr = new Uint8Array(7);
  var v = new DataView(arr.buffer);
  v.setUint16(0, date.getFullYear(), true);
  v.setUint8(2, date.getMonth() + 1);
  v.setUint8(3, date.getDate());
  v.setUint8(4, date.getHours());
  v.setUint8(5, date.getMinutes());
  v.setUint8(6, date.getSeconds());
  return arr;
}

function trySyncDeviceTime(service) {
  return service.getCharacteristic(BP_DATE_TIME_UUID).then(function (characteristic) {
    return characteristic.writeValue(buildDateTimePayload(new Date())).then(function () {
      log("BP time sync complete");
      return true;
    });
  }).catch(function (e) {
    log("BP time sync skipped", e);
    return false;
  });
}

function disconnectDevice(device) {
  if (!device || !device.disconnect) return;
  try {
    device.disconnect();
  } catch (e) {
    log("BP disconnect failed", e);
  }
}

function exitSoon(delay) {
  setTimeout(function () {
    Bangle.load();
  }, delay || BP_EXIT_DELAY_MS);
}

function getBP(id, attempt) {
  attempt = attempt || 1;
  if (!id) {
    showMessage("ERROR!", "No BP device paired");
    exitSoon();
    return Promise.resolve(false);
  }

  showWaiting(attempt);
  var device;
  var service;
  var measurementTimeout;
  var indicationIdleTimeout;
  var finished = false;
  var savedCount = 0;
  var measurementReady = false;

  function clearMeasurementTimeout() {
    if (measurementTimeout) {
      clearTimeout(measurementTimeout);
      measurementTimeout = undefined;
    }
  }

  function clearIndicationIdleTimeout() {
    if (indicationIdleTimeout) {
      clearTimeout(indicationIdleTimeout);
      indicationIdleTimeout = undefined;
    }
  }

  function clearTimeouts() {
    clearMeasurementTimeout();
    clearIndicationIdleTimeout();
  }

  function finishSuccess() {
    if (finished) return;
    finished = true;
    clearTimeouts();
    disconnectDevice(device);
    exitSoon();
  }

  function scheduleFinishAfterIdle() {
    clearIndicationIdleTimeout();
    indicationIdleTimeout = setTimeout(finishSuccess, BP_INDICATION_IDLE_EXIT_MS);
  }

  function fail(e, retryable) {
    clearTimeouts();
    disconnectDevice(device);
    var msg = e && e.message ? e.message : String(e);
    log("BP failed", msg);
    if (retryable && attempt < BP_MAX_ATTEMPTS) {
      showMessage("Blood Pressure", "Retrying...");
      setTimeout(function () {
        getBP(id, attempt + 1);
      }, BP_RETRY_DELAY_MS);
    } else {
      showMessage("ERROR!", msg);
      exitSoon();
    }
  }

  function attachDisconnectHandler() {
    if (device.device && device.device.on) {
      device.device.on('gattserverdisconnected', function (reason) {
        log("BP disconnected", reason);
        if (!finished) {
          if (!measurementReady && savedCount === 0) {
            return;
          }
          finished = true;
          clearTimeouts();
          if (savedCount > 0) {
            exitSoon();
            return;
          }
          showMessage("ERROR!", "BP disconnected");
          exitSoon();
        }
      });
    }
  }

  function connectDevice() {
    return NRF.connect(id).then(function (d) {
      device = d;
      return new Promise(function (resolve) {
        setTimeout(resolve, BP_CONNECT_SETTLE_MS);
      });
    }).then(function () {
      log("BP connected", id);
      var security = device.getSecurityStatus ? device.getSecurityStatus() : {};
      if (security && security.bonded) log("BP already bonded");
      attachDisconnectHandler();
      return device;
    });
  }

  function subscribeToMeasurement() {
    return device.getPrimaryService(BP_SERVICE_UUID);
  }

  function setupMeasurement() {
    return subscribeToMeasurement().then(function (s) {
      service = s;
      return trySyncDeviceTime(service);
    }).then(function () {
      return service.getCharacteristic(BP_MEASUREMENT_UUID);
    }).then(function (c) {
      c.on('characteristicvaluechanged', function (event) {
        if (finished) return;
        try {
          var receivedData = parseBPMeasurement(event.target.value, id);
          modHS.saveDataToFile('bpres', 'bloodPressure', receivedData);
          savedCount++;
          clearMeasurementTimeout();
          showSavedResult(receivedData, savedCount);
          scheduleFinishAfterIdle();
        } catch (e) {
          finished = true;
          fail(e, false);
        }
      });
      return c.startNotifications();
    });
  }

  function bondAndRetrySetup(e) {
    if (!device || !device.startBonding || !isBPSecurityError(e)) throw e;
    log("BP security requires bonding");
    return device.startBonding().catch(function (bondError) {
      log("BP bonding interrupted", bondError);
      return true;
    }).then(function () {
      disconnectDevice(device);
      return connectDevice();
    }).then(setupMeasurement);
  }

  return connectDevice().then(setupMeasurement).catch(bondAndRetrySetup).then(function () {
    if (finished) return false;
    measurementReady = true;
    log("BP waiting for measurement notifications");
    measurementTimeout = setTimeout(function () {
      if (finished) return;
      finished = true;
      fail(new Error("BP measurement timeout"), false);
    }, BP_MEASUREMENT_TIMEOUT_MS);
    return true;
  }).catch(function (e) {
    if (finished) return false;
    finished = true;
    fail(e, true);
    return false;
  });
}

function startBP() {
  settings = modHS.getSettings();
  var id = settings.bt_bloodPressure_id;
  return getBP(id);
}

setTimeout(startBP, 2000);
