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
  const profit = t.profit_usd;
  const dir    = t.direction === 'BUY' ? '🟢 BUY' : '🔴 SELL';

  // Determina tipo de resultado
  let tipo, header;
  if (profit >= -5 && profit <= 5) {
    tipo   = 'be';
    header = `⚪ <b>BREAK EVEN</b>`;
  } else if (profit > 5 && profit <= 30) {
    tipo   = 'parcial';
    header = `✅ <b>PARCIAL</b>`;
  } else if (profit > 30) {
    tipo   = 'take';
    header = `🏆 <b>TAKE!!!!</b> 🏆`;
  } else {
    tipo   = 'loss';
    header = `❌ <b>LOSS</b>`;
  }

  const profitStr = profit >= 0
    ? `+$${Math.abs(profit).toFixed(2)}`
    : `-$${Math.abs(profit).toFixed(2)}`;

  const emojis = tipo === 'take' ? '\n\n🚀🔥💎' : '';

  return `${header}

${dir}  ·  XAU/USD
📍 Entrada:  <code>${t.entry.toFixed(2)}</code>
🏁 Saída:    <code>${t.exit_price.toFixed(2)}</code>

💰 <b>${profitStr}</b>${emojis}

<i>AURUM EA — Ouro. Automatizado.</i>`;
}

// ── Rotas ─────────────────────────────────────────────────────────────

// Health
app.get('/', (req, res) => res.json({ ok: true }));

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




// ── MetaApi CopyFactory — cadastra subscriber ──────────────────────
const METAAPI_TOKEN    = process.env.METAAPI_TOKEN;
const COPYFACTORY_STRATEGY_ID = 'um1N'; // ID da estratégia AURUM EA

async function registerMetaApiSubscriber(login, password, server, email) {
  // 1. Cria a conta MT5 no MetaApi
  const createRes = await fetch('https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'auth-token': METAAPI_TOKEN
    },
    body: JSON.stringify({
      login,
      password,
      name: `AURUM EA - ${email}`,
      server,
      type: 'cloud-g2',
      platform: 'mt5',
      magic: 0,
      application: 'MetaApi',
      copyFactoryRoles: ['SUBSCRIBER'],
      reliability: 'high'
    })
  });

  const account = await createRes.json();
  if (!account.id) throw new Error('Falha ao criar conta: ' + JSON.stringify(account));

  const accountId = account.id;
  console.log('MetaApi account criada:', accountId);

  // 2. Aguarda a conta ficar deployed (polling simples)
  await new Promise(r => setTimeout(r, 8000));

  // 3. Adiciona como subscriber na estratégia
  const subRes = await fetch(`https://copyfactory-api-v1.agiliumtrade.agiliumtrade.ai/users/current/configuration/strategies/${COPYFACTORY_STRATEGY_ID}/subscribers/${accountId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'auth-token': METAAPI_TOKEN
    },
    body: JSON.stringify({
      symbolMapping: [],
      tradeSizeScaling: { mode: 'balanceRisk' }
    })
  });

  if (!subRes.ok) {
    const err = await subRes.text();
    throw new Error('Falha ao adicionar subscriber: ' + err);
  }

  console.log('Subscriber adicionado:', accountId);
  return { accountId };
}

async function removeMetaApiSubscriber(metaapiId) {
  if (!metaapiId) return;
  // Remove da estratégia
  await fetch(`https://copyfactory-api-v1.agiliumtrade.agiliumtrade.ai/users/current/configuration/strategies/${COPYFACTORY_STRATEGY_ID}/subscribers/${metaapiId}`, {
    method: 'DELETE',
    headers: { 'auth-token': METAAPI_TOKEN }
  });
  // Undeploy a conta
  await fetch(`https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts/${metaapiId}/undeploy`, {
    method: 'POST',
    headers: { 'auth-token': METAAPI_TOKEN }
  });
  console.log('Subscriber removido:', metaapiId);
}

