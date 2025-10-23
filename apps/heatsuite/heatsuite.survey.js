var EMASurvey = require("survey");
var modHS = require("HSModule");

Bangle.setOptions({ backlightTimeout:30000, lockTimeout:30000 });


var survey = require("Storage").readJSON("heatsuite.survey.json", true);
EMASurvey.init({
  surveyObj   : survey,
  getSettings : function(){ return modHS.getSettings(); }, 
  getCache    : function(){ return modHS.getCache(); },    
  save        : function(k,f,e){ modHS.saveDataToFile(k,f,e); }, 
  onDone      : function(){ /* optional */ },
  onSave      : function(entry){ /* optional */ },
  onLog       : function(msg){ /* optional */ },
  timeoutMs   : 180000,
  buzz        : true
});
EMASurvey.start();