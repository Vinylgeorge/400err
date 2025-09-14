// ==UserScript==
// @name         Cookie Man
// @namespace    ViolentMonkey
// @version      1.7
// @description  tabs
// @match        https://*.mturk.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* ---------------- TAB LIMITER ---------------- */
    const TAB_LIMIT = 3;
    const TAB_ID = Date.now() + "-" + Math.random().toString(16).slice(2);
    const KEY = "mturk_tabs";
    const HEARTBEAT_INTERVAL = 500;  // 0.5 sec
    const TIMEOUT = 3000;            // 3 sec

    function getTabs() {
        try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
        catch { return {}; }
    }
    function saveTabs(tabs) { localStorage.setItem(KEY, JSON.stringify(tabs)); }

    function registerTab() {
        let tabs = getTabs();
        const now = Date.now();

        // Remove expired
        for (let id in tabs) {
            if (now - tabs[id] > TIMEOUT) delete tabs[id];
        }

        // Add this tab
        tabs[TAB_ID] = now;

        // If too many → remove 3rd tab (second-newest)
        let ids = Object.keys(tabs).sort((a, b) => tabs[a] - tabs[b]); // oldest → newest
        if (ids.length > TAB_LIMIT) {
            const thirdTab = ids[ids.length - 2]; // 2nd newest = 3rd tab
            delete tabs[thirdTab];
        }

        saveTabs(tabs);
        return true;
    }

    function heartbeat() {
        let tabs = getTabs();

        // If this tab was removed → close it fast
        if (!tabs[TAB_ID]) {
            console.warn("[MTurk Manager] This tab was kicked (3rd tab logic). Closing...");
            window.close();
            return;
        }

        // Refresh heartbeat
        tabs[TAB_ID] = Date.now();
        saveTabs(tabs);
    }

    function unregisterTab() {
        let tabs = getTabs();
        delete tabs[TAB_ID];
        saveTabs(tabs);
    }

    // Register this tab
    if (!registerTab()) return;
    setInterval(heartbeat, HEARTBEAT_INTERVAL);
    window.addEventListener("beforeunload", unregisterTab);

    /* ---------------- COOKIE TRIMMER ---------------- */
    const KEEP = [
        "session-id", "session-id-time",
        "csrf-token", "ubid-main",
        "at-main", "x-main", "sess-at-main"
    ];
    let lastTrim = null;

    function trimCookies() {
        try {
            const raw = document.cookie;
            if (!raw) return;
            raw.split("; ").forEach(c => {
                const name = c.split("=")[0];
                if (!KEEP.includes(name) && name !== "") {
                    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/;`;
                    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.mturk.com;`;
                }
            });
            lastTrim = Date.now();
        } catch (e) {
            console.error("[MTurk Manager] Error trimming cookies:", e);
        }
    }
    setInterval(trimCookies, 10000);
    trimCookies();

    /* ---------------- STATUS BADGE ---------------- */
    const badge = document.createElement("div");
    badge.style.position = "fixed";
    badge.style.bottom = "10px";
    badge.style.right = "10px";
    badge.style.padding = "6px 10px";
    badge.style.background = "rgba(0,0,0,0.7)";
    badge.style.color = "#0f0";
    badge.style.fontSize = "12px";
    badge.style.fontFamily = "monospace";
    badge.style.borderRadius = "6px";
    badge.style.zIndex = "99999";
    badge.style.pointerEvents = "none";
    document.body.appendChild(badge);

    function updateBadge() {
        let tabs = getTabs();
        const count = Object.keys(tabs).length;
        let secsAgo = lastTrim ? Math.floor((Date.now() - lastTrim) / 1000) : "–";
        badge.textContent = `Tabs: ${count}/${TAB_LIMIT} | Last trim: ${secsAgo}s ago`;
    }
    setInterval(updateBadge, 500);
    updateBadge();
})();
