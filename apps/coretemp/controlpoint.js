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
  RESPONSE: 0x80
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
  var qualityAndState;
  function hasBytes(count) {
    return index + count <= dv.byteLength;
  }
  var data = {
    flags: flags,
    core: undefined,
    skin: undefined,
    unit: (flags & 0x08) ? "F" : "C",
    heatflux: undefined,
    hsiValid: !!(flags & 0x20),
    hsi: undefined,
    battery: batteryLevel || 0,
    quality: undefined,
    dataQuality: undefined,
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
  if (hasBytes(1)) index++;
  if (data.hsiValid && index < dv.byteLength) {
    data.hsi = dv.getUint8(index) / 10;
  }
  if (qualityAndState !== undefined) {
    dataQuality = qualityAndState & 0x07;
    data.quality = dataQuality;
    data.dataQuality = dataQuality;
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
