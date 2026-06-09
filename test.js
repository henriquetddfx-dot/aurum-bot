const fetch = require('node-fetch');

fetch('https://aurum-bot-y1fv.onrender.com/trade', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    account: '99999999',
    direction: 'BUY',
    symbol: 'XAUUSD',
    entry: 4325.41,
    exit_price: 4348.57,
    profit_usd: 120.26,
    rr_achieved: 2.4,
    session: 'LONDON',
    lots: 0.01
  })
})
.then(r => r.json())
.then(d => console.log(d));