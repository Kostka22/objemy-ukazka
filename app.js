/* Objemy – webová aplikácia: mapa, nahratie DXF, kolízie, výrez, uloženie, hľadanie, export. */
"use strict";

// Statická ukážka (bez servera) dodá window.DemoApi – rovnaké odpovede z kópie dát v prehliadači.
const DEMO = window.DemoApi || null;
const FORMATS = DEMO ? DEMO.formats : [
  ["dxf", "DXF"], ["dxf3d", "DXF 3D"], ["shp", "SHP (zip)"], ["gpkg", "GPKG"], ["xlsx", "XLSX"],
];
const state = {
  meta: null, typeColor: {}, typeName: {}, allVolumes: new Map(),
  candidates: [], selected: null, upload: null,
  cutPreview: null, lastDragEnd: 0,
};
const hidden = new Set();   // id objemov vypnutých používateľom (nezobrazujú sa a nie sú v exporte výrezu)

// ------------------------------------------------------------------ pomocné funkcie
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const nf = (v, d = 0) => (v === null || v === undefined || v === "") ? "–"
  : Number(v).toLocaleString("sk-SK", { minimumFractionDigits: d, maximumFractionDigits: d });
const km = (v) => (v === null || v === undefined) ? "–" : Number(v).toFixed(3);
// slovenské množné číslo: 1 / 2–4 / 0 a 5+
const plural = (n, one, few, many) => `${n} ${n === 1 ? one : (n >= 2 && n <= 4 ? few : many)}`;
const FIT = { maxZoom: 19, animate: false };  // ortofoto WMS nemá snímky nad ~z19; animované priblíženie sa môže stratiť
const num = (s) => parseFloat(String(s).replace(/\s/g, "").replace(",", "."));

async function api(url, opts) {
  if (DEMO) return DEMO.request(url, opts);
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}
const postJSON = (url, body) => api(url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

function toast(text, kind = "info", ms = 5000) {
  const box = document.createElement("div");
  box.className = `msg ${kind}`;
  box.textContent = text;
  $("#toast").appendChild(box);
  setTimeout(() => box.remove(), ms);
}

function msg(el, text, kind) {
  el.innerHTML = text ? `<div class="msg ${kind}">${text}</div>` : "";
}

function remember(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* súkromný režim */ } }
function recall(key) { try { return localStorage.getItem(key) || ""; } catch (_) { return ""; } }

// stiahnutie súboru (GET, alebo POST s JSON telom)
async function download(url, btn, body) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "…";
  if (DEMO) {
    try {
      const f = await DEMO.exportFile(url, body);
      const r = await DEMO.deliver(f);
      if (r.downloaded) toast(`Stiahnuté: ${r.name}`, "ok");
    } catch (e) {
      toast(`Export zlyhal: ${e.message}`, "err", 8000);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
    return;
  }
  try {
    const r = await fetch(url, body === undefined ? undefined : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || r.statusText);
    }
    const blob = await r.blob();
    const cd = r.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename\*=UTF-8''([^;]+)/) || cd.match(/filename="?([^";]+)"?/);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = m ? decodeURIComponent(m[1]) : "export";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast(`Stiahnuté: ${a.download}`, "ok");
  } catch (e) {
    toast(`Export zlyhal: ${e.message}`, "err", 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function formatButtons(container, urlFor, bodyFor) {
  container.innerHTML = "";
  for (const [fmt, label] of FORMATS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => download(urlFor(fmt), b, bodyFor ? bodyFor(fmt) : undefined));
    container.appendChild(b);
  }
}

// ------------------------------------------------------------------ mapa
const map = L.map("map", { zoomControl: true });
const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 21, maxNativeZoom: 19, attribution: "© OpenStreetMap",
});
const ortho = L.tileLayer.wms("https://zbgisws.skgeodesy.sk/zbgis_ortofoto_wms/service.svc/get", {
  layers: "1", format: "image/jpeg", maxZoom: 21, attribution: "Ortofoto © GKÚ Bratislava, NLC",
});
const cadastre = L.tileLayer.wms("https://kataster.skgeodesy.sk/eskn/services/NR/kn_wms_norm/MapServer/WmsServer", {
  layers: "5,2,10,13", format: "image/png", transparent: true, maxZoom: 21, attribution: "Kataster © ÚGKK SR",
});
ortho.addTo(map);

// Ak sa mapový podklad nedá načítať (bez internetu, alebo v náhľade na claude.ai, ktorý cudzie obrázky blokuje),
// zobrazí sa malé upozornenie – objemy a všetky funkcie fungujú aj bez neho.
(() => {
  let ok = 0, bad = 0, shown = false;
  const note = L.control({ position: "topright" });
  note.onAdd = () => {
    const d = L.DomUtil.create("div", "leaflet-control basemap-note");
    d.textContent = "Mapový podklad sa tu nedá načítať – objemy a všetky funkcie fungujú aj bez neho.";
    return d;
  };
  const check = () => { if (!shown && bad >= 6 && ok === 0) { shown = true; note.addTo(map); } };
  for (const layer of [ortho, osm]) {
    layer.on("tileload", () => { ok++; });
    layer.on("tileerror", () => { bad++; check(); });
  }
})();

const cutOn = () => cut.on;
function volStyle(f) {
  const p = f.properties;
  const c = state.typeColor[p.volume_type] || "#999";
  if (hidden.has(p.id)) return { opacity: 0, fillOpacity: 0 };
  if (cutOn()) return { color: c, weight: 1, opacity: 0.35, fillColor: c, fillOpacity: 0.12 };
  return { color: c, weight: 1.2, opacity: 1, fillColor: c, fillOpacity: 0.45 };
}
function colStyle(f) {
  const p = f.properties;
  if (hidden.has(p.a_id) || hidden.has(p.b_id)) return { opacity: 0, fillOpacity: 0 };
  if (cutOn()) return { color: "#e31a1c", weight: 1, opacity: 0.25, fillColor: "#e31a1c", fillOpacity: 0.12 };
  return { color: "#e31a1c", weight: 1.5, opacity: 1, fillColor: "#e31a1c", fillOpacity: 0.5 };
}

const volLayer = L.geoJSON(null, {
  style: volStyle,
  onEachFeature: (f, layer) => {
    const p = f.properties;
    layer.bindTooltip(() => hidden.has(p.id) ? "" :
      `<b>#${p.id} ${esc(p.name)}</b><br>${esc(p.so)} · km ${km(p.km)}<br>` +
      `${esc(p.volume_type_name)} · ${nf(p.volume_m3)} m³` +
      (p.collision_count ? `<br><span style="color:#d92d20">${plural(p.collision_count, "kolízia", "kolízie", "kolízií")}</span>` : "") +
      `<br><span class="muted">kliknutím zobrazíte všetky objemy v mieste</span>`,
      { sticky: true, className: "vol-tip" });
  },
}).addTo(map);
const colLayer = L.geoJSON(null, {
  style: colStyle,
  onEachFeature: (f, layer) => layer.bindTooltip(
    `Kolízia #${f.properties.a_id} × #${f.properties.b_id}<br>${nf(f.properties.overlap_m2, 1)} m²`, { sticky: true }),
}).addTo(map);
const hitLayer = L.geoJSON(null, { style: { color: "#ff7f00", weight: 3, fill: false }, interactive: false }).addTo(map);
const ovlLayer = L.geoJSON(null, {
  style: { color: "#b10026", weight: 2, fillColor: "#e31a1c", fillOpacity: 0.7 },
  onEachFeature: (f, layer) => layer.bindTooltip(
    `Prekrytie s #${f.properties.other_id}: ${nf(f.properties.overlap_m2, 1)} m² (${nf(f.properties.overlap_pct, 1)} %)`,
    { sticky: true }),
}).addTo(map);
const candLayer = L.geoJSON(null, {
  bubblingMouseEvents: false,
  style: { color: "#1f78b4", weight: 2, dashArray: "6 4", fillOpacity: 0.05 },
  onEachFeature: (f, layer) => layer.on("click", () => selectCandidate(f.properties.idx)),
}).addTo(map);
const selLayer = L.geoJSON(null, {
  style: { color: "#1f78b4", weight: 4, dashArray: "8 5", fillColor: "#1f78b4", fillOpacity: 0.12 },
  interactive: false,
}).addTo(map);
const prevLayer = L.geoJSON(null, {   // náhľad exportu výrezu
  style: (f) => {
    const c = state.typeColor[f.properties.volume_type] || "#999";
    return { color: c, weight: 2, opacity: 1, fillColor: c, fillOpacity: 0.65 };
  },
  onEachFeature: (f, layer) => {
    const p = f.properties;
    layer.bindTooltip(`<b>#${p.id} ${esc(p.name)}</b><br>vo výreze ${nf(p.overlap_m2, 1)} m² (${nf(p.overlap_pct, 1)} % objemu)`,
      { sticky: true, className: "vol-tip" });
  },
}).addTo(map);
const cutGroup = L.layerGroup().addTo(map);

L.control.layers(
  { "ZBGIS ortofoto": ortho, "OpenStreetMap": osm },
  { "Kataster (ESKN)": cadastre, "Objemy": volLayer, "Kolízie v databáze": colLayer },
  { collapsed: true },
).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

function clearHighlights() {
  hitLayer.clearLayers();
  ovlLayer.clearLayers();
}

// ------------------------------------------------------------------ zapínanie / vypínanie objemov
function setHidden(ids, off) {
  for (const id of ids) { if (off) hidden.add(id); else hidden.delete(id); }
  refreshVisibility();
}

function refreshVisibility() {
  volLayer.setStyle(volStyle);
  colLayer.setStyle(colStyle);
  if (cut.on && state.cutPreview) renderPreview();
  updateLegendChecks();
  document.querySelectorAll("input[data-vis]").forEach((cb) => { cb.checked = !hidden.has(Number(cb.dataset.vis)); });
}

