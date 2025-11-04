// ==UserScript==
// @name         🔒 MTurk Earnings Report (AB2soft) v6.3
// @namespace    ab2soft.secure
// @version      6.3
// @description  Capture MTurk earnings + metadata once per day (BST), merge with CSV (TEAM/USERNAME/SERVER IP), push to Firestore
// @match        https://worker.mturk.com/earnings*
// @run-at       document-end
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(async () => {
  'use strict';

  /******************************************************************
   * CONFIG
   ******************************************************************/
  const SHEET_CSV =
    'https://docs.google.com/spreadsheets/d/1Jmx4qVw9J_CQNZPuq_hCL08lZzSW2vO4rEl9z9uO5sU/export?format=csv&gid=0';

  // Firebase (your new project)
  const FIREBASE_CFG = {
    apiKey: "AIzaSyBZKAO1xSMUWBWHusx8sfZGs0yd3QIKOqU",
    authDomain: "hasibteam1-10981.firebaseapp.com",
    projectId: "hasibteam1-10981",
    storageBucket: "hasibteam1-10981.firebasestorage.app",
    messagingSenderId: "537251545985",
    appId: "1:537251545985:web:05b1667f9ec7eb6258de80"
  };

  // password hash (same as your older script)
  const PASS_HASH_HEX = '9b724d9df97a91d297dc1c714a3987338ebb60a2a53311d2e382411a78b9e07d';

  // we’ll use compat SDK because Tampermonkey doesn’t like ESM imports
  const FIREBASE_LIBS = [
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js'
  ];

  /******************************************************************
   * SMALL HELPERS
   ******************************************************************/
  const sha256hex = async text => {
    const enc = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  };

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function toast(msg, ms = 3000) {
    const d = document.createElement('div');
    d.textContent = msg;
    Object.assign(d.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      background: '#111827',
      color: '#fff',
      padding: '8px 12px',
      borderRadius: '8px',
      fontSize: '12px',
      zIndex: 999999
    });
    document.body.appendChild(d);
    setTimeout(() => d.remove(), ms);
  }

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const safeJSONParse = s => {
    try {
      return JSON.parse(s.replace(/&quot;/g, '"'));
    } catch {
      return null;
    }
  };

  /******************************************************************
   * WAIT FOR REACT CONTENT
   * (MTurk earnings page is React, so DOM is late sometimes)
   ******************************************************************/
  async function waitForEarningsDom(timeoutMs = 7000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // look for the "Current Earnings:" text or transfer table react element
      const html = document.body.innerHTML;
      if (/Current Earnings:/i.test(html) || document.querySelector("[data-react-class*='TransferHistoryTable']")) {
        return true;
      }
      await sleep(400);
    }
    return false;
  }

  /******************************************************************
   * PAGE EXTRACTORS
   ******************************************************************/
  function getWorkerId() {
    // worker id is in the top bar react prop
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

  async function extractDataFromPage() {
    await waitForEarningsDom(); // make sure react is done

    const html = document.body.innerHTML.replace(/\s+/g, ' ');
    const workerId = getWorkerId();
    const userName = $(".me-bar a[href='/account']")?.textContent.trim() || '';

    // Current earnings
    const currentEarnings =
      (html.match(/Current Earnings:\s*\$([\d.]+)/i) || [])[1] ||
      (html.match(/"currentEarnings":"([\d.]+)"/i) || [])[1] ||
      '0.00';

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
    } catch (e) {
      console.warn('transfer table parse error', e);
    }

    const { bankAccount, nextTransferDate } = extractNextTransferInfo();

    let ip = 'unknown';
    try {
      ip = (await fetch('https://api.ipify.org?format=json').then(r => r.json())).ip;
    } catch (e) {
      console.warn('IP fetch failed', e);
    }

    return {
      workerId,
      userName,
      currentEarnings,
      lastTransferAmount,
      lastTransferDate,
      nextTransferDate,
      bankAccount,
      ip,
      lastMonthEarnings
    };
  }

  /******************************************************************
   * CSV LOADER (to get SERVER IP / TEAM / USERNAME / WORKER ID mapping)
   ******************************************************************/
  async function loadSheetFullMap() {
    const map = {};
    try {
      const res = await fetch(SHEET_CSV, { cache: 'no-store' });
      const text = await res.text();
      const rows = text.split(/\r?\n/).filter(Boolean).map(r => r.split(','));
      const headers = rows.shift().map(h => h.trim());
      const workerIdIndex = headers.findIndex(h => /worker.?id/i.test(h));
      for (const row of rows) {
        const workerId = (row[workerIdIndex] || '').replace(/^\uFEFF/, '').trim();
        if (workerId) {
          map[workerId] = {};
          headers.forEach((h, i) => {
            map[workerId][h] = (row[i] || '').trim();
          });
        }
      }
    } catch (e) {
      console.warn('⚠️ CSV load error:', e);
    }
    return map;
  }

  /******************************************************************
   * PASSWORD CHECK (same as your older script)
   ******************************************************************/
  async function ensurePassword(workerId) {
    const key = `verified_${workerId}`;
    const ok = await GM_getValue(key, false);
    if (ok) return;
    const entered = prompt(`🔒 Enter password for WorkerID ${workerId}:`);
    if (!entered) throw new Error('no password');
    const h = await sha256hex(entered.trim());
    if (h !== PASS_HASH_HEX) {
      alert('❌ Incorrect password');
      throw new Error('bad password');
    }
    await GM_setValue(key, true);
  }

  /******************************************************************
   * LOAD FIREBASE COMPAT
   ******************************************************************/
  async function loadFirebaseCompat() {
    for (const url of FIREBASE_LIBS) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = res;
        s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    // now window.firebase exists
    if (!window.firebase?.apps?.length) {
      window.firebase.initializeApp(FIREBASE_CFG);
    }
    return window.firebase.firestore();
  }

  /******************************************************************
   * MAIN
   ******************************************************************/
  try {
    const pageData = await extractDataFromPage();
    if (!pageData.workerId) {
      toast('⚠️ No Worker ID — redirecting');
      setTimeout(() => location.assign('https://worker.mturk.com/tasks/'), 2000);
      return;
    }

    // once per day (Bangladesh)
    const todayKey = `lastSync_${pageData.workerId}`;
    const lastSync = await GM_getValue(todayKey, '');
    const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
    if (lastSync === todayDate) {
      console.log(`[MTurk→Firebase] ${pageData.workerId} already synced today (${todayDate})`);
      toast('✅ Already synced today — skipping.');
      return;
    }

    // password gate
    await ensurePassword(pageData.workerId);

    // CSV merge
    const sheetMap = await loadSheetFullMap();
    const extraInfo = sheetMap[pageData.workerId] || {};

    // Firestore
    const db = await loadFirebaseCompat();

    const mergedData = {
      ...pageData,
      ...extraInfo,              // SERVER IP, TEAM, USERNAME, WORKER ID from CSV
      timestamp: new Date().toLocaleString('en-BD', { timeZone: 'Asia/Dhaka' })
    };

    await db.collection('earnings_logs').doc(pageData.workerId).set(mergedData, { merge: true });

    await GM_setValue(todayKey, todayDate);

    console.log('[MTurk→Firebase] Synced', pageData.workerId, mergedData);
    toast(`Synced ${pageData.workerId} → Firebase (BST)`);

  } catch (err) {
    console.error('AB2soft v6.3 error:', err);
    toast('❌ Error: ' + err.message);
  }

})();
