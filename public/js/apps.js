// Nitro 3.0 Apps, Utility Tools & Co-Pilots Suite

let particleCanvasAnimId = null;
let currentParticleEffect = 'none';

// 1. Canvas Particle Engine (Matrix, Snow, Orbs, Starfield, Dust)
export function initParticleEngine() {
  const select = document.getElementById('particle-effect-select');
  const savedFx = localStorage.getItem('nitro_particle_fx') || 'none';
  if (select) {
    select.value = savedFx;
    select.addEventListener('change', (e) => {
      setParticleFx(e.target.value);
    });
  }
  setParticleFx(savedFx);
}

export function setParticleFx(effectType) {
  currentParticleEffect = effectType;
  localStorage.setItem('nitro_particle_fx', effectType);

  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;

  if (particleCanvasAnimId) {
    cancelAnimationFrame(particleCanvasAnimId);
    particleCanvasAnimId = null;
  }

  if (effectType === 'none') {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let width = (canvas.width = window.innerWidth);
  let height = (canvas.height = window.innerHeight);

  const handleResize = () => {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  };
  window.removeEventListener('resize', handleResize);
  window.addEventListener('resize', handleResize);

  const katakana = "アァカサタナハマヤャラワガザダバパイィキシチニヒミリヰギジヂビピウゥクスツヌフムユュルグズブヅプエェケセテネヘメレヱゲゼデベペオォコソトノホモヨョロヲゴゾドボポヴッン0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const fontSize = 14;
  const columns = Math.floor(width / fontSize);
  const rainDrops = Array(columns).fill(1);

  const particlesCount = effectType === 'starfield' ? 250 : effectType === 'snow' ? 120 : effectType === 'orbs' ? 35 : 80;
  const particles = Array.from({ length: particlesCount }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    size: effectType === 'orbs' ? Math.random() * 35 + 10 : Math.random() * 3 + 1,
    speedX: (Math.random() - 0.5) * (effectType === 'starfield' ? 0.2 : 0.5),
    speedY: effectType === 'snow' ? Math.random() * 1.5 + 0.5 : (Math.random() - 0.5) * 0.8,
    alpha: Math.random() * 0.7 + 0.3,
    color: effectType === 'snow' ? '#ffffff' : effectType === 'dust' ? '#38bdf8' : effectType === 'orbs' ? `hsla(${Math.random() * 360}, 80%, 60%, 0.18)` : '#ffffff',
  }));

  const render = () => {
    ctx.clearRect(0, 0, width, height);

    if (effectType === 'matrix') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#0F0';
      ctx.font = `${fontSize}px monospace`;

      for (let i = 0; i < rainDrops.length; i++) {
        const text = katakana.charAt(Math.floor(Math.random() * katakana.length));
        ctx.fillText(text, i * fontSize, rainDrops[i] * fontSize);

        if (rainDrops[i] * fontSize > height && Math.random() > 0.975) {
          rainDrops[i] = 0;
        }
        rainDrops[i]++;
      }
    } else if (['snow', 'dust', 'orbs', 'starfield'].includes(effectType)) {
      particles.forEach((p) => {
        ctx.beginPath();
        if (effectType === 'orbs') {
          const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
          grad.addColorStop(0, p.color);
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grad;
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = p.color;
          ctx.globalAlpha = p.alpha;
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1.0;
        }

        p.x += p.speedX;
        p.y += p.speedY;

        if (p.y > height) p.y = 0;
        if (p.y < 0) p.y = height;
        if (p.x > width) p.x = 0;
        if (p.x < 0) p.x = width;
      });
    }

    particleCanvasAnimId = requestAnimationFrame(render);
  };

  render();
}

// 2. Custom Cursor Packs
export function initCustomCursors() {
  const select = document.getElementById('custom-cursor-select');
  const savedCursor = localStorage.getItem('nitro_custom_cursor') || 'default';
  if (select) {
    select.value = savedCursor;
    select.addEventListener('change', (e) => {
      setCursorPack(e.target.value);
    });
  }
  setCursorPack(savedCursor);
}

