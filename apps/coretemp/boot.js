var s = require("Storage").readJSON("coretemp.json", true) || {};

if (s.enabled === true) {
  require("CORESensor").enable();

  if (Bangle.setCORESensorPower) {
    Bangle.setCORESensorPower(1, "coretemp.enabled");
  }
}