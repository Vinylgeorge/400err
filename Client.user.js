// ==UserScript==
// @name         🔒 AB2soft Earnings Report v6.3TV
// @namespace    ab2soft.secure
// @version      6.3
// @description  Uploads MTurk earnings to Firebase only if team exists in Sheet (once per day, password protected)
// @match        https://worker.mturk.com/earnings*
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(async () => {
'use strict';

/* ────────────────────────────── CONFIG ────────────────────────────── */
const SHEET_CSV =
  'https://docs.google.com/spreadsheets/d/1Jmx4qVw9J_CQNZPuq_hCL08lZzSW2vO4rEl9z9uO5sU/export?format=csv&gid=0';
const FIREBASE_APP_JS = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
const FIRESTORE_JS    = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const FIREBASE_CFG = {
  apiKey: "AIzaSyBZKAO1xSMUWBWHusx8sfZGs0yd3QIKOqU",
  authDomain: "hasibteam1-10981.firebaseapp.com",
  projectId: "hasibteam1-10981",
  storageBucket: "hasibteam1-10981.firebasestorage.app",
  messagingSenderId: "537251545985",
  appId: "1:537251545985:web:05b1667f9ec7eb6258de80"
};

const PASS_HASH_HEX = '9b724d9df97a91d297dc1c714a3987338ebb60a2a53311d2e382411a78b9e07d';

/* ────────────────────────────── HELPERS ────────────────────────────── */
const sha256hex = async t => {
  const e = new TextEncoder().encode(t);
  const h = await crypto.subtle.digest('SHA-256', e);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
};
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const safeJSONParse = s => { try { return JSON.parse(s.replace(/&quot;/g, '"')); } catch { return null; } };

function toast(msg, ms = 3000) {
  const n = document.createElement('div');
  Object.assign(n.style, {
    position: 'fixed', right: '16px', bottom: '16px',
    background: '#111827', color: '#fff',
    padding: '8px 12px', borderRadius: '8px',
    fontFamily: 'Segoe UI, sans-serif', fontSize: '12px', zIndex: 999999
  });
  n.textContent = msg;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), ms);
}

/* ────────────────────────────── PARSERS ────────────────────────────── */
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
      strongTag.querySelector("a[href*='amazon.com/gp/css/gc/balance']");
    if (bankLink) {
      if (/amazon\.com/i.test(bankLink.href)) bankAccount = 'Amazon Gift Card';
      else if (/direct_deposit/i.test(bankLink.href)) bankAccount = bankLink.textContent.trim() || 'Bank';
      else bankAccount = bankLink.textContent.trim() || 'Other';
    }
    const m = strongTag.textContent.replace(/\s+/g, ' ').match(/on\s+([A-Za-z]{3,}\s+\d{1,2},\s+\d{4})/i);
    if (m) nextTransferDate = m[1].trim();
  }
  return { bankAccount, nextTransferDate };
}

function computeLastMonthEarnings(bodyData) {
  if (!Array.isArray(bodyData)) return '0.00';
  const now = new Date();
  const startThis = new Date(now.getFullYear(), now.getMonth(), 1);
  const startLast = new Date(startThis.getFullYear(), startThis.getMonth() - 1, 1);
  const endLast   = new Date(startThis.getFullYear(), startThis.getMonth(), 0);
  endLast.setHours(23,59,59,999);
  let total = 0;
  for (const t of bodyData) {
    const ds = (t.requestedDate || '').trim();
    const [mm, dd, yy_] = ds.split('/').map(p=>parseInt(p,10));
    const yy = yy_ < 100 ? yy_ + 2000 : yy_;
    const d = new Date(yy, mm-1, dd);
    if (d >= startLast && d <= endLast) total += parseFloat(t.amountRequested) || 0;
  }
  return total.toFixed(2);
}

