'use strict';
/* ВетХаб — агрегатор живых JSON-источников vet-экосистемы.
   Данных своих не производит: меты/прогнозы считает каждый тул в своём репо,
   хаб только читает и показывает. Все источники отдают CORS *. */

const PAGES = 'https://shray77.github.io/';
const RAW = 'https://raw.githubusercontent.com/shray77/';
const SOURCES = {
  meteo: { url: RAW   + 'vet-meteo/main/data/latest.json',          label: 'Метео' },
  flu:   { url: PAGES + 'vetflu-site/data/model.json',              label: 'ВПГП' },
  heat:  { url: PAGES + 'vet-heatmap/data/outbreaks.json',          label: 'Хитмап' },
  fc:    { url: PAGES + 'vetflu-forecast/data/forecast.json',       label: 'TimesFM' },
  retro: { url: PAGES + 'vetflu-forecast/data/retrospective.json',  label: 'Ретро' },
  tsp:   { url: RAW   + 'vet-pilots/main/tspulse/latest.json',       label: 'Аномалия' },
};
const S  = {};  // распарсенные данные
const ST = {};  // {status: 'load'|'ok'|'err', ts: Date}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m]));
const nowMsk = () => new Date().toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const fmtD = (iso) => { // '2026-10-13' или ISO-штамп → '13.10'
  if (!iso) return '—';
  const d = iso.slice(0, 10).split('-');
  return d.length === 3 ? `${d[2]}.${d[1]}` : iso;
};
const fmtMsk = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
};
const rampR = (v) => v >= 75 ? '#f87171' : v >= 45 ? '#fbbf24' : '#34d399';
/* THI-шкала синхронизирована с витриной vet-meteo (StationColor.ts): 68/72/80/90,
   цвета байт-в-байт те же — обе карты читаются одинаково. */
const rampThi = (v) => v == null || !Number.isFinite(v) ? '#8a8a6a' : v < 68 ? '#5f9e5f' : v < 72 ? '#a8b845' : v < 80 ? '#e0a636' : v < 90 ? '#d95f2b' : '#c0392b';
/* Метки THI — как в thi.ts vet-meteo (нет стресса/лёгкий/умеренный/тяжёлый/критический). */
const thiLevel = (v) => v == null || !Number.isFinite(v) ? '<span class="lv na">—</span>' :
  v < 68 ? '<span class="lv ok">нет стресса</span>' :
  v < 72 ? '<span class="lv mild">лёгкий</span>' :
  v < 80 ? '<span class="lv watch">умеренный</span>' :
  v < 90 ? '<span class="lv stress">тяжёлый</span>' :
  '<span class="lv alert">критический</span>';
/* CCI (Comprehensive Climate Index, Mader 2010 err. 2011) — комфорт в °C: -10..30 термонейтрально,
   >=30 жара-осторожно, >=40 опасная жара, <=-10 холод-осторожно, <=-30 опасный холод (OK Mesonet 2016) */
const cciZone = (v) => v == null ? null :
  v >= 40 ? { tx: 'опасная жара', cls: 'alert' } :
  v >= 30 ? { tx: 'жара · осторожно', cls: 'watch' } :
  v <= -30 ? { tx: 'опасный холод', cls: 'alert' } :
  v <= -10 ? { tx: 'холод · осторожно', cls: 'watch' } :
  { tx: 'комфорт', cls: 'ok' };
const rampCci = (v) => v >= 40 ? '#f87171' : v >= 30 ? '#fb923c' : v <= -30 ? '#60a5fa' : v <= -10 ? '#93c5fd' : '#34d399';
const CHAN = { transit: 'M·транзит', colonial: 'C·колонии', wintering: 'Z·зимовки' };

/* ── загрузка ─────────────────────────────────────────────── */

async function loadSource(key) {
  ST[key] = { status: 'load', ts: ST[key]?.ts };
  renderChips();
  const bust = (SOURCES[key].url.includes('?') ? '&' : '?') + '_=' + Date.now();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(SOURCES[key].url + bust, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    S[key] = await r.json();
    ST[key] = { status: 'ok', ts: new Date() };
  } catch (e) {
    ST[key] = { status: 'err', ts: ST[key]?.ts };
    console.warn('[vethub]', key, e.message);
  }
}