function addLegend() {
  const legend = L.control({ position: "bottomleft" });
  legend.onAdd = () => {
    const d = L.DomUtil.create("details", "leaflet-control legend");
    d.open = window.innerHeight > 800 && window.innerWidth > 1000;
    d.innerHTML = "<summary>Legenda a zapínanie</summary>" + state.meta.types.map((t) =>
      `<label class="row"><input type="checkbox" data-type="${esc(t.code)}" checked>
        <span class="swatch" style="background:${t.color}"></span>${esc(t.name_sk)}</label>`).join("") +
      `<div class="row"><span class="swatch" style="background:#e31a1c"></span>kolízia (prekrytie)</div>` +
      `<div class="row"><span class="swatch" style="background:#fff;border:2px dashed #1f78b4"></span>hranica / výrez</div>` +
      `<div class="row"><span class="swatch" style="background:#fff;border:2px solid #ff7f00"></span>kolidujúci objem</div>` +
      `<div id="hidden-info" class="small"></div>`;
    d.querySelectorAll("input[data-type]").forEach((cb) => cb.addEventListener("change", () => {
      const ids = [...state.allVolumes.values()].filter((p) => p.volume_type === cb.dataset.type).map((p) => p.id);
      setHidden(ids, !cb.checked);
    }));
    L.DomEvent.disableClickPropagation(d);
    L.DomEvent.disableScrollPropagation(d);
    return d;
  };
  legend.addTo(map);
  updateLegendChecks();
}

function updateLegendChecks() {
  document.querySelectorAll(".legend input[data-type]").forEach((cb) => {
    const ofType = [...state.allVolumes.values()].filter((p) => p.volume_type === cb.dataset.type);
    const off = ofType.filter((p) => hidden.has(p.id)).length;
    cb.checked = off < ofType.length || ofType.length === 0;
    cb.indeterminate = off > 0 && off < ofType.length;
  });
  const info = $("#hidden-info");
  if (!info) return;
  info.innerHTML = hidden.size
    ? `Vypnuté: <b>${plural(hidden.size, "objem", "objemy", "objemov")}</b> <button type="button" id="show-all">zapnúť všetky</button>`
    : "";
  const btn = $("#show-all");
  if (btn) btn.addEventListener("click", () => setHidden([...hidden], false));
}

// ------------------------------------------------------------------ klik do mapy: objemy v mieste
const mPerPx = () => 40075016.686 / (256 * Math.pow(2, map.getZoom()));   // Mercator m na pixel

map.on("click", async (e) => {
  if (Date.now() - state.lastDragEnd < 400) return;   // koniec ťahania výrezu nie je klik
  const tol = Math.max(0.2, mPerPx() * 4 * Math.cos(e.latlng.lat * Math.PI / 180));
  let res;
  try {
    res = await api(`/api/at?lat=${e.latlng.lat}&lng=${e.latlng.lng}&tol=${tol.toFixed(2)}`);
  } catch (err) {
    toast(err.message, "err");
    return;
  }
  const div = document.createElement("div");
  div.className = "at-popup";
  if (!res.volumes.length) {
    div.innerHTML = "<b>Žiadny objem</b><div class='small muted'>V tomto mieste nie je žiadny objem.</div>";
  } else {
    div.innerHTML = `<b>Objemy v tomto mieste (${res.volumes.length})</b>
      <div class="small muted">Zaškrtnuté = zapnuté (zobrazené na mape a v exporte výrezu)</div>
      <div class="at-list">${res.volumes.map((v) => `
        <div class="at-row">
          <input type="checkbox" data-vis="${v.id}" ${hidden.has(v.id) ? "" : "checked"} title="zapnúť / vypnúť">
          <span class="swatch" style="background:${state.typeColor[v.volume_type] || "#999"}"></span>
          <span class="at-main"><b>#${v.id}</b> ${esc(v.name)}
            <span class="small muted">${esc(v.so)} · km ${km(v.km)} · ${esc(v.volume_type_name)} · ${nf(v.volume_m3)} m³` +
            `${v.collision_count ? ` · <span style="color:#d92d20">${plural(v.collision_count, "kolízia", "kolízie", "kolízií")}</span>` : ""}</span></span>
          <button type="button" class="link" data-detail="${v.id}">detail</button>
        </div>`).join("")}</div>
      <div class="btnrow tight"><button type="button" data-all="1">zapnúť všetky</button><button type="button" data-all="0">vypnúť všetky</button></div>`;
    div.querySelectorAll("input[data-vis]").forEach((cb) =>
      cb.addEventListener("change", () => setHidden([Number(cb.dataset.vis)], !cb.checked)));
    div.querySelectorAll("button[data-detail]").forEach((b) =>
      b.addEventListener("click", () => { map.closePopup(); showVolume(Number(b.dataset.detail), true); }));
    div.querySelectorAll("button[data-all]").forEach((b) =>
      b.addEventListener("click", () => setHidden(res.volumes.map((v) => v.id), b.dataset.all === "0")));
  }
  L.popup({ maxWidth: 380, minWidth: 260, className: "at-pop" }).setLatLng(e.latlng).setContent(div).openOn(map);
});

// ------------------------------------------------------------------ načítanie dát
async function loadMeta() {
  state.meta = await api("/api/meta");
  for (const t of state.meta.types) {
    state.typeColor[t.code] = t.color;
    state.typeName[t.code] = t.name_sk;
  }
  const fill = (sel, html) => { const keep = sel.value; sel.innerHTML = html; sel.value = keep; };
  const typeOpts = state.meta.types.map((t) => `<option value="${esc(t.code)}">${esc(t.name_sk)}</option>`).join("");
  fill($("#type-select"), `<option value="">– vyberte –</option>` + typeOpts);
  fill($("#type-filter"), `<option value="">všetky</option>` + typeOpts);
  const soOpts = state.meta.so_list.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  fill($("#so-select"), `<option value="">všetky</option>` + soOpts);
  fill($("#bal-so"), `<option value="">všetky</option>` + soOpts);
  fill($("#export-so"), soOpts);
  if (!$("#export-so").value && state.meta.so_list.length) $("#export-so").value = state.meta.so_list[0];
  $("#so-list").innerHTML = state.meta.so_list.map((s) => `<option value="${esc(s)}">`).join("");
  $("#author-list").innerHTML = state.meta.authors.map((s) => `<option value="${esc(s)}">`).join("");
  $("#stats").textContent = `${plural(state.meta.stats.volumes, "objem", "objemy", "objemov")} · ` +
    `${plural(state.meta.stats.collisions, "kolízia", "kolízie", "kolízií")}`;
}

async function loadVolumes(params = "") {
  const fc = await api(`/api/volumes${params ? "?" + params : ""}`);
  volLayer.clearLayers().addData(fc);
  if (!params) state.allVolumes = new Map(fc.features.map((f) => [f.properties.id, f.properties]));
  return fc;
}

async function loadCollisions() {
  colLayer.clearLayers().addData(await api("/api/collisions"));
}

async function refreshAll() {
  await Promise.all([loadMeta(), loadVolumes(), loadCollisions()]);
  updateLegendChecks();
}

// ------------------------------------------------------------------ karty
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => openTab(t.dataset.tab)));
function openTab(id) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === id));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === id));
  // import a bilancia potrebujú širší panel (tabuľky, grafy)
  const wide = id === "tab-import" || id === "tab-balance";
  if (document.body.classList.contains("wide") !== wide) {
    document.body.classList.toggle("wide", wide);
    setTimeout(() => map.invalidateSize(), 60);
  }
  if (id === "tab-balance") loadBalance();
  if (id === "tab-import" && !DEMO) loadBatches();
  if (id === "tab-export" && !DEMO) loadBackupStatus();
}

// ------------------------------------------------------------------ 1. nahratie DXF / vloženie súradníc
const fileInput = $("#file");
const drop = $("#drop");
fileInput.addEventListener("change", () => fileInput.files[0] && uploadFile(fileInput.files[0]));
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && uploadFile(e.dataTransfer.files[0]));

async function uploadFile(file) {
  resetBoundary();
  msg($("#upload-msg"), `Načítavam <b>${esc(file.name)}</b>…`, "info");
  const fd = new FormData();
  fd.append("file", file);
  try {
    showCandidates(await api("/api/upload", { method: "POST", body: fd }));
  } catch (e) {
    msg($("#upload-msg"), esc(e.message), "err");
  } finally {
    fileInput.value = "";
  }
}

$("#btn-coords").addEventListener("click", async () => {
  resetBoundary();
  try {
    showCandidates(await postJSON("/api/polygon", { coords: $("#coords").value }));
  } catch (e) {
    msg($("#upload-msg"), esc(e.message), "err");
  }
});

function resetBoundary() {
  state.candidates = [];
  state.selected = null;
  state.upload = null;
  candLayer.clearLayers();
  selLayer.clearLayers();
  clearHighlights();
  $("#candidates").innerHTML = "";
  $("#save-result").innerHTML = "";
  $("#boundary-box").hidden = true;
  $("#boundary-steps").hidden = false;
  $("#cut-from-dxf").disabled = true;
  // polia konkrétneho objemu vymazať; SO, KM, typ a autor ostávajú pre ďalší objem
  const f = $("#save-form");
  for (const n of ["name", "volume_m3", "height_max", "height_min", "file_link"]) f[n].value = "";
  delete f.file_link.dataset.touched;
}

