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

  // ANT+ paired HRM management
  HRM_CLEAR_ANT: 0x01,
  HRM_PAIR_ANT: 0x02,
  HRM_PAIR_ANT_ALT: 0x03,
  HRM_PAIRED_COUNT: 0x04,
  HRM_PAIRED_ANT_ENTRY: 0x05,

  // BLE paired HRM management
  HRM_PAIRED_BLE_ENTRY_NAME_OR_STATUS: 0x09,
  HRM_CLEAR_BLE: 0x11,
  HRM_PAIRED_BLE_ENTRY: 0x12,

  // ANT+ scan
  HRM_SCAN_ANT_START: 0x0A,
  HRM_SCAN_ANT_COUNT: 0x0B,
  HRM_SCAN_ANT_ENTRY: 0x0C,

  // BLE scan
  HRM_SCAN_BLE_START: 0x0D,
  HRM_SCAN_BLE_COUNT: 0x0E,
  HRM_SCAN_BLE_NAME: 0x0F,
  HRM_SCAN_BLE_MAC: 0x10,

  // Direct HR injection
  HRM_SEND_EXTERNAL_HR: 0x13
};

exports.dataViewToArray = function (dv) {
  var response = [];
  for (var i = 0; i < dv.byteLength; i++) response.push(dv.getUint8(i));
  return response;
};

exports.parseMeasurement = function (dv, batteryLevel) {
  var index = 0;
  var flags = dv.byteLength > index ? dv.getUint8(index++) : 0;
  var dataQuality;
  var hrState;
  var qualityAndState;
  function hasBytes(count) {
    return index + count <= dv.byteLength;
  }
  var data = {
    flags: flags,
    core: undefined,
    skin: undefined,
    unit: (flags & 0x08) ? "F" : "C",
    hr: 0,
    heatflux: undefined,
    hsiValid: !!(flags & 0x20),
    hsi: undefined,
    battery: batteryLevel || 0,
    quality: undefined,
    dataQuality: undefined,
    hrState: undefined,
    qualityAndStateRaw: undefined
  };

  if (hasBytes(2)) data.core = dv.getInt16(index, true) / 100;
  index += 2;
  if (hasBytes(2)) data.skin = dv.getInt16(index, true) / 100;
  index += 2;
  if (hasBytes(2)) data.heatflux = dv.getInt16(index, true);
  index += 2;

  if (hasBytes(1)) {
    qualityAndState = dv.getUint8(index++);
    data.qualityAndStateRaw = qualityAndState;
  }
  if (hasBytes(1)) data.hr = dv.getUint8(index++);
  if (data.hsiValid && index < dv.byteLength) {
    data.hsi = dv.getUint8(index) / 10;
  }
  if (qualityAndState !== undefined) {
    dataQuality = qualityAndState & 0x07;
    hrState = (qualityAndState >> 4) & 0x03;
    data.quality = dataQuality;
    data.dataQuality = dataQuality;
    data.hrState = hrState;
  }
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

function buildAntEntry(index, antId, txType, state) {
  var stateText = state === undefined ? "Unknown" : STATE_TEXT[state & 0x03];
  if (!stateText) stateText = "Unknown";
  return {
    index: index || 0,
    transport: "ANT+",
    antId: antId,
    txType: txType || 0,
    state: state,
    stateText: stateText
  };
}

exports.parseScannedAntEntry = function (response, index) {
  var byte1 = response[3] || 0;
  var byte2 = response[4] || 0;
  var txType = response[5] || 0;
  return buildAntEntry(index, byte1 | (byte2 << 8), txType, undefined);
};

exports.parsePairedAntEntry = function (response, index) {
  var byte1 = response[3] || 0;
  var byte2 = response[4] || 0;
  var txType = response[5] || 0;
  var state = response.length > 6 ? response[6] : undefined;
  return buildAntEntry(index, byte1 | (byte2 << 8), txType, state);
};

exports.parseAntEntry = exports.parsePairedAntEntry;

exports.makeAntPairParams = function (id) {
  return [id & 0xFF, (id >> 8) & 0xFF, (id >> 16) & 0xFF];
};
