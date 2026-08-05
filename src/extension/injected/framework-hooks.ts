// Pre-load framework hooks — injected BEFORE frameworks load via Page.addScriptToEvaluateOnNewDocument
// Captures initialization data (hydration, SSR payloads, renderer info)
// Must remain a self-contained string (no imports, no closures)
export const FRAMEWORK_HOOK_SCRIPT = `(function() {
  if (window.__CRAWLIO_HOOKS_INSTALLED__) return;
  Object.defineProperty(window, '__CRAWLIO_HOOKS_INSTALLED__', { value: true, enumerable: false, configurable: true });
  Object.defineProperty(window, '__CRAWLIO_FRAMEWORK_DATA__', { value: {}, enumerable: false, configurable: true, writable: true });

  // React: install hook before React loads
  if (!window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    var hook = {
      renderers: new Map(),
      supportsFiber: true,
      inject: function(renderer) {
        var id = hook.renderers.size + 1;
        hook.renderers.set(id, renderer);
        window.__CRAWLIO_FRAMEWORK_DATA__.react = {
          version: renderer.version || null,
          bundleType: renderer.bundleType,
          rendererCount: hook.renderers.size,
        };
        return id;
      },
      onCommitFiberRoot: function() {},
      onCommitFiberUnmount: function() {},
    };
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  }

  // Vue: install hook before Vue loads
  if (!window.__VUE_DEVTOOLS_GLOBAL_HOOK__) {
    var vueHook = { Vue: null, apps: [], _buffer: [] };
    vueHook.emit = function(event) {
      if (event === 'app:init' && arguments[1]) {
        window.__CRAWLIO_FRAMEWORK_DATA__.vue = {
          version: arguments[1].version || null,
          appCount: vueHook.apps.length + 1,
        };
      }
      if (vueHook._buffer.length >= 100) vueHook._buffer.shift();
      vueHook._buffer.push({ event: event, args: Array.prototype.slice.call(arguments, 1) });
    };
    vueHook.on = function() {};
    vueHook.once = function() {};
    vueHook.off = function() {};
    window.__VUE_DEVTOOLS_GLOBAL_HOOK__ = vueHook;
  }

  // Next.js: intercept __NEXT_DATA__ assignment
  var _nextData;
  try {
    Object.defineProperty(window, '__NEXT_DATA__', {
      set: function(v) {
        _nextData = v;
        if (v) window.__CRAWLIO_FRAMEWORK_DATA__.nextjs = { buildId: v.buildId, page: v.page };
      },
      get: function() { return _nextData; },
      configurable: true,
    });
  } catch(e) {}

  // Nuxt: intercept __NUXT__ assignment
  var _nuxtData;
  try {
    Object.defineProperty(window, '__NUXT__', {
      set: function(v) {
        _nuxtData = v;
        if (v) window.__CRAWLIO_FRAMEWORK_DATA__.nuxt = { serverRendered: !!v.serverRendered };
      },
      get: function() { return _nuxtData; },
      configurable: true,
    });
  } catch(e) {}
})()`;