function showCandidates(res) {
  state.upload = res;
  state.candidates = res.candidates;
  const valid = res.candidates.filter((c) => c.valid);
  let head = res.file ? `<b>${esc(res.file)}</b>: ` : "";
  head += plural(valid.length, "použiteľná hranica", "použiteľné hranice", "použiteľných hraníc") +
    (res.candidates.length > valid.length
      ? ", " + plural(res.candidates.length - valid.length, "neplatná", "neplatné", "neplatných") : "");
  msg($("#upload-msg"), head + res.warnings.map((w) => `<br><span class="small">⚠ ${esc(w)}</span>`).join(""),
    valid.length ? "info" : "warn");

  const list = document.createElement("div");
  list.className = "list";
  res.candidates.forEach((c, idx) => {
    const row = document.createElement("div");
    row.className = "item" + (c.valid ? "" : " invalid");
    row.dataset.idx = idx;
    const z = (c.zmin !== null && (c.zmin !== 0 || c.zmax !== 0)) ? ` · z ${nf(c.zmin, 2)}–${nf(c.zmax, 2)}` : "";
    row.innerHTML = `<span class="swatch" style="background:${c.valid ? "#1f78b4" : "#ccc"}"></span>
      <div class="main"><div class="title">${esc(c.layer)}</div>
      <div class="small muted">${esc(c.kind)} · ${nf(c.area_m2, 1)} m² · ${plural(c.n_points, "bod", "body", "bodov")}${z}</div>
      ${c.valid ? "" : `<div class="small" style="color:#d92d20">${esc(c.error)}</div>`}</div>`;
    if (c.valid) row.addEventListener("click", () => selectCandidate(idx));
    list.appendChild(row);
    if (c.valid) candLayer.addData({ type: "Feature", geometry: c.geometry, properties: { idx } });
  });
  $("#candidates").replaceChildren(list);
  if (candLayer.getLayers().length) map.fitBounds(candLayer.getBounds().pad(0.6), FIT);
  if (valid.length === 1) selectCandidate(res.candidates.indexOf(valid[0]));
}

// ------------------------------------------------------------------ 2. kolízie vybranej hranice
async function selectCandidate(idx) {
  const c = state.candidates[idx];
  if (!c || !c.valid) return;
  state.selected = c;
  document.querySelectorAll("#candidates .item").forEach((r) => r.classList.toggle("selected", Number(r.dataset.idx) === idx));
  selLayer.clearLayers().addData(c.geometry);
  clearHighlights();
  $("#boundary-box").hidden = false;
  $("#boundary-steps").hidden = false;
  $("#save-result").innerHTML = "";
  $("#cut-from-dxf").disabled = false;
  map.fitBounds(selLayer.getBounds().pad(1.2), FIT);
  prefillForm(c);

  msg($("#check-summary"), "Kontrolujem kolízie…", "info");
  $("#check-table").innerHTML = "";
  try {
    const res = await api(`/api/check/${c.token}`);
    if (state.selected !== c) return;  // medzitým bola vybraná iná hranica
    const rows = res.collisions.features.map((f) => f.properties);
    hitLayer.addData(res.hits);
    ovlLayer.addData(res.collisions);
    msg($("#check-summary"), rows.length
      ? `Hranica (${nf(c.area_m2, 1)} m²) koliduje s <b>${plural(rows.length, "objemom", "objemami", "objemami")}</b>.`
      : `Hranica (${nf(c.area_m2, 1)} m²) <b>nekoliduje</b> so žiadnym objemom.`, rows.length ? "warn" : "ok");
    $("#check-table").innerHTML = collisionTable(rows);
    bindCollisionRows($("#check-table"));
  } catch (e) {
    msg($("#check-summary"), esc(e.message), "err");
  }
}

function collisionTable(rows) {
  if (!rows.length) return "";
  return `<table><thead><tr><th>#</th><th>Objem</th><th>Typ</th><th class="num">Prekrytie m²</th><th class="num">%</th></tr></thead><tbody>` +
    rows.map((r) => `<tr class="clickable" data-id="${r.other_id}"><td>${r.other_id}</td>
      <td>${esc(r.other_name)}${r.same_shape ? ' <span class="pill amber" title="takmer rovnaký pôdorys – možné dvojité započítanie">duplicita?</span>' : ""}
        <div class="small muted">${esc(r.other_so)} · km ${km(r.other_km)} · ${esc(r.other_author)}</div></td>
      <td>${esc(state.typeName[r.other_type] || r.other_type)}</td>
      <td class="num">${nf(r.overlap_m2, 1)}</td><td class="num">${nf(r.overlap_pct, 1)}</td></tr>`).join("") +
    `</tbody></table>`;
}

function zoomToVolume(id) {
  volLayer.eachLayer((l) => { if (l.feature.properties.id === id) map.fitBounds(l.getBounds().pad(0.5), FIT); });
}

function bindCollisionRows(root) {
  root.querySelectorAll("tr[data-id]").forEach((tr) => tr.addEventListener("click", () => zoomToVolume(Number(tr.dataset.id))));
}

$("#to-cut").addEventListener("click", () => {
  if (!state.selected) return;
  startCutFromCandidate(state.selected);
  openTab("tab-cut");
});

// ------------------------------------------------------------------ 3b. uloženie nového objemu
function prefillForm(c) {
  const f = $("#save-form");
  if (!f.author.value) f.author.value = recall("volumes.author");
  if (c.zmin !== null && c.zmax > c.zmin) {
    f.height_max.value = c.zmax.toFixed(2);
    f.height_min.value = c.zmin.toFixed(2);
  }
  if (state.upload && state.upload.saved_as && !f.file_link.dataset.touched) f.file_link.value = state.upload.saved_as;
  if (!f.name.value && state.upload && state.upload.file) f.name.value = state.upload.file.replace(/\.dxf$/i, "").replace(/_/g, " ");
  updateHint();
}

function updateHint() {
  const f = $("#save-form");
  const c = state.selected;
  const h = num(f.height_max.value) - num(f.height_min.value);
  if (!c || !(h > 0)) { $("#volume-hint").textContent = c ? `Plocha hranice ${nf(c.area_m2, 1)} m².` : ""; return; }
  const est = c.area_m2 * h;
  const vol = num(f.volume_m3.value);
  // kontrola zmysluplnosti: objem nemôže byť väčší ako hranol plocha × výška
  const tooBig = vol > est * 1.01 + 0.1;
  $("#volume-hint").innerHTML = `Plocha ${nf(c.area_m2, 1)} m² × výška ${nf(h, 2)} m ≈ <b>${nf(est, 1)} m³</b> (horná hranica hranola) ` +
    `<button type="button" id="use-est">použiť</button>` +
    (tooBig ? `<div class="warn-text">⚠ Zadaný objem ${nf(vol, 1)} m³ je väčší ako plocha × výška – skontrolujte objem alebo výšky.</div>` : "");
  $("#use-est").addEventListener("click", () => { f.volume_m3.value = est.toFixed(1); updateHint(); });
}
["height_max", "height_min", "volume_m3"].forEach((n) => $(`#save-form [name=${n}]`).addEventListener("input", updateHint));
$("#save-form [name=file_link]").addEventListener("input", (e) => { e.target.dataset.touched = "1"; });

$("#save-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  if (!state.selected) return;
  const body = Object.fromEntries(new FormData(f).entries());
  body.token = state.selected.token;
  const btn = f.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    const res = await postJSON("/api/save", body);
    remember("volumes.author", body.author);
    const p = res.volume.properties;
    toast(`Uložené ako #${p.id} – ${plural(res.collisions.features.length, "kolízia", "kolízie", "kolízií")}`, "ok");
    await refreshAll();
    candLayer.clearLayers();
    $("#candidates").innerHTML = "";
    msg($("#upload-msg"), "", "");
    $("#boundary-steps").hidden = true;
    $("#cut-from-dxf").disabled = true;
    showDetail(res, $("#save-result"));
  } catch (err) {
    toast(err.message, "err", 9000);
  } finally {
    btn.disabled = false;
  }
});

// ------------------------------------------------------------------ detail objemu (hľadanie a po uložení)
async function showVolume(id, switchTab) {
  try {
    const res = await api(`/api/volume/${id}`);
    if (switchTab) openTab("tab-search");
    showDetail(res, $("#detail"));
    $("#detail").scrollIntoView({ block: "nearest" });
  } catch (e) {
    toast(e.message, "err");
  }
}

