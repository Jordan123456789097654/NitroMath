const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../authMiddleware');

// In-memory squads storage if DB table is missing, synced dynamically
let inMemorySquads = [
  { id: 'squad-1', name: 'Nitro Elites', tag: 'NTR', emblem: '⚡', description: 'Top leaderboard speedrunners and coders.', membersCount: 14, leader: 'Jordan', xp: 14500 },
  { id: 'squad-2', name: 'Cyber Phantoms', tag: 'PHM', emblem: '👾', description: 'Stealth proxy users and arcade champions.', membersCount: 9, leader: 'Alex_PRO', xp: 9800 },
  { id: 'squad-3', name: 'STEM Scholars', tag: 'STEM', emblem: '📐', description: 'AI study pod and math solvers.', membersCount: 12, leader: 'Elena', xp: 11200 }
];

// GET /api/squads - List all squads
router.get('/', (req, res) => {
  res.json({ success: true, squads: inMemorySquads });
});

// POST /api/squads/create - Create new squad
router.post('/create', authMiddleware, (req, res) => {
  const { name, tag, emblem, description } = req.body;
  if (!name || !tag) {
    return res.status(400).json({ error: 'Squad name and tag are required.' });
  }

  const user = req.user;
  const squadId = 'squad-' + Date.now();
  const newSquad = {
    id: squadId,
    name: name.trim(),
    tag: tag.trim().toUpperCase().substring(0, 5),
    emblem: emblem || '⚡',
    description: (description || '').trim(),
    membersCount: 1,
    leader: user.username,
    xp: 0
  };

  inMemorySquads.unshift(newSquad);
  res.json({ success: true, squad: newSquad, message: `⚡ Squad [${newSquad.tag}] ${newSquad.name} created!` });
});

// POST /api/squads/join - Join squad
router.post('/join', authMiddleware, (req, res) => {
  const { squadId } = req.body;
  const squad = inMemorySquads.find(s => s.id === squadId);
  if (!squad) {
    return res.status(404).json({ error: 'Squad not found.' });
  }

  squad.membersCount++;
  res.json({ success: true, squad, message: `✅ Joined Squad [${squad.tag}] ${squad.name}!` });
});

module.exports = router;
