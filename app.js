(() => {
  'use strict';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const STORAGE_KEY = 'recast-calc-v2';
  const now = new Date();
  const TODAY_IDX = now.getFullYear() * 12 + now.getMonth();

  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Dates are stored as a single month index: year * 12 + month (0-based).
  const toIdx = (y, m) => y * 12 + m;
  const fmtIdx = idx => `${MONTHS[idx % 12]} ${Math.floor(idx / 12)}`;
  const fmtSpan = months => {
    const y = Math.floor(months / 12), m = months % 12;
    const parts = [];
    if (y) parts.push(`${y} yr${y === 1 ? '' : 's'}`);
    if (m) parts.push(`${m} mo`);
    return parts.join(' ') || '0 mo';
  };

  // ---------- Calculation engine ----------

  function payment(P, r, n) {
    if (n <= 0) return P;
    if (r === 0) return P / n;
    return P * r / (1 - Math.pow(1 + r, -n));
  }

  // Merge lumps that fall in the same month; drop ones outside the loan window.
  function prepareLumps(loan, lumps) {
    const end = loan.start + loan.n;
    const byIdx = new Map();
    lumps.forEach((l, i) => {
      if (!(l.amount > 0)) return;
      const idx = toIdx(l.year, l.month);
      if (idx < loan.start || idx >= end) return;
      const cur = byIdx.get(idx) || { idx, amount: 0, rows: [] };
      cur.amount += l.amount;
      cur.rows.push(i);
      byIdx.set(idx, cur);
    });
    return byIdx;
  }

  // mode: 'none' | 'recast' | 'noRecast'. In 'recast' mode every lump sum triggers a recast costing `fee`.
  function simulate(loan, lumpMap, mode, fee = 0) {
    const r = loan.rate / 100 / 12;
    const n = loan.n;
    let bal = loan.principal;
    let pmt = payment(bal, r, n);
    const initialPayment = pmt;
    const rows = [];
    const events = [];
    let totalInterest = 0, totalLump = 0, totalFees = 0, lastK = 0;

    const applyLump = (k, idx) => {
      if (mode === 'none') return 0;
      const l = lumpMap.get(idx);
      if (!l || bal <= 0) return 0;
      const applied = Math.min(l.amount, bal);
      bal -= applied;
      if (bal < 0.005) bal = 0;
      totalLump += applied;
      const ev = { idx, requested: l.amount, applied, capped: applied < l.amount - 0.005, before: pmt, after: pmt, recast: false, fee: 0, balance: bal };
      if (mode === 'recast' && bal > 0 && k < n) {
        pmt = payment(bal, r, n - k);
        ev.after = pmt;
        ev.recast = true;
        ev.fee = fee;
        totalFees += fee;
      }
      events.push(ev);
      return applied;
    };

    // A lump paid in the start month lands before the first payment.
    applyLump(0, loan.start);

    for (let k = 1; k <= n && bal > 0; k++) {
      const idx = loan.start + k;
      const interest = bal * r;
      const principal = Math.min(pmt - interest, bal);
      bal -= principal;
      if (bal < 0.005) bal = 0;
      totalInterest += interest;
      const lump = applyLump(k, idx);
      rows.push({ k, idx, payment: interest + principal, interest, principal, lump, balance: bal });
      lastK = k;
    }

    return {
      mode, rows, events, initialPayment,
      finalPayment: pmt,
      totalInterest, totalLump, totalFees,
      payoffIdx: loan.start + lastK,
      months: lastK,
    };
  }

  function balanceAt(sim, loan, idx) {
    if (idx <= loan.start) return loan.principal;
    let bal = loan.principal;
    for (const row of sim.rows) {
      if (row.idx > idx) break;
      bal = row.balance;
    }
    return bal;
  }

  // ---------- State ----------

  const defaults = () => ({
    principal: 400000,
    rate: 6.5,
    years: 30,
    startMonth: 0,
    startYear: now.getFullYear() - 2,
    recastFee: 0,
    lumps: [{ amount: 25000, month: now.getMonth(), year: now.getFullYear() }],
    scheduleMode: 'recast',
  });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = Object.assign(defaults(), JSON.parse(raw));
        saved.lumps = (saved.lumps || []).map(({ amount, month, year }) => ({ amount, month, year }));
        return saved;
      }
    } catch (e) { /* storage unavailable */ }
    return defaults();
  }
  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  const loanFromState = () => ({
    principal: Math.max(0, +state.principal || 0),
    rate: Math.max(0, +state.rate || 0),
    n: Math.max(1, Math.round(+state.years || 1)) * 12,
    start: toIdx(+state.startYear, +state.startMonth),
  });

  // ---------- DOM ----------

  const $ = id => document.getElementById(id);
  const el = {
    principal: $('principal'), rate: $('rate'), years: $('years'), recastFee: $('recastFee'),
    startMonth: $('startMonth'), startYear: $('startYear'),
    currentBalance: $('currentBalance'),
    lumps: $('lumps'), lumpEmpty: $('lumpEmpty'), addLump: $('addLump'), tpl: $('lumpTpl'),
    compareBody: $('compareBody'), notices: $('notices'), timeline: $('timeline'),
    chart: $('chart'), schedule: $('schedule'), scheduleMode: $('scheduleMode'),
  };

  const fillMonths = sel => { sel.innerHTML = MONTHS_LONG.map((m, i) => `<option value="${i}">${m}</option>`).join(''); };
  const fillYears = (sel, from, to, desc) => {
    const keep = sel.value;
    const ys = [];
    for (let y = from; y <= to; y++) ys.push(y);
    if (desc) ys.reverse();
    sel.innerHTML = ys.map(y => `<option value="${y}">${y}</option>`).join('');
    if (keep && ys.includes(+keep)) sel.value = keep;
  };

  function initLoanInputs() {
    fillMonths(el.startMonth);
    fillYears(el.startYear, 1980, now.getFullYear() + 1, true);
    el.principal.value = state.principal;
    el.rate.value = state.rate;
    el.years.value = state.years;
    el.recastFee.value = state.recastFee;
    el.startMonth.value = state.startMonth;
    el.startYear.value = state.startYear;
    el.scheduleMode.value = state.scheduleMode;

    [['principal', 'principal'], ['rate', 'rate'], ['years', 'years'], ['startMonth', 'startMonth'], ['startYear', 'startYear'], ['recastFee', 'recastFee']]
      .forEach(([id, key]) => el[id].addEventListener('input', () => {
        state[key] = el[id].value === '' ? '' : +el[id].value;
        if (key === 'years' || key === 'startYear') refreshLumpYears();
        update();
      }));
    el.scheduleMode.addEventListener('change', () => { state.scheduleMode = el.scheduleMode.value; renderSchedule(lastSims); save(); });
    el.addLump.addEventListener('click', () => {
      const prev = state.lumps[state.lumps.length - 1];
      const loan = loanFromState();
      // Default the new payment to a year after the last one, or this month.
      const base = prev ? toIdx(prev.year, prev.month) + 12 : Math.max(TODAY_IDX, loan.start);
      const idx = Math.min(base, loan.start + loan.n - 1);
      state.lumps.push({ amount: 10000, month: idx % 12, year: Math.floor(idx / 12) });
      renderLumps();
      update();
      el.lumps.lastElementChild?.querySelector('[data-k="amount"]').focus();
    });
  }

  function lumpYearRange() {
    const loan = loanFromState();
    return [Math.floor(loan.start / 12), Math.floor((loan.start + loan.n) / 12)];
  }

  function refreshLumpYears() {
    const [from, to] = lumpYearRange();
    el.lumps.querySelectorAll('.lump').forEach((li, i) => {
      const sel = li.querySelector('[data-k="year"]');
      const l = state.lumps[i];
      fillYears(sel, Math.min(from, l.year), Math.max(to, l.year), false);
      sel.value = l.year;
    });
  }

  function renderLumps() {
    el.lumps.innerHTML = '';
    const [from, to] = lumpYearRange();
    state.lumps.forEach((l, i) => {
      const li = el.tpl.content.firstElementChild.cloneNode(true);
      const f = k => li.querySelector(`[data-k="${k}"]`);
      fillMonths(f('month'));
      fillYears(f('year'), Math.min(from, l.year), Math.max(to, l.year), false);
      f('amount').value = l.amount;
      f('month').value = l.month;
      f('year').value = l.year;

      li.addEventListener('input', e => {
        const k = e.target.dataset.k;
        if (!k) return;
        l[k] = e.target.value === '' ? '' : +e.target.value;
        update();
      });
      li.querySelector('.remove').addEventListener('click', () => {
        state.lumps.splice(i, 1);
        renderLumps();
        update();
      });
      el.lumps.appendChild(li);
    });
    el.lumpEmpty.hidden = state.lumps.length > 0;
  }

  // ---------- Render ----------

  let lastSims = null;

  function update() {
    save();
    const loan = loanFromState();
    const lumps = state.lumps.map(l => ({ amount: +l.amount || 0, month: +l.month, year: +l.year }));
    const lumpMap = prepareLumps(loan, lumps);
    const fee = Math.max(0, +state.recastFee || 0);
    const sims = {
      none: simulate(loan, lumpMap, 'none'),
      recast: simulate(loan, lumpMap, 'recast', fee),
      noRecast: simulate(loan, lumpMap, 'noRecast'),
    };
    lastSims = { ...sims, loan };

    const notices = validateLumps(loan, lumps, sims);
    renderCurrentBalance(loan, sims.none);
    renderCompare(loan, sims);
    renderNotices(notices);
    renderTimeline(sims.recast);
    renderChart(loan, sims);
    renderSchedule(lastSims);
  }

  function validateLumps(loan, lumps, sims) {
    const notices = [];
    const end = loan.start + loan.n;
    const seen = new Map();
    el.lumps.querySelectorAll('.lump').forEach((li, i) => {
      const l = lumps[i];
      const idx = toIdx(l.year, l.month);
      const warn = li.querySelector('.lump-warn');
      let msg = '';
      if (idx < loan.start) msg = 'This date is before the loan starts, so the payment is ignored.';
      else if (idx >= end) msg = 'This date is after the loan matures, so the payment is ignored.';
      else if (seen.has(idx)) msg = `This is the same month as payment #${seen.get(idx) + 1}. The two amounts are combined.`;
      else if (idx > sims.noRecast.payoffIdx && l.amount > 0) msg = 'In the Lump Sums scenario, the loan is already paid off by this date.';
      if (!seen.has(idx)) seen.set(idx, i);
      warn.textContent = msg;
      warn.hidden = !msg;
      li.querySelector('[data-k="year"]').setAttribute('aria-invalid', String(idx < loan.start || idx >= end));
    });
    for (const s of [sims.recast, sims.noRecast]) {
      for (const ev of s.events) {
        if (ev.capped) notices.push(`${fmtIdx(ev.idx)}: the payment of ${usd.format(ev.requested)} is more than the remaining balance, so only ${usd2.format(ev.applied)} was applied (${s.mode === 'recast' ? 'Recast' : 'Lump Sums'} scenario).`);
      }
    }
    return notices;
  }

  function renderCurrentBalance(loan, none) {
    if (TODAY_IDX <= loan.start) {
      el.currentBalance.innerHTML = `The loan hasn't started yet. Starting balance: <strong>${usd.format(loan.principal)}</strong>`;
      return;
    }
    const bal = balanceAt(none, loan, TODAY_IDX);
    el.currentBalance.innerHTML = `Scheduled balance as of ${fmtIdx(TODAY_IDX)}: <strong>${usd2.format(bal)}</strong>`;
  }

  function renderCompare(loan, sims) {
    const cols = [sims.none, sims.recast, sims.noRecast];
    const base = sims.none;
    const maxSaved = Math.max(...cols.map(c => base.totalInterest - c.totalInterest));
    const rows = [
      ['Starting monthly payment', c => usd2.format(c.initialPayment)],
      ['Monthly payment after lump sums', c => {
        const changed = Math.abs(c.finalPayment - c.initialPayment) > 0.005;
        return usd2.format(c.finalPayment) + (changed ? `<small>−${usd2.format(c.initialPayment - c.finalPayment)}/mo</small>` : '');
      }],
      ['Total lump sums applied', c => usd.format(c.totalLump)],
      ['Total interest', c => usd.format(c.totalInterest)],
      ['Interest saved', c => {
        const saved = base.totalInterest - c.totalInterest;
        const cls = saved > 0.5 && Math.abs(saved - maxSaved) < 0.5 ? ' class="best"' : '';
        return { html: usd.format(saved), attr: cls };
      }],
      ['Recast fees', c => usd.format(c.totalFees)],
      ['Payoff date', c => fmtIdx(c.payoffIdx)],
      ['Term shortened by', c => base.months - c.months > 0 ? fmtSpan(base.months - c.months) : '—'],
      ['Total paid (incl. lump sums & fees)', c => usd.format(loan.principal + c.totalInterest + c.totalFees)],
    ];
    el.compareBody.innerHTML = rows.map(([label, fn]) => `<tr><th scope="row">${label}</th>${cols.map(c => {
      const v = fn(c);
      return typeof v === 'object' ? `<td${v.attr}>${v.html}</td>` : `<td>${v}</td>`;
    }).join('')}</tr>`).join('');
  }

  function renderNotices(list) {
    el.notices.innerHTML = list.map(t => `<li>${t}</li>`).join('');
  }

  function renderTimeline(sim) {
    if (!sim.events.length) {
      el.timeline.innerHTML = '<li class="muted">Add a lump-sum payment to see how your monthly payment changes.</li>';
      return;
    }
    el.timeline.innerHTML = sim.events.map(ev => {
      const change = ev.recast
        ? `payment ${usd2.format(ev.before)} → <strong>${usd2.format(ev.after)}</strong>${ev.fee ? ` <span class="muted">(fee ${usd.format(ev.fee)})</span>` : ''}`
        : '<strong>loan paid off</strong>';
      return `<li><span class="date">${fmtIdx(ev.idx)}</span><span>${usd.format(ev.applied)} paid</span><span>→ ${change}</span><span class="muted">balance ${usd.format(ev.balance)}</span></li>`;
    }).join('');
  }

  function renderChart(loan, sims) {
    const W = 720, H = 260, pad = { l: 56, r: 12, t: 10, b: 26 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const maxY = loan.principal || 1;
    const x = k => pad.l + (k / loan.n) * iw;
    const y = v => pad.t + ih - (v / maxY) * ih;
    const path = sim => {
      let d = `M${x(0).toFixed(1)},${y(loan.principal).toFixed(1)}`;
      let prevBal = loan.principal;
      for (const r of sim.rows) {
        // A lump sum shows as a vertical drop.
        if (r.lump) d += `L${x(r.k).toFixed(1)},${y(prevBal - (r.principal)).toFixed(1)}`;
        d += `L${x(r.k).toFixed(1)},${y(r.balance).toFixed(1)}`;
        prevBal = r.balance;
      }
      return d;
    };
    const yTicks = [0, .25, .5, .75, 1].map(f => f * maxY);
    const yrs = loan.n / 12;
    const step = yrs <= 10 ? 1 : yrs <= 20 ? 2 : 5;
    const xTicks = [];
    for (let yr = 0; yr <= yrs; yr += step) xTicks.push(yr * 12);
    const short = v => v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${Math.round(v / 1000)}k`;
    el.chart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Remaining balance over time for each scenario">
      ${yTicks.map(v => `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`).join('')}
      ${xTicks.map(k => `<text class="axis" x="${x(k)}" y="${H - 6}" text-anchor="middle">${Math.floor((loan.start + k) / 12)}</text>`).join('')}
      <path class="l-none" d="${path(sims.none)}"/>
      <path class="l-recast" d="${path(sims.recast)}"/>
      <path class="l-norecast" d="${path(sims.noRecast)}"/>
    </svg>`;
  }

  function renderSchedule(s) {
    if (!s) return;
    const sim = s[state.scheduleMode] || s.recast;
    const years = new Map();
    for (const r of sim.rows) {
      const yr = Math.floor(r.idx / 12);
      if (!years.has(yr)) years.set(yr, []);
      years.get(yr).push(r);
    }
    const sum = (rows, k) => rows.reduce((a, r) => a + r[k], 0);
    let html = '<table><thead><tr><th>Date</th><th>Payment</th><th>Principal</th><th>Interest</th><th>Lump sum</th><th>Balance</th></tr></thead><tbody>';
    for (const [yr, rows] of years) {
      const hasLump = rows.some(r => r.lump);
      html += `<tr class="year${hasLump ? ' has-lump' : ''}" data-year="${yr}"><td>${yr}</td><td>${usd2.format(sum(rows, 'payment'))}</td><td>${usd2.format(sum(rows, 'principal'))}</td><td>${usd2.format(sum(rows, 'interest'))}</td><td>${hasLump ? usd2.format(sum(rows, 'lump')) : '—'}</td><td>${usd2.format(rows[rows.length - 1].balance)}</td></tr>`;
      for (const r of rows) {
        html += `<tr class="month${r.lump ? ' has-lump' : ''}" data-parent="${yr}" hidden><td>${fmtIdx(r.idx)}</td><td>${usd2.format(r.payment)}</td><td>${usd2.format(r.principal)}</td><td>${usd2.format(r.interest)}</td><td>${r.lump ? usd2.format(r.lump) : ''}</td><td>${usd2.format(r.balance)}</td></tr>`;
      }
    }
    html += '</tbody></table>';
    const open = new Set([...el.schedule.querySelectorAll('tr.year.open')].map(t => t.dataset.year));
    el.schedule.innerHTML = html;
    open.forEach(yr => toggleYear(yr, true));
  }

  function toggleYear(yr, force) {
    const head = el.schedule.querySelector(`tr.year[data-year="${yr}"]`);
    if (!head) return;
    const open = force ?? !head.classList.contains('open');
    head.classList.toggle('open', open);
    el.schedule.querySelectorAll(`tr.month[data-parent="${yr}"]`).forEach(tr => { tr.hidden = !open; });
  }
  el.schedule.addEventListener('click', e => {
    const tr = e.target.closest('tr.year');
    if (tr) toggleYear(tr.dataset.year);
  });

  // Exposed for quick console checks.
  window.recastCalc = { payment, simulate, prepareLumps };

  initLoanInputs();
  renderLumps();
  update();
})();
