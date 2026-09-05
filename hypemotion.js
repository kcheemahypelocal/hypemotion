(function () {
  "use strict";

  var VERSION = "2.5.0";
  var LIB = "HypeMotion";

  // 
  // 0. INSTANT HIDE — runs synchronously at parse time
  //    to prevent flash of visible content before init()
  // 

  (function earlyHide() {
    // Avoid double-injection on reinit
    if (document.getElementById("hm-early-hide")) return;
    var s = document.createElement("style");
    s.id = "hm-early-hide";
    s.textContent = [
      // Hide ALL animated elements instantly from first paint.
      // Excludes parallax (no visibility change) and counter (shows "0").
      "[data-animate]:not([data-animate='parallax']):not([data-animate='counter']) {",
      "  opacity: 0 !important; }",
      // This stylesheet is removed once init() finishes, so it",
      // won't interfere with animations.  If JS fails, the",
      // FOIC fallback timeout forces everything visible anyway.",
    ].join("\n");
    // Insert into <head> or <html> — works even before <head> exists
    (document.head || document.documentElement).appendChild(s);
  })();

  // 
  // 1. CONFIGURATION
  // 

  var CONFIG = {
    duration: 0.8,
    ease: "power3.out",
    cssEase: "cubic-bezier(0.33, 1, 0.68, 1)",
    distance: 40,
    stagger: 0.08,
    delay: 0,
    scrollStart: "top 80%",
    observerThreshold: 0.15,
    observerMargin: "0px 0px -20% 0px",
    once: true,
    parallaxSpeed: 0.2,
    foicTimeout: 4000,
    // Max time to wait for webfonts before measuring text splits.
    // Measuring in a fallback font bakes in the wrong line breaks.
    fontTimeout: 1500,
    // Splits are re-measured after a width change (rotation, resize).
    resizeDebounce: 250,
    // Retry gap when a re-measure lands while a split is still animating.
    rebuildRetry: 400,
    // Window in which stagger-children collects elements entering the
    // viewport into one batch. Roughly "arrived together".
    batchInterval: 0.1,
    // Longest a single stagger cascade may run, however large the batch.
    staggerMaxTotal: 1.2,
    gsapCDN: "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5",
  };

  var CSS_TIER = [
    "fade-up", "fade-down", "fade-left",
    "fade-right", "fade-in", "scale-in", "reveal-up",
  ];
  var GSAP_TIER = [
    "split-lines", "split-words", "split-chars",
    "img-reveal", "stagger-children", "counter",
    "draw-line", "parallax", "hero-text", "hero-image",
  ];

  // 
  // 2. STATE
  // 

  var state = {
    initialized: false,
    gsapLoaded: false,
    gsapLoading: false,
    gsapPromise: null,
    reducedMotion: false,
    triggers: [],
    observers: [],
    listeners: [],
    mutationObs: null,
    processedEls: new WeakSet(),

    // Split-text bookkeeping. Splits destroy and rebuild the DOM of the
    // element they run on, so we keep the pristine markup to restore from
    // and re-measure against whenever layout changes underneath us.
    splits: [],
    originalHTML: new WeakMap(),
    resizeBound: false,
    lastWidth: 0,
    rebuildRetry: null,

    // stagger-children containers, kept so children added after init
    // (CMS collections, "load more", filter re-renders) still animate.
    staggers: [],

    // The single IntersectionObserver driving the CSS tier. Kept separate
    // from state.observers (which is teardown-only and mixes observer types).
    cssObserver: null,

    // Teardown handles.
    styles: [],
    foicTimer: null,

    // Timestamp of the last DOM mutation we caused ourselves, so the CMS
    // observer doesn't chase its own tail when a split rewrites innerHTML.
    lastSelfMutation: 0,
  };

  //   // 3. UTILITIES
  // 
  
  function attr(el, name, fallback) {
    var v = el.getAttribute("data-hm-" + name);
    if (v === null) {
      v = el.getAttribute("data-" + name);
    }
    if (v === null) return fallback;
    if (v === "true") return true;
    if (v === "false") return false;
    var n = parseFloat(v);
    return isNaN(n) ? v : n;
  }

  function rawAttr(el, name, fallback) {
    var v = el.getAttribute("data-" + name);
    if (v === null) return fallback;
    if (v === "true") return true;
    if (v === "false") return false;
    var n = parseFloat(v);
    return isNaN(n) ? v : n;
  }

  function addListener(el, evt, fn) {
    el.addEventListener(evt, fn);
    state.listeners.push({ el: el, evt: evt, fn: fn });
  }

  function warn(msg) {
    console.warn("[" + LIB + "] " + msg);
  }

  function log(msg) {
    console.log("[" + LIB + " v" + VERSION + "] " + msg);
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, ms);
    };
  }

  function isInViewport(el) {
    var rect = el.getBoundingClientRect();
    return (
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    );
  }

  // How an element should start out, decided once at init.
  //
  //   "played"  - already scrolled past. Show it immediately: waiting for an
  //               observer that will never fire leaves it blank forever on a
  //               reload that restores scroll position.
  //   "enter"   - inside (or near) the viewport. Animate it now, so the CSS
  //               tier matches the GSAP tier, whose already-passed
  //               ScrollTriggers fire on the first refresh.
  //   "observe" - below the fold. Hand it to the observer.
  //
  // The 0.8 threshold mirrors CONFIG.observerMargin ("0px 0px -20% 0px"), so
  // an element never lands in "enter" that the observer would have ignored.
  function initialPosition(el) {
    var rect = el.getBoundingClientRect();
    if (rect.bottom <= 0) return "played";
    if (rect.top < window.innerHeight * 0.8) return "enter";
    return "observe";
  }

  // Text splitting depends on getBoundingClientRect(), which returns zeroes
  // for anything display:none or not yet laid out (closed tabs, unopened
  // sliders, lazy sections). Splitting there collapses every word onto one
  // "line" and wrecks the layout, so we defer instead.
  function isMeasurable(el) {
    if (!el || !el.isConnected) return false;
    if (el.getBoundingClientRect().width < 1) return false;
    if (!el.offsetParent) {
      // offsetParent is legitimately null for position:fixed subtrees.
      if (window.getComputedStyle(el).position !== "fixed") return false;
    }
    return true;
  }

  // Words on the same visual line share a top within sub-pixel noise, but
  // superscripts and mixed font sizes drift a few px. Half a line-height
  // separates "same line" from "next line" at any type size.
  function lineTolerance(el) {
    var cs = window.getComputedStyle(el);
    var lh = parseFloat(cs.lineHeight);
    if (isNaN(lh)) lh = (parseFloat(cs.fontSize) || 16) * 1.2;
    return Math.max(4, lh * 0.5);
  }

  // Resolves once webfonts have settled, or after CONFIG.fontTimeout if they
  // stall. Never rejects: a font that fails to load must not block animation.
  function whenFontsReady(cb) {
    var done = false;
    function go() {
      if (done) return;
      done = true;
      cb();
    }
    if (!document.fonts || !document.fonts.ready) return go();
    var t = setTimeout(go, CONFIG.fontTimeout);
    document.fonts.ready
      .then(function () { clearTimeout(t); go(); })
      .catch(function () { clearTimeout(t); go(); });
  }

  function setWillChange(els, value) {
    for (var i = 0; i < els.length; i++) {
      els[i].style.willChange = value;
    }
  }

  function markSelfMutation() {
    state.lastSelfMutation = Date.now();
  }

  // ── GSAP helpers ───────────────────────────────────────
  
  function getScrollStart(el) {
    return rawAttr(el, "scroll-start", CONFIG.scrollStart);
  }

  function getOnce(el) {
    return attr(el, "once", CONFIG.once);
  }

  function getDuration(el, fallback) {
    var v = el.getAttribute("data-hm-duration");
    if (v !== null) {
      var n = parseFloat(v);
      return isNaN(n) ? fallback : n;
    }
    return fallback;
  }

  function getDelay(el) {
    var v = el.getAttribute("data-hm-delay");
    if (v !== null) {
      var n = parseFloat(v);
      return isNaN(n) ? CONFIG.delay : n;
    }
    return CONFIG.delay;
  }

  function getDistance(el) {
    var v = el.getAttribute("data-hm-distance");
    if (v !== null) {
      var n = parseFloat(v);
      return isNaN(n) ? CONFIG.distance : n;
    }
    return CONFIG.distance;
  }

  function getStagger(el, fallback) {
    var v = el.getAttribute("data-hm-stagger");
    if (v !== null) {
      var n = parseFloat(v);
      return isNaN(n) ? fallback : n;
    }
    return fallback;
  }

  function getEase(el, fallback) {
    var v = el.getAttribute("data-hm-ease");
    return v || fallback;
  }

  function scrollCfg(el) {
    return {
      trigger: el,
      start: getScrollStart(el),
      toggleActions: getOnce(el)
        ? "play none none none"
        : "play none none reverse",
    };
  }

  function trackTrigger(tween) {
    if (tween && tween.scrollTrigger) {
      state.triggers.push(tween.scrollTrigger);
    }
  }

  // Splits are torn down and rebuilt on every width change; without this the
  // triggers array would grow by one entry per split per resize.
  function untrackTrigger(tween) {
    if (!tween || !tween.scrollTrigger) return;
    var i = state.triggers.indexOf(tween.scrollTrigger);
    if (i > -1) state.triggers.splice(i, 1);
  }

  function fadeVars(el, dir) {
    var d = getDistance(el);
    var base = {
      opacity: 0,
      duration: getDuration(el, CONFIG.duration),
      ease: getEase(el, CONFIG.ease),
      delay: getDelay(el),
    };
    if (dir === "up") { base.y = d; }
    else if (dir === "down") { base.y = -d; }
    else if (dir === "left") { base.x = -d; }
    else if (dir === "right") { base.x = d; }
    return base;
  }

  function setInitialState(el, dir) {
    var d = getDistance(el);
    var props = { opacity: 0 };
    if (dir === "up") { props.y = d; }
    else if (dir === "down") { props.y = -d; }
    else if (dir === "left") { props.x = -d; }
    else if (dir === "right") { props.x = d; }
    primeWillChange(el);
    gsap.set(el, props);
  }