function showDetail(res, container) {
  const v = res.volume;
  const p = v.properties;
  const cols = res.collisions.features.map((f) => f.properties);
  clearHighlights();
  hitLayer.addData(res.hits);
  ovlLayer.addData(res.collisions);
  selLayer.clearLayers().addData(v.geometry);
  map.fitBounds(selLayer.getBounds().pad(1.0), FIT);

  container.innerHTML = `<div class="card">
    <h3>#${p.id} ${esc(p.name)} ${cols.length ? `<span class="pill red">${plural(cols.length, "kolízia", "kolízie", "kolízií")}</span>` : `<span class="pill green">bez kolízií</span>`}</h3>
    <dl class="kv">
      <dt>SO</dt><dd>${esc(p.so)}</dd>
      <dt>KM</dt><dd>${km(p.km)}</dd>
      <dt>Typ</dt><dd>${esc(p.volume_type_name)}</dd>
      <dt>Autor</dt><dd>${esc(p.author)}</dd>
      <dt>Objem</dt><dd>${nf(p.volume_m3, 1)} m³</dd>
      <dt>Výška</dt><dd>${nf(p.height_min, 2)} – ${nf(p.height_max, 2)} m Bpv</dd>
      <dt>Plocha</dt><dd>${nf(p.area_m2, 1)} m²</dd>
      <dt>Odkaz</dt><dd>${p.file_link ? `<code>${esc(p.file_link)}</code>` : "–"}</dd>
      ${p.source_key ? `<dt>Kľúč</dt><dd>${esc(p.source_key)}</dd>` : ""}
      ${p.import_batch_id ? `<dt>Dávka importu</dt><dd>#${p.import_batch_id}</dd>` : ""}
    </dl>
    ${(res.checks || []).map((c) => `<div class="msg warn small">⚠ ${esc(c.message)}</div>`).join("")}
    <div class="detail-cols"></div>
    <details class="history"><summary>História zmien</summary><div class="hist-body small muted">Načítavam…</div></details>
    <h2>Export kolízií objemu</h2>
    <div class="fmt"></div>
  </div>`;
  const card = container.querySelector(".card");
  card.querySelector(".detail-cols").innerHTML = collisionTable(cols);
  bindCollisionRows(card);
  formatButtons(card.querySelector(".fmt"), (fmt) => `/export/volume/${p.id}?fmt=${fmt}`);
  card.querySelector("details.history").addEventListener("toggle", (e) => {
    if (e.target.open && !e.target.dataset.loaded) { e.target.dataset.loaded = "1"; loadHistory(p.id, card.querySelector(".hist-body")); }
  });
}

const fmtTime = (iso) => iso ? new Date(iso).toLocaleString("sk-SK", { dateStyle: "short", timeStyle: "short" }) : "–";

async function loadHistory(id, el) {
  try {
    const h = (await api(`/api/volume/${id}/history`)).history;
    el.classList.remove("muted");
    el.innerHTML = h.length ? `<ul class="hist">` + h.map((x) => `<li>
        <div><b>${fmtTime(x.when)}</b> · ${esc(x.action)} · ${esc(x.who || "?")}
          <span class="muted">(${esc(x.source || "")}${x.batch_id ? `, dávka #${x.batch_id}` : ""})</span></div>
        ${x.changes.length ? `<ul>${x.changes.map((c) => `<li>${esc(c.field)}: ${c.old === null ? "" : `${esc(c.old)} → `}<b>${esc(c.new)}</b></li>`).join("")}</ul>` : ""}
      </li>`).join("") + `</ul>` : "Žiadne záznamy.";
  } catch (e) {
    el.textContent = e.message;
  }
}

// ------------------------------------------------------------------ VÝREZ: posun, otočenie, zmena veľkosti, náhľad
// Výrez sa počíta v metroch Web Mercatora (konformné zobrazenie – uhly a tvar sedia),
// na server ide ako polygón v WGS84 a databáza ho prepočíta do S-JTSK.
const SM = L.Projection.SphericalMercator;
const toM = (ll) => { const p = SM.project(L.latLng(ll)); return [p.x, p.y]; };
const toLL = (m) => SM.unproject(L.point(m[0], m[1]));
const cut = {
  on: false, kind: null, base: [], hx: 1, hy: 1, cx: 0, cy: 0, angle: 0, sx: 1, sy: 1,
  token: null, name: "Výrez", orig: null,
};
let cutPoly = null, cutCorners = [], cutRot = null, cutRotLine = null, cutMove = null;

const groundK = () => Math.cos(toLL([cut.cx, cut.cy]).lat * Math.PI / 180);   // metre v teréne na meter Mercatora
const rot = (x, y, a) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
const toWorld = (lx, ly) => { const [x, y] = rot(lx, ly, cut.angle); return [cut.cx + x, cut.cy + y]; };
const toLocal = (m) => rot(m[0] - cut.cx, m[1] - cut.cy, -cut.angle);
const cutRing = () => cut.base.map(([x, y]) => toWorld(x * cut.sx, y * cut.sy));
const minScale = (h) => (0.5 / groundK()) / h;   // výrez aspoň 1 m

function handle(cls, html, size) {
  return L.marker([0, 0], {
    draggable: true, autoPan: true, keyboard: false, zIndexOffset: 1000,
    icon: L.divIcon({ className: `cut-handle ${cls}`, html, iconSize: [size, size] }),
  });
}

function buildCutLayers() {
  cutGroup.clearLayers();
  cutPoly = L.polygon([], {
    className: "cut-poly", color: "#1f6feb", weight: 2.5, dashArray: "7 5", fillColor: "#1f6feb", fillOpacity: 0.06,
  }).addTo(cutGroup);
  cutRotLine = L.polyline([], { color: "#1f6feb", weight: 1.5, interactive: false }).addTo(cutGroup);
  cutCorners = [0, 1, 2, 3].map((i) => {
    const m = handle("corner", "", 14).addTo(cutGroup);
    m.bindTooltip(cut.kind === "rect" ? "ťahaním zmeníte veľkosť" : "ťahaním zväčšíte / zmenšíte", { direction: "top" });
    m.on("drag", () => {
      const [lx, ly] = toLocal(toM(m.getLatLng()));
      if (cut.kind === "rect") {
        cut.sx = Math.max(Math.abs(lx) / cut.hx, minScale(cut.hx));
        cut.sy = Math.max(Math.abs(ly) / cut.hy, minScale(cut.hy));
      } else {
        const s = Math.hypot(lx, ly) / Math.hypot(cut.hx, cut.hy);
        cut.sx = cut.sy = Math.max(s, minScale(Math.max(cut.hx, cut.hy)));
      }
      drawCut(m);
    });
    m.on("dragend", cutChanged);
    return m;
  });
  cutRot = handle("rot", "⟳", 22).addTo(cutGroup);
  cutRot.bindTooltip("ťahaním otočíte (po 1°)", { direction: "top" });
  cutRot.on("drag", () => {
    const v = toM(cutRot.getLatLng());
    const a = Math.atan2(v[1] - cut.cy, v[0] - cut.cx) - Math.PI / 2;
    cut.angle = Math.round(a * 180 / Math.PI) * Math.PI / 180;
    drawCut(cutRot);
  });
  cutRot.on("dragend", cutChanged);
  cutMove = handle("move", "✥", 24).addTo(cutGroup);
  cutMove.bindTooltip("ťahaním posuniete", { direction: "top" });
  cutMove.on("drag", () => { [cut.cx, cut.cy] = toM(cutMove.getLatLng()); drawCut(cutMove); });
  cutMove.on("dragend", cutChanged);
  cutPoly.on("mousedown", startBodyDrag);
}

function drawCut(skip) {
  const ring = cutRing();
  cutPoly.setLatLngs(ring.map(toLL));
  const hx = cut.hx * cut.sx, hy = cut.hy * cut.sy;
  [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]].forEach(([x, y], i) => {
    if (cutCorners[i] !== skip) cutCorners[i].setLatLng(toLL(toWorld(x, y)));
  });
  const top = toWorld(0, hy);
  const rotPos = toWorld(0, hy + mPerPx() * 30);
  if (cutRot !== skip) cutRot.setLatLng(toLL(rotPos));
  cutRotLine.setLatLngs([toLL(top), toLL(skip === cutRot ? toM(cutRot.getLatLng()) : rotPos)]);
  if (cutMove !== skip) cutMove.setLatLng(toLL([cut.cx, cut.cy]));
  updateCutInputs();
}

// ťahanie celého výrezu
function startBodyDrag(e) {
  L.DomEvent.stop(e.originalEvent);
  map.dragging.disable();
  const start = toM(e.latlng);
  const c0 = [cut.cx, cut.cy];
  let moved = false, done = false;
  const onMove = (ev) => {
    const p = toM(ev.latlng);
    cut.cx = c0[0] + p[0] - start[0];
    cut.cy = c0[1] + p[1] - start[1];
    moved = true;
    drawCut();
  };
  const onUp = () => {
    if (done) return;
    done = true;
    map.off("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    map.dragging.enable();
    if (moved) { state.lastDragEnd = Date.now(); cutChanged(); }
  };
  map.on("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function startCut(kind, base, centre, opts = {}) {
  const xs = base.map((p) => p[0]), ys = base.map((p) => p[1]);
  const mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
  Object.assign(cut, {
    on: true, kind, base: base.map(([x, y]) => [x - mx, y - my]),
    hx: (Math.max(...xs) - Math.min(...xs)) / 2, hy: (Math.max(...ys) - Math.min(...ys)) / 2,
    cx: centre[0] + mx, cy: centre[1] + my, angle: 0, sx: 1, sy: 1,
    token: opts.token || null, name: opts.name || "Výrez",
  });
  cut.orig = { cx: cut.cx, cy: cut.cy };
  clearHighlights();
  buildCutLayers();
  drawCut();
  $("#cut-box").hidden = false;
  $("#cut-clear").disabled = false;
  $("#cut-w").readOnly = $("#cut-h").readOnly = kind !== "rect";
  refreshVisibility();
  map.fitBounds(cutPoly.getBounds().pad(0.4), FIT);
  drawCut();   // úchyt otáčania závisí od mierky mapy
  schedulePreview();
}

function startCutRect() {
  const b = map.getBounds();
  const [x0, y0] = toM(b.getSouthWest()), [x1, y1] = toM(b.getNorthEast());
  const c = toM(map.getCenter());
  const k = Math.cos(map.getCenter().lat * Math.PI / 180);
  const w = Math.max(5, Math.round((x1 - x0) * 0.4 * k / 5) * 5) / k;   // zaokrúhlené na 5 m v teréne
  const h = Math.max(5, Math.round((y1 - y0) * 0.3 * k / 5) * 5) / k;
  startCut("rect", [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]], c, { name: "Výrez" });
}

function startCutFromCandidate(c) {
  const ring = c.geometry.coordinates[0].slice(0, -1).map(([lng, lat]) => toM([lat, lng]));
  startCut("shape", ring, [0, 0], {
    token: c.token, name: (state.upload && state.upload.file ? state.upload.file.replace(/\.dxf$/i, "") + " / " : "") + c.layer,
  });
}

function clearCut() {
  cut.on = false;
  state.cutPreview = null;
  cutGroup.clearLayers();
  prevLayer.clearLayers();
  $("#cut-box").hidden = true;
  $("#cut-clear").disabled = true;
  refreshVisibility();
}

const unchanged = () => cut.kind === "shape" && cut.token && cut.angle === 0 && cut.sx === 1 && cut.sy === 1 &&
  Math.abs(cut.cx - cut.orig.cx) < 1e-6 && Math.abs(cut.cy - cut.orig.cy) < 1e-6;

function cutBody() {
  if (unchanged()) return { token: cut.token, name: cut.name };   // presná geometria z DXF
  const ring = cutRing().map(toLL);
  const pts = ring.concat([ring[0]]).map((ll) => `${ll.lng.toFixed(9)} ${ll.lat.toFixed(9)}`).join(", ");
  return { polygon: `SRID=4326;POLYGON((${pts}))`, name: cut.name };
}
const clipMode = () => document.querySelector("input[name=cut-clip]:checked").value === "1";

function updateCutInputs() {
  const k = groundK();
  const set = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
  set("#cut-w", (2 * cut.hx * cut.sx * k).toFixed(1));
  set("#cut-h", (2 * cut.hy * cut.sy * k).toFixed(1));
  set("#cut-rot", ((((-cut.angle * 180 / Math.PI) % 360) + 360) % 360).toFixed(0));
  set("#cut-scale", Math.abs(cut.sx - cut.sy) < 1e-9 ? (cut.sx * 100).toFixed(0) : "–");
}

function cutChanged() {
  state.lastDragEnd = Date.now();
  drawCut();
  schedulePreview();
}

$("#cut-w").addEventListener("change", (e) => {
  const v = num(e.target.value);
  if (cut.kind === "rect" && v >= 1) { cut.sx = (v / groundK()) / (2 * cut.hx); cutChanged(); } else updateCutInputs();
});
$("#cut-h").addEventListener("change", (e) => {
  const v = num(e.target.value);
  if (cut.kind === "rect" && v >= 1) { cut.sy = (v / groundK()) / (2 * cut.hy); cutChanged(); } else updateCutInputs();
});
$("#cut-rot").addEventListener("change", (e) => {
  const v = num(e.target.value);
  if (Number.isFinite(v)) { cut.angle = -v * Math.PI / 180; cutChanged(); } else updateCutInputs();
});
$("#cut-scale").addEventListener("change", (e) => {
  const v = num(e.target.value);
  if (v > 0) { cut.sx = cut.sy = v / 100; cutChanged(); } else updateCutInputs();
});
document.querySelectorAll("#cut-box button[data-rot]").forEach((b) => b.addEventListener("click", () => {
  cut.angle -= Number(b.dataset.rot) * Math.PI / 180;
  cutChanged();
}));
document.querySelectorAll("#cut-box button[data-scale]").forEach((b) => b.addEventListener("click", () => {
  cut.sx *= Number(b.dataset.scale);
  cut.sy *= Number(b.dataset.scale);
  cutChanged();
}));
$("#cut-center").addEventListener("click", () => { [cut.cx, cut.cy] = toM(map.getCenter()); cutChanged(); });
$("#cut-fit").addEventListener("click", () => { map.fitBounds(cutPoly.getBounds().pad(0.4), FIT); drawCut(); });
$("#cut-new").addEventListener("click", startCutRect);
$("#cut-from-dxf").addEventListener("click", () => state.selected && startCutFromCandidate(state.selected));
$("#cut-clear").addEventListener("click", clearCut);
document.querySelectorAll("input[name=cut-clip]").forEach((r) => r.addEventListener("change", schedulePreview));
map.on("zoomend", () => { if (cut.on) drawCut(); });

let previewTimer = null, previewSeq = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 250);
}

async function runPreview() {
  if (!cut.on) return;
  const seq = ++previewSeq;
  $("#cut-summary").classList.add("busy");
  try {
    const res = await postJSON("/api/cut/preview", { ...cutBody(), clip: clipMode() });
    if (seq !== previewSeq || !cut.on) return;
    state.cutPreview = res;
    renderPreview();
  } catch (e) {
    if (seq === previewSeq) msg($("#cut-summary"), esc(e.message), "err");
  } finally {
    if (seq === previewSeq) $("#cut-summary").classList.remove("busy");
  }
}

function renderPreview() {
  const res = state.cutPreview;
  const items = res.parts.features.map((f) => f.properties);
  const on = items.filter((p) => !hidden.has(p.id));
  prevLayer.clearLayers().addData({ type: "FeatureCollection", features: res.parts.features.filter((f) => !hidden.has(f.properties.id)) });
  $("#cut-info").textContent = `Plocha výrezu ${nf(res.area_m2, 1)} m²` +
    (unchanged() ? " · presná hranica z DXF" : "");
  msg($("#cut-summary"), items.length
    ? `Exportuje sa <b>${on.length}</b> z ${plural(items.length, "objemu", "objemov", "objemov")} vo výreze` +
      (res.clip ? " – <b>orezané výrezom</b>." : " – <b>celé</b> (aj časti mimo výrezu).") +
      (items.length > on.length ? `<br><span class="small">${plural(items.length - on.length, "objem je vypnutý", "objemy sú vypnuté", "objemov je vypnutých")} a nebude v exporte.</span>` : "")
    : "Vo výreze nie je žiadny objem. Posuňte alebo zväčšite výrez.", items.length ? "info" : "warn");
  $("#cut-list").innerHTML = items.length ? `<table><thead><tr><th></th><th>Objem</th>
      <th class="num">Vo výreze m²</th><th class="num">${res.clip ? "Objem odhad m³" : "Objem m³"}</th></tr></thead><tbody>` +
    items.map((p) => `<tr class="${hidden.has(p.id) ? "off" : ""}">
      <td><input type="checkbox" data-vis="${p.id}" ${hidden.has(p.id) ? "" : "checked"} title="zapnúť / vypnúť"></td>
      <td class="clickable" data-zoom="${p.id}"><span class="swatch" style="display:inline-block;background:${state.typeColor[p.volume_type]}"></span>
        <b>#${p.id}</b> ${esc(p.name)}<div class="small muted">${esc(p.so)} · km ${km(p.km)} · ${esc(p.volume_type_name)}</div></td>
      <td class="num">${nf(p.overlap_m2, 1)}<div class="small muted">${nf(p.overlap_pct, 1)} %</div></td>
      <td class="num">${res.clip ? "≈ " + nf(p.volume_cut_m3, 1) : nf(p.volume_m3, 1)}</td></tr>`).join("") +
    `</tbody></table><div class="btnrow tight"><button type="button" id="cut-all-on">zapnúť všetky</button>` +
    `<button type="button" id="cut-all-off">vypnúť všetky</button></div>` : "";
  $("#cut-list").querySelectorAll("input[data-vis]").forEach((cb) =>
    cb.addEventListener("change", () => setHidden([Number(cb.dataset.vis)], !cb.checked)));
  $("#cut-list").querySelectorAll("[data-zoom]").forEach((td) =>
    td.addEventListener("click", () => zoomToVolume(Number(td.dataset.zoom))));
  const ids = items.map((p) => p.id);
  const allOn = $("#cut-all-on"), allOff = $("#cut-all-off");
  if (allOn) allOn.addEventListener("click", () => setHidden(ids, false));
  if (allOff) allOff.addEventListener("click", () => setHidden(ids, true));
}

formatButtons($("#cut-export"), () => "/export/cut", (fmt) => {
  const items = state.cutPreview ? state.cutPreview.parts.features.map((f) => f.properties.id) : [];
  return { ...cutBody(), clip: clipMode(), fmt, exclude: items.filter((id) => hidden.has(id)) };
});

// ------------------------------------------------------------------ IMPORT: Excel + DXF
const IMP_STATUS = {
  new: { label: "nový", icon: "✔", color: "#12805c" },
  update: { label: "zmena", icon: "↻", color: "#1f6feb" },
  unchanged: { label: "bez zmeny", icon: "=", color: "#667085" },
  error: { label: "chyba", icon: "✖", color: "#d92d20" },
  unmatched: { label: "polygón bez riadku v Exceli", icon: "?", color: "#7a5af8" },
};
const imp = { token: null, res: null, filter: "all", include: new Set(), eligible: new Set(), typeMap: {} };
const impLayer = L.geoJSON(null, {
  bubblingMouseEvents: false,
  style: (f) => {
    const s = f.properties.status, c = IMP_STATUS[s].color;
    return { color: c, weight: 2.5, dashArray: s === "error" || s === "unmatched" ? "6 4" : null,
      fillColor: c, fillOpacity: s === "unchanged" ? 0.08 : 0.28 };
  },
  onEachFeature: (f, layer) => {
    const p = f.properties;
    layer.bindTooltip(`<b>${esc(p.key || "")}</b> ${esc(p.name || "")}<br>${IMP_STATUS[p.status].icon} ${IMP_STATUS[p.status].label}` +
      (p.row ? ` · riadok ${p.row}` : ""), { sticky: true, className: "vol-tip" });
    layer.on("click", () => { if (p.row) highlightImportRow(p.row); });
  },
}).addTo(map);

$("#import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  msg($("#imp-msg"), "Načítavam a kontrolujem…", "info");
  $("#imp-done").innerHTML = "";
  imp.typeMap = {};
  try {
    showImport(await api("/api/import/upload", { method: "POST", body: fd }), true);
  } catch (err) {
    msg($("#imp-msg"), esc(err.message), "err");
  } finally {
    btn.disabled = false;
  }
});

function impParams(withMapping = true) {
  const p = { token: imp.token, sheet: $("#imp-sheet").value, type_map: imp.typeMap, heights_from_dxf: $("#imp-zdxf").checked };
  if (withMapping) {
    p.mapping = {};
    document.querySelectorAll("#imp-mapping select").forEach((s) => { if (s.value !== "") p.mapping[s.dataset.field] = Number(s.value); });
  }
  return p;
}

async function revalidate(withMapping = true) {
  if (!imp.token) return;
  msg($("#imp-msg"), "Kontrolujem…", "info");
  try {
    showImport(await postJSON("/api/import/validate", impParams(withMapping)), false);
  } catch (err) {
    msg($("#imp-msg"), esc(err.message), "err");
  }
}
$("#imp-revalidate").addEventListener("click", () => revalidate());
$("#imp-sheet").addEventListener("change", () => revalidate(false));   // iný hárok: stĺpce sa priradia znova
$("#imp-zdxf").addEventListener("change", () => revalidate());

function showImport(res, fresh) {
  imp.token = res.token;
  imp.res = res;
  const setupErr = res.setup_errors && res.setup_errors.length;
  msg($("#imp-msg"), `<b>${esc(res.excel)}</b> (hárok „${esc(res.sheet)}“, hlavička v riadku ${res.header_row}) + <b>${esc(res.dxf)}</b>` +
    res.dxf_warnings.map((w) => `<br><span class="small">⚠ ${esc(w)}</span>`).join("") +
    (setupErr ? res.setup_errors.map((w) => `<br><b>✖ ${esc(w)}</b> – priraďte stĺpce nižšie.`).join("") : ""),
    setupErr ? "err" : "info");

  $("#imp-sheet").innerHTML = res.sheets.map((s) => `<option ${s === res.sheet ? "selected" : ""}>${esc(s)}</option>`).join("");
  const opts = (sel) => `<option value="">– nepriradené –</option>` + res.headers.map((h, i) =>
    `<option value="${i}" ${sel === i ? "selected" : ""}>${esc(h || `(stĺpec ${i + 1})`)}</option>`).join("");
  $("#imp-mapping").innerHTML = res.fields.map((f) =>
    `<label>${esc(f.label)}${f.required ? " *" : ""}<select data-field="${f.key}">${opts(res.mapping[f.key])}</select></label>`).join("");
  document.querySelectorAll("#imp-mapping select").forEach((s) => s.addEventListener("change", () => revalidate()));
  $("#imp-map-info").textContent = `– priradených ${Object.keys(res.mapping).length} z ${res.fields.length} stĺpcov`;
  if (setupErr) $("#imp-mapping-box").open = true;

  // neznáme typy -> priradiť k povoleným (výber sa pamätá, kým sa nenahrá nový súbor)
  const raw = [...new Set([...res.unknown_types, ...Object.keys(imp.typeMap)])];
  $("#imp-types").innerHTML = raw.length ? `<div class="msg warn"><b>Typy, ktoré nie sú v zozname</b> – priraďte ich k povoleným:` +
    raw.map((t) => `<label class="typemap">„${esc(t)}“ →<select data-raw="${esc(t)}"><option value="">– vyberte –</option>` +
      state.meta.types.map((x) => `<option value="${esc(x.code)}" ${imp.typeMap[t] === x.code ? "selected" : ""}>${esc(x.name_sk)}</option>`).join("") +
      `</select></label>`).join("") + `</div>` : "";
  document.querySelectorAll("#imp-types select").forEach((s) => s.addEventListener("change", () => {
    if (s.value) imp.typeMap[s.dataset.raw] = s.value; else delete imp.typeMap[s.dataset.raw];
    revalidate();
  }));
  $("#imp-setup").hidden = false;

  if (setupErr) {
    $("#imp-result").hidden = true;
    impLayer.clearLayers();
    return;
  }
  // vybrané riadky: nové a zmenené; po opakovanej kontrole ostanú odškrtnuté tie, ktoré používateľ odškrtol
  const eligible = new Set(res.rows.filter((r) => r.status === "new" || r.status === "update").map((r) => r.row));
  if (fresh) imp.include = new Set(eligible);
  else imp.include = new Set([...eligible].filter((r) => imp.include.has(r) || !imp.eligible.has(r)));
  imp.eligible = eligible;
  if (!$("#imp-by").value) $("#imp-by").value = recall("volumes.author");
  renderImport();
  impLayer.clearLayers().addData(res.polygons);
  if (fresh && impLayer.getLayers().length) map.fitBounds(impLayer.getBounds().pad(0.15), FIT);
}

function renderImport() {
  const res = imp.res, s = res.summary;
  $("#imp-result").hidden = false;
  const chip = (st, n, text) => `<span class="chip" style="--c:${IMP_STATUS[st].color}">${IMP_STATUS[st].icon} ${text} <b>${n}</b></span>`;
  $("#imp-summary").innerHTML = `<div class="chips">${chip("new", s.new, "nové")}${chip("update", s.update, "zmeny")}` +
    `${chip("unchanged", s.unchanged, "bez zmeny")}${chip("error", s.error, "chyby")}` +
    `<span class="chip" style="--c:#b54708">⚠ s upozornením <b>${s.warning}</b></span>` +
    (s.unmatched_polygons ? chip("unmatched", s.unmatched_polygons, "polygóny bez riadku") : "") + `</div>`;

  const filters = [["all", "všetko"], ["error", "chyby"], ["warning", "upozornenia"], ["new", "nové"], ["update", "zmeny"], ["unchanged", "bez zmeny"]];
  $("#imp-filter").innerHTML = filters.map(([k, l]) => `<button type="button" data-f="${k}" class="${imp.filter === k ? "on" : ""}">${l}</button>`).join("");
  $("#imp-filter").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { imp.filter = b.dataset.f; renderImport(); }));

  const rows = res.rows.filter((r) => imp.filter === "all" || r.status === imp.filter ||
    (imp.filter === "warning" && r.warnings.length && r.status !== "error"));
  $("#imp-rows").innerHTML = rows.length ? `<table class="imp-table"><thead><tr><th></th><th>Stav</th><th>Riadok</th><th>Kľúč</th>
      <th>Objem</th><th>Správy</th></tr></thead><tbody>` + rows.map((r) => {
    const st = IMP_STATUS[r.status];
    const can = r.status === "new" || r.status === "update";
    return `<tr data-row="${r.row}" class="${can && !imp.include.has(r.row) ? "off" : ""}">
      <td>${can ? `<input type="checkbox" data-inc="${r.row}" ${imp.include.has(r.row) ? "checked" : ""} title="importovať tento riadok">` : ""}</td>
      <td><span class="st" style="color:${st.color}">${st.icon}</span> ${st.label}</td>
      <td class="num">${r.row}</td>
      <td><b>${esc(r.source_key || "–")}</b></td>
      <td class="clickable">${esc(r.name || "–")}<div class="small muted">${esc(r.so || "–")} · km ${km(r.km)} · ` +
        `${esc(r.volume_type_name || r.volume_type_raw || "–")} · ${nf(r.volume_m3, 1)} m³${r.existing_id ? ` · objem #${r.existing_id}` : ""}</div></td>
      <td class="msgs">${r.errors.map((m) => `<div class="e">✖ ${esc(m)}</div>`).join("")}` +
        `${r.warnings.map((m) => `<div class="w">⚠ ${esc(m)}</div>`).join("")}` +
        `${r.changes.map((m) => `<div class="c">↻ ${esc(m)}</div>`).join("")}</td></tr>`;
  }).join("") + `</tbody></table>` : `<p class="small muted">Žiadne riadky pre tento filter.</p>`;
  $("#imp-rows").querySelectorAll("input[data-inc]").forEach((cb) => cb.addEventListener("change", () => {
    if (cb.checked) imp.include.add(Number(cb.dataset.inc)); else imp.include.delete(Number(cb.dataset.inc));
    cb.closest("tr").classList.toggle("off", !cb.checked);
    updateCommitButton();
  }));
  $("#imp-rows").querySelectorAll("td.clickable").forEach((td) => td.addEventListener("click", () => zoomImportRow(Number(td.closest("tr").dataset.row))));

  $("#imp-unmatched").innerHTML = res.unmatched.length ? `<details class="tablebox"><summary>Polygóny v DXF bez riadku v Exceli (${res.unmatched.length})</summary>
    <table><thead><tr><th>Hladina</th><th>Popisy vo vnútri</th><th class="num">Plocha m²</th></tr></thead><tbody>` +
    res.unmatched.map((u) => `<tr><td>${esc(u.layer)}</td><td>${esc(u.labels.join(", ") || "–")}${u.error ? `<div class="e small">${esc(u.error)}</div>` : ""}</td>
      <td class="num">${nf(u.area_m2, 1)}</td></tr>`).join("") + `</tbody></table></details>` : "";
  updateCommitButton();
}

function updateCommitButton() {
  const n = [...imp.include].filter((r) => imp.eligible.has(r)).length;
  const b = $("#imp-commit");
  b.disabled = n === 0;
  b.textContent = n ? `Importovať ${plural(n, "objem", "objemy", "objemov")}` : "Nie je čo importovať";
}

function zoomImportRow(row) {
  impLayer.eachLayer((l) => { if (l.feature.properties.row === row) { map.fitBounds(l.getBounds().pad(1.5), FIT); l.openTooltip(); } });
}
function highlightImportRow(row) {
  imp.filter = "all";
  renderImport();
  const tr = document.querySelector(`#imp-rows tr[data-row="${row}"]`);
  if (tr) { tr.classList.add("flash"); tr.scrollIntoView({ block: "center" }); setTimeout(() => tr.classList.remove("flash"), 1500); }
}