/* ────────────────────────────── DATA EXTRACT ────────────────────────────── */
async function extractData() {
  const html = document.body.innerHTML.replace(/\s+/g, ' ');
  const workerId = getWorkerId();
  const userName = $(".me-bar a[href='/account']")?.textContent.trim() || '';
  const currentEarnings = (html.match(/Current Earnings:\s*\$([\d.]+)/i) || [])[1] || '0.00';
  let lastTransferAmount='', lastTransferDate='', lastMonthEarnings='0.00';

  try {
    const el = $$('[data-react-class]').find(e => e.getAttribute('data-react-class')?.includes('TransferHistoryTable'));
    if (el) {
      const parsed = safeJSONParse(el.getAttribute('data-react-props'));
      const body = parsed?.bodyData || [];
      if (body.length > 0) {
        const last = body[0];
        lastTransferAmount = (last.amountRequested ?? '').toString();
        lastTransferDate   = last.requestedDate ?? '';
      }
      lastMonthEarnings = computeLastMonthEarnings(body);
    }
  } catch {}

  const { bankAccount, nextTransferDate } = extractNextTransferInfo();
  let ip = 'unknown';
  try { ip = (await fetch('https://api.ipify.org?format=json').then(r=>r.json())).ip; } catch {}
  return { workerId, userName, currentEarnings, lastTransferAmount, lastTransferDate, nextTransferDate, bankAccount, ip, lastMonthEarnings };
}

/* ────────────────────────────── CSV MAP LOADER ────────────────────────────── */
async function loadSheetFullMap() {
  const map = {};
  try {
    const res = await fetch(SHEET_CSV, { cache:'no-store' });
    const text = await res.text();
    const rows = text.split(/\r?\n/).filter(Boolean).map(r=>r.split(','));
    const headers = rows.shift().map(h=>h.trim());
    const workerIdIndex = headers.findIndex(h=>/worker.?id/i.test(h));
    for (const row of rows) {
      const workerId = (row[workerIdIndex]||'').replace(/^\uFEFF/,'').trim();
      if (workerId) {
        map[workerId] = {};
        headers.forEach((h,i)=>{ map[workerId][h]= (row[i]||'').trim(); });
      }
    }
  } catch(e){ console.warn("⚠️ CSV load error",e); }
  return map;
}

/* ────────────────────────────── AUTH ────────────────────────────── */
async function ensurePassword(workerId) {
  const key=`verified_${workerId}`;
  if(await GM_getValue(key,false)) return;
  const entered = prompt(`🔒 Enter password for WorkerID ${workerId}:`);
  if(!entered) throw new Error('no password');
  const h=await sha256hex(entered.trim());
  if(h!==PASS_HASH_HEX){ alert('❌ Incorrect password'); throw new Error('bad password'); }
  await GM_setValue(key,true);
}

/* ────────────────────────────── MAIN LOGIC ────────────────────────────── */
const { initializeApp } = await import(FIREBASE_APP_JS);
const { getFirestore, doc, setDoc } = await import(FIRESTORE_JS);
const app = initializeApp(FIREBASE_CFG);
const db  = getFirestore(app);

const data = await extractData();
if (!data.workerId) {
  toast('⚠️ No Worker ID found.');
  return;
}

const todayKey=`lastSync_${data.workerId}`;
const lastSync=await GM_getValue(todayKey,'');
const todayDate=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Dhaka'});
if(lastSync===todayDate){
  console.log(`[AB2soft] Skipped ${data.workerId}: already synced today`);
  toast('✅ Already synced today — skipping');
  return;
}

await ensurePassword(data.workerId);
const sheetMap=await loadSheetFullMap();
const extraInfo=sheetMap[data.workerId]||{};
const teamName=extraInfo["TEAM"]||"";

if(!teamName){
  console.warn(`[AB2soft] Skipped ${data.workerId}: no team`);
  toast('⛔ Skipped — Team not in spreadsheet');
  return;
}

const mergedData={...data,...extraInfo,timestamp:new Date().toLocaleString('en-BD',{timeZone:'Asia/Dhaka'})};
const ref=doc(db,'earnings_logs',data.workerId);
await setDoc(ref,mergedData,{merge:true});
await GM_setValue(todayKey,todayDate);

toast(`✅ Synced ${data.workerId} (${teamName}) → Firebase`);
console.log(`[AB2soft] Synced ${data.workerId}`,mergedData);

})();
