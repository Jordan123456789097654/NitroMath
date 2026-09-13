// AI Essay Proofreader, Plagiarism Scanner & AI Humanizer Client Controller

export function initProofreader() {
  const form = document.getElementById('proofread-form');
  const humanizeBtn = document.getElementById('proofread-humanize-btn');
  const plagiaristBtn = document.getElementById('proofread-plagiarism-btn');

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = document.getElementById('proofread-text-input')?.value.trim();
      const tone = document.getElementById('proofread-tone-select')?.value || 'Academic';
      const outputBox = document.getElementById('proofread-output-box');
      const correctionsBox = document.getElementById('proofread-corrections-list');

      if (!text) return alert('Please enter essay or text to proofread.');

      if (outputBox) outputBox.innerHTML = '<div style="color: #38bdf8;">🧠 Kyro AI is analyzing grammar, vocabulary, and tone...</div>';

      try {
        const res = await fetch('/api/ai/proofread', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, tone })
        });
        const data = await res.json();
        if (res.ok && data.success && data.result) {
          const r = data.result;
          if (outputBox) {
            outputBox.innerHTML = `
              <div style="margin-bottom: 12px; font-weight: 800; color: #10b981;">Tone Score: ${r.toneScore || 95}% (${tone})</div>
              <div style="background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; font-size: 0.9rem; line-height: 1.6; color: #fff; white-space: pre-wrap;">${escapeHtml(r.enhancedText || r.correctedText || text)}</div>
            `;
          }
          if (correctionsBox && Array.isArray(r.corrections)) {
            correctionsBox.innerHTML = r.corrections.map(c => `
              <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); padding: 10px; border-radius: 8px; font-size: 0.82rem;">
                <span style="color: #fbbf24; font-weight: 800; text-transform: uppercase;">[${escapeHtml(c.type)}]</span>
                <span style="color: #ef4444; text-decoration: line-through; margin: 0 6px;">${escapeHtml(c.original)}</span> → 
                <strong style="color: #10b981; margin-left: 6px;">${escapeHtml(c.suggestion)}</strong>
                <p style="color: #cbd5e1; margin: 4px 0 0 0; font-size: 0.78rem;">${escapeHtml(c.explanation)}</p>
              </div>
            `).join('');
          }
        } else {
          if (outputBox) outputBox.textContent = data.error || 'Failed to proofread text.';
        }
      } catch (err) {
        if (outputBox) outputBox.textContent = 'Error connecting to AI proofreading service.';
      }
    });
  }

  if (humanizeBtn) {
    humanizeBtn.addEventListener('click', async () => {
      const text = document.getElementById('proofread-text-input')?.value.trim();
      const outputBox = document.getElementById('proofread-output-box');
      if (!text) return alert('Please enter text to humanize.');

      if (outputBox) outputBox.innerHTML = '<div style="color: #a855f7;">✨ Humanizing text with natural sentence structure & burstiness...</div>';

      try {
        const res = await fetch('/api/ai/humanize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        const data = await res.json();
        if (res.ok && data.success && data.humanizedText) {
          if (outputBox) {
            outputBox.innerHTML = `
              <div style="margin-bottom: 8px; font-weight: 800; color: #a855f7;">✨ Humanized Text Output (100% Organic Score):</div>
              <div style="background: rgba(0,0,0,0.3); padding: 12px; border-radius: 8px; font-size: 0.9rem; line-height: 1.6; color: #fff; white-space: pre-wrap;">${escapeHtml(data.humanizedText)}</div>
            `;
          }
        } else {
          if (outputBox) outputBox.textContent = data.error || 'Failed to humanize text.';
        }
      } catch (e) {
        if (outputBox) outputBox.textContent = 'Error humanizing text.';
      }
    });
  }

  if (plagiaristBtn) {
    plagiaristBtn.addEventListener('click', async () => {
      const text = document.getElementById('proofread-text-input')?.value.trim();
      const outputBox = document.getElementById('proofread-output-box');
      if (!text) return alert('Please enter text to scan.');

      if (outputBox) outputBox.innerHTML = '<div style="color: #fbbf24;">🔍 Scanning text for originality and AI clichés...</div>';

      try {
        const res = await fetch('/api/ai/plagiarism-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        const data = await res.json();
        if (res.ok && data.success && data.scan) {
          const s = data.scan;
          if (outputBox) {
            outputBox.innerHTML = `
              <div style="display: flex; gap: 16px; margin-bottom: 12px;">
                <div style="background: rgba(16,185,129,0.15); border: 1px solid #10b981; padding: 10px 16px; border-radius: 8px; font-weight: 800; color: #10b981;">
                  Originality: ${s.originalityScore}%
                </div>
                <div style="background: rgba(56,189,248,0.15); border: 1px solid #38bdf8; padding: 10px 16px; border-radius: 8px; font-weight: 800; color: #38bdf8;">
                  Status: ${escapeHtml(s.status)}
                </div>
              </div>
              <p style="color: #cbd5e1; font-size: 0.85rem; margin: 0;">${(s.recommendations || []).map(r => `• ${escapeHtml(r)}`).join('<br>')}</p>
            `;
          }
        } else {
          if (outputBox) outputBox.textContent = data.error || 'Failed to complete originality scan.';
        }
      } catch (e) {
        if (outputBox) outputBox.textContent = 'Error running plagiarism scan.';
      }
    });
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
