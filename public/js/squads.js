// Squads & Student Guilds Client Controller

export function initSquads() {
  const modal = document.getElementById('squads-modal');
  const openBtns = document.querySelectorAll('#open-squads-btn, [data-open-modal="squads"]');
  const closeBtn = document.getElementById('squads-modal-close');
  const createForm = document.getElementById('create-squad-form');

  openBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (modal) {
        modal.classList.add('active');
        fetchSquads();
      }
    });
  });

  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => modal.classList.remove('active'));
  }

  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('squad-name-input')?.value.trim();
      const tag = document.getElementById('squad-tag-input')?.value.trim();
      const emblem = document.getElementById('squad-emblem-select')?.value || '⚡';
      const description = document.getElementById('squad-desc-input')?.value.trim();

      if (!name || !tag) return alert('Please provide squad name and tag.');

      try {
        const token = localStorage.getItem('nitro_jwt_token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch('/api/squads/create', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name, tag, emblem, description })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          alert(data.message || 'Squad created successfully!');
          createForm.reset();
          fetchSquads();
        } else {
          alert(data.error || 'Failed to create squad. Please sign in.');
        }
      } catch (err) {
        alert('Error creating squad.');
      }
    });
  }
}

export async function fetchSquads() {
  const container = document.getElementById('squads-list-container');
  if (!container) return;

  try {
    const res = await fetch('/api/squads');
    const data = await res.json();
    if (res.ok && data.success && Array.isArray(data.squads)) {
      container.innerHTML = data.squads.map(s => `
        <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--card-border); border-radius: 12px; padding: 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="font-size: 2rem;">${s.emblem || '⚡'}</span>
            <div>
              <div style="display: flex; align-items: center; gap: 8px;">
                <strong style="color: #fff; font-size: 1.05rem;">${escapeHtml(s.name)}</strong>
                <span style="font-size: 0.72rem; font-weight: 800; background: rgba(56,189,248,0.15); border: 1px solid #38bdf8; color: #38bdf8; padding: 2px 8px; border-radius: 6px;">[${escapeHtml(s.tag)}]</span>
              </div>
              <p style="color: #94a3b8; font-size: 0.8rem; margin: 4px 0 0 0;">${escapeHtml(s.description || 'No squad description.')}</p>
              <div style="font-size: 0.75rem; color: #fbbf24; margin-top: 4px;">Leader: <strong>${escapeHtml(s.leader)}</strong> • ${s.membersCount} Members • ${s.xp || 0} XP</div>
            </div>
          </div>
          <button class="btn-pill primary" onclick="window.joinSquad('${s.id}')" style="background: #38bdf8; color: #000; font-weight: 800; border: none; padding: 8px 16px;">
            Join Squad
          </button>
        </div>
      `).join('');
    }
  } catch (e) {
    container.innerHTML = '<div style="color: #ef4444; padding: 20px; text-align: center;">Error loading squads list.</div>';
  }
}

window.joinSquad = async function(squadId) {
  try {
    const token = localStorage.getItem('nitro_jwt_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const res = await fetch('/api/squads/join', {
      method: 'POST',
      headers,
      body: JSON.stringify({ squadId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert(data.message);
      fetchSquads();
    } else {
      alert(data.error || 'Failed to join squad.');
    }
  } catch (e) {
    alert('Error joining squad.');
  }
};

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
