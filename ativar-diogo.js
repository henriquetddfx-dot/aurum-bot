fetch('https://aurum-bot-y1fv.onrender.com/ativar', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'diogobrafe@gmail.com',
    login: '196625051',
    password: 'u8Ws$Xws',
    server: 'Exness-MT5Real11'
  })
}).then(r => r.json()).then(console.log)