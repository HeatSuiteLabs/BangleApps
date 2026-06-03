var store = require("coretemp.store");
var ble = require("coretemp.ble");
var hrm = require("coretemp.hrm");

var enabled;
var killHandler;

function getStatus() {
  var status = ble.getStatus();
  status.hrm = hrm.getManagerState();
  return status;
}

exports.enable = function () {
  if (enabled) return;
  enabled = true;
  store.init();
  ble.init();
  hrm.init();

  Bangle.enableCORESensorLog = function () {
    store.setDebug(true);
  };

  Bangle.disableCORESensorLog = function () {
    store.setDebug(false);
  };

  Bangle.CORESensorSetDebugLog = function (isEnabled) {
    store.setDebug(!!isEnabled);
  };

  Bangle.isCORESensorOn = ble.isOn;
  Bangle.isCORESensorConnected = ble.isConnected;
  Bangle.CORESensorConnect = ble.connect;
  Bangle.CORESensorDisconnect = ble.disconnect;
  Bangle.CORESensorPair = ble.pairDevice;
  Bangle.CORESensorUnpair = ble.unpairDevice;
  Bangle.CORESensorRebuildCache = ble.rebuildCache;
  Bangle.CORESensorWriteControlPoint = ble.writeControlPoint;
  Bangle.CORESensorGetStatus = getStatus;
  Bangle.CORESensorHRMGetManagerState = hrm.getManagerState;
  Bangle.CORESensorHRMGetStatus = hrm.getStatus;
  Bangle.CORESensorHRMEnsureConfigured = hrm.ensureConfigured;
  Bangle.CORESensorHRMScanANT = hrm.scanANT;
  Bangle.CORESensorHRMPairANT = hrm.pairANT;
  Bangle.CORESensorHRMClear = hrm.clear;
  Bangle.setCORESensorPower = ble.setPower;

  ble.onConnected(function (sessionId) {
    return hrm.autoConfigureForConnection(sessionId);
  });

  killHandler = function () {
    ble.shutdown();
    store.shutdown();
  };
  E.on("kill", killHandler);
};
