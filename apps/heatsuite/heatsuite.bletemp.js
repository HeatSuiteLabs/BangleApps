var Layout = require("Layout");
const modHS = require('HSModule');
var layout;

var settings = modHS.getSettings();
//var appCache = modHS.getCache();
function log() {
  if (!settings.DEBUG) {
    return;
  } else {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v === undefined) {
        parts.push("undefined");
        continue;
      }
      if (v === null) {
        parts.push("null");
        continue;
      }
      if (typeof v === "object") {
        try {
          parts.push(JSON.stringify(v));
          continue;
        } catch (e) {
          parts.push("[object]");
          continue;
        }
      }
      parts.push("" + v);
    }
    var msg = parts.join(" ");
    modHS.log(msg);
  }
}

//Schema for the message coming from the BLE ThermistorPod:
const Schema_ThermistorPodBLE = {
  msgType: 'int32',
  ta: 'float32',
  rh: 'float32',
  batP: 'int32',
  temp: 'float32',
  tempAvg: 'float32',
  adc: 'int32',
  resistance: 'float32',
  ambLight: 'int32'
};

function getTcore(id) {
  log("[bletemp] getTcore start", id);
  layout = new Layout({
    type: "v", c: [
      {
        type: "h", c: [
          { type: "txt", font: "12x20:2", label: "Oral Temp", fillx: 1 },
        ]
      },
      {
        type: "h", c: [
          { type: "txt", font: "12x20:2", label: "Waiting...", fillx: 1 },
        ]
      }
    ]
  });
  g.clear();
  layout.render();
  var gatt;
  var startTime;
  var complete = false;
  var TCoreData = {
    "temp": null,
    "ta": null,
    "rh": null,
    "measures": []
  };
  NRF.connect(id).then(function (g) {
    log("[bletemp] connected", id);
    gatt = g;
    startTime = parseInt((getTime()).toFixed(0));
    gatt.device.on('gattserverdisconnected', function (reason) {
      gatt = null;
      Bangle.load();
      log("[bletemp] disconnected", reason);
    });
    log("[bletemp] requesting service", "1809");
    return gatt.getPrimaryService("1809");
  }).then(function (s) {
    log("[bletemp] service ready");
    log("[bletemp] requesting characteristic", "00002A1F-0000-1000-8000-00805F9B34FB");
    return s.getCharacteristic("00002A1F-0000-1000-8000-00805F9B34FB");
  }).then(function (c) {
    log("[bletemp] characteristic ready, listening for notifications");
    c.on('characteristicvaluechanged', function (event) {
      log("[bletemp] notification received");
      const receivedData = modHS.parseBLEData(event.target.value, Schema_ThermistorPodBLE);
      log("[bletemp] parsed sample", {
        adc: receivedData.adc,
        temp: receivedData.temp,
        tempAvg: receivedData.tempAvg,
        ta: receivedData.ta,
        rh: receivedData.rh
      });
      TCoreData.temp = receivedData.tempAvg;
      TCoreData.ta = receivedData.ta;
      TCoreData.rh = receivedData.rh;
      TCoreData.measures.push(receivedData.adc);
      var timeNow = parseInt((getTime()).toFixed(0));
      var diff = timeNow - startTime;
      log("[bletemp] elapsed", diff, "seconds");
      var display;
      if (diff > 90 && !complete) { // time to save the data and disconnect
        complete = true;
        log("[bletemp] measurement window complete, saving");
        if (modHS.saveDataToFile('coreTemp', 'coreTemperature', TCoreData)) {
          log("[bletemp] save success");
          display = {
            type: "v", c: [
              {
                type: "h", c: [
                  { type: "txt", font: "12x20:2", label: "Saved!", fillx: 1 }
                ]
              }
            ]
          };
        } else {
          log("[bletemp] save failed");
        }
      } else {
        var remaining = 90 - diff;
        log("[bletemp] waiting", remaining, "seconds remaining");
        display = {
          type: "v", c: [
            {
              type: "h", c: [
                { type: "txt", font: "12x20:2", label: remaining + " secs", fillx: 1 }
              ]
            },
            {
              type: "h", c: [
                { type: "txt", font: "4x6:2", label: receivedData.adc + " " + receivedData.temp.toFixed(2) + "C", fillx: 1 }
              ]
            }
          ]
        };
      }
      layout = new Layout(display);
      g.clear();
      layout.render();
      if (complete) {
        log("[bletemp] cleanup start");
        if(gatt){
          log("[bletemp] disconnecting gatt");
          gatt.disconnect();
        } else {
          log("[bletemp] no gatt to disconnect");
        }
        log("[bletemp] returning to launcher in 2s");
        setTimeout(() => { Bangle.load(); }, 5000);
      }
    });
    log("[bletemp] starting notifications");
    return c.startNotifications();
  }).then(function (d) {
    log("[bletemp] notifications started");
  }).catch(function (e) {
    log("[bletemp] error", e);
    E.showAlert("error! " + e).then(function () { Bangle.load(); });
  });
}

let macID = settings.bt_coreTemperature_id.split(" ");
//so you can see timeout
Bangle.setOptions({backlightTimeout: 0}); // turn off the timeout
Bangle.setBacklight(1); // keep screen on
modHS.log("Starting Core Temp app with macID: " + macID[0]);
log("[bletemp] debug logging enabled:", !!settings.DEBUG);
getTcore(macID[0]);
