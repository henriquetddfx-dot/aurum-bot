require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const fetch   = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHANNEL = process.env.TELEGRAM_CHANNEL_ID; // -1003667622366

// ── Telegram ─────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHANNEL, text, parse_mode: 'HTML' })
  });
}

function buildTradeMessage(t) {
  const emoji  = t.profit_usd >= 0 ? '✅' : '❌';
  const dir    = t.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL';
  const sign   = t.profit_usd >= 0 ? '+' : '';
  const rr     = t.rr_achieved >= 0
    ? `${t.rr_achieved.toFixed(1)}R`
    : `${t.rr_achieved.toFixed(1)}R`;
  const sess   = t.session === 'LONDON' ? '🇬🇧 London' : '🇺🇸 New York';

  return `${emoji} <b>Trade Fechado</b>

${dir}  ·  XAU/USD
📍 Entrada:  <code>${t.entry.toFixed(2)}</code>
🏁 Saída:    <code>${t.exit_price.toFixed(2)}</code>

💰 Resultado:  <b>${sign}$${Math.abs(t.profit_usd).toFixed(2)}</b>
⚠️ Risco máx:  R$50
📊 RR:         <b>${rr}</b>

${sess}

<i>AURUM EA — Ouro. Automatizado.</i>`;
}

// ── Rotas ─────────────────────────────────────────────────────────────

// Health
app.get('/', (req, res) => res.json({ status: 'AURUM EA API online ✅' }));

// Validação de licença (chamada pelo EA no OnInit)
app.get('/license', async (req, res) => {
  const { account } = req.query;
  if (!account) return res.status(400).json({ valid: false });

  const { data, error } = await supabase
    .from('aurum_licenses')
    .select('*')
    .eq('mt5_account', account)
    .eq('active', true)
    .single();

  if (error || !data) return res.json({ valid: false, reason: 'not_found' });
  if (data.expires_at && new Date(data.expires_at) < new Date())
    return res.json({ valid: false, reason: 'expired' });

  return res.json({ valid: true, plan: data.plan });
});

// Notificação de trade fechado (chamada pelo EA)
app.post('/trade', async (req, res) => {
  const t = req.body;
  const required = ['account', 'direction', 'profit_usd', 'entry', 'exit_price'];
  for (const f of required)
    if (t[f] === undefined) return res.status(400).json({ error: `missing: ${f}` });

  // Verifica licença
  const { data: lic } = await supabase
    .from('aurum_licenses')
    .select('active')
    .eq('mt5_account', t.account)
    .eq('active', true)
    .single();
  if (!lic) return res.status(403).json({ error: 'unlicensed' });

  // Salva no banco
  await supabase.from('aurum_trades').insert({
    mt5_account:  t.account,
    symbol:       t.symbol || 'XAUUSD',
    direction:    t.direction,
    lots:         t.lots || 0,
    entry:        t.entry,
    exit_price:   t.exit_price,
    profit_usd:   t.profit_usd,
    rr_achieved:  t.rr_achieved || 0,
    session:      t.session || 'UNKNOWN',
    closed_at:    new Date().toISOString()
  });

  // Posta no Telegram
  await sendTelegram(buildTradeMessage(t));

  return res.json({ ok: true });
});

// Admin: adiciona licença
app.post('/admin/license', async (req, res) => {
  const { secret, mt5_account, plan, expires_at } = req.body;
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: 'unauthorized' });

  const { data, error } = await supabase
    .from('aurum_licenses')
    .upsert({ mt5_account, plan: plan || 'monthly', active: true, expires_at })
    .select().single();

  if (error) return res.status(500).json({ error });
  await sendTelegram(`🔑 Nova licença ativada\nConta: <code>${mt5_account}</code>`);
  return res.json({ ok: true, data });
});

// Admin: desativa licença
app.delete('/admin/license/:account', async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: 'unauthorized' });

  await supabase
    .from('aurum_licenses')
    .update({ active: false })
    .eq('mt5_account', req.params.account);

  return res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AURUM EA API rodando na porta ${PORT}`));