$("#imp-commit").addEventListener("click", async () => {
  const who = $("#imp-by").value.trim();
  if (!who) { toast("Vyplňte, kto importuje", "err"); $("#imp-by").focus(); return; }
  remember("volumes.author", who);
  const btn = $("#imp-commit");
  btn.disabled = true;
  try {
    const r = await postJSON("/api/import/commit", { ...impParams(), include: [...imp.include], imported_by: who });
    const x = r.result;
    $("#imp-done").innerHTML = `<div class="msg ok"><b>Dávka #${x.batch_id} je uložená:</b> ` +
      `${x.inserted} nových, ${x.updated} zmenených, ${x.unchanged} bez zmeny, ${x.skipped} preskočených.<br>` +
      `<a href="/api/import/batches/${x.batch_id}/report">Stiahnuť protokol (XLSX)</a> · súbory sú archivované v <code>${esc(x.archive_dir)}</code></div>`;
    renderBatches(r.batches);
    $("#imp-result").hidden = true;
    $("#imp-setup").hidden = true;
    impLayer.clearLayers();
    imp.token = null;
    $("#import-form").reset();
    msg($("#imp-msg"), "", "");
    toast(`Import hotový – dávka #${x.batch_id}`, "ok");
    await refreshAll();
  } catch (err) {
    toast(err.message, "err", 9000);
  } finally {
    btn.disabled = false;
  }
});

