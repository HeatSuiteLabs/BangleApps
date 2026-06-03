var STATE_TEXT = ["Closed", "Searching", "Synchronized", "Reserved"];

exports.CORE_SERVICE_UUID = "00002100-5b1e-4347-b07c-97b514dae121";
exports.CORE_TEMP_UUID = "00002101-5b1e-4347-b07c-97b514dae121";
exports.CORE_CONTROL_POINT_UUID = "00002102-5b1e-4347-b07c-97b514dae121";

exports.SUPPORTED_SERVICES = [
  exports.CORE_SERVICE_UUID,
  "0x180f",
  "0x1809"
];

exports.SUPPORTED_CHARACTERISTIC_UUIDS = [
  exports.CORE_TEMP_UUID,
  exports.CORE_CONTROL_POINT_UUID,
  "0x2a19"
];

exports.OPCODES = {
  RESPONSE: 0x80,
  HRM_CLEAR: 0x01,
  HRM_PAIR_ANT: 0x02,
  HRM_PAIRED_COUNT: 0x04,
  HRM_ENTRY: 0x05,
  HRM_SCAN_START: 0x0A,
  HRM_SCAN_COUNT: 0x0B,
  HRM_SCAN_ENTRY: 0x0C,
  HRM_SCAN_STOP: 0x0D
};

exports.dataViewToArray = function (dv) {
  var response = [];
  for (var i = 0; i < dv.byteLength; i++) response.push(dv.getUint8(i));
  return response;
};

exports.enableIndications = function (characteristic, log) {
  return characteristic.writeValue(new Uint8Array([0x02]), {
    type: "command",
    handle: true
  }).then(function () {
    if (log) log("Control point indications enabled");
  });
};

exports.parseMeasurement = function (dv, batteryLevel) {
  var index = 0;
  var flags = dv.getUint8(index++);
  var dataQuality;
  var hrState;
  var qualityAndState;
  var data = {
    core: dv.getInt16(index, true) / 100,
    skin: dv.getInt16(index + 2, true) / 100,
    unit: (flags & 0x08) ? "F" : "C",
    hr: 0,
    heatflux: dv.getInt16(index + 4, true),
    hsi: 0,
    battery: batteryLevel || 0
  };
  index += 6;
  qualityAndState = dv.getUint8(index++);
  data.hr = dv.getUint8(index++);
  data.hsi = dv.getUint8(index) / 10;
  dataQuality = qualityAndState & 0x07;
  hrState = (qualityAndState >> 4) & 0x03;
  data.dataQuality = dataQuality;
  data.hrState = hrState;
  return data;
};

exports.parseBattery = function (dv) {
  return dv.getUint8(0);
};

exports.parseResponse = function (dv) {
  return {
    opCode: dv.getUint8(0),
    requestOpCode: dv.getUint8(1),
    resultCode: dv.getUint8(2),
    bytes: exports.dataViewToArray(dv)
  };
};

exports.parseCount = function (response) {
  return response[3] || 0;
};

exports.parseAntEntry = function (response, index) {
  var byte1 = response[3] || 0;
  var byte2 = response[4] || 0;
  var txType = response[5] || 0;
  var state = response[6] || 0;
  return {
    index: index || 0,
    transport: "ANT+",
    antId: byte1 | (byte2 << 8) | (txType << 16),
    txType: txType,
    state: state,
    stateText: STATE_TEXT[state & 0x03]
  };
};

exports.makeAntPairParams = function (id) {
  return [id & 0xFF, (id >> 8) & 0xFF, (id >> 16) & 0xFF];
};