// ════════════════════════════════════════════════════════
  // 4. SAFETY SYSTEMS
  // ════════════════════════════════════════════════════════
  
  function injectSafetyCSS() {
    var style = document.createElement("style");
    style.id = "hm-safety-css";
    style.textContent = [
      // Promote animated elements for GPU compositing during loading.
      //
      // Scoped to .hm-loading deliberately. A permanent will-change keeps
      // every animated element on its own compositing layer for the life of
      // the page, which drops text off subpixel antialiasing and holds GPU
      // memory that is never reclaimed. Past this phase each animation
      // primes and releases will-change around its own tween.
      ".hm-loading [data-animate]:not([data-animate='parallax']):not([data-animate='counter']) {",
      "  will-change: transform, opacity; }",
      // Force visible if something goes wrong (timeout fallback)
      ".hm-fallback [data-animate] {",
      "  opacity: 1 !important;",
      "  transform: none !important;",
      "  clip-path: none !important;",
      "  will-change: auto !important; }",
    ].join("\n");
    document.head.appendChild(style);
    state.styles.push(style);
  }

  function enableFOICFallback() {
    state.foicTimer = setTimeout(function () {
      if (!state.initialized) {
        document.documentElement.classList.add("hm-fallback");
        // Remove early-hide so fallback can force everything visible
        var earlyHide = document.getElementById("hm-early-hide");
        if (earlyHide) earlyHide.parentNode.removeChild(earlyHide);
        warn("Init timeout — fallback activated, content forced visible.");
      }
    }, CONFIG.foicTimeout);
  }

  function checkReducedMotion() {
    var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    state.reducedMotion = mq.matches;
    mq.addEventListener("change", function (e) {
      state.reducedMotion = e.matches;
      if (e.matches) { log("Reduced motion enabled."); }
    });
  }

  function shouldAnimate(el) {
    if (!state.reducedMotion) return true;
    return el.getAttribute("data-motion") === "essential";
  }

  function checkConflicts(el) {
    if (el.getAttribute("data-w-id")) {
      warn(
        "Conflict: element has both data-animate and Webflow Interaction " +
        "(data-w-id). Remove the Webflow Interaction or the data-animate " +
        "attribute. Element: " + (el.className || el.tagName)
      );
    }
  }

  // Hint the compositor just before a tween starts. Paired with
  // clearWillChange so the promotion lasts only as long as the animation.
  function primeWillChange(el, props) {
    el.style.willChange = props || "transform, opacity";
  }

  // Clean up will-change after animation completes to free GPU memory
  function clearWillChange(el) {
    el.style.willChange = "auto";
  }

