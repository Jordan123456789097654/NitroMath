const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../authMiddleware');

let activeTradeOffers = [
  { id: 'trade-101', sender: 'Jordan', offeredItem: '⚡ Golden Aura Glow', requestedItem: '🌈 Rainbow Chroma Glow', coins: 150, status: 'active', createdAt: new Date().toISOString() },
  { id: 'trade-102', sender: 'Alex_PRO', offeredItem: '👑 VIP ELITE Title', requestedItem: '💎 Cyberpunk Cyan Glow', coins: 300, status: 'active', createdAt: new Date().toISOString() }
];

// GET /api/trading/offers - Get active trade offers
router.get('/offers', (req, res) => {
  res.json({ success: true, offers: activeTradeOffers.filter(o => o.status === 'active') });
});

// POST /api/trading/create - Create trade offer
router.post('/create', authMiddleware, (req, res) => {
  const { offeredItem, requestedItem, coins } = req.body;
  if (!offeredItem || !requestedItem) {
    return res.status(400).json({ error: 'Offered item and requested item are required.' });
  }

  const user = req.user;
  const newOffer = {
    id: 'trade-' + Date.now(),
    sender: user.username,
    offeredItem: offeredItem.trim(),
    requestedItem: requestedItem.trim(),
    coins: parseInt(coins, 10) || 0,
    status: 'active',
    createdAt: new Date().toISOString()
  };

  activeTradeOffers.unshift(newOffer);
  res.json({ success: true, offer: newOffer, message: '🛍️ Trade offer published to the P2P Marketplace!' });
});

// POST /api/trading/accept - Accept trade offer
router.post('/accept', authMiddleware, (req, res) => {
  const { offerId } = req.body;
  const offer = activeTradeOffers.find(o => o.id === offerId && o.status === 'active');
  if (!offer) {
    return res.status(404).json({ error: 'Trade offer is no longer available.' });
  }

  offer.status = 'completed';
  offer.acceptedBy = req.user.username;
  res.json({ success: true, offer, message: `🎉 Trade completed! Swapped ${offer.offeredItem} for ${offer.requestedItem}.` });
});

module.exports = router;
