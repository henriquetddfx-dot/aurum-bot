// Rode: node post-historico.js
// Posta os 4 trades historicos no canal AURUM EA

const TOKEN   = "8845963727:AAGlVff0ccJe3rXPbEB1dTv4fPOEYK0tcXs";
const CHANNEL = "-1003667622366";

const trades = [
  {
    ok: true,
    dir: "SELL",
    entry: "4.348,75",
    exit:  "4.329,49",
    profit: "+$99,50",
    rr: "2.0R",
    session: "🇬🇧 London",
    date: "08 Jun 2026",
    risk: "R$50"
  },
  {
    ok: false,
    dir: "BUY",
    entry: "4.340,43",
    exit:  "4.334,72",
    profit: "−$29,62",
    rr: "−1R",
    session: "🇺🇸 New York",
    date: "08 Jun 2026",
    risk: "R$50"
  },
  {
    ok: false,
    dir: "BUY",
    entry: "4.331,66",
    exit:  "4.325,87",
    profit: "−$29,98",
    rr: "−1R",
    session: "🇺🇸 New York",
    date: "08 Jun 2026",
    risk: "R$50"
  },
  {
    ok: true,
    dir: "BUY",
    entry: "4.325,41",
    exit:  "4.348,57",
    profit: "+$120,26",
    rr: "2.4R",
    session: "🇬🇧 London",
    date: "09 Jun 2026",
    risk: "R$50"
  }
];

function buildMessage(t) {
  const emoji  = t.ok ? "✅" : "❌";
  const dir    = t.dir === "BUY" ? "🟢 BUY" : "🔴 SELL";
  return `${emoji} <b>Trade Fechado</b>

${dir}  ·  XAU/USD
📍 Entrada:  <code>${t.entry}</code>
🏁 Saída:    <code>${t.exit}</code>

💰 Resultado:  <b>${t.profit}</b>
⚠️ Risco máx:  ${t.risk}
📊 RR:         <b>${t.rr}</b>

${t.session}  ·  ${t.date}

<i>AURUM EA — Ouro. Automatizado.</i>`;
}

async function post(text) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHANNEL, text, parse_mode: "HTML" })
  });
  const data = await res.json();
  return data.ok;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log("Postando trades históricos no AURUM EA...\n");
  for (let i = 0; i < trades.length; i++) {
    const msg = buildMessage(trades[i]);
    const ok  = await post(msg);
    console.log(`Trade ${i+1}: ${ok ? "✅ postado" : "❌ erro"}`);
    await sleep(1500); // delay entre mensagens
  }
  console.log("\nConcluído.");
})();
