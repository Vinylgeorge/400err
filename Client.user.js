// ==UserScript==
// @name         🔒 MTurk Earnings Report
// @namespace    ab2soft.secure
// @version      5.13
// @match        https://worker.mturk.com/earnings*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(async () => {
  'use strict';

  // -------------------------
  // Configuration
  // -------------------------
  const SHEET_CSV = 'https://docs.google.com/spreadsheets/d/1Ytmr7dHSAv69N27uZcrhKaEerL8WhzMCI02vugq_C_M/export?format=csv&gid=0';
  const FIREBASE_APP_JS = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
  const FIRESTORE_JS = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

  const FIREBASE_CFG = {
    apiKey: "AIzaSyCCtBCAJvQCDj8MXb2w90qYUqRrENIIGIQ",
    authDomain: "mturk-monitordeep.firebaseapp.com",
    projectId: "mturk-monitordeep",
    storageBucket: "mturk-monitordeep.firebasestorage.app",
    messagingSenderId: "58392297487",
    appId: "1:58392297487:web:1365ad12110ffd0586637a"
  };

  // SHA-256 hash of password
  const PASS_HASH_HEX = '9b724d9df97a91d297dc1c714a3987338ebb60a2a53311d2e382411a78b9e07d';

  // -------------------------
  // Helpers
  // -------------------------
  const sha256hex = async text => {
    const enc = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  };
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const safeJSONParse = s => { try { return JSON.parse(s.replace(/&quot;/g, '"')); } catch { return null; } };

  // -------------------------
  // Extractors
  // -------------------------
  function getWorkerId() {
    const el = $$('[data-react-props]').find(e => e.getAttribute('data-react-props')?.includes('textToCopy'));
    if (el) {
      const j = safeJSONParse(el.getAttribute('data-react-props'));
      if (j?.textToCopy) return j.textToCopy.trim();
    }
    return $('.me-bar .text-uppercase span')?.textContent.trim() || '';
  }

  function extractNextTransferInfo() {
    const strongTag = $$('strong').find(el => /transferred to your/i.test(el.textContent));
    let bankAccount = '', nextTransferDate = '';

    if (strongTag) {
      const bankLink =
        strongTag.querySelector("a[href*='direct_deposit']") ||
        strongTag.querySelector("a[href*='https://www.amazon.com/gp/css/gc/balance']");
      if (bankLink) {
        if (/amazon\.com/i.test(bankLink.href)) {
          bankAccount = 'Amazon Gift Card Balance';
        } else if (/direct_deposit/i.test(bankLink.href)) {
          bankAccount = bankLink.textContent.trim() || 'Bank Account';
        } else {
          bankAccount = bankLink.textContent.trim() || 'Other Method';
        }
      }

      const text = strongTag.textContent.replace(/\s+/g, ' ');
      const m = text.match(/on\s+([A-Za-z]{3,}\s+\d{1,2},\s+\d{4})\s+based/i);
      if (m) nextTransferDate = m[1].trim();
    }
    return { bankAccount, nextTransferDate };
  }

  function computeLastMonthEarnings(bodyData) {
    if (!Array.isArray(bodyData)) return '0.00';
    const now = new Date();
    const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startLastMonth = new Date(startThisMonth.getFullYear(), startThisMonth.getMonth() - 1, 1);
    const endLastMonth = new Date(startThisMonth.getFullYear(), startThisMonth.getMonth(), 0);
    endLastMonth.setHours(23, 59, 59, 999);

    let total = 0;
    for (const t of bodyData) {
      const ds = (t.requestedDate || '').trim();
      if (!ds) continue;
      const parts = ds.split('/');
      if (parts.length !== 3) continue;
      let [mm, dd, yy] = parts.map(p => parseInt(p, 10));
      if (Number.isNaN(mm) || Number.isNaN(dd) || Number.isNaN(yy)) continue;
      if (yy < 100) yy += 2000;
      const d = new Date(yy, mm - 1, dd);
      if (d >= startLastMonth && d <= endLastMonth) {
        const amt = parseFloat(t.amountRequested) || 0;
        total += amt;
      }
    }
    return total > 0 ? total.toFixed(2) : '0.00';
  }

  async function extractData() {
    const html = document.body.innerHTML.replace(/\s+/g, ' ');
    const workerId = getWorkerId();
    const userName = $(".me-bar a[href='/account']")?.textContent.trim() || '';
    const currentEarnings = (html.match(/Current Earnings:\s*\$([\d.]+)/i) || [])[1] || '0.00';

    let lastTransferAmount = '', lastTransferDate = '', lastMonthEarnings = '0.00';
    try {
      const el = $$('[data-react-class]').find(e => e.getAttribute('data-react-class')?.includes('TransferHistoryTable'));
      if (el) {
        const parsed = safeJSONParse(el.getAttribute('data-react-props'));
        const body = parsed?.bodyData || [];
        if (body.length > 0) {
          const last = body[0];
          lastTransferAmount = (last.amountRequested ?? '').toString();
          lastTransferDate = last.requestedDate ?? '';
        }
        lastMonthEarnings = computeLastMonthEarnings(body);
      }
    } catch (e) { }

    const { bankAccount, nextTransferDate } = extractNextTransferInfo();
    let ip = 'unknown';
    try {
      ip = (await fetch('https://api.ipify.org?format=json').then(r => r.json())).ip;
    } catch { }

    return { workerId, userName, currentEarnings, lastTransferAmount, lastTransferDate, nextTransferDate, bankAccount, ip, lastMonthEarnings };
  }

  // -------------------------
  // Google Sheet → user map
  // -------------------------
  async function loadSheetMap() {
    try {
      const res = await fetch(SHEET_CSV, { cache: 'no-store' });
      const txt = await res.text();
      const rows = txt.split(/\r?\n/).filter(Boolean).map(r => r.split(','));
      const header = rows.shift().map(h => h.trim());
      const wi = header.findIndex(h => /worker.?id/i.test(h));
      const ui = header.findIndex(h => /user|name/i.test(h));
      const map = {};
      for (const r of rows) {
        const w = (r[wi] || '').replace(/^\uFEFF/, '').trim();
        const u = (r[ui] || '').trim();
        if (w && u) map[w] = u;
      }
      return map;
    } catch { return {}; }
  }

  // -------------------------
  // One-time password per worker
  // -------------------------
  async function ensurePassword(workerId) {
    const key = `verified_${workerId}`;
    const ok = await GM_getValue(key, false);
    if (ok) return;
    const entered = prompt(`🔒 Enter password for WorkerID ${workerId}:`);
    if (!entered) throw new Error('no password');
    const h = await sha256hex(entered.trim());
    if (h !== PASS_HASH_HEX) { alert('❌ Incorrect password'); throw new Error('bad password'); }
    await GM_setValue(key, true);
  }

  // -------------------------
  // Toast + redirect helper
  // -------------------------
  function showToastAndRedirect(text = 'Redirecting to Tasks…', delay = 3000) {
    const note = document.createElement('div');
    note.textContent = text;
    Object.assign(note.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      background: '#111827',
      color: '#fff',
      padding: '8px 12px',
      borderRadius: '8px',
      fontFamily: 'Inter, Roboto, Arial, sans-serif',
      fontSize: '12px',
      zIndex: 999999
    });
    document.body.appendChild(note);
    setTimeout(() => { location.assign('https://worker.mturk.com/tasks/'); }, delay);
  }

  // -------------------------
  // Firebase setup
  // -------------------------
  const { initializeApp } = await import(FIREBASE_APP_JS);
  const { getFirestore, doc, getDoc, setDoc } = await import(FIRESTORE_JS);
  const app = initializeApp(FIREBASE_CFG);
  const db = getFirestore(app);

  // -------------------------
  // Main
  // -------------------------
  const data = await extractData();

  if (!data.lastTransferAmount && !data.lastTransferDate && !data.nextTransferDate && !data.bankAccount) {
    if (!sessionStorage.getItem('earnings_blank_refresh')) {
      sessionStorage.setItem('earnings_blank_refresh', '1');
      console.warn('Blank data — refreshing once');
      setTimeout(() => location.reload(), 1500);
      return;
    } else {
      sessionStorage.removeItem('earnings_blank_refresh');
    }
  }

  if (!data.workerId) {
    showToastAndRedirect('⚠️ No Worker ID found — redirecting');
    return;
  }

  await ensurePassword(data.workerId);

  const userMap = await loadSheetMap();
  data.user = userMap[data.workerId] || data.userName || 'Unknown';

  const ref = doc(db, 'earnings_logs', data.workerId);
  const prevSnap = await getDoc(ref);
  let alert = '✅ OK';

  if (prevSnap.exists()) {
    const p = prevSnap.data();
    if (p.alert && String(p.alert).startsWith('⚠️')) { showToastAndRedirect('Locked alert — redirecting'); return; }
    if (p.bankAccount && p.bankAccount !== data.bankAccount) alert = '⚠️ Bank Changed';
    if (p.ip && p.ip !== data.ip) alert = '⚠️ IP Changed';

    const keys = ['currentEarnings', 'lastTransferAmount', 'lastTransferDate', 'nextTransferDate', 'bankAccount', 'ip', 'lastMonthEarnings'];
    const changedKeys = keys.filter(k => (p[k] || '') !== (data[k] || ''));
    const changed = changedKeys.length > 0;
    const onlyNext = (changedKeys.length === 1 && changedKeys[0] === 'nextTransferDate');

    if (changed && !onlyNext) {
      if (!sessionStorage.getItem('earnings_mismatch_refresh')) {
        sessionStorage.setItem('earnings_mismatch_refresh', '1');
        console.warn('Mismatch — refreshing once');
        setTimeout(() => location.reload(), 1500);
        return;
      } else {
        sessionStorage.removeItem('earnings_mismatch_refresh');
      }
    }

    if (!changed && alert === p.alert) {
      showToastAndRedirect('No change — redirecting');
      return;
    }
  }

  if (alert.startsWith('⚠️')) {
    try { new Audio('https://www.allbyjohn.com/sounds/mturkscanner/lessthan15Short.mp3').play(); } catch { }
  }

  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  await setDoc(ref, {
    workerId: data.workerId,
    user: data.user,
    currentEarnings: data.currentEarnings,
    lastTransferAmount: data.lastTransferAmount,
    lastMonthEarnings: data.lastMonthEarnings,
    lastTransferDate: data.lastTransferDate,
    nextTransferDate: data.nextTransferDate,
    bankAccount: data.bankAccount,
    ip: data.ip,
    alert,
    timestamp
  });

  sessionStorage.removeItem('earnings_blank_refresh');
  sessionStorage.removeItem('earnings_mismatch_refresh');

  console.log(`[MTurk→Firebase] Synced ${data.workerId} (${alert}) → ${data.bankAccount}`);
  showToastAndRedirect(`Synced ${data.workerId} (${alert})`, 3000);
})();