async function loadAll() {
  $('refreshBtn').classList.add('spin');
  await Promise.allSettled(Object.keys(SOURCES).map(loadSource));
  $('refreshBtn').classList.remove('spin');
  $('globalUpd').textContent = 'обновлено ' + nowMsk();
  renderOverview();
  if (mapInited) refreshMapLayers();
  if (fcBuilt) { renderVerdicts(); showSeries(curKey); }
}

/* ── чипы источников в шапке ─────────────────────────────── */

function renderChips() {
  $('srcChips').innerHTML = Object.keys(SOURCES).map(k => {
    const st = ST[k]?.status || 'load';
    const cls = st === 'ok' ? 'ok' : st === 'err' ? 'err' : '';
    return `<span class="chip ${cls}" title="${esc(SOURCES[k].label)}: ${st}"><span class="dot"></span>${esc(SOURCES[k].label)}</span>`;
  }).join('');
}

/* ── Сводка ──────────────────────────────────────────────── */

const stub = (id) => `<div class="skeleton">источник недоступен · повторите «обновить»</div>`;

function renderOverview() {
  renderMeteo(); renderAnomaly(); renderBrd(); renderFlu(); renderHeat(); renderFc(); renderRetro(); renderFeed(); renderSrcTable();
}

function renderMeteo() {
  const el = $('c-meteo');
  if (!S.meteo?.stations?.length) { el.innerHTML = `<h3>Метео · Ростовская обл.<span class="src">vet-meteo</span></h3>` + stub(); return; }
  const st = S.meteo.stations;
  const mx = st.reduce((a, b) => (b.thi > a.thi ? b : a));
  const n72 = st.filter(s => s.thi >= 72).length;
  const tvals = st.map(s => s.t).filter(Number.isFinite);
  const tmin = tvals.length ? Math.min(...tvals) : null, tmax = tvals.length ? Math.max(...tvals) : null;
  const lv = thiLevel(mx.thi);
  /* CCI: станция с максимальным отклонением от термонейтральной зоны */
  const stc = st.filter(s => s.cci != null);
  let cciLine = '';
  if (stc.length) {
    const cciworst = stc.reduce((a, b) => (Math.abs(b.cci - 10) > Math.abs(a.cci - 10) ? b : a));
    const z = cciZone(cciworst.cci);
    const out = stc.filter(s => (s.cci >= 30 || s.cci <= -10)).length;
    cciLine = `<div class="sub">CCI <b style="color:${rampCci(cciworst.cci)}">${cciworst.cci > 0 ? '+' : ''}${cciworst.cci.toFixed(1)}°C</b> · ${esc(cciworst.name)} <span class="lv ${z.cls}">${z.tx}</span> · вне комфорта: <b>${out}/${stc.length}</b></div>`;
  }
  el.innerHTML = `<h3>Метео · Ростовская обл.<span class="src">vet-meteo</span></h3>
    <div class="big">${mx.thi.toFixed(0)} <small>THI max · ${esc(mx.name)}</small></div>
    <div class="sub">${lv} · станций THI≥72: <b>${n72}/${st.length}</b> · t ${tmin == null ? '—' : tmin.toFixed(0)}…${tmax == null ? '—' : tmax.toFixed(0)}°C</div>
    ${cciLine}
    <div class="sub" style="color:var(--faint)">срез ${fmtMsk(S.meteo.generatedAt)} МСК</div>`;
}

