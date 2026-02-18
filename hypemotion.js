(function () {
  "use strict";

  var VERSION = "2.0.0";
  var LIB = "HypeMotion";

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
    scrollStart: "top 88%",
    observerMargin: "0px 0px -12% 0px",
    once: true,
    parallaxSpeed: 0.2,
    foicTimeout: 4000,
    gsapCDN: "https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5",
  };

  // Which animations belong to which tier
  var CSS_TIER = [
    "fade-up", "fade-down", "fade-left",
    "fade-right", "fade-in", "scale-in", "reveal-up",
  ];
  var GSAP_TIER = [
    "split-lines", "split-words", "split-chars",
    "img-reveal", "stagger-children", "counter",
    "draw-line", "parallax", "hero-text", "hero-image",
  ];
  var BTN_TYPES = ["fill", "magnetic", "text-slide"];

  // ════════════════════════════════════════════════════════
  // 2. STATE & TRACKING
  // ════════════════════════════════════════════════════════

  var state = {
    initialized: false,
    gsapLoaded: false,
    gsapLoading: false,
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

  function scrollCfg(el) {
    return {
      trigger: el,
      start: attr(el, "scroll-start", CONFIG.scrollStart),
      toggleActions: attr(el, "once", CONFIG.once)
        ? "play none none none"
        : "play none none reverse",
    };
  }

  function trackTrigger(st) {
    if (st && st.scrollTrigger) state.triggers.push(st.scrollTrigger);
    else if (st && st.vars && st.vars.scrollTrigger) state.triggers.push(st.scrollTrigger);
  }

  function fadeFrom(el, dir) {
    var d = attr(el, "distance", CONFIG.distance);
    var base = {
      opacity: 0,
      duration: attr(el, "duration", CONFIG.duration),
      ease: attr(el, "ease", CONFIG.ease),
      delay: attr(el, "delay", CONFIG.delay),
    };
    if (dir === "up") return Object.assign(base, { y: d });
    if (dir === "down") return Object.assign(base, { y: -d });
    if (dir === "left") return Object.assign(base, { x: -d });
    if (dir === "right") return Object.assign(base, { x: d });
    return base;
  }

  // ════════════════════════════════════════════════════════
  // 4. SAFETY SYSTEMS
  // ════════════════════════════════════════════════════════

  // ── 4a. Flash of Invisible Content Protection ──────────

  function injectSafetyCSS() {
    var style = document.createElement("style");
    style.id = "hm-safety-css";
    style.textContent = [
      ".hm-loading [data-animate]:not([data-animate='parallax']):not([data-animate='counter']) {",
      "  opacity: 0; }",
      ".hm-fallback [data-animate] {",
      "  opacity: 1 !important;",
      "  transform: none !important;",
      "  clip-path: none !important; }",
    ].join("\n");
    document.head.appendChild(style);
  }

  function enableFOICFallback() {
    setTimeout(function () {
      if (!state.initialized) {
        document.documentElement.classList.add("hm-fallback");
        warn("Init timeout — fallback activated, content made visible.");
      }
    }, CONFIG.foicTimeout);
  }

  // ── 4b. Reduced Motion Detection ──────────────────────

  function checkReducedMotion() {
    var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    state.reducedMotion = mq.matches;
    mq.addEventListener("change", function (e) {
      state.reducedMotion = e.matches;
      if (e.matches) log("Reduced motion enabled — animations simplified.");
    });
  }

  function shouldAnimate(el) {
    if (!state.reducedMotion) return true;
    return el.getAttribute("data-motion") === "essential";
  }

  // ── 4c. Webflow Interaction Conflict Detection ────────

  function checkConflicts(el) {
    if (el.getAttribute("data-w-id")) {
      warn(
        'Element has both data-animate and a Webflow Interaction (data-w-id). ' +
        'These may conflict. Remove one. Element: ' +
        (el.className || el.tagName)
      );
    }
  }

  // ════════════════════════════════════════════════════════
  // 5. CSS TIER — Zero Dependencies
  // ════════════════════════════════════════════════════════

  function injectCSSTier() {
    var style = document.createElement("style");
    style.id = "hm-css-animations";
    style.textContent = [
      "@keyframes hm-fade-up {",
      "  from { opacity:0; transform: translateY(var(--hm-dist, 40px)); }",
      "  to { opacity:1; transform: translateY(0); } }",

      "@keyframes hm-fade-down {",
      "  from { opacity:0; transform: translateY(calc(var(--hm-dist, 40px) * -1)); }",
      "  to { opacity:1; transform: translateY(0); } }",

      "@keyframes hm-fade-left {",
      "  from { opacity:0; transform: translateX(calc(var(--hm-dist, 40px) * -1)); }",
      "  to { opacity:1; transform: translateX(0); } }",

      "@keyframes hm-fade-right {",
      "  from { opacity:0; transform: translateX(var(--hm-dist, 40px)); }",
      "  to { opacity:1; transform: translateX(0); } }",

      "@keyframes hm-fade-in {",
      "  from { opacity:0; }",
      "  to { opacity:1; } }",

      "@keyframes hm-scale-in {",
      "  from { opacity:0; transform: scale(0.9); }",
      "  to { opacity:1; transform: scale(1); } }",

      "@keyframes hm-reveal-up {",
      "  from { clip-path: inset(100% 0% 0% 0%); }",
      "  to { clip-path: inset(0% 0% 0% 0%); } }",

      ".hm-in[data-animate='fade-up'] {",
      "  animation: hm-fade-up var(--hm-dur, 0.8s) var(--hm-ease, cubic-bezier(0.33,1,0.68,1)) var(--hm-del, 0s) both; }",

      ".hm-in[data-animate='fade-down'] {",
      "  animation: hm-fade-down var(--hm-dur, 0.8s) var(--hm-ease, cubic-bezier(0.33,1,0.68,1)) var(--hm-del, 0s) both; }",

      ".hm-in[data-animate='fade-left'] {",
      "  animation: hm-fade-left var(--hm-dur, 0.8s) var(--hm-ease, cubic-bezier(0.33,1,0.68,1)) var(--hm-del, 0s) both; }",

      ".hm-in[data-animate='fade-right'] {",
      "  animation: hm-fade-right var(--hm-dur, 0.8s) var(--hm-ease, cubic-bezier(0.33,1,0.68,1)) var(--hm-del, 0s) both; }",

      ".hm-in[data-animate='fade-in'] {",
      "  animation: hm-fade-in var(--hm-dur, 0.8s) var(--hm-ease, cubic-bezier(0.33,1,0.68,1)) var(--hm-del, 0s) both; }",

      ".hm-in[data-animate='scale-in'] {",
      "  animation: hm-scale-in var(--hm-dur, 0.8s) var(--hm-ease, cubic-bezier(0.33,1,0.68,1)) var(--hm-del, 0s) both; }",

      ".hm-in[data-animate='reveal-up'] {",
      "  animation: hm-reveal-up var(--hm-dur, 1s) cubic-bezier(0.76,0,0.24,1) var(--hm-del, 0s) both; }",

      "@media (prefers-reduced-motion: reduce) {",
      "  [data-animate]:not([data-motion='essential']) {",
      "    animation-duration: 0.01ms !important;",
      "    transition-duration: 0.01ms !important; }",
      "  .hm-in[data-animate]:not([data-motion='essential']) {",
      "    opacity: 1; transform: none; clip-path: none; } }",
    ].join("\n");
    document.head.appendChild(style);
  }

  function applyCSSOverrides(el) {
    var d = el.getAttribute("data-duration");
    var del = el.getAttribute("data-delay");
    var dist = el.getAttribute("data-distance");
    if (d) el.style.setProperty("--hm-dur", d + "s");
    if (del) el.style.setProperty("--hm-del", del + "s");
    if (dist) el.style.setProperty("--hm-dist", dist + "px");
  }

  function initCSSTier(elements) {
    if (!elements.length) return;

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("hm-in");
            var once = attr(entry.target, "once", CONFIG.once);
            if (once) observer.unobserve(entry.target);
          } else {
            var once = attr(entry.target, "once", CONFIG.once);
            if (!once) entry.target.classList.remove("hm-in");
          }
        });
      },
      { rootMargin: CONFIG.observerMargin, threshold: 0 }
    );

    elements.forEach(function (el) {
      if (state.reducedMotion && !shouldAnimate(el)) {
        el.style.opacity = "1";
        return;
      }
      applyCSSOverrides(el);
      observer.observe(el);
    });

    state.observers.push(observer);
  }

  // ════════════════════════════════════════════════════════
  // 6. DYNAMIC GSAP LOADER
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
      return Promise.resolve();
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
        log("GSAP loaded dynamically (required by page content).");
      })
      .catch(function (err) {
        state.gsapLoading = false;
        warn("GSAP failed to load: " + err.message);
        document.documentElement.classList.add("hm-fallback");
      });

    return state.gsapPromise;
  }

  // ════════════════════════════════════════════════════════
  // 7. TEXT SPLITTER — HTML-Preserving
  // ════════════════════════════════════════════════════════

  function splitContent(el, type) {
    el.setAttribute("aria-label", el.textContent);
    var hasBR = el.querySelector("br");
    var hasHTML = el.querySelector("a, strong, em, span, b, i, u, mark, sup, sub");

    if (hasHTML) {
      warn(
        'Element with data-animate="split-' + type + '" contains inline HTML ' +
        "(links, bold, etc). HTML structure is preserved but results may vary. " +
        "Element: " + el.textContent.substring(0, 40) + "..."
      );
    }

    if (type === "lines") return splitLines(el, hasBR);
    if (type === "words") return splitWords(el);
    if (type === "chars") return splitChars(el);
  }

  function splitLines(el, hasBR) {
    if (hasBR) {
      var html = el.innerHTML;
      var parts = html.split(/<br\s*\/?>/gi);
      el.innerHTML = "";
      parts.forEach(function (part) {
        var outer = document.createElement("span");
        outer.style.display = "block";
        outer.style.overflow = "hidden";
        var inner = document.createElement("span");
        inner.innerHTML = part.trim();
        inner.style.display = "inline-block";
        inner.classList.add("hm-line");
        outer.appendChild(inner);
        el.appendChild(outer);
      });
      return el.querySelectorAll(".hm-line");
    }

    var words = [];
    walkTextNodes(el, function (textNode) {
      var parts = textNode.textContent.split(/(\s+)/);
      var frag = document.createDocumentFragment();
      parts.forEach(function (p) {
        if (/^\s+$/.test(p)) {
          frag.appendChild(document.createTextNode(p));
        } else if (p) {
          var s = document.createElement("span");
          s.textContent = p;
          s.className = "hm-measure";
          s.style.display = "inline";
          frag.appendChild(s);
          words.push(s);
        }
      });
      textNode.parentNode.replaceChild(frag, textNode);
    });

    var lines = [];
    var curLine = [];
    var curTop = null;
    words.forEach(function (w) {
      var top = w.getBoundingClientRect().top;
      if (curTop === null || Math.abs(top - curTop) < 4) {
        curLine.push(w);
        if (curTop === null) curTop = top;
      } else {
        lines.push(curLine);
        curLine = [w];
        curTop = top;
      }
    });
    if (curLine.length) lines.push(curLine);

    el.innerHTML = "";
    lines.forEach(function (lineWords) {
      var outer = document.createElement("span");
      outer.style.display = "block";
      outer.style.overflow = "hidden";
      var inner = document.createElement("span");
      inner.style.display = "inline-block";
      inner.classList.add("hm-line");
      lineWords.forEach(function (w, i) {
        inner.appendChild(document.createTextNode(w.textContent));
        if (i < lineWords.length - 1) {
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
      var parts = textNode.textContent.split(/(\s+)/);
      var frag = document.createDocumentFragment();
      parts.forEach(function (p) {
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

    el.querySelectorAll("a, strong, em, span:not(.hm-word), b, i").forEach(function (node) {
      if (!node.classList.contains("hm-word")) {
        node.style.display = "inline-block";
        node.classList.add("hm-word");
      }
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
    var textNodes = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    textNodes.forEach(callback);
  }

  // ════════════════════════════════════════════════════════
  // 8. GSAP TIER — SCROLL ANIMATIONS
  // ════════════════════════════════════════════════════════

  var gsapScrollAnims = {
    "fade-up": function (el) {
      var t = gsap.from(el, Object.assign(fadeFrom(el, "up"), { scrollTrigger: scrollCfg(el) }));
      trackTrigger(t);
    },
    "fade-down": function (el) {
      var t = gsap.from(el, Object.assign(fadeFrom(el, "down"), { scrollTrigger: scrollCfg(el) }));
      trackTrigger(t);
    },
    "fade-left": function (el) {
      var t = gsap.from(el, Object.assign(fadeFrom(el, "left"), { scrollTrigger: scrollCfg(el) }));
      trackTrigger(t);
    },
    "fade-right": function (el) {
      var t = gsap.from(el, Object.assign(fadeFrom(el, "right"), { scrollTrigger: scrollCfg(el) }));
      trackTrigger(t);
    },
    "fade-in": function (el) {
      var t = gsap.from(el, Object.assign(fadeFrom(el, "none"), { scrollTrigger: scrollCfg(el) }));
      trackTrigger(t);
    },
    "scale-in": function (el) {
      var t = gsap.from(el, {
        opacity: 0, scale: 0.9,
        duration: attr(el, "duration", CONFIG.duration),
        ease: attr(el, "ease", CONFIG.ease),
        delay: attr(el, "delay", CONFIG.delay),
        scrollTrigger: scrollCfg(el),
      });
      trackTrigger(t);
    },
    "reveal-up": function (el) {
      var t = gsap.from(el, {
        clipPath: "inset(100% 0% 0% 0%)",
        duration: attr(el, "duration", 1),
        ease: attr(el, "ease", "power4.inOut"),
        delay: attr(el, "delay", CONFIG.delay),
        scrollTrigger: scrollCfg(el),
      });
      trackTrigger(t);
    },

    "split-lines": function (el) {
      var parts = splitContent(el, "lines");
      if (!parts || !parts.length) return;
      gsap.from(parts, {
        y: "110%", opacity: 0,
        duration: attr(el, "duration", 0.9),
        ease: attr(el, "ease", "power3.out"),
        stagger: attr(el, "stagger", 0.12),
        delay: attr(el, "delay", CONFIG.delay),
        scrollTrigger: scrollCfg(el),
      });
    },
    "split-words": function (el) {
      var parts = splitContent(el, "words");
      if (!parts || !parts.length) return;
      gsap.from(parts, {
        y: 20, opacity: 0,
        duration: attr(el, "duration", 0.6),
        ease: attr(el, "ease", "power2.out"),
        stagger: attr(el, "stagger", 0.04),
        delay: attr(el, "delay", CONFIG.delay),
        scrollTrigger: scrollCfg(el),
      });
    },
    "split-chars": function (el) {
      var parts = splitContent(el, "chars");
      if (!parts || !parts.length) return;
      gsap.from(parts, {
        y: 15, opacity: 0,
        duration: attr(el, "duration", 0.5),
        ease: attr(el, "ease", "power2.out"),
        stagger: attr(el, "stagger", 0.02),
        delay: attr(el, "delay", CONFIG.delay),
        scrollTrigger: scrollCfg(el),
      });
    },

    "img-reveal": function (el) {
      var dir = attr(el, "reveal-direction", "left");
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
        case "bottom": default:
          clipFrom = "inset(100% 0 0 0)";
          clipTo = "inset(0% 0 0 0)";
          break;
      }

      gsap.set(el, { clipPath: clipFrom, scale: 1.15 });

      var tl = gsap.timeline({
        scrollTrigger: scrollCfg(el),
        delay: attr(el, "delay", CONFIG.delay),
      });

      tl.to(el, {
        clipPath: clipTo,
        duration: attr(el, "duration", 1),
        ease: attr(el, "ease", "power4.inOut"),
      }).to(el, {
        scale: 1,
        duration: 1.2,
        ease: "power2.out",
      }, "<0.3");
    },

    "stagger-children": function (el) {
      var selector = attr(el, "stagger-selector", null);
      var children = selector
        ? el.querySelectorAll(selector)
        : el.children;

      if (!children.length) return;

      gsap.from(children, {
        opacity: 0,
        y: attr(el, "distance", 30),
        duration: attr(el, "duration", CONFIG.duration),
        ease: attr(el, "ease", CONFIG.ease),
        stagger: attr(el, "stagger", CONFIG.stagger),
        delay: attr(el, "delay", CONFIG.delay),
        scrollTrigger: scrollCfg(el),
      });
    },

    counter: function (el) {
      var raw = el.textContent.trim();
      var match = raw.match(/^([^0-9]*?)([\d,]+\.?\d*)(.*?)$/);
      if (!match) {
        warn('Counter: could not parse number from "' + raw + '"');
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
        duration: attr(el, "duration", 2),
        ease: attr(el, "ease", "power2.out"),
        delay: attr(el, "delay", CONFIG.delay),
        scrollTrigger: scrollCfg(el),
        onUpdate: function () {
          var display = decimals
            ? obj.val.toFixed(decimals)
            : Math.round(obj.val).toString();
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

    "draw-line": function (el) {
      var paths = el.querySelectorAll("path, line, circle, rect, polyline, polygon");
      paths.forEach(function (p) {
        var len = p.getTotalLength ? p.getTotalLength() : 0;
        if (!len) return;
        gsap.set(p, { strokeDasharray: len, strokeDashoffset: len });
        gsap.to(p, {
          strokeDashoffset: 0,
          duration: attr(el, "duration", 1.5),
          ease: attr(el, "ease", "power2.inOut"),
          delay: attr(el, "delay", CONFIG.delay),
          scrollTrigger: scrollCfg(el),
        });
      });
    },

    parallax: function (el) {
      var speed = attr(el, "parallax-speed", CONFIG.parallaxSpeed);
      if (window.innerWidth < 768 && !el.getAttribute("data-parallax-mobile")) {
        return;
      }
      gsap.to(el, {
        y: function () { return speed * 100; },
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
  // 9. GSAP TIER — LOAD ANIMATIONS (Hero)
  // ════════════════════════════════════════════════════════

  var gsapLoadAnims = {
    "hero-text": function (el) {
      var parts = splitContent(el, "lines");
      if (!parts || !parts.length) return;
      gsap.from(parts, {
        y: "110%",
        duration: attr(el, "duration", 1),
        ease: attr(el, "ease", "power4.out"),
        stagger: attr(el, "stagger", 0.15),
        delay: attr(el, "delay", 0.3),
      });
    },
    "hero-image": function (el) {
      gsap.from(el, {
        opacity: 0,
        scale: 1.05,
        duration: attr(el, "duration", 1.4),
        ease: attr(el, "ease", "power3.out"),
        delay: attr(el, "delay", 0.2),
      });
    },
  };

  // ════════════════════════════════════════════════════════
  // 10. GSAP TIER — BUTTON INTERACTIONS
  // ════════════════════════════════════════════════════════

  var btnInteractions = {
    fill: function (el) {
      el.style.position = "relative";
      el.style.overflow = "hidden";

      var fill = document.createElement("span");
      fill.classList.add("hm-btn-fill");
      fill.style.cssText =
        "position:absolute;inset:0;transform:scaleX(0);transform-origin:left;" +
        "pointer-events:none;z-index:0;";

      var color = attr(el, "fill-color", null);
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
      var strength = attr(el, "magnetic-strength", 0.3);
      if ("ontouchstart" in window) return;

      addListener(el, "mousemove", function (e) {
        var r = el.getBoundingClientRect();
        var x = e.clientX - r.left - r.width / 2;
        var y = e.clientY - r.top - r.height / 2;
        gsap.to(el, { x: x * strength, y: y * strength, duration: 0.2, ease: "power2.out" });
      });
      addListener(el, "mouseleave", function () {
        gsap.to(el, { x: 0, y: 0, duration: 0.4, ease: "elastic.out(1, 0.5)" });
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

      el.style.overflow = "hidden";
      el.style.position = "relative";

      textEl.style.display = "inline-block";
      textEl.style.position = "relative";
      textEl.style.transition = "none";

      var clone = textEl.cloneNode(true);
      clone.classList.add("hm-btn-clone");
      clone.style.position = "absolute";
      clone.style.left = "0";
      clone.style.top = "0";
      clone.style.width = "100%";
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

      if (CSS_TIER.indexOf(type) > -1 && !state.gsapLoaded) return;

      if (gsapScrollAnims[type] && state.gsapLoaded) {
        gsapScrollAnims[type](el);
        return;
      }

      if (gsapLoadAnims[type] && state.gsapLoaded) {
        gsapLoadAnims[type](el);
        return;
      }
    }

    if (btn && state.gsapLoaded) {
      if (state.reducedMotion && !shouldAnimate(el)) return;
      if (btnInteractions[btn]) btnInteractions[btn](el);
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
          state.observers.forEach(function (obs) { obs.observe(el); });
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
    state.mutationObs.observe(document.body, { childList: true, subtree: true });
  }

  // ════════════════════════════════════════════════════════
  // 13. MAIN INITIALIZATION
  // ════════════════════════════════════════════════════════

  function init() {
    if (state.initialized) return;

    checkReducedMotion();
    injectSafetyCSS();
    enableFOICFallback();

    document.documentElement.classList.add("hm-loading");
    injectCSSTier();

    var allEls = document.querySelectorAll("[data-animate]");
    var btnEls = document.querySelectorAll("[data-btn]");
    var cssEls = [];
    var needsGSAP = false;

    allEls.forEach(function (el) {
      var type = el.getAttribute("data-animate");
      if (CSS_TIER.indexOf(type) > -1) cssEls.push(el);
      if (GSAP_TIER.indexOf(type) > -1) needsGSAP = true;
    });

    if (btnEls.length > 0) needsGSAP = true;

    // CSS tier starts immediately — zero wait
    initCSSTier(cssEls);
    cssEls.forEach(function (el) { state.processedEls.add(el); });

    if (needsGSAP) {
      loadGSAP().then(function () {
        allEls.forEach(function (el) { processElement(el); });
        btnEls.forEach(function (el) { processElement(el); });

        window.addEventListener("load", function () {
          ScrollTrigger.refresh();
        });

        finishInit();
      });
    } else {
      log("CSS-only mode — no GSAP needed for this page.");
      finishInit();
    }
  }

  function finishInit() {
    state.initialized = true;
    document.documentElement.classList.remove("hm-loading");
    document.documentElement.classList.add("hm-ready");
    startCMSObserver();

    log(
      "Initialized. " +
      document.querySelectorAll("[data-animate]").length + " animations, " +
      document.querySelectorAll("[data-btn]").length + " button interactions."
    );
  }

  // ════════════════════════════════════════════════════════
  // 14. PUBLIC API
  // ════════════════════════════════════════════════════════

  function destroy() {
    state.triggers.forEach(function (st) {
      if (st && st.kill) st.kill();
    });
    state.triggers = [];

    state.observers.forEach(function (obs) { obs.disconnect(); });
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
      ScrollTrigger.getAll().forEach(function (st) { st.kill(); });
    }

    state.processedEls = new WeakSet();
    state.initialized = false;

    document.documentElement.classList.remove("hm-loading", "hm-ready", "hm-fallback");

    log("Destroyed — all animations and listeners cleaned up.");
  }

  function refresh() {
    if (state.gsapLoaded) ScrollTrigger.refresh();
    log("ScrollTrigger refreshed.");
  }

  function reinit() {
    destroy();
    init();
  }

  // Expose public API
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