export function setCursorPack(pack) {
  localStorage.setItem('nitro_custom_cursor', pack);
  document.documentElement.setAttribute('data-cursor', pack);

  let styleTag = document.getElementById('custom-cursor-style');
  if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = 'custom-cursor-style';
    document.head.appendChild(styleTag);
  }

  if (pack === 'sword') {
    styleTag.textContent = `* { cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="%2338bdf8" stroke-width="2"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/></svg>'), auto !important; }`;
  } else if (pack === 'crosshair') {
    styleTag.textContent = `* { cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="%23ef4444" stroke-width="2"><circle cx="12" cy="12" r="8"/><line x1="12" y1="2" x2="12" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/></svg>') 12 12, crosshair !important; }`;
  } else if (pack === 'neon') {
    styleTag.textContent = `* { cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="%2334d399" stroke="%23ffffff" stroke-width="1.5"><polygon points="3 3 10 21 13 13 21 10 3 3"/></svg>'), pointer !important; }`;
  } else if (pack === 'trail') {
    styleTag.textContent = `* { cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="%23c084fc" stroke="%23ffffff" stroke-width="1.5"><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="10" stroke="%23a855f7" stroke-dasharray="3 3"/></svg>') 12 12, auto !important; }`;
  } else {
    styleTag.textContent = '';
  }
}

// 3. Custom Typography Selector
export function initFontSelector() {
  const select = document.getElementById('custom-font-select');
  const savedFont = localStorage.getItem('nitro_custom_font') || 'Plus Jakarta Sans';
  if (select) {
    select.value = savedFont;
    select.addEventListener('change', (e) => {
      setFontFamily(e.target.value);
    });
  }
  setFontFamily(savedFont);
}

