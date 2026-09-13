// Player-to-Player Cosmetics & Item Trading Controller

export function initTrading() {
  const modal = document.getElementById('trading-modal');
  const openBtns = document.querySelectorAll('#open-trading-btn, [data-open-modal="trading"]');
  const closeBtn = document.getElementById('trading-modal-close');
  const createForm = document.getElementById('create-trade-form');

  openBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (modal) {
        modal.classList.add('active');
        fetchTradeOffers();
      }
    });
  });

  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => modal.classList.remove('active'));
  }

  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const offeredItem = document.getElementById('trade-offered-input')?.value.trim();
      const requestedItem = document.getElementById('trade-requested-input')?.value.trim();
      const coins = document.getElementById('trade-coins-input')?.value || 0;

      if (!offeredItem || !requestedItem) return alert('Please enter both offered and requested items.');

      try {
        const token = localStorage.getItem('nitro_jwt_token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch('/api/trading/create', {
          method: 'POST',
          headers,
          body: JSON.stringify({ offeredItem, requestedItem, coins })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          alert(data.message || 'Trade offer published!');
          createForm.reset();
          fetchTradeOffers();
        } else {
          alert(data.error || 'Failed to publish trade offer. Please log in.');
        }
      } catch (err) {
        alert('Error publishing trade offer.');
      }
    });
  }
}

export async function fetchTradeOffers() {
  const container = document.getElementById('trade-offers-container');
  if (!container) return;

  try {
    const res = await fetch('/api/trading/offers');
    const data = await res.json();
    if (res.ok && data.success && Array.isArray(data.offers)) {
      if (!data.offers.length) {
        container.innerHTML = '<div style="color: #94a3b8; text-align: center; padding: 20px;">No active trade offers. Be the first to publish one!</div>';
        return;
      }
      container.innerHTML = data.offers.map(o => `
        <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--card-border); border-radius: 12px; padding: 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <div>
            <div style="font-size: 0.78rem; color: #fbbf24; font-weight: 800; margin-bottom: 4px;">Seller: ${escapeHtml(o.sender)}</div>
            <div style="display: flex; align-items: center; gap: 10px; font-size: 0.9rem; color: #fff;">
              <span style="color: #10b981; font-weight: 800;">${escapeHtml(o.offeredItem)}</span>
              <span>⇄</span>
              <span style="color: #38bdf8; font-weight: 800;">${escapeHtml(o.requestedItem)}</span>
            </div>
            ${o.coins ? `<div style="font-size: 0.78rem; color: #fbbf24; margin-top: 4px;">Includes ${o.coins} Coins</div>` : ''}
          </div>
          <button class="btn-pill primary" onclick="window.acceptTrade('${o.id}')" style="background: #10b981; color: #000; font-weight: 800; border: none; padding: 8px 16px;">
            Accept Trade
          </button>
        </div>
      `).join('');
    }
  } catch (e) {
    container.innerHTML = '<div style="color: #ef4444; padding: 20px; text-align: center;">Error loading trade offers.</div>';
  }
}

window.acceptTrade = async function(offerId) {
  try {
    const token = localStorage.getItem('nitro_jwt_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch('/api/trading/accept', {
      method: 'POST',
      headers,
      body: JSON.stringify({ offerId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert(data.message);
      fetchTradeOffers();
    } else {
      alert(data.error || 'Failed to accept trade.');
    }
  } catch (e) {
    alert('Error accepting trade.');
  }
};

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
