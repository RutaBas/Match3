/*
 * sound.js — Tide Pool audio (Web Audio, synthesized, zero asset files).
 *
 * Ships Set 3 · "Marimba Tide" (design-sound.html) — warm wooden marimba plinks.
 * The voice()/wood() synth helpers are ported VERBATIM from design-sound.html so
 * the in-game sounds match the picker exactly.
 *
 * The AudioContext is created lazily and resumed on the first user gesture. Mute
 * is persisted in localStorage ('tp-muted'); haptics live in the game controller.
 */
(function (root) {
  "use strict";

  var MUTE_KEY = "tp-muted";
  var muted = false;
  try { muted = localStorage.getItem(MUTE_KEY) === "1"; } catch (e) {}

  var AC = null;
  function ctx() {
    if (!AC) {
      try { AC = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { return null; }
    }
    if (AC && AC.state === "suspended") AC.resume();
    return AC;
  }

  // --- exact synth from design-sound.html ---------------------------------
  // generic voice: osc with gain envelope + optional pitch bend + harmonic.
  function voice(freq, dur, opts) {
    opts = opts || {};
    var c = ctx(); if (!c) return;
    var type = opts.type || "sine";
    var g = opts.g == null ? 0.22 : opts.g;
    var a = opts.a == null ? 0.008 : opts.a;
    var bendTo = opts.bendTo == null ? null : opts.bendTo;
    var harm = opts.harm || 0;
    var hg = opts.hg || 0.0;
    var t0 = opts.t0 || 0;
    var now = c.currentTime + t0;
    var o = c.createOscillator(), gain = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, now);
    if (bendTo) o.frequency.exponentialRampToValueAtTime(bendTo, now + dur);
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(g, now + a);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.connect(gain); gain.connect(c.destination); o.start(now); o.stop(now + dur + 0.02);
    if (harm) {
      var o2 = c.createOscillator(), g2 = c.createGain(); o2.type = type;
      o2.frequency.setValueAtTime(freq * harm, now);
      g2.gain.setValueAtTime(0, now); g2.gain.linearRampToValueAtTime(hg, now + a);
      g2.gain.exponentialRampToValueAtTime(0.0001, now + dur * 0.7);
      o2.connect(g2); g2.connect(c.destination); o2.start(now); o2.stop(now + dur);
    }
  }
  // warm wooden marimba plink
  function wood(f, t0, g, d) {
    voice(f, d == null ? 0.28 : d, {
      type: "sine", g: g == null ? 0.24 : g, a: 0.004,
      t0: t0 || 0, harm: 4, hg: 0.05
    });
  }

  var API = {
    resume: function () { ctx(); },
    isMuted: function () { return muted; },
    setMuted: function (m) {
      muted = !!m;
      try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch (e) {}
    },
    toggle: function () { API.setMuted(!muted); return muted; },

    // select / swap — single plink (D5)
    select: function () { if (!muted) wood(587); },

    // match & clear — a rising three-note figure (D5 F5 A5)
    match: function () {
      if (muted) return;
      [587, 698, 880].forEach(function (f, i) { wood(f, i * 0.08); });
    },

    // cascade step n (0-based) — the match figure lifted a step per chain, so
    // deeper cascades ring higher/brighter (the brief's "rising pitch").
    cascade: function (n) {
      if (muted) return;
      var mul = Math.pow(1.122, Math.min(n || 0, 6)); // ~+2 semitones per step
      [587, 698, 880].forEach(function (f, i) { wood(f * mul, i * 0.05, 0.2); });
    },

    // special formed (current / pearl) — bright ascending glint
    special: function () {
      if (muted) return;
      [880, 988, 1175, 1319].forEach(function (f, i) { wood(f, i * 0.06, 0.2, 0.24); });
    },

    // Depth cleared — WIN flourish (marimba run + a held triad)
    win: function () {
      if (muted) return;
      [523, 587, 659, 784, 880, 1047].forEach(function (f, i) { wood(f, i * 0.1, 0.24, 0.3); });
      [523, 659, 784].forEach(function (f) { wood(f, 0.72, 0.18, 0.6); });
    },

    // out of moves — gentle descending "gulp"
    lose: function () {
      if (muted) return;
      [440, 392, 330, 262].forEach(function (f, i) { wood(f, i * 0.12, 0.2, 0.34); });
    },

    // illegal swap — dull "nope"
    bad: function () {
      if (muted) return;
      voice(150, 0.16, { type: "square", g: 0.1, bendTo: 110 });
    }
  };

  root.TideSound = API;
})(typeof window !== "undefined" ? window : this);