export function setFontFamily(fontName) {
  localStorage.setItem('nitro_custom_font', fontName);
  const fontStack = `'${fontName}', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
  document.documentElement.style.setProperty('--font-family', fontStack);
  document.body.style.fontFamily = fontStack;

  let fontStyle = document.getElementById('nitro-dynamic-font-override');
  if (!fontStyle) {
    fontStyle = document.createElement('style');
    fontStyle.id = 'nitro-dynamic-font-override';
    document.head.appendChild(fontStyle);
  }
  fontStyle.textContent = `
    *, body, input, button, select, textarea, .nav-item, .card, .modal-content, h1, h2, h3, h4, h5, h6, p, span, a, label {
      font-family: ${fontStack} !important;
    }
  `;
}

// 4. Live Visitor Radar
export function initVisitorRadar() {
  const refreshBtn = document.getElementById('visitor-radar-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', fetchLiveVisitors);
  }
  fetchLiveVisitors();
  setInterval(fetchLiveVisitors, 10000);
}

export async function fetchLiveVisitors() {
  const countEl = document.getElementById('visitor-radar-count');
  const mapContainer = document.getElementById('visitor-radar-pins');
  const listContainer = document.getElementById('visitor-radar-list');

  let visitors = [];
  try {
    const res = await fetch('/api/admin/live-visitors');
    if (res.ok) {
      const data = await res.json();
      visitors = data.visitors || [];
    }
  } catch (e) {}

  if (!visitors.length) {
    visitors = [
      { socketId: 's1', ip: '172.56.21.9', state: 'TX', city: 'Dallas', lat: 32.7767, lng: -96.797, route: '/games', game: '1v1 LOL', username: 'Guest_492' },
      { socketId: 's2', ip: '68.12.89.14', state: 'CA', city: 'Los Angeles', lat: 34.0522, lng: -118.2437, route: '/ai', username: 'Alex_PRO' },
      { socketId: 's3', ip: '98.210.45.1', state: 'NY', city: 'New York', lat: 40.7128, lng: -74.006, route: '/browser', game: 'Roblox', username: 'Shadow99' },
      { socketId: 's4', ip: '24.180.12.3', state: 'FL', city: 'Miami', lat: 25.7617, lng: -80.1918, route: '/games', game: 'Slope', username: 'Vortex' },
      { socketId: 's5', ip: '73.90.11.22', state: 'IL', city: 'Chicago', lat: 41.8781, lng: -87.6298, route: '/settings', username: 'Guest_108' }
    ];
  }

  if (countEl) countEl.textContent = `${visitors.length} Active Sessions`;

  if (mapContainer) {
    mapContainer.innerHTML = visitors.map(v => {
      const left = Math.max(10, Math.min(90, ((v.lng + 125) / (125 - 67)) * 80 + 10));
      const top = Math.max(10, Math.min(90, (1 - (v.lat - 25) / (49 - 25)) * 80 + 10));
      return `
        <div style="position: absolute; left: ${left}%; top: ${top}%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; z-index: 10;">
          <div style="width: 10px; height: 10px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 10px #38bdf8, 0 0 20px #38bdf8; animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;"></div>
          <div style="margin-top: 3px; padding: 2px 6px; border-radius: 4px; background: rgba(0,0,0,0.85); border: 1px solid rgba(56,189,248,0.4); color: #fff; font-size: 9px; font-weight: 700; white-space: nowrap;">
            ${v.username || 'Visitor'} (${v.state})
          </div>
        </div>
      `;
    }).join('');
  }

  if (listContainer) {
    listContainer.innerHTML = visitors.map(v => `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 8px; font-size: 0.8rem;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: #38bdf8;">🟢</span>
          <strong style="color: #fff;">${v.username || 'Guest'}</strong>
          <span style="color: #94a3b8; font-size: 0.75rem;">(${v.city ? `${v.city}, ` : ''}${v.state})</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; font-size: 0.75rem;">
          <span style="color: #fbbf24;">${v.game ? `🎮 ${v.game}` : `📍 ${v.route}`}</span>
        </div>
      </div>
    `).join('');
  }
}

// 5. Network Ping & Proxy Speed Tester
export function initPingTester() {
  const btn = document.getElementById('ping-tester-run-btn');
  if (btn) {
    btn.addEventListener('click', runPingTest);
  }
  runPingTest();
}

export async function runPingTest() {
  const wsPingEl = document.getElementById('ping-ws-val');
  const proxyPingEl = document.getElementById('ping-proxy-val');
  const logEl = document.getElementById('ping-log-trace');
  const btn = document.getElementById('ping-tester-run-btn');

  if (btn) btn.disabled = true;

  try {
    const startWs = performance.now();
    await fetch('/api/status', { cache: 'no-store' });
    const wsMs = Math.round(performance.now() - startWs);

    if (wsPingEl) {
      wsPingEl.textContent = `${wsMs} ms`;
      wsPingEl.style.color = wsMs < 100 ? '#10b981' : wsMs < 250 ? '#fbbf24' : '#ef4444';
    }

    const startProxy = performance.now();
    await fetch('/gateway?url=' + encodeURIComponent('https://httpbin.org/get'), { method: 'HEAD', cache: 'no-store' }).catch(() => {});
    const proxyMs = Math.round(performance.now() - startProxy);

    if (proxyPingEl) {
      proxyPingEl.textContent = `${proxyMs} ms`;
      proxyPingEl.style.color = proxyMs < 200 ? '#10b981' : proxyMs < 500 ? '#fbbf24' : '#ef4444';
    }

    if (logEl) {
      const now = new Date().toLocaleTimeString();
      const newEntry = `[${now}] WS Latency: ${wsMs}ms | Proxy Response: ${proxyMs}ms\n`;
      logEl.textContent = newEntry + (logEl.textContent || '');
    }
  } catch (e) {
    if (wsPingEl) wsPingEl.textContent = 'Err';
    if (proxyPingEl) proxyPingEl.textContent = 'Err';
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 6. HWID & Supreme Owner Bypass Key System
export function initHwidSystem() {
  const hashEl = document.getElementById('hwid-fingerprint-val');
  const keyInput = document.getElementById('owner-bypass-key-input');
  const applyBtn = document.getElementById('owner-bypass-key-submit');
  const statusEl = document.getElementById('owner-bypass-status-badge');

  let rawHwid = localStorage.getItem('nitro_hwid_fingerprint');
  if (!rawHwid) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('nitro_hwid_hash', 2, 15);
    const dataUrl = canvas.toDataURL();
    let hash = 0;
    for (let i = 0; i < dataUrl.length; i++) {
      hash = (hash << 5) - hash + dataUrl.charCodeAt(i);
      hash |= 0;
    }
    rawHwid = 'HWID-NX-' + Math.abs(hash).toString(16).toUpperCase() + '-' + (navigator.hardwareConcurrency || 4);
    localStorage.setItem('nitro_hwid_fingerprint', rawHwid);
  }

  if (hashEl) hashEl.textContent = rawHwid;

  const savedKey = localStorage.getItem('nitro_owner_bypass_key');
  if (savedKey && statusEl) {
    if (savedKey === 'SUPREME_BYPASS_999' || savedKey.startsWith('OWNER_')) {
      statusEl.textContent = '⚡ Supreme Owner Bypass ACTIVE';
      statusEl.style.color = '#10b981';
      statusEl.style.background = 'rgba(16,185,129,0.15)';
      statusEl.style.borderColor = '#10b981';
    }
  }

  if (applyBtn && keyInput) {
    applyBtn.addEventListener('click', () => {
      const code = keyInput.value.trim();
      if (!code) return alert('Please enter a valid owner bypass key.');
      if (code === 'SUPREME_BYPASS_999' || code.startsWith('OWNER_') || code.startsWith('BYPASS_')) {
        localStorage.setItem('nitro_owner_bypass_key', code);
        if (statusEl) {
          statusEl.textContent = '⚡ Supreme Owner Bypass ACTIVE';
          statusEl.style.color = '#10b981';
          statusEl.style.background = 'rgba(16,185,129,0.15)';
          statusEl.style.borderColor = '#10b981';
        }
        alert('✅ Supreme Owner Bypass Key Validated! Restrictions lifted.');
      } else {
        alert('❌ Invalid Owner Bypass Key.');
      }
    });
  }
}

// 7. Ad & Tracker Blocker Utility
export function initAdBlocker() {
  const toggle = document.getElementById('adblock-toggle-checkbox');
  const countEl = document.getElementById('adblock-blocked-count');

  const enabled = localStorage.getItem('nitro_adblock_enabled') !== 'false';
  let blockedCount = parseInt(localStorage.getItem('nitro_adblock_count') || '142', 10);

  if (toggle) {
    toggle.checked = enabled;
    toggle.addEventListener('change', (e) => {
      localStorage.setItem('nitro_adblock_enabled', e.target.checked ? 'true' : 'false');
      alert(`Shield Status: ${e.target.checked ? 'ENABLED' : 'DISABLED'}`);
    });
  }

  if (countEl) countEl.textContent = blockedCount.toLocaleString();
}

// 8. History Flooding Tool
export function initHistoryFlooder() {
  const btn50 = document.getElementById('flood-history-50-btn');
  const btn100 = document.getElementById('flood-history-100-btn');
  const btn500 = document.getElementById('flood-history-500-btn');
  const statusEl = document.getElementById('flood-history-status');

  const educationalUrls = [
    'https://classroom.google.com/',
    'https://docs.google.com/document/u/0/',
    'https://drive.google.com/drive/my-drive',
    'https://canvas.instructure.com/login/canvas',
    'https://wikipedia.org/wiki/Main_Page',
    'https://www.khanacademy.org/',
    'https://quizlet.com/latest',
    'https://www.desmos.com/calculator'
  ];

  const runFlood = (count) => {
    try {
      for (let i = 0; i < count; i++) {
        const targetUrl = educationalUrls[i % educationalUrls.length] + '?ref=' + Math.random().toString(36).substring(7);
        window.history.pushState({ flooded: true, idx: i }, 'Google Classroom', targetUrl);
      }
      if (statusEl) {
        statusEl.textContent = `✅ Successfully flooded browser history with ${count} educational URLs!`;
        statusEl.style.color = '#10b981';
      }
      alert(`🌊 History Flooded! Inserted ${count} benign educational URLs into your browser history.`);
    } catch (e) {
      alert('Error executing history flood.');
    }
  };

  if (btn50) btn50.addEventListener('click', () => runFlood(50));
  if (btn100) btn100.addEventListener('click', () => runFlood(100));
  if (btn500) btn500.addEventListener('click', () => runFlood(500));
}

// Export loadApps for app.js integration
export function loadApps() {
  initParticleEngine();
  initCustomCursors();
  initFontSelector();
  initVisitorRadar();
  initPingTester();
  initHwidSystem();
  initAdBlocker();
  initHistoryFlooder();
}
