// LaunchScope dashboard: renders window.RADAR (written by main.ts) with no network.
//
// Routes, all in the hash so a view is a link:
//   #/                  the full board
//   #/detail/<slug>     one protocol's detail view above the board
//   #/filter/<category> the board filtered to a category
// The search box, chain picker, watchlist toggle and sort all filter live.

(function () {
  'use strict';

  var data = window.RADAR;
  if (!data || !Array.isArray(data.rows)) {
    document.getElementById('meta').textContent = 'No radar data loaded.';
    return;
  }

  var rows = data.rows;
  var meta = data.meta;

  var $ = function (id) { return document.getElementById(id); };
  var qEl = $('q'), catEl = $('cat'), chainEl = $('chain'), sortEl = $('sort');
  var watchEl = $('watch'), statsEl = $('stats'), bodyEl = $('rows');
  var detailEl = $('detail'), emptyEl = $('empty');

  function money(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + String(Math.round(n));
  }

  function moneyFull(n) {
    return '$' + Math.round(n).toLocaleString('en-US');
  }

  function signedPct(n) {
    if (n === null || n === undefined) return '—';
    var s = (n > 0 ? '+' : '') + n.toFixed(1) + '%';
    return s;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function yearsListed(row) {
    if (!row.listed_at) return '—';
    var days = (Date.parse(meta.as_of + 'T00:00:00Z') - Date.parse(row.listed_at + 'T00:00:00Z')) / 86400000;
    if (days < 365) return Math.max(0, Math.round(days / 30)) + ' mo';
    return (days / 365.25).toFixed(1) + ' yr';
  }

  // -- header ---------------------------------------------------------------
  var top = rows[0];
  $('meta').innerHTML =
    'Snapshot <b>' + esc(meta.as_of) + '</b> · ' + rows.length + ' pre-token protocols<br>' +
    'Watchlist <b>' + meta.watchlist_size + '</b> · live comps <b>' + meta.live_size + '</b> · global multiple <b>' +
    meta.global_multiple.toFixed(3) + '×</b><br>' +
    'Top launch: <b>' + esc(top.name) + ' ' + money(top.implied_value_usd) + '</b>';

  // -- filter options --------------------------------------------------------
  var cats = [], chains = [];
  rows.forEach(function (r) {
    if (cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort();
  chains.sort();
  cats.forEach(function (c) { catEl.add(new Option(c, c)); });
  chains.forEach(function (c) { chainEl.add(new Option(c, c)); });

  function currentFilter() {
    return {
      q: qEl.value.trim().toLowerCase(),
      cat: catEl.value,
      chain: chainEl.value,
      watch: watchEl.checked,
      sort: sortEl.value,
    };
  }

  function filtered() {
    var f = currentFilter();
    var list = rows.filter(function (r) {
      if (f.watch && !r.on_watchlist) return false;
      if (f.cat && r.category !== f.cat) return false;
      if (f.chain && r.chains.indexOf(f.chain) < 0) return false;
      if (f.q && (r.name.toLowerCase().indexOf(f.q) < 0 && r.slug.indexOf(f.q) < 0)) return false;
      return true;
    });
    if (f.sort === 'tvl') list.sort(function (a, b) { return b.tvl_usd - a.tvl_usd; });
    else if (f.sort === 'growth') list.sort(function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); });
    else if (f.sort === 'age') list.sort(function (a, b) { return (a.listed_at || '9999') < (b.listed_at || '9999') ? -1 : 1; });
    else list.sort(function (a, b) { return b.implied_value_usd - a.implied_value_usd; });
    return list;
  }

  function changeClass(n) {
    if (n === null || n === undefined) return 'flat';
    return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  }

  // -- board -----------------------------------------------------------------
  var selectedSlug = null;

  function renderBoard() {
    var list = filtered();
    var total = list.reduce(function (s, r) { return s + r.implied_value_usd; }, 0);
    statsEl.innerHTML = 'Showing <b>' + list.length + '</b> of ' + rows.length +
      ' pre-token protocols · combined implied value <b>' + money(total) + '</b>';
    emptyEl.hidden = list.length > 0;
    var html = '';
    list.forEach(function (r) {
      html += '<tr data-slug="' + esc(r.slug) + '"' + (r.slug === selectedSlug ? ' class="selected"' : '') + '>' +
        '<td class="num rank">' + r.rank + '</td>' +
        '<td><span class="name">' + esc(r.name) +
        (r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : '') +
        '<span class="slug">' + esc(r.slug) + '</span></span></td>' +
        '<td class="cat">' + esc(r.category) + '</td>' +
        '<td class="chains">' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num ' + changeClass(r.change_7d) + '">' + signedPct(r.change_7d) + '</td>' +
        '<td class="num value">' + money(r.implied_value_usd) + '</td>' +
        '<td class="num mult">' + r.multiple.toFixed(2) + '×</td>' +
        '</tr>';
    });
    bodyEl.innerHTML = html;
  }

  // -- detail ----------------------------------------------------------------
  function renderDetail(slug) {
    var r = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].slug === slug) { r = rows[i]; break; }
    }
    selectedSlug = r ? r.slug : null;
    if (!r) {
      detailEl.hidden = true;
      detailEl.innerHTML = '';
      return;
    }
    var comp = null;
    meta.comps.forEach(function (c) { if (c.category === r.category) comp = c; });
    var compLine = comp
      ? (comp.comps === 1 ? '1 live ' + r.category + ' comp' : comp.comps + ' live ' + r.category + ' comps') + ', median ' + comp.median_multiple.toFixed(3) + '×'
      : 'no live ' + r.category + ' comps, global median used';
    var growthLine = r.change_7d === null
      ? 'no 7-day change reported, factor 1.00'
      : '7-day TVL ' + signedPct(r.change_7d) + ' (clamped to -50%..+100%), factor ' + r.growth_factor.toFixed(3);
    var ageLine = r.listed_at === null
      ? 'no listing date reported, factor 1.00'
      : 'listed ' + r.listed_at + ' (' + yearsListed(r) + ' untokenised), factor ' + r.age_factor.toFixed(3);
    var working =
      moneyFull(r.tvl_usd) + ' TVL × ' + r.multiple.toFixed(3) + '× multiple = ' + moneyFull(r.tvl_usd * r.multiple) + '\n' +
      '× ' + r.growth_factor.toFixed(3) + ' growth  × ' + r.age_factor.toFixed(3) + ' age  =  ' + moneyFull(r.implied_value_usd);
    var steps = r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
    detailEl.innerHTML =
      '<p class="crumbs"><button type="button" id="back">← Board</button> · detail · ' + esc(r.slug) + '</p>' +
      '<h2>' + esc(r.name) + '<span class="slug">' + esc(r.slug) + '</span>' +
      (r.on_watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '</h2>' +
      '<p class="sub">' + esc(r.category) + ' · ' + esc(r.chains.join(', ')) +
      (r.listed_at ? ' · tracked since ' + esc(r.listed_at) : '') + '</p>' +
      '<div class="grid">' +
      '<div class="cell"><div class="k">Implied value</div><div class="v">' + moneyFull(r.implied_value_usd) + '</div></div>' +
      '<div class="cell"><div class="k">TVL</div><div class="v">' + moneyFull(r.tvl_usd) + '</div></div>' +
      '<div class="cell"><div class="k">7-day change</div><div class="v">' + signedPct(r.change_7d) + '</div></div>' +
      '<div class="cell"><div class="k">Untokenised for</div><div class="v">' + yearsListed(r) + '</div></div>' +
      '</div>' +
      '<h3>Why this value</h3>' +
      '<p class="working"><b>' + esc(compLine) + '</b> → multiple ' + r.multiple.toFixed(3) + '×\n' +
      esc(growthLine) + '\n' + esc(ageLine) + '\n' + esc(working) + '</p>' +
      '<h3>How to farm it — ' + r.farm_steps.length + ' steps</h3>' +
      '<ol class="steps">' + steps + '</ol>' +
      '<p class="note">Implied value is this entry&rsquo;s claim from the snapshot, not a prediction that ' +
      esc(r.name) + ' will issue a token, or at this price. &ldquo;Records no token&rdquo; means the snapshot carries no token for it.</p>';
    detailEl.hidden = false;
    $('back').addEventListener('click', function () { location.hash = '#/'; });
  }

  // -- routing ---------------------------------------------------------------
  function applyHash() {
    var hash = location.hash || '#/';
    var m = hash.match(/^#\/detail\/([A-Za-z0-9._-]+)$/);
    if (m) {
      renderDetail(m[1]);
    } else {
      var f = hash.match(/^#\/filter\/(.+)$/);
      if (f) {
        var cat = decodeURIComponent(f[1]);
        var found = false;
        for (var i = 0; i < catEl.options.length; i++) {
          if (catEl.options[i].value === cat) { found = true; break; }
        }
        if (found) catEl.value = cat;
      }
      renderDetail(null);
    }
    renderBoard();
    if (m) detailEl.scrollIntoView();
  }

  // -- events ------------------------------------------------------------------
  bodyEl.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) location.hash = '#/detail/' + tr.getAttribute('data-slug');
  });
  [qEl, catEl, chainEl, sortEl, watchEl].forEach(function (el) {
    el.addEventListener('input', renderBoard);
    el.addEventListener('change', renderBoard);
  });
  $('reset').addEventListener('click', function () {
    qEl.value = ''; catEl.value = ''; chainEl.value = ''; sortEl.value = 'value'; watchEl.checked = false;
    location.hash = '#/';
    renderBoard();
  });
  window.addEventListener('hashchange', applyHash);

  applyHash();
})();
