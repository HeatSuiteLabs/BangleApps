var store = require("coretemp.store");
var ble = require("coretemp.ble");

var enabled;
var killHandler;

function getStatus() {
  return ble.getStatus();
}

exports.enable = function () {
  if (!enabled) {
    enabled = true;
    store.init();
    ble.init();

    killHandler = function () {
      ble.shutdown();
      store.shutdown();
    };
    E.on("kill", killHandler);
  }

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
  Bangle.setCORESensorPower = ble.setPower;
};