// ════════════════════════════════════════════════════════
  // 5. CSS TIER
  // ════════════════════════════════════════════════════════
  
  function injectCSSTier() {
    var style = document.createElement("style");
    style.id = "hm-css-animations";
    style.textContent = [
      // ── Keyframes ──
      "@keyframes hm-fade-up {",
      "  from { opacity:0; transform:translate3d(0,var(--hm-dist,40px),0); }",
      "  to { opacity:1; transform:translate3d(0,0,0); } }",

      "@keyframes hm-fade-down {",
      "  from { opacity:0; transform:translate3d(0,calc(var(--hm-dist,40px) * -1),0); }",
      "  to { opacity:1; transform:translate3d(0,0,0); } }",

      "@keyframes hm-fade-left {",
      "  from { opacity:0; transform:translate3d(calc(var(--hm-dist,40px) * -1),0,0); }",
      "  to { opacity:1; transform:translate3d(0,0,0); } }",

      "@keyframes hm-fade-right {",
      "  from { opacity:0; transform:translate3d(var(--hm-dist,40px),0,0); }",
      "  to { opacity:1; transform:translate3d(0,0,0); } }",

      "@keyframes hm-fade-in {",
      "  from { opacity:0; }",
      "  to { opacity:1; } }",

      "@keyframes hm-scale-in {",
      "  from { opacity:0; transform:scale3d(0.9,0.9,1); }",
      "  to { opacity:1; transform:scale3d(1,1,1); } }",

      "@keyframes hm-reveal-up {",
      "  from { clip-path:inset(100% 0% 0% 0%); }",
      "  to { clip-path:inset(0% 0% 0% 0%); } }",

      // ── Pre-animation: set initial state with transform to avoid jump ──
      "[data-animate='fade-up']:not(.hm-in):not(.hm-visible) {",
      "  opacity:0; transform:translate3d(0,var(--hm-dist,40px),0); }",
      "[data-animate='fade-down']:not(.hm-in):not(.hm-visible) {",
      "  opacity:0; transform:translate3d(0,calc(var(--hm-dist,40px) * -1),0); }",
      "[data-animate='fade-left']:not(.hm-in):not(.hm-visible) {",
      "  opacity:0; transform:translate3d(calc(var(--hm-dist,40px) * -1),0,0); }",
      "[data-animate='fade-right']:not(.hm-in):not(.hm-visible) {",
      "  opacity:0; transform:translate3d(var(--hm-dist,40px),0,0); }",
      "[data-animate='fade-in']:not(.hm-in):not(.hm-visible) {",
      "  opacity:0; }",
      "[data-animate='scale-in']:not(.hm-in):not(.hm-visible) {",
      "  opacity:0; transform:scale3d(0.9,0.9,1); }",
      "[data-animate='reveal-up']:not(.hm-in):not(.hm-visible) {",
      "  clip-path:inset(100% 0% 0% 0%); }",

      // ── Animation classes ──
      ".hm-in[data-animate='fade-up'] {",
      "  will-change:transform,opacity;",
      "  animation:hm-fade-up var(--hm-dur,0.8s) var(--hm-ease,cubic-bezier(0.33,1,0.68,1)) var(--hm-del,0s) both; }",

      ".hm-in[data-animate='fade-down'] {",
      "  will-change:transform,opacity;",
      "  animation:hm-fade-down var(--hm-dur,0.8s) var(--hm-ease,cubic-bezier(0.33,1,0.68,1)) var(--hm-del,0s) both; }",

      ".hm-in[data-animate='fade-left'] {",
      "  will-change:transform,opacity;",
      "  animation:hm-fade-left var(--hm-dur,0.8s) var(--hm-ease,cubic-bezier(0.33,1,0.68,1)) var(--hm-del,0s) both; }",

      ".hm-in[data-animate='fade-right'] {",
      "  will-change:transform,opacity;",
      "  animation:hm-fade-right var(--hm-dur,0.8s) var(--hm-ease,cubic-bezier(0.33,1,0.68,1)) var(--hm-del,0s) both; }",

      ".hm-in[data-animate='fade-in'] {",
      "  will-change:opacity;",
      "  animation:hm-fade-in var(--hm-dur,0.8s) var(--hm-ease,cubic-bezier(0.33,1,0.68,1)) var(--hm-del,0s) both; }",

      ".hm-in[data-animate='scale-in'] {",
      "  will-change:transform,opacity;",
      "  animation:hm-scale-in var(--hm-dur,0.8s) var(--hm-ease,cubic-bezier(0.33,1,0.68,1)) var(--hm-del,0s) both; }",

      ".hm-in[data-animate='reveal-up'] {",
      "  will-change:clip-path;",
      "  animation:hm-reveal-up var(--hm-dur,1s) cubic-bezier(0.76,0,0.24,1) var(--hm-del,0s) both; }",

      // ── Above fold: already visible elements ──
      ".hm-visible[data-animate] {",
      "  opacity:1 !important; transform:none !important; clip-path:none !important; }",

      // ── Clean up will-change after animation ends ──
      ".hm-done[data-animate] {",
      "  will-change:auto; }",

      // ── Reduced motion ──
      "@media (prefers-reduced-motion:reduce) {",
      "  [data-animate]:not([data-motion='essential']) {",
      "    animation-duration:0.01ms !important;",
      "    transition-duration:0.01ms !important; }",
      "  .hm-in[data-animate]:not([data-motion='essential']) {",
      "    opacity:1; transform:none; clip-path:none; } }",
    ].join("\n");
    document.head.appendChild(style);
    state.styles.push(style);
  }

  function applyCSSOverrides(el) {
    var d = el.getAttribute("data-hm-duration");
    var del = el.getAttribute("data-hm-delay");
    var dist = el.getAttribute("data-hm-distance");
    if (d) { el.style.setProperty("--hm-dur", d + "s"); }
    if (del) { el.style.setProperty("--hm-del", del + "s"); }
    if (dist) { el.style.setProperty("--hm-dist", dist + "px"); }
  }

  // Starts a CSS-tier animation and releases will-change once it ends.
  function enterCSS(el) {
    el.classList.add("hm-in");
    el.addEventListener("animationend", function onEnd() {
      el.removeEventListener("animationend", onEnd);
      el.classList.add("hm-done");
    });
  }

  function initCSSTier(elements) {
    if (!elements.length) return;

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            var el = entry.target;
            enterCSS(el);

            if (getOnce(el)) {
              observer.unobserve(el);
            }
          } else {
            if (!getOnce(entry.target)) {
              entry.target.classList.remove("hm-in");
              entry.target.classList.remove("hm-done");
            }
          }
        });
      },
      {
        rootMargin: CONFIG.observerMargin,
        threshold: CONFIG.observerThreshold,
      }
    );

    elements.forEach(function (el) {
      if (state.reducedMotion && !shouldAnimate(el)) {
        el.style.opacity = "1";
        return;
      }

      applyCSSOverrides(el);

      var pos = initialPosition(el);
      if (pos === "played") {
        // Above the viewport already. Show it outright — its observer would
        // never fire, leaving it invisible for the rest of the session.
        el.classList.add("hm-visible");
      } else if (pos === "enter") {
        // In view at load. Animate rather than snap, so above-the-fold
        // content behaves the same as the GSAP tier does.
        enterCSS(el);
      } else {
        observer.observe(el);
      }
    });

    state.cssObserver = observer;
    state.observers.push(observer);
  }


  // ════════════════════════════════════════════════════════
  // 6. GSAP LOADER
  // ════════════════════════════════════════════════════════
  
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error("Failed to load: " + src));
      };
      document.head.appendChild(s);
    });
  }

  // Mobile browsers resize the viewport as the URL bar hides and shows.
  // Left alone, ScrollTrigger recalculates on every one of those, which
  // makes scroll-driven animations stutter and re-fire while scrolling.
  var stConfigured = false;

  function configureScrollTrigger() {
    if (stConfigured || !window.ScrollTrigger || !ScrollTrigger.config) return;
    stConfigured = true;

    ScrollTrigger.config({ ignoreMobileResize: true });

    // Row offsets for stagger-children are cached per refresh; a refresh is
    // exactly when the layout may have moved underneath them.
    if (ScrollTrigger.addEventListener) {
      ScrollTrigger.addEventListener("refreshInit", function () { rowTick++; });
    }
  }

  function loadGSAP() {
    if (state.gsapLoaded) return Promise.resolve();
    if (state.gsapLoading) return state.gsapPromise;

    if (window.gsap && window.ScrollTrigger) {
      state.gsapLoaded = true;
      gsap.registerPlugin(ScrollTrigger);
      configureScrollTrigger();
      log("Using existing GSAP on page.");
      return Promise.resolve();
    }

    if (window.gsap && !window.ScrollTrigger) {
      state.gsapLoading = true;
      state.gsapPromise = loadScript(CONFIG.gsapCDN + "/ScrollTrigger.min.js")
        .then(function () {
          gsap.registerPlugin(ScrollTrigger);
          state.gsapLoaded = true;
          state.gsapLoading = false;
          log("ScrollTrigger loaded (GSAP was already present).");
        })
        .catch(function (err) {
          state.gsapLoading = false;
          warn("ScrollTrigger failed to load: " + err.message);
          document.documentElement.classList.add("hm-fallback");
        });
      return state.gsapPromise;
    }

    state.gsapLoading = true;
    state.gsapPromise = loadScript(CONFIG.gsapCDN + "/gsap.min.js")
      .then(function () {
        return loadScript(CONFIG.gsapCDN + "/ScrollTrigger.min.js");
      })
      .then(function () {
        gsap.registerPlugin(ScrollTrigger);
        configureScrollTrigger();
        state.gsapLoaded = true;
        state.gsapLoading = false;
        log("GSAP + ScrollTrigger loaded dynamically.");
      })
      .catch(function (err) {
        state.gsapLoading = false;
        warn("GSAP failed to load: " + err.message);
        document.documentElement.classList.add("hm-fallback");
      });

    return state.gsapPromise;
  }


  // ════════════════════════════════════════════════════════
  // 7. TEXT SPLITTER
  // ════════════════════════════════════════════════════════
  
  // Elements that carry meaning with no text of their own. A line containing
  // only one of these still has content and must not be pruned away.
  var VOID_CONTENT = /^(IMG|SVG|VIDEO|CANVAS|INPUT|PICTURE|IFRAME|OBJECT|EMBED)$/;

  function splitContent(el, type) {
    // Splitting scatters the text across dozens of spans. Naming the element
    // keeps it as one coherent announcement. Skipped when the element holds
    // focusable children, because aria-label on an ancestor would mask their
    // own accessible names.
    if (!el.querySelector("a, button, input, select, textarea, [tabindex]")) {
      el.setAttribute("aria-label", el.textContent.replace(/\s+/g, " ").trim());
    }

    if (type === "lines") return splitLines(el);
    if (type === "words") return splitWords(el);
    if (type === "chars") return splitChars(el);
    return null;
  }

  // Wraps every token (word AND whitespace run) of el's text in an indexed
  // probe span, in place, without disturbing the surrounding markup.
  //
  // Whitespace gets a probe too, even though it is never measured: it means a
  // line is a contiguous index range, so rebuilding a line preserves the
  // author's exact spacing instead of us guessing where to re-insert " ".
  function markTokens(el) {
    var idx = 0;
    var words = [];

    walkTextNodes(el, function (textNode) {
      var text = textNode.textContent;
      if (!text) return;

      var frag = document.createDocumentFragment();
      text.split(/(\s+)/).forEach(function (piece) {
        if (!piece) return;
        var s = document.createElement("span");
        s.className = "hm-measure";
        s.style.display = "inline";
        s.setAttribute("data-hm-i", idx);
        s.textContent = piece;
        frag.appendChild(s);
        if (!/^\s+$/.test(piece)) words.push({ node: s, i: idx });
        idx++;
      });
      textNode.parentNode.replaceChild(frag, textNode);
    });

    return words;
  }

  // Reads probes and <br> elements back in document order. A separate pass is
  // needed because <br> is not a text node, so markTokens never sees it, yet
  // its position between words decides where lines break.
  function orderedTokens(el) {
    var out = [];
    var walker = document.createTreeWalker(
      el, NodeFilter.SHOW_ELEMENT, null, false
    );
    while (walker.nextNode()) {
      var n = walker.currentNode;
      if (n.nodeName === "BR") {
        out.push({ br: true });
      } else if (n.classList && n.classList.contains("hm-measure")) {
        if (/^\s*$/.test(n.textContent)) continue;
        out.push({ br: false, node: n, i: +n.getAttribute("data-hm-i") });
      }
    }
    return out;
  }

  function unwrapMeasures(root) {
    var probes = root.querySelectorAll(".hm-measure");
    for (var i = 0; i < probes.length; i++) {
      var p = probes[i];
      var parent = p.parentNode;
      while (p.firstChild) parent.insertBefore(p.firstChild, p);
      parent.removeChild(p);
    }
    if (root.normalize) root.normalize();
  }

  // Drops wrappers left hollow after the out-of-range tokens were removed —
  // e.g. a <span class="accent"> whose words all belong to a different line.
  // Bottom-up so a wrapper emptied by this pass is itself reconsidered.
  function pruneEmpty(root) {
    var els = Array.prototype.slice.call(root.querySelectorAll("*"));
    for (var i = els.length - 1; i >= 0; i--) {
      var e = els[i];
      if (e.classList && e.classList.contains("hm-measure")) continue;
      if (VOID_CONTENT.test(e.nodeName)) continue;
      if (e.querySelector(".hm-measure")) continue;
      if (e.textContent.trim()) continue;
      if (e.querySelector("img,svg,video,canvas,input,picture,iframe")) continue;
      if (e.parentNode) e.parentNode.removeChild(e);
    }
  }

  // Each line is cut from a full clone, so an id inside the split text would
  // otherwise be duplicated once per line. First line wins; later ones lose
  // the attribute rather than the element.
  function dedupeIds(root, seen) {
    var ided = root.querySelectorAll("[id]");
    for (var i = 0; i < ided.length; i++) {
      var id = ided[i].id;
      if (seen[id]) ided[i].removeAttribute("id");
      else seen[id] = true;
    }
  }

  // Builds one line as a fragment that keeps the full ancestor chain.
  //
  // Deep-cloning the whole element and subtracting the tokens that belong to
  // other lines is what preserves markup: a wrapper spanning two lines is
  // reproduced in both, each holding only its own share of the words. Range
  // extraction cannot do this — the DOM spec drops the range's common
  // ancestor, so a heading wrapped entirely in one <span> would lose it.
  function buildLineFragment(el, fromIdx, toIdx, seenIds) {
    var clone = el.cloneNode(true);

    // Line structure is explicit from here on; author <br>s would double it.
    var brs = clone.querySelectorAll("br");
    for (var i = 0; i < brs.length; i++) {
      brs[i].parentNode.removeChild(brs[i]);
    }

    var probes = clone.querySelectorAll(".hm-measure");
    for (var j = 0; j < probes.length; j++) {
      var p = probes[j];
      var n = +p.getAttribute("data-hm-i");
      var keep = n >= fromIdx && n <= toIdx;

      // Also keep the whitespace that followed the line's last word. Lines
      // are separate blocks visually, but textContent concatenates them, so
      // without this the text copies out as "...epsilonzeta". A trailing
      // space at the end of a line box is not rendered, so it costs nothing.
      if (!keep && n === toIdx + 1 && /^\s+$/.test(p.textContent)) keep = true;

      if (!keep) p.parentNode.removeChild(p);
    }

    pruneEmpty(clone);
    dedupeIds(clone, seenIds);
    unwrapMeasures(clone);

    var frag = document.createDocumentFragment();
    while (clone.firstChild) frag.appendChild(clone.firstChild);
    return frag;
  }

  function makeLineMask() {
    var outer = document.createElement("span");
    outer.className = "hm-line-mask";
    outer.style.display = "block";
    outer.style.overflow = "hidden";
    // Bottom padding prevents descender clipping (g, y, p, etc.);
    // negative margin keeps visual layout unchanged.
    outer.style.paddingBottom = "0.15em";
    outer.style.marginBottom = "-0.15em";
    return outer;
  }

  // Splits into visual lines, preserving every wrapper, class and attribute.
  //
  // Author <br>s need no special case: the words after one measure to a new
  // top, so the same measurement pass that detects natural wrapping detects
  // them too. Only consecutive <br>s need explicit handling, since a blank
  // line has no word to measure.
  function splitLines(el) {
    var words = markTokens(el);
    if (!words.length) {
      unwrapMeasures(el);
      return null;
    }

    var tol = lineTolerance(el);
    var lines = [];        // {from, to} index ranges; null = blank spacer line
    var cur = null;
    var curTop = null;
    var afterBreak = false;

    orderedTokens(el).forEach(function (t) {
      if (t.br) {
        if (cur) {
          lines.push(cur);
          cur = null;
          curTop = null;
        } else if (afterBreak) {
          // <br><br> with no word between: an intentional vertical gap.
          lines.push(null);
        }
        afterBreak = true;
        return;
      }

      afterBreak = false;
      var top = t.node.getBoundingClientRect().top;

      if (!cur) {
        cur = { from: t.i, to: t.i };
        curTop = top;
      } else if (Math.abs(top - curTop) < tol) {
        cur.to = t.i;
      } else {
        lines.push(cur);
        cur = { from: t.i, to: t.i };
        curTop = top;
      }
    });
    if (cur) lines.push(cur);

    // Every fragment is cut from a clone of the still-intact element, so all
    // of them must be built before el is emptied.
    var seenIds = {};
    var fragments = lines.map(function (ln) {
      return ln ? buildLineFragment(el, ln.from, ln.to, seenIds) : null;
    });

    markSelfMutation();
    el.innerHTML = "";

    // Each mask pads its bottom to save descenders from the overflow:hidden
    // clip and cancels that padding with a negative margin. On a plain block
    // the last mask's negative margin collapses out through the parent, so
    // the parent measures ~0.15em taller than the text it contains — visible
    // as soon as it has a background, border, or is a flex/grid item.
    // A block formatting context keeps that margin inside, where it cancels.
    // Only applied to plain blocks, so authored display values are left be.
    if (!el.style.display && window.getComputedStyle(el).display === "block") {
      el.style.display = "flow-root";
    }

    fragments.forEach(function (frag) {
      var outer = makeLineMask();

      if (!frag) {
        outer.innerHTML = "&nbsp;";
        el.appendChild(outer);
        return;
      }

      var inner = document.createElement("span");
      inner.className = "hm-line";
      inner.style.display = "inline-block";
      inner.appendChild(frag);
      outer.appendChild(inner);
      el.appendChild(outer);
    });

    return el.querySelectorAll(".hm-line");
  }

  // Wraps each word in place. Inline markup around the words is left exactly
  // as authored — walkTextNodes only ever touches text nodes, so an <a> or
  // <em> keeps its tag, classes and styling and simply ends up containing
  // .hm-word spans.
  //
  // Earlier versions also tagged those wrappers as .hm-word themselves, which
  // animated the wrapper and its words independently (compounding transforms)
  // and forced display:inline-block onto wrappers, breaking text wrapping.
  function splitWords(el) {
    walkTextNodes(el, function (textNode) {
      var fragments = textNode.textContent.split(/(\s+)/);
      var frag = document.createDocumentFragment();
      fragments.forEach(function (p) {
        if (/^\s+$/.test(p)) {
          frag.appendChild(document.createTextNode(p));
        } else if (p) {
          var s = document.createElement("span");
          s.textContent = p;
          s.style.display = "inline-block";
          s.classList.add("hm-word");
          frag.appendChild(s);
        }
      });
      textNode.parentNode.replaceChild(frag, textNode);
    });

    return el.querySelectorAll(".hm-word");
  }

  function splitChars(el) {
    walkTextNodes(el, function (textNode) {
      var frag = document.createDocumentFragment();
      var chars = textNode.textContent.split("");
      var wordWrap = null;

      chars.forEach(function (c) {
        if (/\s/.test(c)) {
          if (wordWrap) {
            frag.appendChild(wordWrap);
            wordWrap = null;
          }
          frag.appendChild(document.createTextNode(c));
        } else {
          if (!wordWrap) {
            wordWrap = document.createElement("span");
            wordWrap.style.display = "inline-block";
            wordWrap.style.whiteSpace = "nowrap";
          }
          var s = document.createElement("span");
          s.textContent = c;
          s.style.display = "inline-block";
          s.classList.add("hm-char");
          wordWrap.appendChild(s);
        }
      });
      if (wordWrap) frag.appendChild(wordWrap);
      textNode.parentNode.replaceChild(frag, textNode);
    });

    return el.querySelectorAll(".hm-char");
  }

  function walkTextNodes(el, callback) {
    var nodes = [];
    var walker = document.createTreeWalker(
      el, NodeFilter.SHOW_TEXT, null, false
    );
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(callback);
  }


  // ════════════════════════════════════════════════════════
  // 7b. SPLIT ANIMATION RUNNER
  // ════════════════════════════════════════════════════════

  // Every split animation is the same shape — cut the text up, offset the
  // pieces, stagger them back to rest — so they share one runner. That runner
  // is also the single place where measurement can be deferred or repeated,
  // which is what makes splits behave the same on every page.
  var SPLIT_PRESETS = {
    "split-lines": {
      type: "lines", from: { y: "110%" }, to: { y: "0%" },
      duration: 0.9, ease: "power3.out", stagger: 0.12, scrolled: true,
    },
    "split-words": {
      type: "words", from: { y: 20 }, to: { y: 0 },
      duration: 0.6, ease: "power2.out", stagger: 0.04, scrolled: true,
    },
    "split-chars": {
      type: "chars", from: { y: 15 }, to: { y: 0 },
      duration: 0.5, ease: "power2.out", stagger: 0.02, scrolled: true,
    },
    "hero-text": {
      type: "lines", from: { y: "120%" }, to: { y: "0%" },
      duration: 1, ease: "power4.out", stagger: 0.15, delay: 0.3,
      scrolled: false,
    },
  };

  function findSplit(el) {
    for (var i = 0; i < state.splits.length; i++) {
      if (state.splits[i].el === el) return state.splits[i];
    }
    return null;
  }

  // Waits for an element to gain layout before splitting it. Covers tabs,
  // sliders and accordions, whose panels are display:none at init.
  function deferUntilMeasurable(el, run) {
    if (!window.ResizeObserver) return false;
    var ro = new ResizeObserver(function () {
      if (!isMeasurable(el)) return;
      ro.disconnect();
      run();
      if (state.gsapLoaded) ScrollTrigger.refresh();
    });
    ro.observe(el);
    state.observers.push(ro);
    return true;
  }

  function runSplit(el, preset, instant) {
    // Captured before the first split; every re-measure restores from this.
    if (!state.originalHTML.has(el)) {
      state.originalHTML.set(el, el.innerHTML);
    }

    // Splitting rewrites this element's DOM; keep the CMS observer off it.
    markSelfMutation();

    if (!isMeasurable(el)) {
      // Show it rather than leave it blank, and split once it has a size.
      el.style.opacity = "1";
      if (!deferUntilMeasurable(el, function () {
        el.style.opacity = "";
        el.innerHTML = state.originalHTML.get(el);
        runSplit(el, preset, instant);
      })) {
        warn(
          "Cannot measure element for split-" + preset.type +
          " (hidden or zero-width) and ResizeObserver is unavailable. " +
          "Shown without animation."
        );
      }
      return;
    }

    var parts = splitContent(el, preset.type);
    if (!parts || !parts.length) {
      el.style.opacity = "1";
      return;
    }
    var arr = Array.prototype.slice.call(parts);

    var rec = findSplit(el);
    if (!rec) {
      rec = { el: el, played: false };
      state.splits.push(rec);
      ensureResizeWatcher();
    }
    rec.preset = preset;
    rec.parts = arr;

    // Re-measured after the animation already ran: land on the final state
    // without replaying it.
    if (instant) {
      gsap.set(arr, mergeTo(preset));
      rec.played = true;
      return;
    }

    gsap.set(arr, mergeFrom(preset));

    var vars = mergeTo(preset);
    vars.duration = getDuration(el, preset.duration);
    vars.ease = getEase(el, preset.ease);
    vars.stagger = getStagger(el, preset.stagger);

    // An explicit data-hm-delay of 0 must win over the preset's default,
    // so test for the attribute rather than for a falsy value.
    vars.delay = el.getAttribute("data-hm-delay") !== null
      ? getDelay(el)
      : (preset.delay || 0);

    // Promote on start, not on creation: a scroll-triggered split may sit
    // below the fold for a long time, and holding a compositing layer per
    // waiting element is what makes long pages feel heavy.
    vars.onStart = function () {
      setWillChange(arr, "transform, opacity");
    };
    vars.onComplete = function () {
      rec.played = true;
      setWillChange(arr, "auto");
    };

    // Load animations (hero-*) normally fire immediately. If the element is
    // below the fold — a restored scroll position, a long page, an anchor
    // link — playing blind wastes the animation, so fall back to scroll.
    if (preset.scrolled || !isInViewport(el)) {
      vars.scrollTrigger = scrollCfg(el);
    }

    var tween = gsap.to(arr, vars);
    rec.tween = tween;
    trackTrigger(tween);
  }

  function mergeFrom(preset) {
    var o = { opacity: 0 };
    for (var k in preset.from) o[k] = preset.from[k];
    return o;
  }

  function mergeTo(preset) {
    var o = { opacity: 1 };
    for (var k in preset.to) o[k] = preset.to[k];
    return o;
  }

  // Re-measures every split against the current layout.
  //
  // Line boxes are baked in at split time, so once the text rewraps — a
  // resize, a rotation, a webfont arriving late — the old boxes no longer
  // match and the overflow:hidden masks clip the text. Restoring the pristine
  // markup and splitting again is the only way to stay correct.
  function rebuildSplits() {
    if (!state.gsapLoaded || !state.splits.length) return;

    markSelfMutation();

    var deferred = false;

    state.splits.forEach(function (rec) {
      var html = state.originalHTML.get(rec.el);
      if (html == null || !rec.el.isConnected) return;

      // Mid-flight: restarting would visibly jump, so let it finish and come
      // back for it. Skipping outright would strand the element on line boxes
      // measured for the old width until some later resize happened to
      // arrive — which, on a rotation that lands mid-animation, is never.
      if (rec.tween && rec.tween.isActive()) {
        deferred = true;
        return;
      }

      if (rec.tween) {
        untrackTrigger(rec.tween);
        if (rec.tween.scrollTrigger) rec.tween.scrollTrigger.kill();
        rec.tween.kill();
        rec.tween = null;
      }
      if (rec.parts) gsap.killTweensOf(rec.parts);

      rec.el.innerHTML = html;
      runSplit(rec.el, rec.preset, rec.played);
    });

    ScrollTrigger.refresh();

    // Terminates: it only re-arms while a tween is running, and tweens end.
    if (deferred) {
      clearTimeout(state.rebuildRetry);
      state.rebuildRetry = setTimeout(rebuildSplits, CONFIG.rebuildRetry);
    }
  }

  function ensureResizeWatcher() {
    if (state.resizeBound) return;
    state.resizeBound = true;
    state.lastWidth = window.innerWidth;

    addListener(window, "resize", debounce(function () {
      // Width-only. Mobile browsers fire resize constantly as the URL bar
      // hides and shows, and a height change never rewraps text.
      if (window.innerWidth === state.lastWidth) return;
      state.lastWidth = window.innerWidth;
      rebuildSplits();
    }, CONFIG.resizeDebounce));
  }

  // ════════════════════════════════════════════════════════
  // 7c. STAGGER CHILDREN
  // ════════════════════════════════════════════════════════

  // Built on ScrollTrigger.batch, which groups elements by WHEN THEY ENTER
  // the viewport rather than by where they sit.
  //
  // This replaces hand-rolled row detection that grouped children by their
  // measured top in DOM order. That approach broke in ordinary layouts:
  //
  //   - align-items other than stretch/start gives items in one visual row
  //     different tops, so each became its own "row" and stagger — which
  //     needs more than one target to do anything — silently did nothing.
  //   - Vertical lists hit the same thing: every item its own group.
  //   - Rows were measured once and baked in, so after a resize rewrapped a
  //     3-column grid into 1 column the groups were still the old triples.
  //   - A container that was display:none at init measured every child at
  //     top 0, collapsing them into a single group whose trigger was the
  //     first child. Everything then fired at once when that child scrolled
  //     into view, so lower rows were already finished by the time they were
  //     on screen — the "it just doesn't animate" case.
  //
  // Batching sidesteps all of it: one trigger per child, grouped at runtime.

  // Per-child triggers have one artifact: children in the same visual row can
  // sit at different heights (align-items:center, or simply shorter content),
  // so a lower one crosses the trigger line later. Stop scrolling in that gap
  // and a fully visible row has an un-animated card sitting in it.
  //
  // Fixed by offsetting each child's start by how far it sits below the top
  // of its own row, so one row shares one trigger line. The offset is
  // returned from a function, which ScrollTrigger re-evaluates on every
  // refresh — so it re-derives itself after a resize instead of going stale.
  var rowTick = 0;
  var rowCache = new WeakMap();

  // offsetTop/offsetHeight rather than getBoundingClientRect: they ignore
  // transforms, so rows measure correctly even mid-animation.
  function computeRowOffsets(children) {
    var boxes = [];
    children.forEach(function (c) {
      var h = c.offsetHeight;
      if (h > 0) boxes.push({ el: c, top: c.offsetTop, bottom: c.offsetTop + h });
    });
    boxes.sort(function (a, b) { return a.top - b.top; });

    var offsets = new WeakMap();
    var i = 0;
    while (i < boxes.length) {
      var rowTop = boxes[i].top;          // sorted, so this is the row's top
      var rowBottom = boxes[i].bottom;
      var row = [boxes[i]];
      var j = i + 1;

      // Same row if the vertical bands overlap by at least half the height
      // of the shorter box. Tolerates centred and unequal-height items
      // without assuming DOM order matches visual order.
      while (j < boxes.length) {
        var b = boxes[j];
        var overlap = Math.min(rowBottom, b.bottom) - Math.max(rowTop, b.top);
        var shorter = Math.min(b.bottom - b.top, rowBottom - rowTop);
        if (overlap < shorter * 0.5) break;
        row.push(b);
        rowBottom = Math.max(rowBottom, b.bottom);
        j++;
      }

      row.forEach(function (b) { offsets.set(b.el, b.top - rowTop); });
      i = j;
    }
    return offsets;
  }

  function rowOffsetFor(container, child) {
    var entry = rowCache.get(container);
    if (!entry || entry.tick !== rowTick) {
      entry = { tick: rowTick, offsets: computeRowOffsets(staggerTargets(container)) };
      rowCache.set(container, entry);
    }
    return entry.offsets.get(child) || 0;
  }

  // Shifts a ScrollTrigger start string earlier by `off` pixels:
  //   ("top 80%", 90)      -> "top-=90 80%"
  //   ("top+=120 80%", 90) -> "top+=30 80%"
  // Anything it cannot parse is passed through untouched.
  function alignedStart(start, off) {
    if (!off) return start;
    var parts = String(start).trim().split(/\s+/);
    var m = parts[0].match(/^([a-z]+)(?:([+-]=)(-?[\d.]+))?$/i);
    if (!m) return start;

    var existing = m[2] ? (m[2] === "-=" ? -parseFloat(m[3]) : parseFloat(m[3])) : 0;
    var total = existing - off;
    var head = m[1] + (total ? (total < 0 ? "-=" : "+=") + Math.abs(total) : "");
    return [head].concat(parts.slice(1)).join(" ");
  }

  function staggerTargets(el) {
    var selector = rawAttr(el, "stagger-selector", null);
    if (selector && typeof selector === "string") {
      return Array.prototype.slice.call(el.querySelectorAll(selector));
    }
    return Array.prototype.slice.call(el.children);
  }

  // Small batches keep their per-item rhythm. Past a point, adding another
  // interval per item makes the tail of a large batch arrive long after the
  // viewer has moved on, so spread the whole batch over a fixed window.
  function staggerFor(count, each) {
    return count * each > CONFIG.staggerMaxTotal
      ? { amount: CONFIG.staggerMaxTotal }
      : each;
  }

  function runStagger(el) {
    var children = staggerTargets(el);
    if (!children.length) {
      warn(
        "stagger-children: nothing to animate in " +
        (el.className || el.tagName) +
        (rawAttr(el, "stagger-selector", null)
          ? " (data-stagger-selector matched no elements)" : "")
      );
      return;
    }

    var o = {
      dist: getDistance(el),
      dur: getDuration(el, CONFIG.duration),
      ease: getEase(el, CONFIG.ease),
      stag: getStagger(el, CONFIG.stagger),
      del: getDelay(el),
      once: getOnce(el),
      start: getScrollStart(el),
      batchMax: parseFloat(el.getAttribute("data-hm-batch-max")) || 0,
    };

    var rec = { el: el, opts: o, seen: new WeakSet() };
    state.staggers.push(rec);

    attachStagger(rec, children);
  }

  // Hides a set of children and gives them their own batch of triggers.
  // Called for the initial children and again for any added later by a CMS
  // collection, a "load more" button, or a filter re-render.
  function attachStagger(rec, children) {
    var o = rec.opts;
    var fresh = children.filter(function (c) { return !rec.seen.has(c); });
    if (!fresh.length) return;
    fresh.forEach(function (c) { rec.seen.add(c); });

    // Safe to hide even while the container is display:none — nothing is on
    // screen — and doing it now avoids a flash when it is revealed.
    gsap.set(fresh, { opacity: 0, y: o.dist });

    function create() {
      var vars = {
        interval: CONFIG.batchInterval,
        // Re-evaluated by ScrollTrigger on every refresh, so row alignment
        // follows the layout instead of being measured once and baked in.
        start: function (self) {
          return alignedStart(o.start, rowOffsetFor(rec.el, self.trigger));
        },
        once: o.once,
        onEnter: function (batch) {
          setWillChange(batch, "transform, opacity");
          gsap.to(batch, {
            opacity: 1,
            y: 0,
            duration: o.dur,
            ease: o.ease,
            delay: o.del,
            stagger: staggerFor(batch.length, o.stag),
            overwrite: true,
            onComplete: function () { setWillChange(batch, "auto"); },
          });
        },
      };

      if (o.batchMax) vars.batchMax = o.batchMax;

      if (!o.once) {
        vars.onLeaveBack = function (batch) {
          gsap.to(batch, {
            opacity: 0,
            y: o.dist,
            duration: o.dur * 0.6,
            ease: o.ease,
            stagger: staggerFor(batch.length, o.stag),
            overwrite: true,
          });
        };
      }

      ScrollTrigger.batch(fresh, vars).forEach(function (t) {
        state.triggers.push(t);
      });
    }

    if (isMeasurable(rec.el)) {
      create();
    } else if (!deferUntilMeasurable(rec.el, create)) {
      // Nothing will tell us when this gains layout, so never leave it
      // hidden — an un-animated grid beats an invisible one.
      gsap.set(fresh, { opacity: 1, y: 0 });
    }
  }

  // Picks up children added after init. Webflow collection lists, "load
  // more" buttons and filter re-renders all append into a container that was
  // already processed, so the container itself is never revisited.
  function refreshStaggers() {
    if (!state.gsapLoaded) return;
    state.staggers.forEach(function (rec) {
      if (!rec.el.isConnected) return;
      attachStagger(rec, staggerTargets(rec.el));
    });
  }

  // ════════════════════════════════════════════════════════
  // 8. GSAP SCROLL ANIMATIONS
  // ════════════════════════════════════════════════════════

  var gsapScrollAnims = {

    "fade-up": function (el) {
      setInitialState(el, "up");
      var t = gsap.to(el, {
        opacity: 1, y: 0,
        duration: getDuration(el, CONFIG.duration),
        ease: getEase(el, CONFIG.ease),
        delay: getDelay(el),

        scrollTrigger: scrollCfg(el),
        onComplete: function () { clearWillChange(el); },
      });
      trackTrigger(t);
    },

    "fade-down": function (el) {
      setInitialState(el, "down");
      var t = gsap.to(el, {
        opacity: 1, y: 0,
        duration: getDuration(el, CONFIG.duration),
        ease: getEase(el, CONFIG.ease),
        delay: getDelay(el),

        scrollTrigger: scrollCfg(el),
        onComplete: function () { clearWillChange(el); },
      });
      trackTrigger(t);
    },

    "fade-left": function (el) {
      setInitialState(el, "left");
      var t = gsap.to(el, {
        opacity: 1, x: 0,
        duration: getDuration(el, CONFIG.duration),
        ease: getEase(el, CONFIG.ease),
        delay: getDelay(el),

        scrollTrigger: scrollCfg(el),
        onComplete: function () { clearWillChange(el); },
      });
      trackTrigger(t);
    },

    "fade-right": function (el) {
      setInitialState(el, "right");
      var t = gsap.to(el, {
        opacity: 1, x: 0,
        duration: getDuration(el, CONFIG.duration),
        ease: getEase(el, CONFIG.ease),
        delay: getDelay(el),

        scrollTrigger: scrollCfg(el),
        onComplete: function () { clearWillChange(el); },
      });
      trackTrigger(t);
    },

    "fade-in": function (el) {
      primeWillChange(el, "opacity");
      gsap.set(el, { opacity: 0 });
      var t = gsap.to(el, {
        opacity: 1,
        duration: getDuration(el, CONFIG.duration),
        ease: getEase(el, CONFIG.ease),
        delay: getDelay(el),
        scrollTrigger: scrollCfg(el),
        onComplete: function () { clearWillChange(el); },
      });
      trackTrigger(t);
    },

    "scale-in": function (el) {
      primeWillChange(el);
      gsap.set(el, { opacity: 0, scale: 0.9 });
      var t = gsap.to(el, {
        opacity: 1, scale: 1,
        duration: getDuration(el, CONFIG.duration),
        ease: getEase(el, CONFIG.ease),
        delay: getDelay(el),

        scrollTrigger: scrollCfg(el),
        onComplete: function () { clearWillChange(el); },
      });
      trackTrigger(t);
    },

    "reveal-up": function (el) {
      primeWillChange(el, "clip-path");
      gsap.set(el, { clipPath: "inset(100% 0% 0% 0%)" });
      var t = gsap.to(el, {
        clipPath: "inset(0% 0% 0% 0%)",
        duration: getDuration(el, 1),
        ease: getEase(el, "power4.inOut"),
        delay: getDelay(el),
        scrollTrigger: scrollCfg(el),
        onComplete: function () { clearWillChange(el); },
      });
      trackTrigger(t);
    },

    // ── Text splits ──────────────────────────────────────

    "split-lines": function (el, instant) {
      runSplit(el, SPLIT_PRESETS["split-lines"], instant);
    },

    "split-words": function (el, instant) {
      runSplit(el, SPLIT_PRESETS["split-words"], instant);
    },

    "split-chars": function (el, instant) {
      runSplit(el, SPLIT_PRESETS["split-chars"], instant);
    },

    // ── Image reveal ─────────────────────────────────────

    "img-reveal": function (el) {
      var dir = rawAttr(el, "reveal-direction", "left");
      var clipFrom, clipTo;

      switch (dir) {
        case "left":
          clipFrom = "inset(0 100% 0 0)";
          clipTo = "inset(0 0% 0 0)";
          break;
        case "right":
          clipFrom = "inset(0 0 0 100%)";
          clipTo = "inset(0 0 0 0%)";
          break;
        case "top":
          clipFrom = "inset(0 0 100% 0)";
          clipTo = "inset(0 0 0% 0)";
          break;
        case "bottom":
        default:
          clipFrom = "inset(100% 0 0 0)";
          clipTo = "inset(0% 0 0 0)";
          break;
      }

      primeWillChange(el, "clip-path");
      gsap.set(el, { clipPath: clipFrom });

      var t = gsap.to(el, {
        clipPath: clipTo,
        duration: getDuration(el, 1),
        ease: getEase(el, "power4.inOut"),
        delay: getDelay(el),
        scrollTrigger: scrollCfg(el),
        onComplete: function () { clearWillChange(el); },
      });
      trackTrigger(t);
    },

    // ── Stagger children ─────────────────────────────────
    
    "stagger-children": runStagger,

    // ── Counter ──────────────────────────────────────────

    counter: function (el) {
      var raw = el.textContent.trim();
      var match = raw.match(/^([^0-9]*?)([\d,]+\.?\d*)(.*?)$/);

      if (!match) {
        warn("Counter: cannot parse \"" + raw + "\"");
        return;
      }

      var prefix = match[1];
      var numStr = match[2];
      var suffix = match[3];
      var target = parseFloat(numStr.replace(/,/g, ""));
      var decimals = (numStr.split(".")[1] || "").length;
      var useCommas = numStr.indexOf(",") > -1;

      el.textContent = prefix + "0" + suffix;
      var obj = { val: 0 };

      gsap.to(obj, {
        val: target,
        duration: getDuration(el, 2),
        ease: getEase(el, "power2.out"),
        delay: getDelay(el),
        scrollTrigger: scrollCfg(el),
        onUpdate: function () {
          var display;
          if (decimals) {
            display = obj.val.toFixed(decimals);
          } else {
            display = Math.round(obj.val).toString();
          }
          if (useCommas) {
            display = parseFloat(display).toLocaleString("en-US", {
              minimumFractionDigits: decimals,
              maximumFractionDigits: decimals,
            });
          }
          el.textContent = prefix + display + suffix;
        },
      });
    },

    // ── SVG draw ─────────────────────────────────────────

    "draw-line": function (el) {
      var paths = el.querySelectorAll(
        "path, line, circle, rect, polyline, polygon"
      );
      paths.forEach(function (p) {
        var len = p.getTotalLength ? p.getTotalLength() : 0;
        if (!len) return;
        gsap.set(p, {
          strokeDasharray: len,
          strokeDashoffset: len,
        });
        gsap.to(p, {
          strokeDashoffset: 0,
          duration: getDuration(el, 1.5),
          ease: getEase(el, "power2.inOut"),
          delay: getDelay(el),
          scrollTrigger: scrollCfg(el),
        });
      });
    },

    // ── Parallax ─────────────────────────────────────────

    parallax: function (el) {
      var speed = rawAttr(el, "parallax-speed", CONFIG.parallaxSpeed);

      if (window.innerWidth < 768 && !el.hasAttribute("data-parallax-mobile")) {
        return;
      }

      gsap.to(el, {
        y: function () {
          return speed * 100;
        },
        ease: "none",

        scrollTrigger: {
          trigger: el,
          start: "top bottom",
          end: "bottom top",
          scrub: 1,
        },
      });
    },
  };

  // ════════════════════════════════════════════════════════
  // 9. GSAP LOAD ANIMATIONS (Hero)
  // ════════════════════════════════════════════════════════
  
  var gsapLoadAnims = {
    "hero-text": function (el, instant) {
      runSplit(el, SPLIT_PRESETS["hero-text"], instant);
    },

    "hero-image": function (el) {
      primeWillChange(el);
      gsap.set(el, { opacity: 0, scale: 1.05 });

      var vars = {
        opacity: 1, scale: 1,
        duration: getDuration(el, 1.4),
        ease: getEase(el, "power3.out"),
        delay: getDelay(el) || 0.2,
        onComplete: function () { clearWillChange(el); },
      };

      // Same reasoning as hero-text: don't play it where nobody can see it.
      if (!isInViewport(el)) vars.scrollTrigger = scrollCfg(el);

      trackTrigger(gsap.to(el, vars));
    },
  };


  // ════════════════════════════════════════════════════════
  // 10. BUTTON INTERACTIONS
  // ════════════════════════════════════════════════════════
  
  var btnInteractions = {

    fill: function (el) {
      el.style.position = "relative";
      el.style.overflow = "hidden";

      var fill = document.createElement("span");
      fill.classList.add("hm-btn-fill");
      fill.style.cssText =
        "position:absolute;inset:0;transform:scaleX(0);" +
        "transform-origin:left;pointer-events:none;z-index:0;" +
        "will-change:transform;";

      var color = rawAttr(el, "fill-color", null);
      if (color) {
        fill.style.background = color;
      } else {
        fill.style.background = "currentColor";
        fill.style.opacity = "0.08";
      }

      el.insertBefore(fill, el.firstChild);

      Array.from(el.children).forEach(function (c) {
        if (c !== fill) {
          c.style.position = "relative";
          c.style.zIndex = "1";
        }
      });

      addListener(el, "mouseenter", function () {
        fill.style.transformOrigin = "left";
        gsap.to(fill, { scaleX: 1, duration: 0.4, ease: "power2.out" });
      });
      addListener(el, "mouseleave", function () {
        fill.style.transformOrigin = "right";
        gsap.to(fill, { scaleX: 0, duration: 0.3, ease: "power2.in" });
      });
    },

    magnetic: function (el) {
      var strength = rawAttr(el, "magnetic-strength", 0.3);

      if ("ontouchstart" in window) return;

      addListener(el, "mousemove", function (e) {
        var r = el.getBoundingClientRect();
        var x = e.clientX - r.left - r.width / 2;
        var y = e.clientY - r.top - r.height / 2;
        gsap.to(el, {
          x: x * strength,
          y: y * strength,
          duration: 0.2,
          ease: "power2.out",
  
        });
      });

      addListener(el, "mouseleave", function () {
        gsap.to(el, {
          x: 0, y: 0,
          duration: 0.4,
          ease: "elastic.out(1, 0.5)",
  
        });
      });
    },

    "text-slide": function (el) {
      var textEl = el.querySelector("span");

      if (!textEl) {
        textEl = document.createElement("span");
        textEl.textContent = el.textContent;
        el.textContent = "";
        el.appendChild(textEl);
      }

      var rect = el.getBoundingClientRect();
      el.style.height = rect.height + "px";
      el.style.overflow = "hidden";
      el.style.position = "relative";
      el.style.display = "inline-flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";

      textEl.style.display = "block";
      textEl.style.position = "relative";
      textEl.style.transition = "none";
      textEl.style.width = "100%";
      textEl.style.textAlign = "center";
      textEl.style.willChange = "transform";

      var clone = textEl.cloneNode(true);
      clone.classList.add("hm-btn-clone");
      clone.style.position = "absolute";
      clone.style.left = "0";
      clone.style.top = "0";
      clone.style.width = "100%";
      clone.style.height = "100%";
      clone.style.display = "flex";
      clone.style.alignItems = "center";
      clone.style.justifyContent = "center";
      clone.style.willChange = "transform";
      el.appendChild(clone);

      gsap.set(clone, { y: "100%" });

      addListener(el, "mouseenter", function () {
        gsap.to(textEl, { y: "-100%", duration: 0.35, ease: "power2.inOut" });
        gsap.to(clone, { y: "0%", duration: 0.35, ease: "power2.inOut" });
      });
      addListener(el, "mouseleave", function () {
        gsap.to(textEl, { y: "0%", duration: 0.35, ease: "power2.inOut" });
        gsap.to(clone, { y: "100%", duration: 0.35, ease: "power2.inOut" });
      });
    },
  };


  // ════════════════════════════════════════════════════════
  // 11. ELEMENT PROCESSING
  // ════════════════════════════════════════════════════════

  
  function processElement(el) {
    if (state.processedEls.has(el)) return;
    state.processedEls.add(el);
    checkConflicts(el);

    var type = el.getAttribute("data-animate");
    var btn = el.getAttribute("data-btn");

    if (type) {
      if (state.reducedMotion && !shouldAnimate(el)) {
        el.style.opacity = "1";
        el.style.transform = "none";
        el.style.clipPath = "none";
        return;
      }

      // CSS tier elements were already handled — skip
      if (CSS_TIER.indexOf(type) > -1 && !state.gsapLoaded) return;

      // GSAP scroll animations
      if (gsapScrollAnims[type] && state.gsapLoaded) {
        gsapScrollAnims[type](el, false);
        return;
      }

      // GSAP load animations
      if (gsapLoadAnims[type] && state.gsapLoaded) {
        gsapLoadAnims[type](el, false);
        return;
      }
    }

    if (btn && state.gsapLoaded) {
      if (state.reducedMotion && !shouldAnimate(el)) return;
      if (btnInteractions[btn]) {
        btnInteractions[btn](el);
      }
    }
  }


  // ════════════════════════════════════════════════════════
  // 12. CMS DYNAMIC CONTENT OBSERVER
  // ════════════════════════════════════════════════════════
  
  function startCMSObserver() {
    if (!window.MutationObserver) return;

    var handleMutations = debounce(function () {
      // Splitting text rewrites innerHTML, which trips this observer. Without
      // this guard every split schedules a full-document rescan.
      if (Date.now() - state.lastSelfMutation < 400) return;

      var newEls = document.querySelectorAll("[data-animate], [data-btn]");
      var needsGSAP = false;

      newEls.forEach(function (el) {
        if (state.processedEls.has(el)) return;

        var type = el.getAttribute("data-animate");
        var btn = el.getAttribute("data-btn");

        if ((type && GSAP_TIER.indexOf(type) > -1) || btn) {
          needsGSAP = true;
        }

        if (type && CSS_TIER.indexOf(type) > -1 && !state.gsapLoaded) {
          applyCSSOverrides(el);
          var pos = initialPosition(el);
          if (pos === "played") {
            el.classList.add("hm-visible");
          } else if (pos === "enter") {
            enterCSS(el);
          } else if (state.cssObserver) {
            state.cssObserver.observe(el);
          } else {
            // CMS content arrived on a page that had no CSS-tier elements at
            // init, so no observer exists yet. Build one around this element.
            initCSSTier([el]);
          }
          state.processedEls.add(el);
        }
      });

      // Children appended into an existing stagger-children container never
      // reach the loop above: the container itself was processed long ago.
      if (state.staggers.length) refreshStaggers();

      if (needsGSAP) {
        loadGSAP().then(function () {
          newEls.forEach(function (el) {
            if (!state.processedEls.has(el)) processElement(el);
          });
          ScrollTrigger.refresh();
        });
      } else if (state.staggers.length && state.gsapLoaded) {
        ScrollTrigger.refresh();
      }
    }, 200);

    state.mutationObs = new MutationObserver(handleMutations);
    state.mutationObs.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // ════════════════════════════════════════════════════════
  // 13. INIT
  // ════════════════════════════════════════════════════════

  function init() {
    if (state.initialized) return;

    checkReducedMotion();
    injectSafetyCSS();
    enableFOICFallback();

    document.documentElement.classList.add("hm-loading");
    injectCSSTier();

    var allEls = Array.prototype.slice.call(
      document.querySelectorAll("[data-animate]")
    );
    var btnEls = Array.prototype.slice.call(
      document.querySelectorAll("[data-btn]")
    );
    var cssEls = [];
    var needsGSAP = false;

    allEls.forEach(function (el) {
      var type = el.getAttribute("data-animate");
      if (CSS_TIER.indexOf(type) > -1) {
        cssEls.push(el);
      }
      if (GSAP_TIER.indexOf(type) > -1) {
        needsGSAP = true;
      }
    });

    if (btnEls.length > 0) needsGSAP = true;

    // CSS tier runs immediately
    initCSSTier(cssEls);
    cssEls.forEach(function (el) {
      state.processedEls.add(el);
    });

    if (needsGSAP) {
      loadGSAP().then(function () {
        if (!state.gsapLoaded) return;   // CDN failed; fallback already active

        // Text splits measure line wrapping, which is wrong until the real
        // fonts are in. Waiting here costs a little time up front and saves
        // every split from being laid out against fallback metrics.
        whenFontsReady(function () {
          // Process elements in batches via rAF to avoid
          // blocking the main thread and causing jank
          var gsapEls = allEls.concat(btnEls);
          var BATCH = 10;
          var idx = 0;

          function processBatch() {
            var end = Math.min(idx + BATCH, gsapEls.length);
            for (var i = idx; i < end; i++) {
              processElement(gsapEls[i]);
            }
            idx = end;
            if (idx < gsapEls.length) {
              requestAnimationFrame(processBatch);
            } else {
              // All elements processed — safe to remove early-hide now
              // that GSAP has set initial states on all elements
              finishInit();
              ScrollTrigger.refresh();
            }
          }

          requestAnimationFrame(processBatch);

          // Recalculate positions after all images/fonts load
          if (document.readyState === "complete") {
            setTimeout(function () { ScrollTrigger.refresh(); }, 100);
          } else {
            addListener(window, "load", function () {
              ScrollTrigger.refresh();
            });
          }

          // A font slower than CONFIG.fontTimeout still lands eventually and
          // rewraps the text under the splits we just measured.
          if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(function () {
              if (state.initialized) rebuildSplits();
            }).catch(function () {});
          }
        });
      });
    } else {
      log("CSS-only mode — no GSAP needed.");
      finishInit();
    }
  }

  function finishInit() {
    state.initialized = true;
    document.documentElement.classList.remove("hm-loading");
    document.documentElement.classList.add("hm-ready");

    // Remove the early-hide stylesheet — all elements are now either
    // hidden by GSAP (gsap.set) or by the CSS pre-animation rules,
    // so this blanket !important hide is no longer needed.
    var earlyHide = document.getElementById("hm-early-hide");
    if (earlyHide) earlyHide.parentNode.removeChild(earlyHide);

    startCMSObserver();

    var animCount = document.querySelectorAll("[data-animate]").length;
    var btnCount = document.querySelectorAll("[data-btn]").length;
    log("Ready. " + animCount + " animations, " + btnCount + " buttons.");
  }

  // ════════════════════════════════════════════════════════
  // 14. PUBLIC API
  // ════════════════════════════════════════════════════════
  
  function destroy() {
    if (state.foicTimer) {
      clearTimeout(state.foicTimer);
      state.foicTimer = null;
    }
    if (state.rebuildRetry) {
      clearTimeout(state.rebuildRetry);
      state.rebuildRetry = null;
    }

    state.triggers.forEach(function (st) {
      if (st && st.kill) st.kill();
    });
    state.triggers = [];

    state.observers.forEach(function (obs) {
      obs.disconnect();
    });
    state.observers = [];
    state.cssObserver = null;

    state.listeners.forEach(function (l) {
      l.el.removeEventListener(l.evt, l.fn);
    });
    state.listeners = [];
    state.resizeBound = false;

    if (state.mutationObs) {
      state.mutationObs.disconnect();
      state.mutationObs = null;
    }

    if (state.gsapLoaded && window.gsap) {
      gsap.killTweensOf("*");
      ScrollTrigger.getAll().forEach(function (st) {
        st.kill();
      });
    }

    // Put split text back the way the author wrote it. Without this a
    // reinit() would split the already-split markup, nesting line masks
    // inside line masks until the layout collapses.
    markSelfMutation();
    state.splits.forEach(function (rec) {
      var html = state.originalHTML.get(rec.el);
      if (html != null && rec.el.isConnected) {
        rec.el.innerHTML = html;
        rec.el.removeAttribute("aria-label");
        rec.el.style.opacity = "";
        if (rec.el.style.display === "flow-root") rec.el.style.display = "";
      }
    });
    state.splits = [];
    state.originalHTML = new WeakMap();

    // Children were left mid-animation at whatever opacity/transform the
    // batch had reached; clear it so nothing stays half-faded.
    state.staggers.forEach(function (rec) {
      if (!rec.el.isConnected) return;
      var kids = staggerTargets(rec.el);
      if (window.gsap) gsap.set(kids, { clearProps: "opacity,transform,willChange" });
    });
    state.staggers = [];

    // Remove injected stylesheets, or a reinit stacks duplicates and the
    // pre-animation rules keep hiding content that nothing will reveal.
    state.styles.forEach(function (s) {
      if (s.parentNode) s.parentNode.removeChild(s);
    });
    state.styles = [];

    var earlyHide = document.getElementById("hm-early-hide");
    if (earlyHide && earlyHide.parentNode) {
      earlyHide.parentNode.removeChild(earlyHide);
    }

    // Animation state classes outlive the stylesheet that gave them meaning.
    var marked = document.querySelectorAll(".hm-in, .hm-visible, .hm-done");
    for (var i = 0; i < marked.length; i++) {
      marked[i].classList.remove("hm-in", "hm-visible", "hm-done");
    }

    state.processedEls = new WeakSet();
    state.initialized = false;

    document.documentElement.classList.remove(
      "hm-loading", "hm-ready", "hm-fallback"
    );

    log("Destroyed.");
  }

  // Call after anything that changes layout — a tab opening, a filter
  // rerendering a grid, a font swap. Split text is re-measured against the
  // new layout, not just repositioned.
  function refresh() {
    if (state.gsapLoaded) {
      refreshStaggers();
      if (state.splits.length) rebuildSplits();   // refreshes ScrollTrigger
      else ScrollTrigger.refresh();
    }
    log("Refreshed.");
  }

  function reinit() {
    destroy();
    init();
  }

  window.HypeMotion = {
    version: VERSION,
    init: init,
    destroy: destroy,
    refresh: refresh,
    reinit: reinit,
  };

  // ════════════════════════════════════════════════════════
  // 15. AUTO-INIT
  // ════════════════════════════════════════════════════════
  
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      requestAnimationFrame(function () {
        requestAnimationFrame(init);
      });
    });
  } else {
    requestAnimationFrame(function () {
      requestAnimationFrame(init);
    });
  }

  // Handle bfcache (back/forward navigation restoring a cached page)
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) {
      if (state.initialized && state.gsapLoaded && window.ScrollTrigger) {
        ScrollTrigger.refresh();
      } else if (!state.initialized) {
        requestAnimationFrame(function () {
          requestAnimationFrame(init);
        });
      }
    }
  });
})();
