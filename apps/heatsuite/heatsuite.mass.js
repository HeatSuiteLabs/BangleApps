var Layout = require("Layout");
var modHS = require("HSModule");
var layout;
var SERVICE_V2 = "181b";
var SERVICE_V1 = "181d";

/** --------- MI SCALE --------------------------- */
function round2(v) {
  return Math.round(v * 100) / 100;
}

function decodeV2(data) {
  if (!data || data.length < 13) return;
  var ctlByte = data[1];
  var stabilized = !!(ctlByte & (1 << 5));
  var weight = round2(((data[12] << 8) + data[11]) / 200);
  var impedance = (data[10] << 8) + data[9];
  if (impedance <= 0 || impedance >= 65534) impedance = null;
  return {
    stable : stabilized,
    mass : weight,
    unit : "kg",
    impedance : impedance
  };
}

function decodeV1(data, prevMass) {
  if (!data || data.length < 3) return;
  var unitByte = data[0] & 0x3F;
  var raw = (data[2] << 8) + data[1];
  var unit = "";
  var mass = raw * 0.01;
  if (unitByte === 0x03) {
    unit = "lbs";
  } else if (unitByte === 0x12) {
    unit = "jin";
  } else if (unitByte === 0x22) {
    unit = "kg";
    mass = mass / 2;
  } else {
    return;
  }
  mass = round2(mass);
  return {
    // V1 does not expose the same control byte flags as V2 in this parser.
    // Treat back-to-back identical values as stable.
    stable : prevMass === mass,
    mass : mass,
    unit : unit,
    impedance : null
  };
}

function renderWaiting() {
  layout = new Layout({
    type: "v", c: [
      {
        type: "h", c: [
          { type: "txt", font: "12x20:2", label: "Body Mass", fillx: 1 },
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
}

function renderAndSave(reading) {
  var dataOut = {
    mass : reading.mass,
    impedance : reading.impedance
  };
  modHS.saveDataToFile("mass", "bodyMass", dataOut);
  layout = new Layout({
    type: "v", c: [
      {
        type: "h", c: [
          { type: "txt", font: "12x20:2", label: reading.mass, fillx: 1 },
          { type: "txt", font: "12x20:2", label: reading.unit, fillx: 1 }
        ]
      },
      {
        type: "h", c: [
          { type: "txt", font: "6x8:2", label: reading.impedance === null ? "-" : reading.impedance, fillx: 1 },
        ]
      },
      {
        type: "h", c: [
          { type: "txt", font: "12x20:2", label: "Saved!", fillx: 1 }
        ]
      },
    ]
  });
  g.clear();
  layout.render();
  setTimeout(function () { Bangle.load(); }, 3000);
}

function getMass() {
  var prevV1Mass;
  NRF.setScan();//clear other scans

  NRF.setScan(function (device) {
    if (!device || !device.serviceData) return;
    var reading;

    if (device.serviceData[SERVICE_V2]) {
      reading = decodeV2(device.serviceData[SERVICE_V2]);
    } else if (device.serviceData[SERVICE_V1]) {
      reading = decodeV1(device.serviceData[SERVICE_V1], prevV1Mass);
      if (reading) prevV1Mass = reading.mass;
    }

    if (reading && reading.stable) {
      NRF.setScan();
      renderAndSave(reading);
    }
  }, { timeout: 2000, filters: [{ services: [SERVICE_V2] }, { services: [SERVICE_V1] }] });
}

//init
renderWaiting();
getMass();