// ── /ativar — recebe credenciais do cliente e cadastra no MetaApi ──
app.post('/ativar', async (req, res) => {
  const { email, login, password, server } = req.body;
  if (!email || !login || !password || !server)
    return res.status(400).json({ error: 'missing_fields' });

  // Verifica se o email tem assinatura ativa na HubLa/Supabase
  const { data: lic } = await supabase
    .from('aurum_licenses')
    .select('*')
    .eq('email', email)
    .eq('active', true)
    .single();

  if (!lic) return res.json({ ok: false, error: 'not_found' });

  // Salva credenciais MT5 do cliente (criptografadas em produção futura)
  await supabase
    .from('aurum_licenses')
    .update({
      mt5_account: login,
      mt5_server:  server,
      mt5_password: password, // TODO: criptografar com AES antes de salvar
      status: 'pending_metaapi'
    })
    .eq('email', email);

  // Cadastra conta no MetaApi como Subscriber
  try {
    const metaapiResult = await registerMetaApiSubscriber(login, password, server, email);
    if (metaapiResult.accountId) {
      await supabase
        .from('aurum_licenses')
        .update({ metaapi_id: metaapiResult.accountId, status: 'active' })
        .eq('email', email);
    }
  } catch(e) {
    console.error('MetaApi error:', e.message);
    // Não falha o request — notifica admin para ativar manualmente
  }

  // Notifica você via Telegram (privado — não vai pro canal público)
  const ADMIN_CHAT = process.env.ADMIN_TELEGRAM_ID;
  if (ADMIN_CHAT) {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: ADMIN_CHAT,
        text: `🔔 <b>Nova ativação pendente</b>\n\nEmail: <code>${email}</code>\nConta MT5: <code>${login}</code>\nServidor: <code>${server}</code>\n\n→ Ativar no MetaApi`,
        parse_mode: 'HTML'
      })
    });
  }

  console.log(`Ativação: ${email} | MT5: ${login} | Server: ${server}`);
  return res.json({ ok: true });
});

// ── Webhook HubLa — dispara quando cliente paga ────────────────────
app.post('/webhook/hubla', async (req, res) => {
  const event = req.body;
  console.log('HubLa webhook:', JSON.stringify(event).substring(0, 200));

  // Evento de nova assinatura
  if (event.type === 'subscription.created' || event.type === 'purchase.completed') {
    const email = event.data?.customer?.email || event.data?.email;
    const name  = event.data?.customer?.name  || event.data?.name || '';
    if (!email) return res.json({ ok: true });

    // Cria licença pendente no Supabase
    await supabase.from('aurum_licenses').upsert({
      email,
      name,
      plan:   'monthly',
      active: true,
      status: 'pending_activation',
      expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString()
    }, { onConflict: 'email' });

    // Notifica você
    const ADMIN_CHAT = process.env.ADMIN_TELEGRAM_ID;
    if (ADMIN_CHAT) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_CHAT,
          text: `💳 <b>Nova assinatura!</b>\n\nNome: ${name}\nEmail: <code>${email}</code>\nStatus: aguardando ativação MT5\n\n→ aurum.tddprotocol.com/ativar`,
          parse_mode: 'HTML'
        })
      });
    }

    console.log(`Nova assinatura: ${email}`);
  }

  // Evento de cancelamento/chargeback
  if (event.type === 'subscription.cancelled' || event.type === 'subscription.expired') {
    const email = event.data?.customer?.email || event.data?.email;
    if (!email) return res.json({ ok: true });

    const { data: licData } = await supabase
      .from('aurum_licenses')
      .select('metaapi_id')
      .eq('email', email)
      .single();

    await supabase
      .from('aurum_licenses')
      .update({ active: false, status: 'cancelled' })
      .eq('email', email);

    // Remove do MetaApi automaticamente
    if (licData && licData.metaapi_id) {
      await removeMetaApiSubscriber(licData.metaapi_id);
    }
    console.log(`Assinatura cancelada: ${email}`);
  }

  return res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AURUM EA API rodando na porta ${PORT}`));