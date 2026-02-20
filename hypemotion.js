(function () {
  "use strict";

  var VERSION = "2.2.0";
  var LIB = "HypeMotion";

  // ════════════════════════════════════════════════════════
  // 0. INSTANT HIDE — runs synchronously at parse time
  //    to prevent flash of visible content before init()
  // ════════════════════════════════════════════════════════

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

  // ════════════════════════════════════════════════════════
  // 1. CONFIGURATION
  // ════════════════════════════════════════════════════════

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

  // ════════════════════════════════════════════════════════
  // 2. STATE
  // ════════════════════════════════════════════════════════

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
  };

  // ════════════════════════════════════════════════════════
  // 3. UTILITIES
  // ════════════════════════════════════════════════════════

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
    gsap.set(el, props);
  }

  // ════════════════════════════════════════════════════════
  // 4. SAFETY SYSTEMS
  // ════════════════════════════════════════════════════════

  function injectSafetyCSS() {
    var style = document.createElement("style");
    style.id = "hm-safety-css";
    style.textContent = [
      // Promote animated elements for GPU compositing during loading
      "[data-animate]:not([data-animate='parallax']):not([data-animate='counter']) {",
      "  will-change: transform, opacity; }",
      // Force visible if something goes wrong (timeout fallback)
      ".hm-fallback [data-animate] {",
      "  opacity: 1 !important;",
      "  transform: none !important;",
      "  clip-path: none !important;",
      "  will-change: auto !important; }",
    ].join("\n");
    document.head.appendChild(style);
  }

  function enableFOICFallback() {
    setTimeout(function () {
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
  }

  function applyCSSOverrides(el) {
    var d = el.getAttribute("data-hm-duration");
    var del = el.getAttribute("data-hm-delay");
    var dist = el.getAttribute("data-hm-distance");
    if (d) { el.style.setProperty("--hm-dur", d + "s"); }
    if (del) { el.style.setProperty("--hm-del", del + "s"); }
    if (dist) { el.style.setProperty("--hm-dist", dist + "px"); }
  }

  function initCSSTier(elements) {
    if (!elements.length) return;

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            var el = entry.target;
            el.classList.add("hm-in");

            // Clean up will-change after animation finishes
            el.addEventListener("animationend", function onEnd() {
              el.removeEventListener("animationend", onEnd);
              el.classList.add("hm-done");
            });

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

      if (isInViewport(el)) {
        el.classList.add("hm-visible");
      } else {
        observer.observe(el);
      }
    });

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

  function loadGSAP() {
    if (state.gsapLoaded) return Promise.resolve();
    if (state.gsapLoading) return state.gsapPromise;

    if (window.gsap && window.ScrollTrigger) {
      state.gsapLoaded = true;
      gsap.registerPlugin(ScrollTrigger);
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

  function splitContent(el, type) {
    el.setAttribute("aria-label", el.textContent);

    var hasHTML = el.querySelector("a, strong, em, span, b, i, u, mark, sup, sub");
    if (hasHTML) {
      warn(
        "split-" + type + ": element contains inline HTML. " +
        "Structure preserved but results may vary. Text: \"" +
        el.textContent.substring(0, 40) + "...\""
      );
    }

    if (type === "lines") return splitLines(el);
    if (type === "words") return splitWords(el);
    if (type === "chars") return splitChars(el);
    return null;
  }

  function splitLines(el) {
    var hasBR = el.querySelector("br");

    if (hasBR) {
      var html = el.innerHTML;
      var parts = html.split(/<br\s*\/?>/gi);
      el.innerHTML = "";
      parts.forEach(function (part) {
        var trimmed = part.trim();
        if (!trimmed) return;
        var outer = document.createElement("span");
        outer.style.display = "block";
        outer.style.overflow = "hidden";
        var inner = document.createElement("span");
        inner.innerHTML = trimmed;
        inner.style.display = "inline-block";
        inner.style.willChange = "transform, opacity";
        inner.classList.add("hm-line");
        outer.appendChild(inner);
        el.appendChild(outer);
      });
      return el.querySelectorAll(".hm-line");
    }

    var measuredWords = [];
    walkTextNodes(el, function (textNode) {
      var fragments = textNode.textContent.split(/(\s+)/);
      var frag = document.createDocumentFragment();
      fragments.forEach(function (p) {
        if (/^\s+$/.test(p)) {
          frag.appendChild(document.createTextNode(p));
        } else if (p) {
          var s = document.createElement("span");
          s.textContent = p;
          s.className = "hm-measure";
          s.style.display = "inline";
          frag.appendChild(s);
          measuredWords.push(s);
        }
      });
      textNode.parentNode.replaceChild(frag, textNode);
    });

    var lineGroups = [];
    var currentGroup = [];
    var currentTop = null;
    measuredWords.forEach(function (w) {
      var top = w.getBoundingClientRect().top;
      if (currentTop === null || Math.abs(top - currentTop) < 4) {
        currentGroup.push(w);
        if (currentTop === null) currentTop = top;
      } else {
        lineGroups.push(currentGroup);
        currentGroup = [w];
        currentTop = top;
      }
    });
    if (currentGroup.length) lineGroups.push(currentGroup);

    el.innerHTML = "";
    lineGroups.forEach(function (words) {
      var outer = document.createElement("span");
      outer.style.display = "block";
      outer.style.overflow = "hidden";
      var inner = document.createElement("span");
      inner.style.display = "inline-block";
      inner.style.willChange = "transform, opacity";
      inner.classList.add("hm-line");
      words.forEach(function (w, i) {
        inner.appendChild(document.createTextNode(w.textContent));
        if (i < words.length - 1) {
          inner.appendChild(document.createTextNode(" "));
        }
      });
      outer.appendChild(inner);
      el.appendChild(outer);
    });

    return el.querySelectorAll(".hm-line");
  }

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
          s.style.willChange = "transform, opacity";
          s.classList.add("hm-word");
          frag.appendChild(s);
        }
      });
      textNode.parentNode.replaceChild(frag, textNode);
    });

    el.querySelectorAll("a, strong, em, span:not(.hm-word), b, i").forEach(
      function (node) {
        if (!node.classList.contains("hm-word")) {
          node.style.display = "inline-block";
          node.classList.add("hm-word");
        }
      }
    );

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
          s.style.willChange = "transform, opacity";
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

    "split-lines": function (el) {
      var parts = splitContent(el, "lines");
      if (!parts || !parts.length) return;
      var partsArr = Array.prototype.slice.call(parts);
      gsap.set(partsArr, { y: "110%", opacity: 0 });
      gsap.to(partsArr, {
        y: "0%", opacity: 1,
        duration: getDuration(el, 0.9),
        ease: getEase(el, "power3.out"),
        stagger: getStagger(el, 0.12),
        delay: getDelay(el),

        scrollTrigger: scrollCfg(el),
        onComplete: function () {
          partsArr.forEach(function (p) { clearWillChange(p); });
        },
      });
    },

    "split-words": function (el) {
      var parts = splitContent(el, "words");
      if (!parts || !parts.length) return;
      var partsArr = Array.prototype.slice.call(parts);
      gsap.set(partsArr, { y: 20, opacity: 0 });
      gsap.to(partsArr, {
        y: 0, opacity: 1,
        duration: getDuration(el, 0.6),
        ease: getEase(el, "power2.out"),
        stagger: getStagger(el, 0.04),
        delay: getDelay(el),

        scrollTrigger: scrollCfg(el),
        onComplete: function () {
          partsArr.forEach(function (p) { clearWillChange(p); });
        },
      });
    },

    "split-chars": function (el) {
      var parts = splitContent(el, "chars");
      if (!parts || !parts.length) return;
      var partsArr = Array.prototype.slice.call(parts);
      gsap.set(partsArr, { y: 15, opacity: 0 });
      gsap.to(partsArr, {
        y: 0, opacity: 1,
        duration: getDuration(el, 0.5),
        ease: getEase(el, "power2.out"),
        stagger: getStagger(el, 0.02),
        delay: getDelay(el),

        scrollTrigger: scrollCfg(el),
        onComplete: function () {
          partsArr.forEach(function (p) { clearWillChange(p); });
        },
      });
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

      gsap.set(el, { clipPath: clipFrom, scale: 1.15 });

      var tl = gsap.timeline({
        scrollTrigger: scrollCfg(el),
        delay: getDelay(el),
      });

      tl.to(el, {
        clipPath: clipTo,
        duration: getDuration(el, 1),
        ease: getEase(el, "power4.inOut"),
      }).to(
        el,
        { scale: 1, duration: 1.2, ease: "power2.out" },
        "<0.3"
      );

      if (tl.scrollTrigger) state.triggers.push(tl.scrollTrigger);
    },

    // ── Stagger children ─────────────────────────────────

    "stagger-children": function (el) {
      var selector = rawAttr(el, "stagger-selector", null);
      var children;

      if (selector) {
        children = Array.prototype.slice.call(el.querySelectorAll(selector));
      } else {
        children = Array.prototype.slice.call(el.children);
      }

      if (!children || !children.length) return;

      var dist = getDistance(el);
      var dur = getDuration(el, CONFIG.duration);
      var ease = getEase(el, CONFIG.ease);
      var stag = getStagger(el, CONFIG.stagger);
      var del = getDelay(el);
      var once = getOnce(el);
      var start = getScrollStart(el);

      // Hide all children immediately
      gsap.set(children, { opacity: 0, y: dist });

      // Group children into visual rows by their vertical position
      // so each row staggers independently when it enters the viewport
      var rows = [];
      var currentRow = [];
      var currentTop = null;
      var tolerance = 10; // px — accounts for subpixel differences

      children.forEach(function (child) {
        var top = child.getBoundingClientRect().top;
        if (currentTop === null || Math.abs(top - currentTop) < tolerance) {
          currentRow.push(child);
          if (currentTop === null) currentTop = top;
        } else {
          rows.push(currentRow);
          currentRow = [child];
          currentTop = top;
        }
      });
      if (currentRow.length) rows.push(currentRow);

      // Each row gets its own ScrollTrigger — children within
      // a row stagger sequentially when that row enters view
      rows.forEach(function (row) {
        var t = gsap.to(row, {
          opacity: 1,
          y: 0,
          duration: dur,
          ease: ease,
          stagger: stag,
          delay: del,
          scrollTrigger: {
            trigger: row[0],
            start: start,
            toggleActions: once
              ? "play none none none"
              : "play none none reverse",
          },
          onComplete: function () {
            row.forEach(function (c) { clearWillChange(c); });
          },
        });
        trackTrigger(t);
      });
    },

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
    "hero-text": function (el) {
      var parts = splitContent(el, "lines");
      if (!parts || !parts.length) return;
      var partsArr = Array.prototype.slice.call(parts);
      gsap.set(partsArr, { y: "110%", opacity: 0 });
      gsap.to(partsArr, {
        y: "0%", opacity: 1,
        duration: getDuration(el, 1),
        ease: getEase(el, "power4.out"),
        stagger: getStagger(el, 0.15),
        delay: getDelay(el) || 0.3,

        onComplete: function () {
          partsArr.forEach(function (p) { clearWillChange(p); });
        },
      });
    },

    "hero-image": function (el) {
      gsap.set(el, { opacity: 0, scale: 1.05 });
      gsap.to(el, {
        opacity: 1, scale: 1,
        duration: getDuration(el, 1.4),
        ease: getEase(el, "power3.out"),
        delay: getDelay(el) || 0.2,

        onComplete: function () { clearWillChange(el); },
      });
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
        gsapScrollAnims[type](el);
        return;
      }

      // GSAP load animations
      if (gsapLoadAnims[type] && state.gsapLoaded) {
        gsapLoadAnims[type](el);
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
          if (isInViewport(el)) {
            el.classList.add("hm-visible");
          } else {
            state.observers.forEach(function (obs) {
              obs.observe(el);
            });
          }
          state.processedEls.add(el);
        }
      });

      if (needsGSAP) {
        loadGSAP().then(function () {
          newEls.forEach(function (el) {
            if (!state.processedEls.has(el)) processElement(el);
          });
          ScrollTrigger.refresh();
        });
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
            // All elements processed, recalc scroll positions
            ScrollTrigger.refresh();
          }
        }

        requestAnimationFrame(processBatch);

        // Recalculate positions after all images/fonts load
        window.addEventListener("load", function () {
          ScrollTrigger.refresh();
        });

        finishInit();
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
    state.triggers.forEach(function (st) {
      if (st && st.kill) st.kill();
    });
    state.triggers = [];

    state.observers.forEach(function (obs) {
      obs.disconnect();
    });
    state.observers = [];

    state.listeners.forEach(function (l) {
      l.el.removeEventListener(l.evt, l.fn);
    });
    state.listeners = [];

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

    state.processedEls = new WeakSet();
    state.initialized = false;

    document.documentElement.classList.remove(
      "hm-loading", "hm-ready", "hm-fallback"
    );

    log("Destroyed.");
  }

  function refresh() {
    if (state.gsapLoaded) ScrollTrigger.refresh();
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
})();