function renderAnomaly() {
  const el = $('c-tsp');
  if (!el) return;
  if (!S.tsp?.week) { el.innerHTML = `<h3>Аномалия недели · вспышки<span class="src">TSPulse</span></h3>` + stub(); return; }
  const wk = S.tsp.week;
  const lvl = wk.verdict === 'аномалия' ? 'alert' : wk.verdict === 'повышенный фон' ? 'watch' : 'ok';
  const dis = Object.entries(S.tsp.week_diseases || {}).slice(0, 3)
    .map(([k, v]) => `${esc(k)} (${v})`).join(' · ');
  const top = S.tsp.recent_anomalies_90d?.[0];
  el.innerHTML = `<h3>Аномалия недели · вспышки<span class="src">TSPulse</span></h3>
    <div class="sub" style="margin:2px 0 6px"><span class="lv ${lvl}">${esc(wk.verdict)}</span> · неделя ${fmtD(wk.window[0])}–${fmtD(wk.window[1])}</div>
    <div class="sub">${esc(wk.note)}</div>
    ${dis ? `<div class="sub" style="color:var(--faint)">за неделю: ${dis}</div>` : ''}
    ${top ? `<div class="sub" style="color:var(--faint)">локальный пик 90д: ${fmtD(top.date)} · score ${top.score}</div>` : ''}
    <div class="sub" style="color:var(--faint)">шкала 0–1, порог 0.6 · <a href="https://github.com/shray77/vet-pilots/blob/main/tspulse/chart.png" target="_blank" rel="noopener">график</a></div>`;
}

function renderBrd() {
  const el = $('c-brd');
  if (!S.meteo?.stations?.length) { el.innerHTML = `<h3>Респираторный индекс BRD<span class="src">vet-meteo</span></h3>` + stub(); return; }
  const st = S.meteo.stations.filter(s => s.brd != null);
  if (!st.length) { el.innerHTML = `<h3>Респираторный индекс BRD<span class="src">vet-meteo</span></h3><div class="sub">нет данных BRD в срезе</div>`; return; }
  const mx = st.reduce((a, b) => (b.brd > a.brd ? b : a));
  const lv = mx.brd >= 75 ? '<span class="lv alert">триггер ≥75</span>' : mx.brd >= 50 ? '<span class="lv watch">внимание</span>' : '<span class="lv ok">низкий</span>';
  el.innerHTML = `<h3>Респираторный индекс BRD<span class="src">vet-meteo</span></h3>
    <div class="big">${mx.brd.toFixed(0)} <small>max · ${esc(mx.name)}</small></div>
    <div class="sub">${lv} · риск БРД КРС по погоде (ветер, осадки, перепады)</div>`;
}

function renderFlu() {
  const el = $('c-flu');
  if (!S.flu?.flyways?.length) { el.innerHTML = `<h3>ВПГП · окна риска<span class="src">vetflu-site</span></h3>` + stub(); return; }
  const fws = S.flu.flyways, ser = S.flu.series;
  const al = S.flu.alert || {};
  const lvl = al.level === 'alert' ? 'alert' : al.level === 'watch' ? 'watch' : 'ok';
  const lvlTx = al.level === 'alert' ? 'окно риска' : al.level === 'watch' ? 'наблюдение' : 'фон';
  const rows = fws.map(fw => {
    const weeks = ser?.[fw.id]?.weeks || [];
    const cur = [...weeks].reverse().find(w => w.r != null);
    const r = cur ? cur.r : null;
    const chan = cur ? (CHAN[cur.chan] || cur.chan) : 'вне окна';
    return `<div class="fwrow" title="${esc(fw.label)}${cur?.ph_r ? ' · ' + esc(cur.ph_r) : ''}">
      <span class="fwdot" style="background:${esc(fw.color || '#888')}"></span>
      <span class="fwname">${esc(fw.short || fw.label)}</span>
      <span class="fwchan">${esc(chan)}</span>
      <span class="fwr" style="color:${r != null ? rampR(r) : 'var(--faint)'}">${r ?? '—'}</span></div>`;
  }).join('');
  el.innerHTML = `<h3>ВПГП · окна риска<span class="src">vetflu-site</span></h3>
    <div class="sub" style="margin:0 0 6px">R-индекс заноса: <span class="lv ${lvl}">${lvlTx}${al.max_r != null ? ' · max R=' + al.max_r : ''}</span></div>
    ${rows}
    <div class="sub" style="color:var(--faint)">M/C/Z × погода × фон вспышек WAHIS</div>`;
}

