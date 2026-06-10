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
  const isWin   = t.profit_usd > 0;
  const dir     = t.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL';
  const profit  = t.profit_usd;
  const pct     = t.profit_pct ? Math.abs(t.profit_pct).toFixed(2) : Math.abs(t.rr_achieved * 100).toFixed(2);
  const sign    = isWin ? '+' : '-';

  if (isWin) {
    return `🏆 <b>TAKE!!!!</b> 🏆

${dir}  ·  XAU/USD
📍 Entrada:  <code>${t.entry.toFixed(2)}</code>
🏁 Saída:    <code>${t.exit_price.toFixed(2)}</code>

💰 <b>+$${Math.abs(profit).toFixed(2)}</b>  ·  <b>+${pct}% do saldo</b>

🚀🔥💎

<i>AURUM EA — Ouro. Automatizado.</i>`;
  } else {
    return `❌ <b>LOSS</b>

${dir}  ·  XAU/USD
📍 Entrada:  <code>${t.entry.toFixed(2)}</code>
🏁 Saída:    <code>${t.exit_price.toFixed(2)}</code>

💸 <b>-$${Math.abs(profit).toFixed(2)}</b>  ·  <b>-${pct}% do saldo</b>

<i>AURUM EA — Ouro. Automatizado.</i>`;
  }
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
  // Notificação interna apenas — não vai para o canal público
  console.log(`Licença ativada: ${mt5_account} | plano: ${plan}`);
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

// ── Resumo semanal (chame via cron ou manualmente) ──────────────────
app.post('/summary/weekly', async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: 'unauthorized' });

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('aurum_trades')
    .select('*')
    .gte('closed_at', weekAgo);

  if (!data || data.length === 0)
    return res.json({ ok: true, message: 'sem trades na semana' });

  const total   = data.length;
  const wins    = data.filter(t => t.profit_usd > 0).length;
  const losses  = total - wins;
  const profit  = data.reduce((s, t) => s + t.profit_usd, 0);
  const winrate = ((wins / total) * 100).toFixed(1);
  const sign    = profit >= 0 ? '+' : '';

  const msg = `📊 <b>Resumo Semanal — AURUM EA</b>

💰 Resultado: <b>${sign}$${Math.abs(profit).toFixed(2)}</b>
✅ Wins: <b>${wins}</b>  ·  ❌ Losses: <b>${losses}</b>
📈 Win Rate: <b>${winrate}%</b>
🔢 Total de trades: <b>${total}</b>

<i>AURUM EA — Ouro. Automatizado.</i>`;

  await sendTelegram(msg);
  return res.json({ ok: true });
});

// ── Resumo mensal ────────────────────────────────────────────────────
app.post('/summary/monthly', async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: 'unauthorized' });

  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('aurum_trades')
    .select('*')
    .gte('closed_at', monthAgo);

  if (!data || data.length === 0)
    return res.json({ ok: true, message: 'sem trades no mês' });

  const total   = data.length;
  const wins    = data.filter(t => t.profit_usd > 0).length;
  const losses  = total - wins;
  const profit  = data.reduce((s, t) => s + t.profit_usd, 0);
  const winrate = ((wins / total) * 100).toFixed(1);
  const avgRR   = (data.reduce((s, t) => s + Math.abs(t.rr_achieved), 0) / total).toFixed(2);
  const sign    = profit >= 0 ? '+' : '';

  const msg = `🗓 <b>Resumo Mensal — AURUM EA</b>

💰 Resultado: <b>${sign}$${Math.abs(profit).toFixed(2)}</b>
✅ Wins: <b>${wins}</b>  ·  ❌ Losses: <b>${losses}</b>
📈 Win Rate: <b>${winrate}%</b>
📊 RR Médio: <b>${avgRR}R</b>
🔢 Total de trades: <b>${total}</b>

<i>AURUM EA — Ouro. Automatizado.</i>`;

  await sendTelegram(msg);
  return res.json({ ok: true });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AURUM EA API rodando na porta ${PORT}`));