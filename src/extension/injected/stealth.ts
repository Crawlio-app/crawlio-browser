// Anti-detection stealth script — injected via Page.addScriptToEvaluateOnNewDocument + Runtime.evaluate
// Must remain a self-contained string (no imports, no closures)
// Covers 22 detection surfaces (up from 6).
export const STEALTH_SCRIPT = `(() => {
  var _csKey = Symbol.for('crawlio:stealth');
  if (window[_csKey]) return;
  Object.defineProperty(window, _csKey, { value: true, enumerable: false, configurable: true });

  // Session-stable seed (deterministic within page load)
  var _seed = Math.random();
  var _seedU32 = (_seed * 4294967295) | 0;

  // Track wrapped natives for Function.prototype.toString
  var _wrapped = new WeakSet();
  var _markNative = function(fn) { try { _wrapped.add(fn); } catch(e) {} return fn; };

  // ── 1. navigator.webdriver ────────────────────────────────────────────────
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: _markNative(() => false),
      configurable: true,
    });
  } catch(e) {}
  Object.defineProperty(navigator, 'webdriver', {
    get: _markNative(() => false),
    configurable: true,
  });

  // ── 2. navigator.plugins ─────────────────────────────────────────────────
  var _fakePlugins = null;
  Object.defineProperty(navigator, 'plugins', {
    get: _markNative(() => {
      if (_fakePlugins) return _fakePlugins;
      var items = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1, item: function(i) { return i === 0 ? this : null; }, namedItem: function() { return null; } },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 0, item: function() { return null; }, namedItem: function() { return null; } },
      ];
      try { Object.setPrototypeOf(items[0], Plugin.prototype); } catch(e) {}
      try { Object.setPrototypeOf(items[1], Plugin.prototype); } catch(e) {}
      _fakePlugins = Object.create(PluginArray.prototype, {
        length: { get: _markNative(() => 2), configurable: true },
        item: { value: _markNative(function(i) { return items[i] || null; }), configurable: true },
        namedItem: { value: _markNative(function(name) { return items.find(function(p) { return p.name === name; }) || null; }), configurable: true },
        refresh: { value: _markNative(function() {}), configurable: true },
        0: { get: function() { return items[0]; }, configurable: true },
        1: { get: function() { return items[1]; }, configurable: true },
      });
      _fakePlugins[Symbol.iterator] = _markNative(function() {
        var i = 0; return { next: function() { return i < items.length ? { value: items[i++], done: false } : { done: true }; } };
      });
      return _fakePlugins;
    }),
    configurable: true,
  });

  // ── 3. navigator.languages ────────────────────────────────────────────────
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', {
      get: _markNative(() => ['en-US', 'en']),
      configurable: true,
    });
  }

  // ── 4. Notification.permission ────────────────────────────────────────────
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
    Object.defineProperty(Notification, 'permission', {
      get: _markNative(() => 'default'),
      configurable: true,
    });
  }

  // ── 5. WebGL vendor/renderer + extensions list ────────────────────────────
  var headlessVendors = /^(Google Inc\\.?|Brian Paul|Mesa|VMware|Microsoft)$/i;
  var headlessRenderers = /SwiftShader|llvmpipe|softpipe|ANGLE.*Direct3D|Mesa/i;
  var _gl1Exts = [
    'ANGLE_instanced_arrays','EXT_blend_minmax','EXT_color_buffer_half_float','EXT_float_blend',
    'EXT_frag_depth','EXT_shader_texture_lod','EXT_texture_compression_bptc',
    'EXT_texture_compression_rgtc','EXT_texture_filter_anisotropic','EXT_sRGB',
    'KHR_parallel_shader_compile','OES_draw_buffers_indexed','OES_element_index_uint',
    'OES_fbo_render_mipmap','OES_standard_derivatives','OES_texture_float',
    'OES_texture_float_linear','OES_texture_half_float','OES_texture_half_float_linear',
    'OES_vertex_array_object','WEBGL_color_buffer_float','WEBGL_compressed_texture_astc',
    'WEBGL_compressed_texture_etc','WEBGL_compressed_texture_s3tc',
    'WEBGL_compressed_texture_s3tc_srgb','WEBGL_debug_renderer_info','WEBGL_debug_shaders',
    'WEBGL_draw_buffers','WEBGL_lose_context','WEBGL_multi_draw'
  ];
  var _gl2Exts = [
    'EXT_color_buffer_float','EXT_color_buffer_half_float','EXT_disjoint_timer_query_webgl2',
    'EXT_float_blend','EXT_texture_compression_bptc','EXT_texture_compression_rgtc',
    'EXT_texture_filter_anisotropic','EXT_texture_norm16','KHR_parallel_shader_compile',
    'OES_draw_buffers_indexed','OES_texture_float_linear','OES_texture_half_float_linear',
    'OVR_multiview2','WEBGL_blend_func_extended','WEBGL_color_buffer_float',
    'WEBGL_compressed_texture_astc','WEBGL_compressed_texture_etc',
    'WEBGL_compressed_texture_s3tc','WEBGL_compressed_texture_s3tc_srgb',
    'WEBGL_debug_renderer_info','WEBGL_debug_shaders','WEBGL_lose_context',
    'WEBGL_multi_draw','WEBGL_polygon_mode'
  ];
  var patchWebGL = function(proto, isGL2) {
    var orig = proto.getParameter;
    var origExts = proto.getSupportedExtensions;
    proto.getParameter = _markNative(function(parameter) {
      var val = orig.call(this, parameter);
      if (parameter === 37445 && headlessVendors.test(val)) return 'Intel Inc.';
      if (parameter === 37446 && headlessRenderers.test(val)) return 'Intel Iris OpenGL Engine';
      return val;
    });
    proto.getSupportedExtensions = _markNative(function() {
      var native = origExts.call(this);
      if (!native || native.length < 20) return isGL2 ? _gl2Exts.slice() : _gl1Exts.slice();
      return native;
    });
  };
  patchWebGL(WebGLRenderingContext.prototype, false);
  if (typeof WebGL2RenderingContext !== 'undefined') {
    patchWebGL(WebGL2RenderingContext.prototype, true);
  }
  if (window.outerWidth === 0) {
    Object.defineProperty(window, 'outerWidth', { get: _markNative(() => window.innerWidth), configurable: true });
  }
  if (window.outerHeight === 0) {
    Object.defineProperty(window, 'outerHeight', { get: _markNative(() => window.innerHeight + 85), configurable: true });
  }

  // ── 6. navigator.permissions.query ───────────────────────────────────────
  try {
    if (navigator.permissions && navigator.permissions.query) {
      var _origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = _markNative(function(parameters) {
        if (parameters && parameters.name === 'notifications') {
          return Promise.resolve({
            state: 'default', name: 'notifications', onchange: null,
            addEventListener: function() {}, removeEventListener: function() {}, dispatchEvent: function() { return false; },
          });
        }
        return _origQuery(parameters);
      });
    }
  } catch(e) {}

  // ── 7. window.chrome stub ─────────────────────────────────────────────────
  try {
    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', {
        value: {
          runtime: {},
          loadTimes: _markNative(function() { return {}; }),
          csi: _markNative(function() { return {}; }),
          app: {},
        },
        configurable: true, writable: true,
      });
    }
  } catch(e) {}

  // ── 8. Canvas fingerprint noise ───────────────────────────────────────────
  try {
    var _origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    var _origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    var _noiseCanvas = function(imageData) {
      var d = imageData.data;
      var s = (_seed * 1e9) | 0;
      for (var i = 0; i < d.length; i += 4) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        var delta = ((s & 3) - 1);
        d[i]     = Math.max(0, Math.min(255, d[i]     + delta));
        d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + delta));
        d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + delta));
      }
      return imageData;
    };
    CanvasRenderingContext2D.prototype.getImageData = _markNative(function(sx, sy, sw, sh) {
      return _noiseCanvas(_origGetImageData.call(this, sx, sy, sw, sh));
    });
    HTMLCanvasElement.prototype.toDataURL = _markNative(function() {
      try {
        var ctx = this.getContext('2d');
        if (ctx && this.width > 0 && this.height > 0) {
          ctx.putImageData(_noiseCanvas(_origGetImageData.call(ctx, 0, 0, this.width, this.height)), 0, 0);
        }
      } catch(e) {}
      return _origToDataURL.apply(this, arguments);
    });
  } catch(e) {}

  // ── 9. Audio fingerprint noise — linear congruential generator, 0.8% ─────
  // Replaces ±1e-7. Covers all 6 intercept paths.
  try {
    var _lcgApply = function(data, channelOrOffset) {
      var state = (_seedU32 ^ (channelOrOffset | 0)) >>> 0;
      for (var i = 0; i < data.length; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        var norm = state / 4294967295;
        data[i] *= 0.996 + norm * 0.008 + (norm * norm - 0.5) * 0.002;
      }
    };
    var _lcgApplyByte = function(data, offset) {
      var state = (_seedU32 ^ (offset | 0)) >>> 0;
      for (var i = 0; i < data.length; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        data[i] = Math.max(0, Math.min(255, data[i] + Math.round((state / 4294967295 - 0.5) * 2)));
      }
    };
    if (typeof AudioBuffer !== 'undefined') {
      var _origGetChannelData = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = _markNative(function(channel) {
        var data = _origGetChannelData.call(this, channel);
        _lcgApply(data, channel);
        return data;
      });
      var _origCopyFromChannel = AudioBuffer.prototype.copyFromChannel;
      AudioBuffer.prototype.copyFromChannel = _markNative(function(dest, channel, startInChannel) {
        _origCopyFromChannel.call(this, dest, channel, startInChannel);
        _lcgApply(dest, channel);
      });
    }
    if (typeof AnalyserNode !== 'undefined') {
      var _origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = _markNative(function(array) {
        _origGetFloatFreq.call(this, array); _lcgApply(array, 0);
      });
      var _origGetByteFreq = AnalyserNode.prototype.getByteFrequencyData;
      AnalyserNode.prototype.getByteFrequencyData = _markNative(function(array) {
        _origGetByteFreq.call(this, array); _lcgApplyByte(array, 1);
      });
      var _origGetFloatTime = AnalyserNode.prototype.getFloatTimeDomainData;
      AnalyserNode.prototype.getFloatTimeDomainData = _markNative(function(array) {
        _origGetFloatTime.call(this, array); _lcgApply(array, 2);
      });
      var _origGetByteTime = AnalyserNode.prototype.getByteTimeDomainData;
      AnalyserNode.prototype.getByteTimeDomainData = _markNative(function(array) {
        _origGetByteTime.call(this, array); _lcgApplyByte(array, 3);
      });
    }
  } catch(e) {}

  // ── 10. AudioContext sampleRate ───────────────────────────────────────────
  try {
    if (typeof AudioContext !== 'undefined') {
      var _origAC = AudioContext;
      window.AudioContext = _markNative(function(opts) {
        return opts ? new _origAC(opts) : new _origAC({ sampleRate: 48000 });
      });
      window.AudioContext.prototype = _origAC.prototype;
      try { Object.setPrototypeOf(window.AudioContext, _origAC); } catch(e) {}
    }
  } catch(e) {}

  // ── 11. Battery API — P0: charging:true level:1.0 is the headless tell ────
  try {
    Object.defineProperty(navigator, 'getBattery', {
      value: _markNative(function() {
        return Promise.resolve({
          charging: false, level: 0.74, chargingTime: Infinity, dischargingTime: 9360,
          addEventListener: function() {}, removeEventListener: function() {}, dispatchEvent: function() { return false; },
        });
      }),
      configurable: true, writable: true,
    });
  } catch(e) {}

  // ── 12. WebRTC IP protection — P0: full candidate + SDP rewrite ──────────
  try {
    if (typeof RTCPeerConnection !== 'undefined') {
      var _origRTC = RTCPeerConnection;
      var _ip4re = /(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)/g;
      var _ip6re = /(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,5}(?::[0-9A-Fa-f]{1,4}){1,2}|(?:[0-9A-Fa-f]{1,4}:){1,4}(?::[0-9A-Fa-f]{1,4}){1,3}|(?:[0-9A-Fa-f]{1,4}:){1,3}(?::[0-9A-Fa-f]{1,4}){1,4}|(?:[0-9A-Fa-f]{1,4}:){1,2}(?::[0-9A-Fa-f]{1,4}){1,5}|[0-9A-Fa-f]{1,4}:(?::[0-9A-Fa-f]{1,4}){1,6}|::(?:[fF]{4}(?::0{1,4})?:)?(?:(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])\\.){3}(?:25[0-5]|(?:2[0-4]|1?[0-9])?[0-9])/g;
      var _isSpecialIP = function(ip) {
        return ip === '0.0.0.0' || ip === '127.0.0.1' || ip === '::' || ip === '::1'
          || /^169\\.254\\./.test(ip) || /^fe80/i.test(ip);
      };
      var _maskStr = function(s) {
        _ip4re.lastIndex = 0; _ip6re.lastIndex = 0;
        return s
          .replace(_ip4re, function(ip) { return _isSpecialIP(ip) ? ip : '0.0.0.0'; })
          .replace(_ip6re, function(ip) { return _isSpecialIP(ip) ? ip : '::'; });
      };
      window.RTCPeerConnection = _markNative(function(config, constraints) {
        var pc = new _origRTC(config, constraints);
        var _iceHandler = null;
        Object.defineProperty(pc, 'onicecandidate', {
          get: function() { return _iceHandler; },
          set: function(fn) {
            _iceHandler = fn ? _markNative(function(ev) {
              if (ev && ev.candidate && ev.candidate.candidate) {
                var masked = _maskStr(ev.candidate.candidate);
                var fakeCand = Object.assign({}, ev.candidate, { candidate: masked });
                fn.call(this, Object.assign({}, ev, { candidate: fakeCand }));
              } else { fn.call(this, ev); }
            }) : fn;
          },
          configurable: true,
        });
        var _origSLD = pc.setLocalDescription;
        pc.setLocalDescription = _markNative(function(description) {
          if (description && description.sdp) {
            return _origSLD.call(this, Object.assign({}, description, { sdp: _maskStr(description.sdp) }));
          }
          return _origSLD.apply(this, arguments);
        });
        var _origGetStats = pc.getStats;
        pc.getStats = _markNative(function() {
          return _origGetStats.apply(this, arguments).then(function(stats) {
            stats.forEach(function(report) {
              if (report.type === 'local-candidate' && report.address && !_isSpecialIP(report.address)) {
                try { report.address = '0.0.0.0'; } catch(e) {}
              }
            });
            return stats;
          });
        });
        return pc;
      });
      window.RTCPeerConnection.prototype = _origRTC.prototype;
      try { Object.setPrototypeOf(window.RTCPeerConnection, _origRTC); } catch(e) {}
    }
  } catch(e) {}

  // ── 13. Screen metrics ─────────────────────────────────────────────────────
  try {
    if (!screen.width)        Object.defineProperty(screen, 'width',       { get: _markNative(() => 1920), configurable: true });
    if (!screen.height)       Object.defineProperty(screen, 'height',      { get: _markNative(() => 1080), configurable: true });
    if (!screen.availWidth)   Object.defineProperty(screen, 'availWidth',  { get: _markNative(() => 1920), configurable: true });
    if (!screen.availHeight)  Object.defineProperty(screen, 'availHeight', { get: _markNative(() => 1040), configurable: true });
    if (!screen.colorDepth || screen.colorDepth < 24)
      Object.defineProperty(screen, 'colorDepth',  { get: _markNative(() => 24), configurable: true });
    if (!screen.pixelDepth || screen.pixelDepth < 24)
      Object.defineProperty(screen, 'pixelDepth',  { get: _markNative(() => 24), configurable: true });
  } catch(e) {}

  // ── 14. navigator platform / hardwareConcurrency / deviceMemory / oscpu ──
  try { Object.defineProperty(navigator, 'platform',             { get: _markNative(() => 'MacIntel'), configurable: true }); } catch(e) {}
  try { Object.defineProperty(navigator, 'hardwareConcurrency',  { get: _markNative(() => 8),          configurable: true }); } catch(e) {}
  try { Object.defineProperty(navigator, 'deviceMemory',         { get: _markNative(() => 8),          configurable: true }); } catch(e) {}
  try {
    if (typeof navigator.oscpu !== 'undefined') {
      Object.defineProperty(navigator, 'oscpu', { get: _markNative(() => undefined), configurable: true });
    }
  } catch(e) {}

  // ── 15. Intl.DateTimeFormat timezone + Date.getTimezoneOffset ────────────
  try {
    var _origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = _markNative(function() {
      var opts = _origResolved.call(this);
      if (opts && opts.timeZone === 'UTC') opts.timeZone = 'America/New_York';
      return opts;
    });
  } catch(e) {}
  try {
    var _origGetTZO = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function() {
      var real = _origGetTZO.call(this);
      if (real === 0) return 300;
      return real;
    };
    _wrapped.add(Date.prototype.getTimezoneOffset);
  } catch(e) {}

  // ── 16. window.history.length ─────────────────────────────────────────────
  try {
    if (window.history && window.history.length <= 1) {
      Object.defineProperty(window.history, 'length', { get: _markNative(() => 3), configurable: true });
    }
  } catch(e) {}

  // ── 17. Automation marker removal ─────────────────────────────────────────
  try {
    ['$cdc_asdjflasutopfhvcZLmcfl_', '__webdriver_script_fn', '__lastWatirAlert',
     '__selenium_evaluate', '__selenium_unwrapped', '__driver_evaluate',
     '__driver_unwrapped', '__webdriver_evaluate', 'callSelenium',
     '_Selenium_IDE_Recorder', '__pw_manual_'].forEach(function(k) {
      try { if (window[k] !== undefined) delete window[k]; } catch(e) {}
    });
  } catch(e) {}

  // ── 18. Function.prototype.toString ──────────────────────────────────────
  try {
    var _origToString = Function.prototype.toString;
    var _nativeStr = function(fn) {
      var name = (fn && fn.name) || '';
      return 'function ' + name + '() { [native code] }';
    };
    Function.prototype.toString = function() {
      if (_wrapped.has(this)) return _nativeStr(this);
      return _origToString.call(this);
    };
    _wrapped.add(Function.prototype.toString);
  } catch(e) {}
})()`;