function renderHeat() {
  const el = $('c-heat');
  const obs = S.heat?.outbreaks;
  if (!obs?.length) { el.innerHTML = `<h3>Заболевания РФ · хитмап<span class="src">vet-heatmap</span></h3>` + stub(); return; }
  const cut30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const recent = obs.filter(o => o.date >= cut30);
  const ongoing = recent.filter(o => o.status === 'Ongoing').length;
  const byDis = {};
  recent.forEach(o => { byDis[o.disease] = (byDis[o.disease] || 0) + 1; });
  const top = Object.entries(byDis).sort((a, b) => b[1] - a[1])[0];
  el.innerHTML = `<h3>Заболевания РФ · хитмап<span class="src">vet-heatmap</span></h3>
    <div class="big">${recent.length} <small>событий за 30 дней</small></div>
    <div class="sub">активных: <b>${ongoing}</b> · всего в базе: ${S.heat.total_outbreaks}${top ? ` · чаще: ${esc(top[0])} (${top[1]})` : ''}</div>
    <div class="sub" style="color:var(--faint)">WAHIS + ФСВПС · обновлено ${fmtD(S.heat.updated)}</div>`;
}

function renderFc() {
  const el = $('c-fc');
  const s0 = S.fc?.series?.[0];
  if (!s0?.forecast) { el.innerHTML = `<h3>Прогноз TimesFM 2.5 · ВПГП<span class="src">vetflu-forecast</span></h3>` + stub(); return; }
  const h = s0.history.values, f = s0.forecast;
  const last = h[h.length - 1], p4 = f.point[f.point.length - 1];
  const d = last ? (p4 / last - 1) * 100 : null;
  const arr = d == null ? '—' : d > 2 ? `↗ +${d.toFixed(0)}%` : d < -2 ? `↘ ${d.toFixed(0)}%` : `→ ${d >= 0 ? '+' : ''}${d.toFixed(0)}%`;
  el.innerHTML = `<h3>Прогноз TimesFM 2.5 · ВПГП<span class="src">vetflu-forecast</span></h3>
    <div class="big">${p4.toFixed(1)} <small>событий/нед к ${fmtD(f.weeks[f.weeks.length - 1])}</small></div>
    <div class="sub">${arr} к текущему уровню (${last.toFixed(1)}) · коридор q10–q90: ${f.q10[f.q10.length - 1].toFixed(1)}–${f.q90[f.q90.length - 1].toFixed(1)}</div>
    <div class="sub" style="color:var(--faint)">${esc(S.fc.model?.repo || '')} · ревизия ${esc(S.fc.model?.revision || '')}</div>`;
}

function renderRetro() {
  const el = $('c-retro');
  if (!S.retro?.panels?.length) { el.innerHTML = `<h3>Ретроспектива модели<span class="src">vetflu-forecast</span></h3>` + stub(); return; }
  const rows = S.retro.panels.map(p => {
    const v = p.verdict || {};
    const good = v.status === 'value', cls = good ? 'ok' : 'watch';
    const skill = v.skill != null ? (v.skill > 0 ? '+' : '') + (v.skill * 100).toFixed(0) + '% MASE' : '—';
    return `<div class="vrow"><span class="lbl" title="${esc(p.title)}">${esc(p.label)} · h=${p.h}:</span>
      <span class="lv ${cls}">${good ? 'польза' : 'паритет'} ${skill}</span></div>`;
  }).join('');
  el.innerHTML = `<h3>Ретроспектива модели<span class="src">vetflu-forecast</span></h3>${rows}
    <div class="sub" style="color:var(--faint)">rolling-origin против бейзлайнов · честный вердикт: на M4 польза есть, на сырых счётчиках — паритет</div>`;
}