async function loadBatches() {
  try { renderBatches((await api("/api/import/batches")).batches); } catch (e) { /* tichý pokus */ }
}

function renderBatches(list) {
  $("#imp-batches").innerHTML = list.length ? `<table><thead><tr><th>#</th><th>Kedy / kto</th><th>Súbory</th>
      <th>Výsledok</th><th></th></tr></thead><tbody>` + list.map((b) => `<tr class="${b.undone_at ? "off" : ""}">
      <td>${b.id}</td><td>${fmtTime(b.created_at)}<div class="small muted">${esc(b.imported_by)}</div></td>
      <td class="small">${esc(b.excel_file || "")}<br>${esc(b.dxf_file || "")}</td>
      <td class="small">+${b.n_inserted} nových<br>↻ ${b.n_updated} zmien${b.n_skipped ? `<br>${b.n_skipped} preskočených` : ""}</td>
      <td class="small">${b.undone_at ? `vrátená ${fmtTime(b.undone_at)}${b.undone_by ? `<br>${esc(b.undone_by)}` : ""}`
        : `<a href="/api/import/batches/${b.id}/report">protokol</a><br><button type="button" class="link" data-undo="${b.id}">vrátiť dávku</button>`}</td>
    </tr>`).join("") + `</tbody></table>` : `<p class="small muted">Zatiaľ žiadny import.</p>`;
  $("#imp-batches").querySelectorAll("button[data-undo]").forEach((b) => b.addEventListener("click", () => undoBatch(Number(b.dataset.undo), false)));
}

