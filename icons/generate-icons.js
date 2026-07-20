/*
 * Tide Pool app-icon generator — a lustrous PEARL glowing on deep tide-teal
 * water, rendered to PNG at 180 / 192 / 512 px.
 *
 * Zero dependencies: a tiny hand-rolled PNG encoder (zlib is built into Node)
 * plus a supersampled software rasteriser. Run with:
 *     node icons/generate-icons.js
 * Produces icons/icon-180.png, icon-192.png, icon-512.png.
 */
"use strict";
var zlib = require("zlib");
var fs = require("fs");
var path = require("path");

// -- Kelp Forest palette ------------------------------------------------------
var DEEP = [0x12, 0x22, 0x23];   // deepest water (corners)
var TEAL = [0x1E, 0x35, 0x36];   // panel teal (center wash)
var AQUA = [0x5B, 0xB6, 0xA6];   // accent glow
var PEARL_HI = [0xFF, 0xFF, 0xFF];
var PEARL_MID = [0xE3, 0xF0, 0xEA];
var PEARL_LO = [0x9F, 0xC4, 0xBE];  // seafoam underside
var GOLD = [0xCB, 0xB2, 0x7A];

// -- PNG encoder --------------------------------------------------------------
function crcTable() {
  var t = [];
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
}
var CRC = crcTable();
function crc32(buf) {
  var c = 0xffffffff;
  for (var i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  var t = Buffer.from(type, "ascii");
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  var sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  var stride = w * 4;
  var raw = Buffer.alloc((stride + 1) * h);
  for (var y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  var idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// -- supersampled rasteriser --------------------------------------------------
function render(size) {
  var SS = 4;
  var W = size * SS;
  var buf = new Float32Array(W * W * 3);

  function px(x, y, rgb, a) {
    if (x < 0 || y < 0 || x >= W || y >= W || a <= 0) return;
    var i = (y * W + x) * 3, ia = 1 - a;
    buf[i] = buf[i] * ia + rgb[0] * a;
    buf[i + 1] = buf[i + 1] * ia + rgb[1] * a;
    buf[i + 2] = buf[i + 2] * ia + rgb[2] * a;
  }

  var cx = W / 2, cy = W / 2;
  var maxd = Math.hypot(cx, cy);

  // water: radial teal wash, darkening toward the corners
  for (var y = 0; y < W; y++) {
    for (var x = 0; x < W; x++) {
      var i = (y * W + x) * 3;
      var dd = Math.hypot(x - cx, y - cy) / maxd; // 0 center .. 1 corner
      var r = TEAL[0] + (DEEP[0] - TEAL[0]) * dd;
      var g = TEAL[1] + (DEEP[1] - TEAL[1]) * dd;
      var b = TEAL[2] + (DEEP[2] - TEAL[2]) * dd;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
    }
  }

  // aqua bioluminescent glow behind the pearl
  var pr = W * 0.30;                 // pearl radius
  var glowR = pr * 2.1;
  for (var gy = 0; gy < W; gy++) {
    for (var gx = 0; gx < W; gx++) {
      var gd = Math.hypot(gx - cx, gy - cy);
      if (gd < glowR) {
        var ga = Math.pow(1 - gd / glowR, 2.2) * 0.5;
        px(gx, gy, AQUA, ga);
      }
    }
  }

  // the pearl: colored sphere with an upper-left sheen + underside seafoam
  var hx = cx - pr * 0.32, hy = cy - pr * 0.36; // highlight center
  var minx = Math.max(0, (cx - pr) | 0), maxx = Math.min(W - 1, Math.ceil(cx + pr));
  var miny = Math.max(0, (cy - pr) | 0), maxy = Math.min(W - 1, Math.ceil(cy + pr));
  for (var by = miny; by <= maxy; by++) {
    for (var bx = minx; bx <= maxx; bx++) {
      var d = Math.hypot(bx + 0.5 - cx, by + 0.5 - cy);
      var a2 = Math.max(0, Math.min(1, pr + 0.5 - d));
      if (a2 <= 0) continue;
      // vertical gradient: pearl-mid up top, seafoam-lo toward the bottom
      var vt = (by - (cy - pr)) / (2 * pr); // 0 top .. 1 bottom
      var base = [
        PEARL_MID[0] + (PEARL_LO[0] - PEARL_MID[0]) * vt,
        PEARL_MID[1] + (PEARL_LO[1] - PEARL_MID[1]) * vt,
        PEARL_MID[2] + (PEARL_LO[2] - PEARL_MID[2]) * vt
      ];
      // sheen toward highlight point
      var hd = Math.hypot(bx + 0.5 - hx, by + 0.5 - hy) / (pr * 0.95);
      var t = Math.max(0, 1 - hd);
      var col = [
        base[0] + (PEARL_HI[0] - base[0]) * t * 0.85,
        base[1] + (PEARL_HI[1] - base[1]) * t * 0.85,
        base[2] + (PEARL_HI[2] - base[2]) * t * 0.85
      ];
      px(bx, by, col, a2);
    }
  }

  // crisp specular dot
  var sx = cx - pr * 0.36, sy = cy - pr * 0.42, sr = pr * 0.16;
  for (var wy = Math.max(0, (sy - sr) | 0); wy <= Math.min(W - 1, sy + sr); wy++) {
    for (var wx = Math.max(0, (sx - sr) | 0); wx <= Math.min(W - 1, sx + sr); wx++) {
      var sd = Math.hypot(wx + 0.5 - sx, wy + 0.5 - sy);
      var sa = Math.max(0, Math.min(1, sr + 0.5 - sd)) * 0.85;
      px(wx, wy, PEARL_HI, sa);
    }
  }

  // a couple of tiny gold plankton motes drifting near the pearl
  function mote(mx, my, mr, rgb, alpha) {
    for (var yy = Math.max(0, (my - mr) | 0); yy <= Math.min(W - 1, my + mr); yy++) {
      for (var xx = Math.max(0, (mx - mr) | 0); xx <= Math.min(W - 1, mx + mr); xx++) {
        var md = Math.hypot(xx + 0.5 - mx, yy + 0.5 - my);
        var ma = Math.max(0, Math.min(1, mr + 0.5 - md)) * alpha;
        px(xx, yy, rgb, ma);
      }
    }
  }
  mote(cx + pr * 1.15, cy - pr * 0.7, W * 0.018, GOLD, 0.9);
  mote(cx - pr * 1.1, cy + pr * 0.5, W * 0.014, AQUA, 0.9);
  mote(cx + pr * 0.9, cy + pr * 1.05, W * 0.012, GOLD, 0.8);

  // downsample SS -> size
  var out = Buffer.alloc(size * size * 4);
  for (var oy = 0; oy < size; oy++) for (var ox = 0; ox < size; ox++) {
    var rr = 0, gg = 0, bb = 0;
    for (var syy = 0; syy < SS; syy++) for (var sxx = 0; sxx < SS; sxx++) {
      var si = ((oy * SS + syy) * W + (ox * SS + sxx)) * 3;
      rr += buf[si]; gg += buf[si + 1]; bb += buf[si + 2];
    }
    var n = SS * SS, oi = (oy * size + ox) * 4;
    out[oi] = Math.round(rr / n); out[oi + 1] = Math.round(gg / n);
    out[oi + 2] = Math.round(bb / n); out[oi + 3] = 255;
  }
  return encodePNG(size, size, out);
}

[180, 192, 512].forEach(function (s) {
  var png = render(s);
  var file = path.join(__dirname, "icon-" + s + ".png");
  fs.writeFileSync(file, png);
  console.log("wrote", file, png.length, "bytes");
});