function renderFeed() {
  const el = $('feedBody');
  const obs = S.heat?.outbreaks;
  if (!obs?.length) { el.innerHTML = stub(); $('feedSrc').textContent = ''; return; }
  $('feedSrc').textContent = 'vet-heatmap · ' + fmtD(S.heat.updated);
  const rows = [...obs].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 8).map(o =>
    `<tr><td class="d">${fmtD(o.date)}</td><td>${esc(o.disease)}<div style="color:var(--faint);font-size:11.5px">${esc(o.region || '')} · ${esc(o.federal_district || '')}</div></td>
     <td><span class="st ${o.status === 'Ongoing' ? 'on' : 'res'}">${o.status === 'Ongoing' ? 'активна' : 'завершена'}</span></td>
     <td>${o.source_url ? `<a href="${esc(o.source_url)}" target="_blank" rel="noopener">↗</a>` : ''}</td></tr>`).join('');
  el.innerHTML = `<table class="feed"><thead><tr><th>дата</th><th>болезнь · регион</th><th>статус</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderSrcTable() {
  const el = $('srcTable');
  el.innerHTML = Object.keys(SOURCES).map(k => {
    const st = ST[k] || {};
    const dot = st.status === 'ok' ? 'var(--accent)' : st.status === 'err' ? 'var(--err)' : 'var(--faint)';
    const ts = st.status === 'ok' ? fmtMsk(st.ts?.toISOString?.()) : st.status === 'err' ? 'нет связи' : '…';
    return `<div class="vrow"><span class="lbl">${esc(SOURCES[k].label)}</span>
      <span style="margin-left:auto"><span class="dot" style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${dot}"></span></span>
      <span class="val" style="color:var(--faint);font-size:11.5px">${ts}</span></div>`;
  }).join('') + `<div class="sub" style="color:var(--faint);margin-top:8px">автообновление каждые 5 минут · timeout 20 c</div>`;
}

/* ── Карта ───────────────────────────────────────────────── */

let map = null, mapInited = false;
const layers = { heat: null, flu: null, meteo: null };

function initMap() {
  if (mapInited) return;
  mapInited = true;
  map = L.map('map', { center: [56, 55], zoom: 3, minZoom: 2, worldCopyJump: true });
  map.attributionControl.setPrefix('');
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, attribution: 'Esri Dark Gray · данные: WAHIS, ФСВПС, Open-Meteo'
  }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, opacity: .7
  }).addTo(map);
  layers.flu = L.layerGroup().addTo(map);
  layers.heat = L.layerGroup().addTo(map);
  layers.meteo = L.layerGroup().addTo(map);
  [['lyHeat', 'heat'], ['lyFlu', 'flu'], ['lyMeteo', 'meteo']].forEach(([id, key]) => {
    $(id).addEventListener('change', e => {
      if (e.target.checked) { refreshMapLayers(); map.addLayer(layers[key]); }
      else map.removeLayer(layers[key]);
    });
  });
  $('heatPeriod').addEventListener('change', refreshMapLayers);
  setTimeout(() => { map.invalidateSize(); refreshMapLayers(); }, 150);
}

function refreshMapLayers() {
  if (!mapInited) return;
  updateHeatLayer(); updateFluLayer(); updateMeteoLayer();
}

function updateHeatLayer() {
  layers.heat.clearLayers();
  const obs = S.heat?.outbreaks || [];
  const days = +$('heatPeriod').value;
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const colByGroup = { Birds: '#f87171', Ruminant: '#93c5fd', Swine: '#f472b6' };
  let n = 0;
  [...obs].sort((a, b) => (a.date || '').localeCompare(b.date || '')).forEach(o => {
    if (!o.lat || !o.lon || (o.date || '') < cutoff) return;
    n++;
    const c = colByGroup[o.disease_group] || '#9ca3af';
    const m = L.circleMarker([o.lat, o.lon], {
      radius: 4, color: '#0b0e14', weight: .8, fillColor: c, fillOpacity: o.status === 'Ongoing' ? .95 : .5
    });
    m.bindPopup(`<b>${esc(o.disease)}</b><br>${esc(o.region || '')} · ${esc(o.federal_district || '')}<br>${fmtD(o.date)} · ${o.status === 'Ongoing' ? '<span class="ph">активна</span>' : 'завершена'}<br>источник: ${esc(o.source || '')}${o.source_url ? ` · <a href="${esc(o.source_url)}" target="_blank" rel="noopener">событие ↗</a>` : ''}`);
    m.addTo(layers.heat);
  });
  $('heatCnt').textContent = `показано ${n} из ${obs.length}`;
}

function updateFluLayer() {
  layers.flu.clearLayers();
  if (!S.flu?.flyways) return;
  const ser = S.flu.series;
  S.flu.flyways.forEach(fw => {
    if (Array.isArray(fw.path) && fw.path.length > 1) {
      L.polyline(fw.path, { color: fw.color || '#888', weight: 2, opacity: .65, dashArray: '7 7' })
        .bindTooltip(`<b>${esc(fw.label)}</b>`, { sticky: true })
        .addTo(layers.flu);
    }
    const nodes = S.flu.nodes?.[fw.id] || [];
    nodes.forEach(nd => {
      if (nd.lat == null) return;
      const r = nd.r ?? 0;
      L.circleMarker([nd.lat, nd.lon], {
        radius: 5 + r / 9, color: '#0b0e14', weight: 1.6,
        fillColor: rampR(r), fillOpacity: .88
      }).bindPopup(`<b>${esc(nd.name)}</b> · ${esc(fw.short || fw.label)}<br>
        R узла: <b>${nd.r ?? '—'}</b> · ${esc(CHAN[nd.chan] || nd.chan || '')}<br>
        MW=${nd.mw != null ? nd.mw.toFixed(2) : '—'} · MB=${nd.mb != null ? nd.mb.toFixed(2) : '—'}<br>
        ${nd.colony ? 'колония · ' : ''}${nd.wintering ? 'зимовка' : ''}`).addTo(layers.flu);
    });
  });
}

function updateMeteoLayer() {
  layers.meteo.clearLayers();
  const st = S.meteo?.stations || [];
  st.forEach(s => {
    if (s.lat == null) return;
    L.circleMarker([s.lat, s.lon], {
      radius: 6.5, color: '#0b0e14', weight: 1.5, fillColor: rampThi(s.thi), fillOpacity: .9
    }).bindPopup(`<b>${esc(s.name)}</b><br>t=${esc(s.t ?? '—')}°C · RH=${esc(s.rh ?? '—')}% · ветер ${esc(s.wind ?? '—')} м/с<br>
      THI=<b>${esc(s.thi ?? '—')}</b> · THIadj=${esc(s.thiAdj ?? '—')}<br>THI max 7д: ${esc(s.thiMax7 ?? '—')} · BRD=${esc(s.brd ?? '—')}<br>
      CCI=<b style="color:${rampCci(s.cci)}">${esc(s.cci ?? '—')}</b> · ${esc(cciZone(s.cci)?.tx || '—')}<br>
      <span style="color:var(--faint)">${esc(s.source || '')}</span>`).addTo(layers.meteo);
  });
}

/* ── Прогноз TimesFM ─────────────────────────────────────── */

let fcChart = null, fcBuilt = false, curKey = 'global';

function renderVerdicts() {
  const el = $('verdicts');
  if (!S.retro?.panels?.length) { el.innerHTML = `<div class="verdict mid"><h4>Ретроспектива</h4><div class="tx">источник недоступен</div></div>`; return; }
  el.innerHTML = S.retro.panels.map(p => {
    const v = p.verdict || {};
    const good = v.status === 'value';
    const rows = [...(p.summary || [])].sort((a, b) => a.mase - b.mase).map(r =>
      `<span style="margin-right:10px;${r.model === 'timesfm' ? 'color:var(--text);font-weight:600' : 'color:var(--muted)'}">${esc(r.model)} ${r.mase.toFixed(3)}</span>`).join('');
    return `<div class="verdict ${good ? 'good' : 'mid'}">
      <h4>${esc(p.label)} · h=${p.h} · ${p.n_pairs} пар</h4>
      <div class="tx">${esc(v.text || '')}</div>
      <div class="mx">${rows}</div>
      <div class="mx">skill=${v.skill != null ? (v.skill * 100).toFixed(1) + '%' : '—'} · лучший бейзлайн: ${esc(v.best_baseline || '—')}</div>
    </div>`;
  }).join('');
}

function renderFcBar() {
  const el = $('fcBar');
  const ss = S.fc?.series || [];
  el.innerHTML = ss.map(s => `<button data-k="${esc(s.key)}" class="${s.key === curKey ? 'on' : ''}">${esc(s.label)}</button>`).join('');
  el.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    curKey = b.dataset.k;
    el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    showSeries(curKey);
  }));
}

const weekShort = (w) => { const e = (w || '').split('/')[1] || w || ''; const p = e.split('-'); return p.length === 3 ? `${p[2]}.${p[1]}` : e; };

function showSeries(key) {
  const s = (S.fc?.series || []).find(x => x.key === key) || S.fc?.series?.[0];
  if (!s) return;
  const H = 52;
  const hv = s.history.values.slice(-H), hw = s.history.weeks.slice(-H);
  const f = s.forecast;
  const labels = [...hw.map(weekShort), ...f.weeks.map(weekShort)];
  const pad = Array(H).fill(null);
  const c = $('fcChart').getContext('2d');
  if (fcChart) fcChart.destroy();
  fcChart = new Chart(c, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'q90', data: [...pad, ...f.q90], borderColor: 'transparent', pointRadius: 0, fill: false },
        { label: 'q10', data: [...pad, ...f.q10], borderColor: 'transparent', pointRadius: 0, fill: '-1', backgroundColor: 'rgba(251,191,36,.14)' },
        { label: 'факт', data: hv, borderColor: '#34d399', borderWidth: 2, pointRadius: 0, tension: .3 },
        { label: 'прогноз', data: [...pad, ...f.point], borderColor: '#fbbf24', borderDash: [5, 4], borderWidth: 2, pointRadius: 2.5, pointBackgroundColor: '#fbbf24' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { title: it => 'нед. ' + it[0].label } }
      },
      scales: {
        x: { ticks: { color: '#7e8899', maxTicksLimit: 11, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,.045)' } },
        y: { ticks: { color: '#93a0b4', font: { size: 11 } }, grid: { color: 'rgba(255,255,255,.045)' } }
      }
    }
  });
  const last = hv[hv.length - 1];
  $('fcTable').innerHTML = `<table class="fct"><thead><tr><th>горизонт</th><th>неделя</th><th>точечный прогноз</th><th>q10–q90</th><th>Δ к текущему</th></tr></thead><tbody>` +
    f.point.map((p, i) => `<tr><td>+${i + 1} нед</td><td>${esc(weekShort(f.weeks[i]))}</td><td><b>${p.toFixed(2)}</b></td>
      <td>${f.q10[i].toFixed(2)} – ${f.q90[i].toFixed(2)}</td>
      <td style="color:${p >= last ? 'var(--warn)' : 'var(--accent)'}">${p >= last ? '+' : ''}${((p / last - 1) * 100).toFixed(0)}%</td></tr>`).join('') +
    `</tbody></table>`;
  $('fcNote').innerHTML = `<b>Как читать:</b> факт — недельные события ВПГП (WOAH WAHIS) · пунктир — точечный прогноз TimesFM 2.5 · плашка — квантильный коридор q10–q90.
    Модель крутится в отдельном воркере <a href="https://github.com/shray77/vetflu-forecast" target="_blank" rel="noopener">vetflu-forecast</a> (GitHub Actions, CPU, веса в кэше), пересчёт — понедельник 06:00 UTC.
    Веса 2.5 — Apache-2.0. Ретроспектива выше: на типовых рядах модель даёт пользу, на сырых счётчиках событий — паритет с наивной; применяйте как ориентир, не как истину.`;
}

function buildForecast() {
  if (!S.fc) { $('fcBar').innerHTML = ''; $('fcNote').textContent = 'Источник прогноза недоступен — повторите «обновить».'; return; }
  fcBuilt = true;
  renderVerdicts(); renderFcBar(); showSeries(curKey);
}

/* ── Инструменты ─────────────────────────────────────────── */

document.querySelectorAll('[data-embed]').forEach(b => b.addEventListener('click', () => {
  const tool = b.closest('.tool');
  const f = tool.querySelector('iframe');
  if (f) { f.remove(); b.textContent = 'предпросмотр'; return; }
  const fr = document.createElement('iframe');
  fr.loading = 'lazy'; fr.src = b.dataset.embed; fr.title = 'предпросмотр';
  tool.appendChild(fr);
  b.textContent = 'скрыть предпросмотр';
}));

/* ── табы ────────────────────────────────────────────────── */

$('tabs').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
  $('tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + b.dataset.tab));
  if (b.dataset.tab === 'map') { initMap(); setTimeout(() => map?.invalidateSize(), 60); }
  if (b.dataset.tab === 'forecast') buildForecast();
}));

/* ── старт ───────────────────────────────────────────────── */

$('refreshBtn').addEventListener('click', loadAll);
renderChips();
loadAll();
setInterval(loadAll, 5 * 60 * 1000);
