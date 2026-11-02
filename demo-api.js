/* Objemy – statická ukážka bez servera.
 *
 * Nahrádza webové služby (api/…) nad kópiou dát z databázy (data.json). Všetko sa počíta v prehliadači:
 * kolízie a výrez (orezanie polygónov, polygon-clipping), prepočet S-JTSK <-> WGS84 (proj4), čítanie DXF,
 * bilancia a exporty (DXF R12, GeoJSON v S-JTSK, CSV). Nič sa neukladá.
 * Načítať pred app.js; app.js ho použije cez window.DemoApi.
 */
"use strict";
(() => {
  document.documentElement.classList.add("demo");

  const SJ = "EPSG:5514";
  const FORMATS = [["dxf", "DXF"], ["geojson", "GeoJSON"], ["csv", "CSV (Excel)"]];
  const D = { data: null, vols: [], byId: new Map(), pairs: [], typeSort: {}, typeOf: {}, tokens: new Map(), seq: 0 };

  class DemoError extends Error {}
  const fail = (msg) => { throw new DemoError(msg); };

  // ------------------------------------------------------------------ geometria (S-JTSK, metre)
  const ringArea = (r) => {
    let a = 0;
    for (let i = 0, n = r.length; i < n; i++) {
      const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % n];
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  };
  const polyArea = (p) => ringArea(p[0]) - p.slice(1).reduce((s, h) => s + ringArea(h), 0);
  const multiArea = (mp) => mp.reduce((s, p) => s + polyArea(p), 0);
  const bboxOf = (polys) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polys) for (const r of p) for (const [x, y] of r) {
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    }
    return [x0, y0, x1, y1];
  };
  const bboxHit = (a, b, tol = 0) => a[0] - tol <= b[2] && b[0] - tol <= a[2] && a[1] - tol <= b[3] && b[1] - tol <= a[3];
  const pip = (x, y, r) => {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const inPoly = (x, y, p) => pip(x, y, p[0]) && !p.slice(1).some((h) => pip(x, y, h));
  const segDist = (px, py, [ax, ay], [bx, by]) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  const distToPoly = (x, y, p) => {
    let d = Infinity;
    for (const r of p) for (let i = 0; i < r.length; i++) d = Math.min(d, segDist(x, y, r[i], r[(i + 1) % r.length]));
    return d;
  };
  const intersect = (a, b) => {
    try { return polygonClipping.intersection(a, b); } catch (e) { return []; }
  };
  // Prepočet WGS84 <-> S-JTSK: proj4 + afinná oprava vyrovnaná z kontrolných bodov PostGIS (data.json),
  // aby výsledok sedel s databázou (PostGIS používa presnejšiu transformáciu z databázy EPSG).
  let AFF = { fwd: (p) => p, inv: (p) => p };
  function fitAffine(ctrl) {
    if (ctrl.length < 3) return AFF;
    const src = ctrl.map(([lng, lat]) => proj4("EPSG:4326", SJ, [lng, lat]));
    const dst = ctrl.map((c) => [c[2], c[3]]);
    const mean = (a, i) => a.reduce((s, p) => s + p[i], 0) / a.length;
    const mu = mean(src, 0), mv = mean(src, 1), mx = mean(dst, 0), my = mean(dst, 1);
    let suu = 0, suv = 0, svv = 0, sux = 0, svx = 0, suy = 0, svy = 0;
    src.forEach(([pu, pv], i) => {
      const u = pu - mu, v = pv - mv, x = dst[i][0] - mx, y = dst[i][1] - my;
      suu += u * u; suv += u * v; svv += v * v; sux += u * x; svx += v * x; suy += u * y; svy += v * y;
    });
    const det = suu * svv - suv * suv;
    const a = (sux * svv - svx * suv) / det, b = (svx * suu - sux * suv) / det;
    const c = (suy * svv - svy * suv) / det, d = (svy * suu - suy * suv) / det;
    const dd = a * d - b * c;
    return {
      fwd: ([u, v]) => [a * (u - mu) + b * (v - mv) + mx, c * (u - mu) + d * (v - mv) + my],
      inv: ([x, y]) => { const X = x - mx, Y = y - my; return [(d * X - b * Y) / dd + mu, (-c * X + a * Y) / dd + mv]; },
    };
  }
  const fwd = ([lng, lat]) => AFF.fwd(proj4("EPSG:4326", SJ, [lng, lat]));
  const inv = ([x, y]) => proj4(SJ, "EPSG:4326", AFF.inv([x, y]));
  const toWgsPoly = (p) => ({ type: "Polygon", coordinates: p.map((r) => r.map(inv)) });
  const toWgsMulti = (mp) => ({ type: "MultiPolygon", coordinates: mp.map((p) => p.map((r) => r.map(inv))) });
  const r1 = (v) => Math.round(v * 10) / 10;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const FC = (features) => ({ type: "FeatureCollection", features });
  const num = (s) => {
    if (s === null || s === undefined || String(s).trim() === "") return null;
    const v = parseFloat(String(s).replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(v)) fail(`„${s}“ nie je číslo`);
    return v;
  };

  // hranica (polygón) zo zadaných bodov: kladné S-JTSK -> EPSG:5514, uzavretie, kontrola krížiacich sa hrán
  function segCross(p1, p2, p3, p4) {
    const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
    if (Math.abs(d) < 1e-12) return null;
    const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
    const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
    return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9 ? [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])] : null;
  }
  function makeRing(points) {
    let pts = [];
    for (const [x, y] of points) {
      const last = pts[pts.length - 1];
      if (!last || Math.abs(last[0] - x) > 1e-6 || Math.abs(last[1] - y) > 1e-6) pts.push([x, y]);
    }
    if (pts.length > 1 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-6 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts.pop();
    if (pts.length < 3) fail("Polygón potrebuje aspoň 3 rôzne body");
    if (pts.every(([x, y]) => x > 0 && y > 0)) pts = pts.map(([x, y]) => [-x, -y]);   // kladné S-JTSK
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const c = segCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]);
        if (c) fail(`Polygón nie je platný: hrany sa pretínajú v bode [${c[0].toFixed(2)} ${c[1].toFixed(2)}]`);
      }
    }
    if (ringArea(pts) <= 0) fail("Polygón nemá plochu");
    return [...pts, pts[0]];
  }
  function register(ring, name, zmin = null, zmax = null) {
    const token = `b${++D.seq}`;
    const poly = [ring];
    D.tokens.set(token, { poly, bbox: bboxOf([poly]), name, zmin, zmax });
    return token;
  }
  const boundary = (token) => D.tokens.get(token) || fail("Hranica sa nenašla – nahrajte DXF znova");

  // ------------------------------------------------------------------ čítanie DXF (textový / ASCII)
  function parseDxf(text) {
    if (text.startsWith("AutoCAD Binary DXF")) fail("Binárny DXF sa v ukážke nečíta – uložte DXF ako textový (ASCII)");
    const lines = text.split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i], 10), lines[i + 1].trim()]);
    let i = pairs.findIndex((p, k) => p[0] === 2 && p[1] === "ENTITIES" && k > 0 && pairs[k - 1][1] === "SECTION");
    if (i < 0) fail("Súbor nie je čitateľný DXF (chýba sekcia ENTITIES)");
    const ents = [];
    for (i++; i < pairs.length; i++) {
      const [c, v] = pairs[i];
      if (c === 0 && v === "ENDSEC") break;
      if (c === 0) ents.push({ type: v, g: [] });
      else if (ents.length) ents[ents.length - 1].g.push([c, v]);
    }
    const polys = [], warnings = [];
    let blocks = 0, bulges = 0;
    const get = (e, code) => (e.g.find((p) => p[0] === code) || [])[1];
    for (let k = 0; k < ents.length; k++) {
      const e = ents[k];
      if (e.type === "INSERT") { blocks++; continue; }
      if (e.type === "LWPOLYLINE") {
        const flags = parseInt(get(e, 70) || "0", 10), z = parseFloat(get(e, 38) || "0");
        const pts = [];
        for (const [c, v] of e.g) {
          if (c === 10) pts.push([parseFloat(v), 0, z]);
          else if (c === 20 && pts.length) pts[pts.length - 1][1] = parseFloat(v);
          else if (c === 42 && Math.abs(parseFloat(v)) > 1e-9) bulges++;
        }
        polys.push({ layer: get(e, 8) || "0", kind: "LWPOLYLINE", flags, pts });
      } else if (e.type === "POLYLINE") {
        const flags = parseInt(get(e, 70) || "0", 10);
        const pts = [];
        while (k + 1 < ents.length && ents[k + 1].type === "VERTEX") {
          k++;
          const vx = ents[k];
          pts.push([parseFloat(get(vx, 10)), parseFloat(get(vx, 20)), parseFloat(get(vx, 30) || "0")]);
        }
        if (k + 1 < ents.length && ents[k + 1].type === "SEQEND") k++;
        if (flags & (16 | 64)) continue;   // sieť / plošná sieť
        polys.push({ layer: get(e, 8) || "0", kind: "POLYLINE", flags, pts });
      }
    }
    const closed = polys.filter((p) => {
      if (p.pts.length < 3) return false;
      if (p.flags & 1) return true;
      const a = p.pts[0], b = p.pts[p.pts.length - 1];
      return p.pts.length > 3 && Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
    });
    if (blocks) warnings.push((blocks === 1 ? "1 blok (bunka) sa" : blocks <= 4 ? `${blocks} bloky (bunky) sa` : `${blocks} blokov (buniek) sa`) +
      " v ukážke nečíta – plná verzia so serverom číta aj polygóny v blokoch");
    if (bulges) warnings.push("Niektoré polyčiary majú oblúky – v ukážke sa berú ako priame úsečky");
    if (!closed.length) warnings.push("Nenašli sa žiadne uzavreté polyčiary (ako hranica slúžia len uzavreté LWPOLYLINE / POLYLINE)");
    return { polys: closed, warnings };
  }

  // ------------------------------------------------------------------ odpovede ako zo servera
  function meta() {
    const m = D.data.meta;
    return { types: m.types, so_list: m.so_list, authors: m.authors, bounds: m.bounds,
      stats: { volumes: D.vols.length, collisions: D.pairs.length } };
  }

  function volumes(q) {
    const so = q.get("so") || null, type = q.get("type") || null;
    const text = (q.get("q") || "").trim().toLowerCase();
    const kmf = num(q.get("km_from")), kmt = num(q.get("km_to"));
    const col = ["1", "true", "on"].includes(q.get("collisions_only"));
    const has = (s) => (s || "").toString().toLowerCase().includes(text);
    const rows = D.vols.filter(({ props: p }) =>
      (!so || p.so === so) && (!type || p.volume_type === type) &&
      (!text || has(p.name) || has(p.author) || has(p.file_link) || has(p.source_key)) &&
      (kmf === null || (p.km !== null && p.km >= kmf)) && (kmt === null || (p.km !== null && p.km <= kmt)) &&
      (!col || p.collision_count > 0));
    rows.sort((a, b) => a.props.so.localeCompare(b.props.so) || (a.props.km ?? 0) - (b.props.km ?? 0) || a.props.id - b.props.id);
    return FC(rows.map((v) => ({ type: "Feature", geometry: v.wgs, properties: { ...v.props } })));
  }

  const collisionsFC = () => FC(D.pairs.map((c) => ({ type: "Feature", geometry: c.wgs, properties: { ...c.props } })));

  function volumeDetail(id) {
    const v = D.byId.get(id) || fail(`Objem #${id} neexistuje`);
    const rows = D.pairs.filter((c) => c.props.a_id === id || c.props.b_id === id).map((c) => {
      const oid = c.props.a_id === id ? c.props.b_id : c.props.a_id;
      const o = D.byId.get(oid).props;
      return { type: "Feature", geometry: c.wgs, properties: {
        other_id: oid, other_name: o.name, other_so: o.so, other_km: o.km, other_type: o.volume_type,
        other_author: o.author, other_volume_m3: o.volume_m3, overlap_m2: c.props.overlap_m2,
        overlap_pct: r1(100 * c.props.overlap_m2 / v.props.area_m2) } };
    }).sort((a, b) => b.properties.overlap_m2 - a.properties.overlap_m2);
    const hits = rows.map((r) => ({ type: "Feature", geometry: D.byId.get(r.properties.other_id).wgs,
      properties: { other_id: r.properties.other_id, other_type: r.properties.other_type } }));
    return { volume: { type: "Feature", geometry: v.wgs, properties: { ...v.props } }, collisions: FC(rows), hits: FC(hits),
      checks: D.data.checks[id] || [] };
  }

  function at(q) {
    const [x, y] = fwd([num(q.get("lng")), num(q.get("lat"))]);
    const tol = Math.min(num(q.get("tol")) ?? 0.5, 50);
    const pt = [x, y, x, y];
    const rows = D.vols.filter((v) => bboxHit(v.bbox, pt, tol) && (inPoly(x, y, v.sj) || distToPoly(x, y, v.sj) <= tol))
      .sort((a, b) => a.props.area_m2 - b.props.area_m2 || a.props.id - b.props.id)
      .map(({ props: p }) => ({ id: p.id, name: p.name, so: p.so, km: p.km, volume_type: p.volume_type,
        volume_type_name: p.volume_type_name, author: p.author, volume_m3: p.volume_m3, area_m2: p.area_m2,
        collision_count: p.collision_count }));
    return { volumes: rows };
  }

  function candidate(ring, extra) {
    const token = register(ring, extra.name, extra.zmin, extra.zmax);
    return { layer: extra.layer, kind: extra.kind, valid: true, token, area_m2: r3(ringArea(ring)),
      n_points: ring.length - 1, zmin: extra.zmin, zmax: extra.zmax, geometry: toWgsPoly([ring]) };
  }

  async function upload(fd) {
    const f = fd.get("file");
    if (!f || !f.name) fail("Vyberte DXF súbor");
    if (!/\.dxf$/i.test(f.name)) fail("Podporovaný je len DXF (DWG/DGN najprv uložte ako DXF)");
    const { polys, warnings } = parseDxf(await f.text());
    const out = polys.map((p) => {
      const zs = p.pts.map((q) => q[2]);
      const extra = { layer: p.layer, kind: p.kind, name: `${f.name} / ${p.layer}`,
        zmin: r3(Math.min(...zs)), zmax: r3(Math.max(...zs)) };
      try {
        return candidate(makeRing(p.pts.map((q) => [q[0], q[1]])), extra);
      } catch (e) {
        if (!(e instanceof DemoError)) throw e;
        return { layer: p.layer, kind: p.kind, valid: false, error: e.message, area_m2: r3(ringArea(p.pts)),
          n_points: p.pts.length, zmin: extra.zmin, zmax: extra.zmax };
      }
    }).sort((a, b) => b.area_m2 - a.area_m2);
    return { file: f.name, saved_as: null, candidates: out, warnings };
  }

  function parsePoints(text) {
    const t = String(text || "").trim();
    if (!t) fail("Pole „súradnice“ je povinné");
    const bad = () => fail("Súradnice sa nedajú prečítať – zadajte dvojice „x y“ oddelené čiarkou, bodkočiarkou alebo novým riadkom (desatinná bodka)");
    let geo = false, pts;
    if (/^(SRID=\d+;)?\s*(MULTI)?POLYGON/i.test(t)) {
      geo = /^SRID=4326;/i.test(t);
      const n = (t.replace(/^SRID=\d+;/i, "").match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) || []).map(Number);
      if (n.length < 6 || n.length % 2) bad();
      pts = [];
      for (let i = 0; i < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    } else {
      pts = t.split(/\s*[,;\r\n]+\s*/).filter(Boolean).map((pair) => {
        const v = pair.trim().split(/\s+/).map(Number);
        if (v.length < 2 || v.length > 3 || v.some((x) => !Number.isFinite(x))) bad();
        return [v[0], v[1]];
      });
    }
    return geo ? pts.map(fwd) : pts;
  }

  function pasted(body) {
    const ring = makeRing(parsePoints(body.coords));
    return { file: null, saved_as: null, warnings: [],
      candidates: [candidate(ring, { layer: "vložené súradnice", kind: "text", name: body.name || "Vložené súradnice", zmin: null, zmax: null })] };
  }

  function overlapsWith(poly, bbox) {
    const out = [];
    for (const v of D.vols) {
      if (!bboxHit(bbox, v.bbox)) continue;
      const mp = intersect(poly, v.sj);
      const a = multiArea(mp);
      if (a > 0.01) out.push({ v, mp, a });
    }
    return out;
  }

  function check(token) {
    const b = boundary(token);
    const area = polyArea(b.poly);
    const rows = overlapsWith(b.poly, b.bbox).sort((p, q) => q.a - p.a).map(({ v, mp, a }) => ({
      type: "Feature", geometry: toWgsMulti(mp), properties: {
        other_id: v.props.id, other_name: v.props.name, other_so: v.props.so, other_km: v.props.km,
        other_type: v.props.volume_type, other_author: v.props.author, other_volume_m3: v.props.volume_m3,
        overlap_m2: r3(a), overlap_pct: r1(100 * a / area),
        same_shape: 100 * a / area >= 95 && a >= 0.95 * v.props.area_m2 } }));
    const hits = rows.map((r) => ({ type: "Feature", geometry: D.byId.get(r.properties.other_id).wgs,
      properties: { other_id: r.properties.other_id, other_type: r.properties.other_type } }));
    return { collisions: FC(rows), hits: FC(hits) };
  }

  function cutWindow(body) {
    if (body.polygon) {
      const ring = makeRing(parsePoints(body.polygon));
      return { poly: [ring], bbox: bboxOf([[ring]]), name: body.name || "Výrez" };
    }
    if (body.token) return boundary(body.token);
    fail("Chýba výrez – nakreslite obdĺžnik alebo vyberte hranicu z DXF");
  }

  function cutPreview(body) {
    const w = cutWindow(body), clip = !!body.clip;
    const items = overlapsWith(w.poly, w.bbox).map(({ v, mp, a }) => {
      const p = v.props;
      return { type: "Feature", geometry: clip ? toWgsMulti(mp) : v.wgs, properties: {
        id: p.id, name: p.name, so: p.so, km: p.km, volume_type: p.volume_type, volume_type_name: p.volume_type_name,
        author: p.author, volume_m3: p.volume_m3, area_m2: p.area_m2, overlap_m2: r3(a),
        overlap_pct: r1(100 * a / p.area_m2), volume_cut_m3: r1(p.volume_m3 * a / p.area_m2) } };
    }).sort((a, b) => (D.typeSort[a.properties.volume_type] - D.typeSort[b.properties.volume_type]) ||
      (a.properties.km ?? 0) - (b.properties.km ?? 0) || a.properties.id - b.properties.id);
    return { name: w.name, clip, area_m2: r1(polyArea(w.poly)), window: toWgsPoly(w.poly), parts: FC(items) };
  }

  function balance(q) {
    const so = q.get("so") || null;
    const section = parseInt(q.get("section") || "500", 10);
    if (!(section >= 50 && section <= 10000)) fail("Dĺžka úseku musí byť 50 – 10 000 m");
    const k = num(q.get("k")) ?? 1;
    if (!(k >= 0.5 && k <= 2)) fail("Koeficient výkopu musí byť 0,5 – 2,0");
    const vols = D.vols.filter((v) => !so || v.props.so === so).map((v) => v.props);
    const types = D.data.meta.types;
    const byType = new Map();
    for (const p of vols) {
      const key = `${p.so}\u0000${p.volume_type}`;
      const t = D.typeOf[p.volume_type];
      const r = byType.get(key) || { so: p.so, code: p.volume_type, name_sk: t.name_sk, balance: t.balance || null, n: 0, m3: 0 };
      r.n += 1; r.m3 += p.volume_m3;
      byType.set(key, r);
    }
    const by_type = [...byType.values()].sort((a, b) => a.so.localeCompare(b.so) || D.typeSort[a.code] - D.typeSort[b.code]);
    const sums = new Map(), noKm = {};
    let lo = Infinity, hi = -Infinity;
    for (const p of vols) {
      const bal = D.typeOf[p.volume_type].balance;
      if (!bal) continue;
      if (p.km === null) { noKm[bal] = (noKm[bal] || 0) + p.volume_m3; continue; }
      const idx = Math.floor(p.km * 1000 / section + 1e-9);
      lo = Math.min(lo, idx); hi = Math.max(hi, idx);
      sums.set(`${idx}${bal}`, (sums.get(`${idx}${bal}`) || 0) + p.volume_m3);
    }
    const sections = [];
    let cum = 0;
    for (let i = lo; i <= hi && Number.isFinite(lo); i++) {
      const cut = sums.get(`${i}vykop`) || 0, fill = sums.get(`${i}nasyp`) || 0, diff = cut * k - fill;
      cum += diff;
      sections.push({ from_km: i * section / 1000, to_km: (i + 1) * section / 1000, vykop: cut, vykop_k: cut * k,
        nasyp: fill, rozdiel: diff, kumulativ: cum });
    }
    const totCut = by_type.filter((r) => r.balance === "vykop").reduce((s, r) => s + r.m3, 0);
    const totFill = by_type.filter((r) => r.balance === "nasyp").reduce((s, r) => s + r.m3, 0);
    return { so, section_m: section, k,
      totals: { vykop: totCut, vykop_k: totCut * k, nasyp: totFill, bilancia: totCut * k - totFill },
      by_type, sections, no_km: noKm,
      balance_types: { vykop: types.filter((t) => t.balance === "vykop").map((t) => t.name_sk),
                       nasyp: types.filter((t) => t.balance === "nasyp").map((t) => t.name_sk) } };
  }

  async function request(url, opts = {}) {
    await ready;
    const u = new URL(url, location.href);
    const p = u.pathname.slice(u.pathname.indexOf("/api/"));
    const body = opts.body instanceof FormData ? opts.body : (opts.body ? JSON.parse(opts.body) : {});
    const q = u.searchParams;
    let m;
    try {
      if (p === "/api/meta") return meta();
      if (p === "/api/volumes") return volumes(q);
      if (p === "/api/collisions") return collisionsFC();
      if ((m = p.match(/^\/api\/volume\/(\d+)\/history$/))) return { history: D.data.history[m[1]] || [] };
      if ((m = p.match(/^\/api\/volume\/(\d+)$/))) return volumeDetail(+m[1]);
      if (p === "/api/at") return at(q);
      if (p === "/api/upload") return await upload(body);
      if (p === "/api/polygon") return pasted(body);
      if ((m = p.match(/^\/api\/check\/(.+)$/))) return check(m[1]);
      if (p === "/api/cut/preview") return cutPreview(body);
      if (p === "/api/balance") return balance(q);
      fail("Táto funkcia je dostupná len v plnej verzii so serverom a databázou.");
    } catch (e) {
      throw e instanceof DemoError ? new Error(e.message) : e;
    }
  }

  // ------------------------------------------------------------------ exporty
  const slug = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^0-9A-Za-z]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "export";
  const stamp = () => {
    const d = new Date(), z = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
  };

  function volRecord(v, clipped) {
    const rec = { ...v.props, sj: clipped ? clipped.mp : [v.sj] };
    if (clipped) {
      rec.area_full_m2 = v.props.area_m2;
      rec.area_m2 = r3(clipped.a);
      rec.volume_cut_m3 = r1(v.props.volume_m3 * clipped.a / v.props.area_m2);
    }
    return rec;
  }

  function pairsBundle(filter, extraIds = []) {
    const pairs = D.pairs.filter((c) => filter(c.props));
    const ids = new Set(extraIds);
    pairs.forEach((c) => { ids.add(c.props.a_id); ids.add(c.props.b_id); });
    return {
      volumes: [...ids].sort((a, b) => a - b).map((id) => volRecord(D.byId.get(id), null)),
      overlaps: pairs.map((c) => ({ label: `${c.props.a_id} x ${c.props.b_id}`, a_id: c.props.a_id, b_id: c.props.b_id,
        a_name: c.props.a_name, b_name: c.props.b_name, overlap_m2: c.props.overlap_m2, sj: c.sj })),
      boundary: null, clipped: false,
    };
  }

  function cutBundle(body) {
    const w = cutWindow(body), clip = !!body.clip, exclude = new Set((body.exclude || []).map(Number));
    const hits = overlapsWith(w.poly, w.bbox).filter(({ v }) => !exclude.has(v.props.id));
    return {
      volumes: hits.map(({ v, mp, a }) => volRecord(v, clip ? { mp, a } : null)),
      overlaps: hits.map(({ v, mp, a }) => ({ label: `HRANICA x ${v.props.id}`, a_id: null, b_id: v.props.id,
        a_name: w.name, b_name: v.props.name, overlap_m2: r3(a), sj: mp })),
      boundary: { name: w.name, sj: [w.poly], area_m2: r3(polyArea(w.poly)) }, clipped: clip,
    };
  }

  const volumeFields = (v) => {
    const f = { ID: v.id, KLUC: v.source_key || "", NAZOV: v.name, SO: v.so, KM: v.km ?? "", TYP: v.volume_type,
      TYP_NAZOV: v.volume_type_name, AUTOR: v.author, OBJEM_M3: v.volume_m3, H_MAX: v.height_max ?? "",
      H_MIN: v.height_min ?? "", PLOCHA_M2: v.area_m2, KOLIZIE: v.collision_count, KOLIDUJE_S: v.collides_with || "",
      ODKAZ: v.file_link || "" };
    if ("area_full_m2" in v) { f.PLOCHA_CELK_M2 = v.area_full_m2; f.OBJEM_VYREZ_M3 = v.volume_cut_m3; }
    return f;
  };

  // bod na popis: ťažisko najväčšieho obrysu, ak leží vnútri; inak priemer vrcholov
  function labelPoint(mp) {
    let best = null, bestA = -1;
    for (const p of mp) { const a = ringArea(p[0]); if (a > bestA) { bestA = a; best = p; } }
    const r = best[0];
    let cx = 0, cy = 0, a2 = 0;
    for (let i = 0; i < r.length - 1; i++) {
      const [x1, y1] = r[i], [x2, y2] = r[i + 1], c = x1 * y2 - x2 * y1;
      a2 += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c;
    }
    if (a2 !== 0) { cx /= 3 * a2; cy /= 3 * a2; if (inPoly(cx, cy, best)) return [cx, cy]; }
    const n = r.length - 1;
    return [r.slice(0, n).reduce((s, q) => s + q[0], 0) / n, r.slice(0, n).reduce((s, q) => s + q[1], 0) / n];
  }

  function writeDxf(b) {
    const out = [];
    const put = (code, value) => { out.push(String(code), String(value)); };
    const str = (s) => String(s ?? "").replace(/[^\x20-\x7e]/g, (ch) => {
      const c = ch.codePointAt(0);
      return c > 0xffff ? "?" : `\\U+${c.toString(16).toUpperCase().padStart(4, "0")}`;
    });
    const f3 = (v) => Number(v).toFixed(3);
    const all = [...b.volumes.flatMap((v) => v.sj), ...(b.boundary ? b.boundary.sj : [])];
    const [x0, y0, x1, y1] = all.length ? bboxOf(all) : [0, 0, 0, 0];
    const layers = new Map([["0", 7], ["POPIS", 7], ["KOLIZIA", 1], ["KOLIZIA_POPIS", 1]]);
    for (const v of b.volumes) layers.set(`OBJ_${v.volume_type}`, D.typeOf[v.volume_type].dxf_color || 7);
    if (b.boundary) { layers.set("HRANICA", 5); layers.set("HRANICA_POPIS", 5); }

    put(0, "SECTION"); put(2, "HEADER");
    put(9, "$ACADVER"); put(1, "AC1009");
    put(9, "$EXTMIN"); put(10, f3(x0)); put(20, f3(y0)); put(30, "0.0");
    put(9, "$EXTMAX"); put(10, f3(x1)); put(20, f3(y1)); put(30, "0.0");
    put(0, "ENDSEC");
    put(0, "SECTION"); put(2, "TABLES");
    put(0, "TABLE"); put(2, "LTYPE"); put(70, 1);
    put(0, "LTYPE"); put(2, "CONTINUOUS"); put(70, 0); put(3, "Solid line"); put(72, 65); put(73, 0); put(40, "0.0");
    put(0, "ENDTAB");
    put(0, "TABLE"); put(2, "LAYER"); put(70, layers.size);
    for (const [name, color] of layers) { put(0, "LAYER"); put(2, name); put(70, 0); put(62, color); put(6, "CONTINUOUS"); }
    put(0, "ENDTAB");
    put(0, "TABLE"); put(2, "STYLE"); put(70, 1);
    put(0, "STYLE"); put(2, "STANDARD"); put(70, 0); put(40, "0.0"); put(41, "1.0"); put(50, "0.0"); put(71, 0); put(42, "1.2"); put(3, "txt"); put(4, "");
    put(0, "ENDTAB");
    put(0, "TABLE"); put(2, "APPID"); put(70, 1);
    put(0, "APPID"); put(2, "VOLUMES_DB"); put(70, 0);
    put(0, "ENDTAB");
    put(0, "ENDSEC");

    put(0, "SECTION"); put(2, "ENTITIES");
    const polyline = (ring, layer, xdata) => {
      put(0, "POLYLINE"); put(8, layer); put(66, 1); put(10, "0.0"); put(20, "0.0"); put(30, "0.0"); put(70, 1);
      if (xdata) {
        put(1001, "VOLUMES_DB");
        for (const [k, v] of Object.entries(xdata)) put(1000, str(`${k}=${v}`).slice(0, 250));
      }
      for (const [x, y] of ring.slice(0, -1)) { put(0, "VERTEX"); put(8, layer); put(10, f3(x)); put(20, f3(y)); put(30, "0.0"); }
      put(0, "SEQEND"); put(8, layer);
    };
    const text = (x, y, h, s, layer) => { put(0, "TEXT"); put(8, layer); put(10, f3(x)); put(20, f3(y)); put(30, "0.0"); put(40, h); put(1, str(s)); };
    const fmt = (v, d) => Number(v).toFixed(d);

    for (const v of b.volumes) {
      const layer = `OBJ_${v.volume_type}`, fields = volumeFields(v);
      v.sj.forEach((p, pi) => p.forEach((ring, ri) => polyline(ring, layer, pi === 0 && ri === 0 ? fields : null)));
      const [lx, ly] = labelPoint(v.sj);
      text(lx, ly, 1.2, `#${v.id}  ${v.so}  km ${v.km === null ? "-" : fmt(v.km, 3)}`, "POPIS");
      text(lx, ly - 1.8, 1.2, `${v.volume_type_name}  ${fmt(v.volume_m3, 1)} m3`, "POPIS");
    }
    for (const o of b.overlaps) {
      o.sj.forEach((p, pi) => p.forEach((ring, ri) => polyline(ring, "KOLIZIA", pi === 0 && ri === 0
        ? { KOLIZIA: o.label, A_ID: o.a_id ?? "", B_ID: o.b_id, A_NAZOV: o.a_name, B_NAZOV: o.b_name, PREKRYV_M2: o.overlap_m2 } : null)));
      const [lx, ly] = labelPoint(o.sj);
      text(lx, ly, 1.2, `KOLIZIA ${o.label}`, "KOLIZIA_POPIS");
      text(lx, ly - 1.8, 1.2, `${fmt(o.overlap_m2, 1)} m2`, "KOLIZIA_POPIS");
    }
    if (b.boundary) {
      b.boundary.sj.forEach((p) => p.forEach((ring, ri) => polyline(ring, "HRANICA", ri === 0
        ? { NAZOV: b.boundary.name, PLOCHA_M2: b.boundary.area_m2, REZIM: b.clipped ? "orezane hranicou" : "cele objemy" } : null)));
      const [fx, fy] = b.boundary.sj[0][0][0];
      text(fx, fy + 2, 1.8, `HRANICA: ${b.boundary.name}  ${fmt(b.boundary.area_m2, 1)} m2`, "HRANICA_POPIS");
    }
    put(0, "ENDSEC"); put(0, "EOF");
    return { content: out.join("\r\n") + "\r\n", mime: "application/dxf", ext: "dxf" };
  }

  function writeGeojson(b) {
    const geom = (mp) => ({ type: "MultiPolygon", coordinates: mp.map((p) => p.map((r) => r.map(([x, y]) => [r3(x), r3(y)]))) });
    const feats = b.volumes.map((v) => {
      const f = volumeFields(v);
      return { type: "Feature", geometry: geom(v.sj), properties: { vrstva: "objemy", id: f.ID, kluc: f.KLUC, nazov: f.NAZOV,
        so: f.SO, km: v.km, typ: f.TYP, typ_nazov: f.TYP_NAZOV, autor: f.AUTOR, objem_m3: v.volume_m3,
        h_max: v.height_max, h_min: v.height_min, plocha_m2: v.area_m2, kolizie: v.collision_count,
        kol_s: v.collides_with, odkaz: v.file_link,
        ...("area_full_m2" in v ? { plocha_cel: v.area_full_m2, objem_vyr: v.volume_cut_m3 } : {}) } };
    }).concat(b.overlaps.map((o) => ({ type: "Feature", geometry: geom(o.sj), properties: { vrstva: "kolizie",
      kolizia: o.label, a_id: o.a_id, b_id: o.b_id, a_nazov: o.a_name, b_nazov: o.b_name, prekryv_m2: o.overlap_m2 } })));
    if (b.boundary) feats.push({ type: "Feature", geometry: geom(b.boundary.sj),
      properties: { vrstva: "hranica", nazov: b.boundary.name, plocha_m2: b.boundary.area_m2 } });
    const fc = { type: "FeatureCollection", name: "objemy", crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::5514" } }, features: feats };
    return { content: JSON.stringify(fc), mime: "application/geo+json", ext: "geojson" };
  }

  function writeCsv(b) {
    const cell = (v) => {
      if (v === null || v === undefined) return "";
      if (typeof v === "number") return String(v).replace(".", ",");
      const s = String(v);
      return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const rows = [["Id", "Kľúč", "Názov", "SO", "KM", "Typ", "Autor", "Objem m3", "Max. výška", "Min. výška", "Plocha m2",
      ...(b.clipped ? ["Plocha celková m2", "Objem vo výreze m3"] : []), "Kolízie", "Koliduje s", "Odkaz"]];
    for (const v of b.volumes) rows.push([v.id, v.source_key, v.name, v.so, v.km, v.volume_type_name, v.author, v.volume_m3,
      v.height_max, v.height_min, v.area_m2, ...(b.clipped ? [v.area_full_m2, v.volume_cut_m3] : []),
      v.collision_count, v.collides_with, v.file_link]);
    rows.push([], ["Kolízia", "Objem A", "Objem B", "Prekrytie m2"]);
    for (const o of b.overlaps) rows.push([o.label, o.a_name, o.b_name, o.overlap_m2]);
    return { content: "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n", mime: "text/csv", ext: "csv" };
  }
  const WRITERS = { dxf: writeDxf, geojson: writeGeojson, csv: writeCsv };

  async function exportFile(url, body = {}) {
    await ready;
    const u = new URL(url, location.href);
    const fmt = body.fmt || u.searchParams.get("fmt") || "dxf";
    if (!WRITERS[fmt]) throw new Error(`Formát ${fmt.toUpperCase()} je len v plnej verzii so serverom`);
    const path = u.pathname;
    let m, bundle, stem;
    try {
      if ((m = path.match(/\/export\/volume\/(\d+)$/))) {
        const id = +m[1];
        D.byId.get(id) || fail(`Objem #${id} neexistuje`);
        bundle = pairsBundle((c) => c.a_id === id || c.b_id === id, [id]);
        stem = `kolizie_objem_${id}`;
      } else if (path.endsWith("/export/so")) {
        const so = u.searchParams.get("so");
        bundle = pairsBundle((c) => c.a_so === so || c.b_so === so);
        stem = `kolizie_${slug(so)}`;
      } else if (path.endsWith("/export/all")) {
        bundle = pairsBundle(() => true);
        stem = "kolizie_vsetky";
      } else if (path.endsWith("/export/cut")) {
        bundle = cutBundle(body);
        stem = `vyrez_${slug(bundle.boundary.name.split(" / ")[0].replace(/\.dxf$/i, ""))}_${body.clip ? "orezane" : "cele"}`;
      } else {
        fail("Tento export je len v plnej verzii so serverom");
      }
    } catch (e) {
      throw e instanceof DemoError ? new Error(e.message) : e;
    }
    const w = WRITERS[fmt](bundle);
    return { name: `${stem}_${stamp()}.${w.ext}`, content: w.content, mime: w.mime };
  }

  // ZIP bez kompresie (STORE) – na claude.ai sa dá stiahnuť .zip, ale nie .dxf / .geojson
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zipStore(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = enc.encode(f.content), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, dosTime, 2], [12, dosDate, 2], [14, crc, 4],
       [18, data.length, 4], [22, data.length, 4], [26, name.length, 2], [28, 0, 2]]
        .forEach(([o, v, n]) => (n === 4 ? h.setUint32(o, v, true) : h.setUint16(o, v, true)));
      const c = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, dosTime, 2], [14, dosDate, 2],
       [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2],
       [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, offset, 4]]
        .forEach(([o, v, n]) => (n === 4 ? c.setUint32(o, v, true) : c.setUint16(o, v, true)));
      parts.push(new Uint8Array(h.buffer), name, data);
      central.push(new Uint8Array(c.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((s, p) => s + p.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, files.length, 2], [10, files.length, 2], [12, size, 4], [16, offset, 4], [20, 0, 2]]
      .forEach(([o, v, n]) => (n === 4 ? e.setUint32(o, v, true) : e.setUint16(o, v, true)));
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: "application/zip" });
  }

  // Stiahnutie: na GitHub Pages / lokálne priamo; na claude.ai cez schopnosť „downloads“ (viewer potvrdí),
  // a ak nie je dostupná, ponúkne sa obsah na skopírovanie.
  async function deliver(f) {
    let framed = true;
    try { framed = window.self !== window.top; } catch (e) { framed = true; }
    if (!framed) {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([f.content], { type: f.mime }));
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return { downloaded: true, name: f.name };
    }
    const dl = window.claude && typeof window.claude.use === "function" ? await window.claude.use("downloads") : null;
    if (dl) {
      const direct = /\.csv$/i.test(f.name);
      const name = direct ? f.name : f.name.replace(/\.[a-z0-9]+$/i, "") + ".zip";
      try {
        await dl.save({ filename: name, data: direct ? f.content : zipStore([{ name: f.name, content: f.content }]) });
        return { downloaded: true, name };
      } catch (err) {
        if (err && err.code === "declined") return { downloaded: false, declined: true };
        if (err && err.code === "rate_limited") throw new Error("Okno na uloženie je už otvorené – dokončite ho a skúste znova");
        // iné chyby: ponúknuť obsah na skopírovanie
      }
    }
    const wrap = document.createElement("div");
    wrap.className = "demo-modal";
    wrap.innerHTML = `<div class="box" role="dialog" aria-modal="true" aria-label="Export">
      <b>${f.name}</b>
      <div class="small muted">V tomto náhľade sa súbory nedajú stiahnuť. Skopírujte obsah a uložte ho ako
        <code>${f.name}</code> (napr. Poznámkový blok → Uložiť ako, kódovanie UTF-8). Na GitHub Pages sa súbor stiahne priamo.</div>
      <textarea readonly spellcheck="false"></textarea>
      <div class="row"><span class="small muted copy-state"></span>
        <button type="button" class="primary" data-act="copy">Kopírovať do schránky</button>
        <button type="button" data-act="close">Zavrieť</button></div></div>`;
    const ta = wrap.querySelector("textarea");
    ta.value = f.content;
    wrap.addEventListener("click", async (e) => {
      const act = e.target.dataset.act;
      if (act === "close" || e.target === wrap) wrap.remove();
      if (act === "copy") {
        try {
          await navigator.clipboard.writeText(f.content);
          wrap.querySelector(".copy-state").textContent = "Skopírované.";
        } catch (err) {
          ta.focus();
          ta.select();
          wrap.querySelector(".copy-state").textContent = "Text je označený – stlačte Ctrl+C.";
        }
      }
    });
    document.body.appendChild(wrap);
    return { downloaded: false };
  }

  const ready = (async () => {
    const r = await fetch("data.json");
    if (!r.ok) throw new Error("Chýba súbor data.json s dátami ukážky");
    D.data = await r.json();
    proj4.defs(SJ, D.data.proj.def);
    AFF = fitAffine(D.data.proj.control);
    for (const t of D.data.meta.types) { D.typeSort[t.code] = t.sort; D.typeOf[t.code] = t; }
    for (const v of D.data.volumes) { v.bbox = bboxOf([v.sj]); D.byId.set(v.props.id, v); }
    D.vols = D.data.volumes;
    D.pairs = D.data.collisions;
    // kontrola prepočtu S-JTSK (proj4) voči bodom prepočítaným v PostGIS
    D.projError = Math.max(...D.data.proj.control.map(([lng, lat, x, y]) => {
      const [px, py] = fwd([lng, lat]);
      return Math.hypot(px - x, py - y);
    }));
    if (D.projError > 0.05) console.warn(`Prepočet S-JTSK sa líši od PostGIS o ${D.projError.toFixed(3)} m`);
    const badge = document.getElementById("demo-badge");
    if (badge) badge.textContent = `statická ukážka · dáta z ${new Date(D.data.snapshot).toLocaleDateString("sk-SK")}`;
  })();

  window.DemoApi = { ready, request, exportFile, deliver, zip: zipStore, formats: FORMATS, state: D };
})();
