(function () {
  var Layout = require("Layout");

  // --------- module-scope state ----------
  var _opts = null;
  var _survey = null;
  var _QArr = [];
  var _layout = undefined;
  var _scrollInterval = undefined;
  var _timeoutHandle = undefined;
  var _settingsCache = undefined;
  var _cacheCache = undefined;
  var _lang;

  // --------- small utils ----------
  function _mergeDefined(defaults, opts) {
    var out = {};
    var k;
    for (k in defaults) out[k] = defaults[k];
    if (opts) for (k in opts) if (opts[k] !== undefined) out[k] = opts[k];
    return out;
  }
  function _settings() {
    if (!_settingsCache) {
      try { _settingsCache = (_opts && _opts.getSettings ? _opts.getSettings() : {}) || {}; }
      catch (e) { _settingsCache = {}; }
    }
    return _settingsCache;
  }
  function _cache() {
    if (!_cacheCache) {
      try { _cacheCache = (_opts && _opts.getCache ? _opts.getCache() : {}) || {}; }
      catch (e) { _cacheCache = {}; }
    }
    return _cacheCache;
  }
  function _log(m) {
    var s = _settings();
    if (_opts && _opts.onLog) _opts.onLog(m);
    else if (s && s.DEBUG) console.log(m);
  }
  function _buzz(ms) {
    if (!_opts || !_opts.buzz) return;
    try { Bangle.buzz(ms || 120); } catch(e){}
  }

  function _isIntlLang() {
    return _lang && _lang.endsWith("_INTL");
  }

  function _displaySettings(question) {
    var defaultPalette = ["#8BC34A", "#FFEB3B", "#FFB74D", "#EF9A9A", "#90CAF9", "#CE93D8"];
    var out = {
      questionFont: "18%",
      intlQuestionFont: "Intl:1",
      questionPad: 2,
      nextButtonFont: "15%",
      nextButtonLabel: ">>",
      nextButtonColor: "#0f0",
      responseHeaderHeight: 30,
      responseFontSize: 24,
      responseMinFontSize: 14,
      intlResponseFontSize: 2,
      intlResponseMinFontSize: 1,
      responseHeight: 30,
      autoFitResponseHeight: true,
      fitResponseText: true,
      wrapResponseText: true,
      responsePad: 4,
      responseLineSpacing: 2,
      responseMinHeight: 30,
      responseMaxHeight: 96,
      responseMaxLines: 3,
      responseTextColor: "#000",
      responsePalette: defaultPalette,
      responsePaletteIndex: 0
    };
    var custom = (_survey && _survey.settings) || {};
    var display = custom.display || custom;
    var k;
    for (k in display) if (display[k] !== undefined) out[k] = display[k];
    if (question && question.display) {
      for (k in question.display) if (question.display[k] !== undefined) out[k] = question.display[k];
    }
    return out;
  }

  function _textFor(map, lang, fallback) {
    if (!map) return fallback || "";
    return map[lang] || map[_lang] || map.en_GB || fallback || "";
  }

  function _setResponseFont(text, maxWidth, ds) {
    text = "" + text;
    if (_isIntlLang()) {
      var intlSize = ds.intlResponseFontSize;
      g.setFont("Intl", intlSize);
      if (ds.wrapResponseText) return;
      if (ds.fitResponseText && intlSize > ds.intlResponseMinFontSize && g.stringWidth(text) > maxWidth) {
        g.setFont("Intl", ds.intlResponseMinFontSize);
      }
      return;
    }
    var size = ds.responseFontSize;
    g.setFont("Vector", size);
    if (ds.wrapResponseText) return;
    if (!ds.fitResponseText) return;
    while (size > ds.responseMinFontSize && g.stringWidth(text) > maxWidth) {
      size -= 2;
      g.setFont("Vector", size);
    }
  }

  function _responseBgColor(option, idx, ds) {
    if (option && option.btnColor) return option.btnColor;
    var palette = (ds.responsePalette && ds.responsePalette.length) ? ds.responsePalette : ["#8BC34A", "#FFEB3B", "#FFB74D", "#EF9A9A", "#90CAF9", "#CE93D8"];
    var startIdx = ds.responsePaletteIndex || 0;
    return palette[(idx + startIdx) % palette.length];
  }

  function _responseText(option, lang) {
    if (option && option.text !== undefined) return _textFor(option.text, lang, option.value);
    return option ? option.value : "";
  }

  function _responseLines(text, maxWidth, ds) {
    text = "" + text;
    _setResponseFont(text, maxWidth, ds);
    if (!ds.wrapResponseText || !g.wrapString) return [text];
    var lines = g.wrapString(text, maxWidth) || [text];
    if (ds.responseMaxLines && lines.length > ds.responseMaxLines) {
      lines = lines.slice(0, ds.responseMaxLines);
      lines[lines.length - 1] += "...";
    }
    return lines;
  }

  function _responseLineHeight() {
    return g.getFontHeight ? g.getFontHeight() : 16;
  }

  function _responseBlockHeight(lines, ds) {
    var lineHeight = _responseLineHeight();
    return (lines.length * lineHeight) + ((lines.length - 1) * ds.responseLineSpacing);
  }

  function _responseHeightForOptions(options, lang, ds) {
    var height = ds.responseHeight;
    if (!ds.wrapResponseText) return height;
    var maxHeight = ds.responseMinHeight;
    var maxWidth = g.getWidth() - (ds.responsePad * 2);
    for (var i = 0; i < options.length; i++) {
      var text = _responseText(options[i], lang);
      var lines = _responseLines(text, maxWidth, ds);
      var needed = _responseBlockHeight(lines, ds) + (ds.responsePad * 2);
      if (needed > maxHeight) maxHeight = needed;
    }
    if (height > maxHeight) maxHeight = height;
    if (ds.responseMaxHeight && maxHeight > ds.responseMaxHeight) maxHeight = ds.responseMaxHeight;
    return maxHeight;
  }

  function _loadSurveyFromFilename(fn) {
    var obj = require("Storage").readJSON(fn, true);
    if (!obj || !obj.questions || !obj.questions.length) throw new Error("Survey: invalid JSON");
    return obj;
  }

  function _shuffleWithOrderFix(arr) {
    var items = arr.slice();
    var result = [];
    while (items.length) {
      var item;
      if (items[0] && items[0].orderFix === true) {
        item = items.splice(0, 1)[0];
      } else {
        var idx = Math.floor(Math.random() * items.length);
        item = items.splice(idx, 1)[0];
      }
      result.push(item);
    }
    return result;
  }

  function _buildInitialQueue(survey, settings) {
    var list = [];
    var i;
    for (i = 0; i < survey.questions.length; i++) {
      var q = survey.questions[i];
      // keep unless followup is strictly true (===), just like your original code
      if (q.followup !== true) list.push(q);
    }
    if (settings && settings.surveyRandomize) list = _shuffleWithOrderFix(list);
    return list;
  }


  function _queueTimeout() {
    if (_timeoutHandle) clearTimeout(_timeoutHandle);
    _timeoutHandle = setTimeout(function(){ Bangle.load(); }, _opts.timeoutMs);
  }

  function _clearScroll() {
    if (_scrollInterval) { clearInterval(_scrollInterval); _scrollInterval = undefined; }
  }

  function _drawScrollingText(text, headerH, ds) {
    Bangle.appRect = { x:0, y:headerH, w:g.getWidth(), h:g.getHeight()-headerH, x2:g.getWidth()-1, y2:g.getHeight()-1 };
    g.reset();
    g.setColor("#000"); g.setBgColor("#FFF");
    g.clearRect(0, 0, g.getWidth(), headerH);
    _setResponseFont(text, g.getWidth() - 8, ds);
    var stringWidth = g.stringWidth(text);
    var textX = (stringWidth > g.getWidth()) ? (stringWidth/2) + 30 : 0;
    function draw() {
      g.reset();
      g.setColor("#000"); g.setBgColor("#FFF");
      g.clearRect(0, 0, g.getWidth(), headerH);
      _setResponseFont(text, g.getWidth() - 8, ds);
      g.setFontAlign(-1, 0, 0);
      g.drawString(text, textX, headerH/2);
      textX -= 5;
      if (textX < (-(stringWidth/2) + g.getWidth() - 30)) textX = (stringWidth/2) + 30;
      g.flip();
    }
    _clearScroll();
    if (stringWidth > g.getWidth()) _scrollInterval = setInterval(draw, 60);
    else draw();
  }

  function _withinTOD(question, now) {
    if (!question.tod || !question.tod.length) return true;
    var currMT = parseInt(now.getHours() + "" + now.getMinutes(), 10);
    var i;
    for (i = 0; i < question.tod.length; i++) {
      if (currMT > question.tod[i][0] && currMT < question.tod[i][1]) return true;
    }
    return false;
  }

  function _alreadyAskedToday(question, now) {
    var c = _cache();
    if (!c.survey || !c.survey[question.key]) return false;
    var lastS = new Date(c.survey[question.key].unix * 1000);
    return Math.floor(now.getTime()/86400000) === Math.floor(lastS.getTime()/86400000);
  }

  function _languageFor(question) {
    var langPref = (_lang || require("locale").name || "en_GB");
    if (question.text && question.text[langPref]) return langPref;
    return "en_GB"; //fail-safe to always return something...
  }

  function _drawResponseOpts(question) {
    g.clear();
    var lang = _languageFor(question);
    var ds = _displaySettings(question);
    _drawScrollingText((question.text[lang] || ""), ds.responseHeaderHeight, ds);
    var height = ds.responseHeight;
    var opt = question.options;
    var resStyle = opt.type || undefined;
    
    switch (resStyle){
        case "number": {
            // ranged/step input
            var currentOpt = (opt.startOpt != undefined) ? opt.startOpt : ((opt.min != undefined) ? opt.min : 0);
            var minOpt = (opt.min != undefined) ? opt.min : 0;
            var maxOpt = (opt.max != undefined) ? opt.max : 10;
            var optStep = (opt.optStep != undefined) ? opt.optStep : 1;
            var units = (opt.units != undefined) ? opt.units : undefined;
            var nextMap = (opt.next != undefined) ? opt.next : {};

            function nextFor(val) { 
              if (!nextMap) return 0;
              if (typeof nextMap === "string" || typeof nextMap === "number") return nextMap; //added so we can have a fixed followup for all questions
              if (typeof nextMap === "object") {
                if(val in nextMap) return nextMap[val] | 0;
              }
              return 0;    
            }

            function handleResponse() {
                var label = currentOpt; if (units) label = "" + label + units;
                var n = nextFor(currentOpt);
                var cbString = question.key + "," + currentOpt + "," + label + "," + n;
                _surveyResponse(cbString);
            }

            function optionDown() {
                var nopt = currentOpt - optStep;
                currentOpt = (nopt < minOpt) ? maxOpt : nopt;
                var label = currentOpt; if (units) label = "" + label + units;
                _layout.response.label = label;
                _layout.clear(_layout.response);
                _layout.render(_layout.response);
            }

            function optionUp() {
                var nopt = currentOpt + optStep;
                currentOpt = (nopt > maxOpt) ? minOpt : nopt;
                var label = currentOpt; if (units) label = "" + label + units;
                _layout.response.label = label;
                _layout.clear(_layout.response);
                _layout.render(_layout.response);
            }

            var initLabel = (units != undefined) ? ("" + currentOpt + units) : currentOpt;
            _layout = new Layout({
                type: "v",
                c: [
                { type:"txt", font:"50%", label:initLabel, fillx:1, id:"response", cb: handleResponse },
                { type:"h", c: [
                    { type:"btn", font:"15%", label:"<<", fillx:1, cb: optionDown },
                    { type:"txt", font:"15%", label:"  ", fillx:1 },
                    { type:"btn", font:"15%", label:">>", fillx:1, cb: optionUp }
                ] }
                ],
                lazy: true
            });
            _layout.render();
            break;
        }
        default :{
            var options = opt.responses;
            if (ds.wrapResponseText) height = _responseHeightForOptions(options, lang, ds);
            function drawItem(idx, r) {
                var optionText = _responseText(options[idx], lang);
                g.reset();
                g.setColor(_responseBgColor(options[idx], idx, ds));
                g.fillRect(r.x, r.y, r.x+r.w-1, r.y+r.h-1);
                g.setColor(options[idx].color || ds.responseTextColor);
                var lines = _responseLines(optionText, r.w - (ds.responsePad * 2), ds);
                var lineHeight = _responseLineHeight();
                var blockHeight = _responseBlockHeight(lines, ds);
                var y = r.y + Math.max(ds.responsePad, Math.floor((r.h - blockHeight) / 2));
                g.setFontAlign(0, -1, 0);
                for (var i = 0; i < lines.length; i++) {
                  g.drawString(lines[i], r.x + (r.w/2), y + (i * (lineHeight + ds.responseLineSpacing)));
                }
            }
            function selectItem(id) {
                var resp = (options[id] && options[id].text) ? _textFor(options[id].text, lang, options[id].value) : options[id].value;
                var next = (options[id] && options[id].next !== undefined) ? options[id].next : 0;
                var cbString = question.key + "," + resp + "," + options[id].value + "," + next;
                _surveyResponse(cbString);
            }

            if (!ds.wrapResponseText && ds.autoFitResponseHeight && options.length < 5) height = Math.floor(Bangle.appRect.h / options.length);

            E.showScroller({ h: height, c: options.length, draw: drawItem, select: selectItem });
            break;
        }
    }
  }

  function _drawDone() {
    g.clear(); g.reset(); g.setBgColor("#FFF");
    _buzz(150);
    _layout = new Layout({
      type: "v",
      c: [
        { type:"img", pad:4, src: require("heatshrink").decompress(atob("ikUwYFCgVJkgMDhMkyVJAwQFCAQNAgESAoQCBwEBBwlIgAFDpNkyAjDkm/5MEBwdf+gUEl/6AoVZkmX/oLClv6pf+DQn1/4+E3//0gFBkACBv/SBYI7D5JiDLJx9CBAR4CAoWQQ4Z9DgAA==")) },
        { type:"txt", font:"20%", label:"Done!" }
      ]
    });
    _layout.render();
    setTimeout(function () {
      if (_opts && _opts.onDone) _opts.onDone();
      Bangle.load();
    }, 500);
  }

  function _drawSurveyLayout(question) {
    _queueTimeout();
    _clearScroll();

    if (!_survey) {
      _log("No Survey File");
      E.showAlert("No Survey File Found.").then(function(){ Bangle.showClock(); });
      return;
    }
    if (!question) { _drawDone(); return; }

    var now = new Date();
    if (!_withinTOD(question, now)) { _drawSurveyLayout(_QArr.shift()); return; }
    if (question.oncePerDay && _alreadyAskedToday(question, now)) { _drawSurveyLayout(_QArr.shift()); return; }

    _buzz(100);
    g.clear(); g.reset();

    var lang = _languageFor(question);
    var questionText = _textFor(question.text, lang, "");
    var ds = _displaySettings(question);

    var out = { type:"v", c: [] };
    var QuestionTextObj = { type:"txt", label:questionText, id:"label", wrap: true, fillx: 1, filly: 1, pad: ds.questionPad };
    QuestionTextObj.font = _isIntlLang() ? ds.intlQuestionFont : ds.questionFont;
    out.c.push(QuestionTextObj);
    var optFont = (question.optFont !== undefined) ? question.optFont : ds.nextButtonFont;

    out.c.push({
      type:"btn", font: optFont, label: ds.nextButtonLabel, pad:1, btnFaceCol:ds.nextButtonColor,
      cb: function(){ _drawResponseOpts(question); }
    });

    _layout = new Layout(out);
    _layout.render();
  }

  function _surveyResponse(csvText) {
    var arr = csvText.split(',');
    var entry = { key: arr[0], resp: arr[1], value: arr[2] };

    if (_opts && _opts.save) {
      try { _opts.save('survey', 'survey', entry); }
      catch(e){ _log("save() error: " + e); }
    }
    if (_opts && _opts.onSave) _opts.onSave(entry);

    var nextKey = (arr[3] !== undefined && arr[3] != 0) ? arr[3] : 0;
    if (nextKey) {
      var i, followup = undefined;
      for (i = 0; i < _survey.questions.length; i++) {
        if (_survey.questions[i].key === nextKey) { followup = _survey.questions[i]; break; }
      }
      _drawSurveyLayout(followup);
    } else {
      _drawSurveyLayout(_QArr.shift());
    }
  }

  // --------- Public API (module-style) ----------
  function init(opts) {
    _opts = _mergeDefined({ timeoutMs: 180000, buzz: true }, opts || {});
    _settingsCache = undefined;
    _cacheCache = undefined;

    if (_opts.surveyObj) _survey = _opts.surveyObj;
    else if (_opts.surveyFilename) _survey = _loadSurveyFromFilename(_opts.surveyFilename);
    else throw new Error("EMA Survey: provide surveyObj or surveyFilename");

    _QArr = _buildInitialQueue(_survey, _settings());
    // set language once we start(), so locale is loaded
  }

  function start() {
    var s = _settings();
    _lang = (s.lang || require("locale").name || "en_GB");
    _queueTimeout();
    _drawSurveyLayout(_QArr.shift());
  }

  function updateOptions(newOpts) {
    _opts = _mergeDefined(_opts || {}, newOpts || {});
    // apply immediate side-effects
    if (newOpts && newOpts.timeoutMs !== undefined) {
      if (_timeoutHandle) clearTimeout(_timeoutHandle);
      _queueTimeout();
    }
  }

  function setSurveyObj(obj) {
    _survey = obj;
    _QArr = _buildInitialQueue(_survey, _settings());
  }

  function setSurveyFilename(fn) {
    _survey = _loadSurveyFromFilename(fn);
    _QArr = _buildInitialQueue(_survey, _settings());
  }

  exports = {
    init: init,
    start: start,
    updateOptions: updateOptions,
    setSurveyObj: setSurveyObj,
    setSurveyFilename: setSurveyFilename
  };
})();