async function undoBatch(id, force) {
  if (!force && !confirm(`Vrátiť dávku #${id}?\n\nObjemy, ktoré dávka pridala, sa zmažú a objemy, ktoré zmenila, dostanú hodnoty spred importu.`)) return;
  const r = await fetch(`/api/import/batches/${id}/undo`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force, user: recall("volumes.author") || "web" }),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 409 && j.confirm) {
    if (confirm(`${j.error}\n\nVrátiť dávku aj tak?`)) undoBatch(id, true);
    return;
  }
  if (!r.ok) { toast(j.error || r.statusText, "err", 8000); return; }
  toast(`Dávka #${id} vrátená: ${j.deleted} zmazaných, ${j.restored} obnovených objemov`, "ok");
  renderBatches(j.batches);
  await refreshAll();
}

// ------------------------------------------------------------------ BILANCIA zemných prác
const C_CUT = "#e6550d", C_FILL = "#31a354", C_LINE = "#1f6feb";   // rovnaké farby ako Výkop / Násyp na mape
const compact = new Intl.NumberFormat("sk-SK", { notation: "compact", maximumFractionDigits: 1 });
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

function niceTicks(min, max, count = 5) {
  if (min === max) { max = min + 1; }
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const ticks = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

function chartFrame(container, title, sub, legend) {
  container.innerHTML = `<div class="chart-head"><div class="chart-title">${title}</div>` +
    (sub ? `<div class="small muted">${sub}</div>` : "") +
    (legend ? `<div class="legend-row">${legend.map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join("")}</div>` : "") +
    `</div><div class="chart-body"></div><div class="chart-tip" hidden></div>`;
  return { body: container.querySelector(".chart-body"), tip: container.querySelector(".chart-tip") };
}

function showTip(tip, container, html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const w = container.clientWidth;
  tip.style.left = `${Math.min(Math.max(x + 12, 0), w - tip.offsetWidth - 4)}px`;
  tip.style.top = `${y}px`;
}

// stĺpce po úsekoch: výkop nad nulou, násyp pod nulou (jedna os, m³)
function drawSectionsChart(el, b) {
  const { body, tip } = chartFrame(el, "Výkop a násyp po úsekoch (m³)",
    b.k !== 1 ? `výkop prepočítaný koeficientom ${nf(b.k, 2)}` : "",
    [[C_CUT, "Výkop"], [C_FILL, "Násyp"]]);
  const S = b.sections;
  if (!S.length) { body.innerHTML = `<p class="small muted">Žiadne objemy so staničením.</p>`; return; }
  const W = Math.max(300, el.clientWidth), H = 220, m = { l: 48, r: 8, t: 8, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const maxUp = Math.max(...S.map((s) => s.vykop_k), 1), maxDn = Math.max(...S.map((s) => s.nasyp), 1);
  const ticks = niceTicks(-maxDn, maxUp, 5);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const y = (v) => m.t + ih * (1 - (v - y0) / (y1 - y0));
  const band = iw / S.length, bw = Math.max(2, Math.min(24, band * 0.7));
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Výkop a násyp po úsekoch" });
  for (const t of ticks) {
    svg.append(svgEl("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), stroke: t === 0 ? "#98a2b3" : "#e8ebef", "stroke-width": 1 }));
    const lab = svgEl("text", { x: m.l - 6, y: y(t) + 4, "text-anchor": "end", class: "axis" });
    lab.textContent = compact.format(Math.abs(t));
    svg.append(lab);
  }
  const r = 4;
  const bar = (x, v, up) => {   // zaoblený koniec (4 px) na strane hodnoty, rovný pri nule
    const h = Math.abs(y(v) - y(0));
    if (h < 0.5) return null;
    const rr = Math.min(r, h, bw / 2), yb = y(0);
    const d = up
      ? `M${x},${yb} V${yb - h + rr} Q${x},${yb - h} ${x + rr},${yb - h} H${x + bw - rr} Q${x + bw},${yb - h} ${x + bw},${yb - h + rr} V${yb} Z`
      : `M${x},${yb} V${yb + h - rr} Q${x},${yb + h} ${x + rr},${yb + h} H${x + bw - rr} Q${x + bw},${yb + h} ${x + bw},${yb + h - rr} V${yb} Z`;
    return svgEl("path", { d, fill: up ? C_CUT : C_FILL });
  };
  const every = Math.max(1, Math.ceil(S.length / (iw / 46)));
  S.forEach((s, i) => {
    const x = m.l + i * band + (band - bw) / 2;
    const up = bar(x, s.vykop_k, true), dn = bar(x, -s.nasyp, false);
    if (up) svg.append(up);
    if (dn) svg.append(dn);
    if (i % every === 0) {
      const t = svgEl("text", { x: m.l + i * band + band / 2, y: H - 8, "text-anchor": "middle", class: "axis" });
      t.textContent = nf(s.from_km, 1);
      svg.append(t);
    }
    const hit = svgEl("rect", { x: m.l + i * band, y: m.t, width: band, height: ih, fill: "transparent", class: "hit" });
    hit.addEventListener("mousemove", (ev) => {
      const rect = el.getBoundingClientRect();
      showTip(tip, el, `<b>km ${nf(s.from_km, 3)} – ${nf(s.to_km, 3)}</b>
        <div><i style="background:${C_CUT}"></i>Výkop ${nf(s.vykop, 0)} m³${b.k !== 1 ? ` (× ${nf(b.k, 2)} = ${nf(s.vykop_k, 0)})` : ""}</div>
        <div><i style="background:${C_FILL}"></i>Násyp ${nf(s.nasyp, 0)} m³</div>
        <div>Rozdiel <b>${s.rozdiel >= 0 ? "+" : "−"}${nf(Math.abs(s.rozdiel), 0)} m³</b></div>`, ev.clientX - rect.left, ev.clientY - rect.top + 10);
    });
    hit.addEventListener("mouseleave", () => { tip.hidden = true; });
    svg.append(hit);
  });
  body.append(svg);
}

// kumulatívna bilancia (hmotnicová čiara): nad nulou prebytok výkopu, pod nulou nedostatok
function drawCumulativeChart(el, b) {
  const { body, tip } = chartFrame(el, "Kumulatívna bilancia – hmotnicová čiara (m³)",
    "nad nulou prebytok výkopu, pod nulou nedostatok materiálu", null);
  const S = b.sections;
  if (!S.length) { body.innerHTML = ""; return; }
  const pts = [{ km: S[0].from_km, v: 0 }, ...S.map((s) => ({ km: s.to_km, v: s.kumulativ }))];
  const W = Math.max(300, el.clientWidth), H = 190, m = { l: 48, r: 56, t: 10, b: 26 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const ticks = niceTicks(Math.min(0, ...pts.map((p) => p.v)), Math.max(0, ...pts.map((p) => p.v)), 4);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const k0 = pts[0].km, k1 = pts[pts.length - 1].km;
  const x = (k) => m.l + iw * (k - k0) / (k1 - k0 || 1), y = (v) => m.t + ih * (1 - (v - y0) / (y1 - y0));
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Kumulatívna bilancia" });
  for (const t of ticks) {
    svg.append(svgEl("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), stroke: t === 0 ? "#98a2b3" : "#e8ebef", "stroke-width": 1 }));
    const lab = svgEl("text", { x: m.l - 6, y: y(t) + 4, "text-anchor": "end", class: "axis" });
    lab.textContent = (t < 0 ? "−" : "") + compact.format(Math.abs(t));
    svg.append(lab);
  }
  const kt = niceTicks(k0, k1, Math.max(2, Math.floor(iw / 70)));
  for (const t of kt.filter((t) => t >= k0 && t <= k1)) {
    const lab = svgEl("text", { x: x(t), y: H - 8, "text-anchor": "middle", class: "axis" });
    lab.textContent = `km ${nf(t, 1)}`;
    svg.append(lab);
  }
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.km).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  svg.append(svgEl("path", { d: `${d} L${x(k1)},${y(0)} L${x(k0)},${y(0)} Z`, fill: C_LINE, "fill-opacity": 0.1 }));
  svg.append(svgEl("path", { d, fill: "none", stroke: C_LINE, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  const last = pts[pts.length - 1];
  svg.append(svgEl("circle", { cx: x(last.km), cy: y(last.v), r: 4, fill: C_LINE, stroke: "#fff", "stroke-width": 2 }));
  const end = svgEl("text", { x: x(last.km) + 8, y: y(last.v) + 4, class: "end-label" });
  end.textContent = `${last.v >= 0 ? "+" : "−"}${compact.format(Math.abs(last.v))}`;
  svg.append(end);
  const cross = svgEl("line", { y1: m.t, y2: m.t + ih, stroke: "#98a2b3", "stroke-width": 1, visibility: "hidden" });
  const dot = svgEl("circle", { r: 4, fill: C_LINE, stroke: "#fff", "stroke-width": 2, visibility: "hidden" });
  svg.append(cross, dot);
  const hit = svgEl("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" });
  hit.addEventListener("mousemove", (ev) => {
    const rect = svg.getBoundingClientRect();
    const kx = k0 + (ev.clientX - rect.left - m.l) / iw * (k1 - k0);
    const p = pts.reduce((a, c) => Math.abs(c.km - kx) < Math.abs(a.km - kx) ? c : a);
    cross.setAttribute("x1", x(p.km)); cross.setAttribute("x2", x(p.km)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x(p.km)); dot.setAttribute("cy", y(p.v)); dot.setAttribute("visibility", "visible");
    showTip(tip, el, `<b>km ${nf(p.km, 3)}</b><div>${p.v >= 0 ? "prebytok" : "nedostatok"} <b>${nf(Math.abs(p.v), 0)} m³</b></div>`,
      x(p.km), ev.clientY - el.getBoundingClientRect().top + 10);
  });
  hit.addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); });
  svg.append(hit);
  body.append(svg);
}

async function loadBalance() {
  const p = new URLSearchParams(new FormData($("#balance-form")));
  state.balanceParams = p.toString();
  let b;
  try {
    b = await api(`/api/balance?${p}`);
  } catch (e) {
    msg($("#bal-tiles"), esc(e.message), "err");
    return;
  }
  const t = b.totals;
  const tile = (label, value, sub) => `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${sub ? `<div class="small muted">${sub}</div>` : ""}</div>`;
  $("#bal-tiles").innerHTML =
    tile(`<i style="background:${C_CUT}"></i>Výkop spolu`, `${nf(t.vykop, 0)} m³`, b.k !== 1 ? `× ${nf(b.k, 2)} = ${nf(t.vykop_k, 0)} m³` : "") +
    tile(`<i style="background:${C_FILL}"></i>Násyp spolu`, `${nf(t.nasyp, 0)} m³`, "") +
    tile(t.bilancia >= 0 ? "Prebytok zeminy" : "Nedostatok zeminy", `${nf(Math.abs(t.bilancia), 0)} m³`,
      t.bilancia >= 0 ? "výkop – násyp > 0 → na depóniu" : "násyp – výkop > 0 → dovoz materiálu");
  drawSectionsChart($("#bal-chart1"), b);
  drawCumulativeChart($("#bal-chart2"), b);
  $("#bal-sections").innerHTML = `<table><thead><tr><th>Úsek km</th><th class="num">Výkop m³</th><th class="num">Násyp m³</th>
      <th class="num">Rozdiel m³</th><th class="num">Kumulatívne m³</th></tr></thead><tbody>` +
    b.sections.map((s) => `<tr><td>${nf(s.from_km, 3)} – ${nf(s.to_km, 3)}</td><td class="num">${nf(s.vykop_k, 0)}</td>
      <td class="num">${nf(s.nasyp, 0)}</td><td class="num">${nf(s.rozdiel, 0)}</td><td class="num">${nf(s.kumulativ, 0)}</td></tr>`).join("") +
    `</tbody></table>`;
  $("#bal-types").innerHTML = `<table><thead><tr><th>SO</th><th>Typ</th><th class="num">Počet</th><th class="num">Objem m³</th></tr></thead><tbody>` +
    b.by_type.map((r) => `<tr><td>${esc(r.so)}</td><td><span class="swatch" style="display:inline-block;background:${state.typeColor[r.code]}"></span>
      ${esc(r.name_sk)}${r.balance ? ` <span class="small muted">(${r.balance === "vykop" ? "výkop" : "násyp"})</span>` : ""}</td>
      <td class="num">${r.n}</td><td class="num">${nf(r.m3, 0)}</td></tr>`).join("") + `</tbody></table>`;
  const noKm = Object.entries(b.no_km).map(([k, v]) => `${k === "vykop" ? "výkop" : "násyp"} ${nf(v, 0)} m³`).join(", ");
  $("#bal-note").innerHTML = `Do výkopu sa počíta: ${esc(b.balance_types.vykop.join(", "))}. Do násypu: ${esc(b.balance_types.nasyp.join(", "))}. ` +
    `Úsek objemu sa určuje podľa jeho KM.` + (noKm ? ` Bez staničenia (nie sú v grafe): ${noKm}.` : "");
}
$("#balance-form").addEventListener("change", loadBalance);
$("#balance-form").addEventListener("submit", (e) => { e.preventDefault(); loadBalance(); });
$("#bal-xlsx").addEventListener("click", (e) => download(`/api/balance.xlsx?${state.balanceParams || ""}`, e.target));
window.addEventListener("resize", () => { if ($("#tab-balance").classList.contains("active") && state.balanceParams) loadBalance(); });

// ------------------------------------------------------------------ ZÁLOHA
async function loadBackupStatus() {
  try {
    const s = await api("/api/backup/status");
    $("#backup-status").innerHTML =
      `<div>Posledná záloha: <b>${s.last ? `${fmtTime(s.last.when)}` : "zatiaľ žiadna"}</b>${s.last ? ` (${nf(s.last.size_kb, 0)} kB)` : ""} · na disku ${s.count}</div>` +
      `<div>Automatická záloha: ${s.scheduled ? `<b>zapnutá</b>${s.mail ? ` – každý deň o ${esc(s.mail.time)}, posiela sa na <b>${esc(s.mail.to)}</b>, uchováva ${esc(String(s.mail.keep_days))} dní` : ""}`
        : `<b>nie je nastavená</b>`}</div>` +
      (s.log.length ? `<details><summary class="small">Záznam záloh</summary><pre class="log">${esc(s.log.join("\n"))}</pre></details>` : "");
  } catch (e) {
    $("#backup-status").textContent = e.message;
  }
}
$("#backup-run").addEventListener("click", async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = "Zálohujem…";
  try {
    const r = await postJSON("/api/backup/run", {});
    toast(r.output.split("\n").slice(-2).join(" · ") || "Záloha hotová", r.mail_failed ? "warn" : "ok", 8000);
  } catch (err) {
    toast(err.message, "err", 9000);
  } finally {
    btn.disabled = false;
    btn.textContent = "Zálohovať teraz";
    loadBackupStatus();
  }
});

// ------------------------------------------------------------------ hľadanie
$("#search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const params = new URLSearchParams();
  for (const [k, v] of new FormData(e.target).entries()) if (v) params.set(k, v);
  try {
    const fc = await loadVolumes(params.toString());
    const rows = fc.features.map((f) => f.properties);
    $("#results").innerHTML = `<p class="small muted">${plural(rows.length, "objem", "objemy", "objemov")}</p>` + (rows.length ? `<table><thead><tr>
      <th>#</th><th>Názov</th><th>Typ</th><th class="num">m³</th><th class="num">Kol.</th></tr></thead><tbody>` +
      rows.map((r) => `<tr class="clickable ${hidden.has(r.id) ? "off" : ""}" data-id="${r.id}"><td>${r.id}</td>
        <td>${esc(r.name)}<div class="small muted">${esc(r.so)} · km ${km(r.km)} · ${esc(r.author)}</div></td>
        <td><span class="swatch" style="display:inline-block;background:${state.typeColor[r.volume_type]}"></span> ${esc(r.volume_type_name)}</td>
        <td class="num">${nf(r.volume_m3)}</td>
        <td class="num">${r.collision_count ? `<span class="pill red">${r.collision_count}</span>` : "0"}</td></tr>`).join("") +
      `</tbody></table>` : "");
    $("#results").querySelectorAll("tr[data-id]").forEach((tr) =>
      tr.addEventListener("click", () => showVolume(Number(tr.dataset.id), false)));
    if (fc.features.length) map.fitBounds(volLayer.getBounds().pad(0.1), FIT);
  } catch (err) {
    toast(err.message, "err");
  }
});
$("#search-form").addEventListener("reset", () => setTimeout(() => loadVolumes(), 0));

// ------------------------------------------------------------------ karta Export
formatButtons($("#export-all"), (fmt) => `/export/all?fmt=${fmt}`);
formatButtons($("#export-so-buttons"), (fmt) => `/export/so?so=${encodeURIComponent($("#export-so").value)}&fmt=${fmt}`);

// ------------------------------------------------------------------ štart
// vzorový DXF jedným klikom (funguje so serverom aj v statickej ukážke)
$("#load-sample").addEventListener("click", async () => {
  try {
    const blob = await (await fetch("samples/novy_objem_sandbox.dxf")).blob();
    uploadFile(new File([blob], "novy_objem_sandbox.dxf"));
  } catch (e) {
    toast(`Vzor sa nepodarilo načítať: ${e.message}`, "err");
  }
});

(async () => {
  try {
    if (DEMO) await DEMO.ready;
    await refreshAll();
    addLegend();
    const fitAll = () => {
      map.invalidateSize();
      if (state.meta.bounds) map.fitBounds(state.meta.bounds, { padding: [20, 20] });
      else map.setView([49.2, 18.74], 13);
    };
    fitAll();
    // v rámci (napr. náhľad na claude.ai) môže mať mapa pri štarte ešte nulovú veľkosť
    setTimeout(() => { if (!cut.on && !state.selected) fitAll(); }, 400);
  } catch (e) {
    msg($("#upload-msg"), `Nepodarilo sa načítať dáta: ${esc(e.message)}`, "err");
    map.setView([49.2, 18.74], 13);
  }
})();
