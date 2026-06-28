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
  const { secret, mt5_account, plan, expires_at, email, name } = req.body;
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: 'unauthorized' });

  const { data, error } = await supabase
    .from('aurum_licenses')
    .upsert({ mt5_account, email: email || null, name: name || null, plan: plan || 'monthly', active: true, expires_at, status: 'pending_activation' })
    .select().single();

  if (error) return res.status(500).json({ error });
  console.log(`Licença ativada: ${mt5_account} | ${email} | plano: ${plan}`);
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
      symbolMapping: [
        { from: 'XAUUSD',  to: 'XAUUSDm' },
        { from: 'XAUUSDm', to: 'XAUUSDm' }
      ],
      tradeSizeScaling: { mode: 'balanceRisk' }
    }),
    agent: new (require('https').Agent)({ rejectUnauthorized: false })
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
    // Notifica admin sobre falha
    const ADMIN_CHAT = process.env.ADMIN_TELEGRAM_ID;
    if (ADMIN_CHAT) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_CHAT,
          text: `⚠️ <b>Falha na ativação MetaApi</b>\n\nEmail: <code>${email}</code>\nLogin: <code>${login}</code>\nServidor: <code>${server}</code>\nErro: ${e.message}\n\n→ Ativar manualmente no MetaApi`,
          parse_mode: 'HTML'
        })
      });
    }
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

  // Evento de pagamento confirmado (evento principal — funciona com PIX e cartão)
  if (event.type === 'invoice.payment_succeeded') {
    const payer = event.event?.invoice?.payer || event.event?.user || {};
    const email = payer.email;
    const firstName = payer.firstName || '';
    const lastName  = payer.lastName  || '';
    const name = `${firstName} ${lastName}`.trim();
    if (!email) return res.json({ ok: true });

    await supabase.from('aurum_licenses').upsert({
      email,
      name,
      plan: 'monthly',
      active: true,
      status: 'pending_activation',
      expires_at: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString()
    }, { onConflict: 'email' });

    const ADMIN_CHAT = process.env.ADMIN_TELEGRAM_ID;
    if (ADMIN_CHAT) {
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_CHAT,
          text: `💳 <b>Pagamento confirmado!</b>\n\nNome: ${name}\nEmail: <code>${email}</code>\nStatus: aguardando ativação MT5\n\n→ aurum.tddprotocol.com/ativar`,
          parse_mode: 'HTML'
        })
      });
    }
    console.log(`Pagamento confirmado: ${email}`);
  }

  // Evento de nova assinatura (fallback)
  if (event.type === 'subscription.created' || event.type === 'purchase.completed') {
    const payer = event.event?.subscription?.payer || event.event?.user || {};
    const email = payer.email || event.data?.customer?.email || event.data?.email;
    const firstName = payer.firstName || '';
    const lastName  = payer.lastName  || '';
    const name  = `${firstName} ${lastName}`.trim() || event.data?.customer?.name || event.data?.name || '';
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
    const payer = event.event?.subscription?.payer || event.event?.user || {};
    const email = payer.email || event.data?.customer?.email || event.data?.email;
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


// ── Health Check MetaApi ─────────────────────────────────────────────
// Chamado pelo cron-job toda manhã às 8h
app.post('/health/metaapi', async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: 'unauthorized' });

  try {
    // Busca todas as contas no MetaApi
    const r = await fetch('https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts?limit=50', {
      headers: { 'auth-token': METAAPI_TOKEN }
    });
    const accounts = await r.json();

    if (!Array.isArray(accounts)) {
      await notifyAdmin('⚠️ <b>AURUM EA — Health Check</b>\n\nErro ao buscar contas no MetaApi.');
      return res.json({ ok: false, error: 'invalid_response' });
    }

    const issues = [];
    let allOk = true;

    for (const acc of accounts) {
      const state      = acc.state;        // DEPLOYED, UNDEPLOYED, etc
      const connected  = acc.connectionStatus; // CONNECTED, DISCONNECTED
      const name       = acc.name || acc.login;

      if (state !== 'DEPLOYED' || connected === 'DISCONNECTED') {
        allOk = false;
        issues.push(`❌ <code>${name}</code> — ${state} / ${connected}`);
      }
    }

    const ADMIN_CHAT = process.env.ADMIN_TELEGRAM_ID;

    if (!allOk && ADMIN_CHAT) {
      const msg = `⚠️ <b>AURUM EA — Alerta de conexão</b>\n\n${issues.join('\n')}\n\n→ Verifique o MetaApi agora`;
      await fetch(`https://api.telegram.org/bot\${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: ADMIN_CHAT, text: msg, parse_mode: 'HTML' })
      });
      console.log('Health check: problemas detectados');
    } else if (ADMIN_CHAT) {
      await fetch(`https://api.telegram.org/bot\${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: ADMIN_CHAT,
          text: `✅ <b>AURUM EA — Health Check</b>\n\nTodas as contas conectadas normalmente.\nTotal: \${accounts.length} contas`,
          parse_mode: 'HTML'
        })
      });
      console.log('Health check: tudo OK');
    }

    return res.json({ ok: true, allOk, total: accounts.length, issues });
  } catch(e) {
    console.error('Health check error:', e.message);
    return res.json({ ok: false, error: e.message });
  }
});


// ── Monitor de copy — verifica se trades da master foram copiados ────
// Chamado a cada 5 minutos via cron-job.org
app.post('/monitor/copy', async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: 'unauthorized' });

  try {
    const ADMIN_CHAT = process.env.ADMIN_TELEGRAM_ID;
    const headers = { 'auth-token': METAAPI_TOKEN, 'Content-Type': 'application/json' };

    // Busca todas as contas
    const accRes = await fetch('https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai/users/current/accounts?limit=50', { headers });
    const accounts = await accRes.json();
    if (!Array.isArray(accounts)) return res.json({ ok: false, error: 'invalid_accounts' });

    // Separa master e slaves
    const master = accounts.find(a => a.login === '83101728' || a.name === 'aurum EA');
    const slaves = accounts.filter(a => a.id !== master?.id);

    if (!master) return res.json({ ok: false, error: 'master_not_found' });

    // Busca posições abertas da master
    const posRes = await fetch(`https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${master.id}/positions`, { headers });
    const masterPositions = await posRes.json();

    if (!Array.isArray(masterPositions) || masterPositions.length === 0)
      return res.json({ ok: true, message: 'no_open_positions' });

    const issues = [];

    // Verifica cada slave
    for (const slave of slaves) {
      if (slave.connectionStatus === 'DISCONNECTED') {
        issues.push(`⚠️ Slave <code>${slave.name || slave.login}</code> — DESCONECTADA`);
        continue;
      }

      const slaveRes = await fetch(`https://mt-client-api-v1.london.agiliumtrade.ai/users/current/accounts/${slave.id}/positions`, { headers });
      const slavePositions = await slaveRes.json();

      if (!Array.isArray(slavePositions)) continue;

      // Verifica se cada posição da master existe na slave
      for (const pos of masterPositions) {
        const copied = slavePositions.some(sp =>
          sp.symbol === pos.symbol &&
          sp.type === pos.type &&
          Math.abs(new Date(sp.time) - new Date(pos.time)) < 5 * 60 * 1000 // 5 min de tolerância
        );
        if (!copied) {
          issues.push(`❌ Trade não copiado na <code>${slave.name || slave.login}</code>\n   ${pos.type} ${pos.symbol} @ ${pos.openPrice}`);
        }
      }
    }

    if (issues.length > 0 && ADMIN_CHAT) {
      const msg = `🚨 <b>AURUM EA — Copy incompleto</b>\n\n${issues.join('\n\n')}\n\n→ Verifique o MetaApi agora`;
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: ADMIN_CHAT, text: msg, parse_mode: 'HTML' })
      });
      console.log('Monitor: problemas detectados', issues.length);
    } else {
      console.log('Monitor: copy OK, posições abertas:', masterPositions.length);
    }

    return res.json({ ok: true, positions: masterPositions.length, issues: issues.length });
  } catch(e) {
    console.error('Monitor error:', e.message);
    return res.json({ ok: false, error: e.message });
  }
});


// ── Resumo Semanal ───────────────────────────────────────────────────
app.post('/summary/weekly', async (req, res) => {
  const { secret } = req.body;
  if (secret !== process.env.ADMIN_SECRET)
    return res.status(401).json({ error: 'unauthorized' });

  try {
    // Lê historico da VPS via arquivo ou usa MetaApi
    // Por enquanto gera resumo baseado nos trades do Supabase
    const { data: trades } = await supabase
      .from('aurum_trades')
      .select('*')
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false });

    if (!trades || trades.length === 0) {
      const msg = `📊 <b>AURUM EA — Resumo Semanal</b>\n\nNenhuma operação registrada esta semana.\n\n<i>AURUM EA — Ouro. Automatizado.</i>`;
      await fetch(`https://api.telegram.org/bot\${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHANNEL, text: msg, parse_mode: 'HTML' })
      });
      return res.json({ ok: true, trades: 0 });
    }

    const wins   = trades.filter(t => t.profit > 0);
    const losses = trades.filter(t => t.profit <= 0);
    const total  = trades.reduce((s, t) => s + (t.profit || 0), 0);
    const best   = trades.reduce((a, b) => (a.profit > b.profit ? a : b));
    const worst  = trades.reduce((a, b) => (a.profit < b.profit ? a : b));
    const winRate = trades.length > 0 ? Math.round((wins.length / trades.length) * 100) : 0;

    const resultEmoji = total >= 0 ? '🟢' : '🔴';
    const sign = total >= 0 ? '+' : '';

    const msg = `📊 <b>AURUM EA — Resumo Semanal</b>\n\n` +
      `Operações: <b>${trades.length}</b>  |  Win rate: <b>${winRate}%</b>\n` +
      `✅ Wins: <b>${wins.length}</b>   ❌ Losses: <b>${losses.length}</b>\n\n` +
      `${resultEmoji} Resultado: <b>${sign}$${total.toFixed(2)}</b>\n\n` +
      `🏆 Melhor trade: <b>+$${best.profit?.toFixed(2)}</b>\n` +
      `📉 Pior trade: <b>$${worst.profit?.toFixed(2)}</b>\n\n` +
      `<i>AURUM EA — Ouro. Automatizado.</i>`;

    await fetch(`https://api.telegram.org/bot\${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHANNEL, text: msg, parse_mode: 'HTML' })
    });

    console.log(`Resumo semanal: \${trades.length} trades, resultado: \${total.toFixed(2)}`);
    return res.json({ ok: true, trades: trades.length, total });
  } catch(e) {
    console.error('Resumo semanal error:', e.message);
    return res.json({ ok: false, error: e.message });
  }
});


// ── Autenticacao /minha-conta ────────────────────────────────────────
const authCodes = {}; // { email: { code, expires } }

app.post('/auth/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email obrigatorio' });

  // Verifica se email tem licenca ativa
  const { data: license } = await supabase
    .from('aurum_licenses')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .eq('active', true)
    .single();

  if (!license) return res.status(404).json({ error: 'email nao encontrado' });

  // Gera codigo de 6 digitos
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  authCodes[email.toLowerCase()] = { code, expires: Date.now() + 10 * 60 * 1000 }; // 10 min

  // Envia email via Resend
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({
      from: 'AURUM EA <onboarding@resend.dev>',
      to: email,
      subject: 'Seu codigo de acesso — AURUM EA',
      html: `
        <div style="background:#000;color:#fff;font-family:Inter,sans-serif;padding:40px;max-width:480px;margin:0 auto;border-radius:16px;">
          <p style="font-size:13px;color:#6e6e73;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:16px;">AURUM EA</p>
          <h1 style="font-size:28px;font-weight:600;letter-spacing:-0.02em;margin-bottom:8px;">Seu codigo de acesso</h1>
          <p style="font-size:15px;color:#aaa;margin-bottom:32px;">Use o codigo abaixo para acessar sua conta. Valido por 10 minutos.</p>
          <div style="background:#111;border:1px solid #222;border-radius:12px;padding:24px;text-align:center;margin-bottom:32px;">
            <p style="font-size:42px;font-weight:700;letter-spacing:0.15em;color:#fff;margin:0;">${code}</p>
          </div>
          <p style="font-size:13px;color:#555;">Se voce nao solicitou este codigo, ignore este email.</p>
          <p style="font-size:12px;color:#333;margin-top:24px;">AURUM EA — Ouro. Automatizado.</p>
        </div>
      `
    })
  });

  const emailData = await emailRes.json();
  if (!emailRes.ok) {
    console.error('Resend error:', emailData);
    return res.status(500).json({ error: 'erro ao enviar email' });
  }

  console.log(`Codigo enviado para ${email}`);
  return res.json({ ok: true, message: 'Codigo enviado para seu email' });
});

app.post('/auth/verify-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'email e codigo obrigatorios' });

  const stored = authCodes[email.toLowerCase()];
  if (!stored) return res.status(400).json({ error: 'codigo expirado ou nao solicitado' });
  if (Date.now() > stored.expires) {
    delete authCodes[email.toLowerCase()];
    return res.status(400).json({ error: 'codigo expirado' });
  }
  if (stored.code !== code) return res.status(400).json({ error: 'codigo incorreto' });

  delete authCodes[email.toLowerCase()];

  // Busca dados da licenca
  const { data: license } = await supabase
    .from('aurum_licenses')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .single();

  // Busca trades da ultima semana
  const { data: trades } = await supabase
    .from('aurum_trades')
    .select('*')
    .eq('mt5_account', license.mt5_account)
    .gte('closed_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(20);

  return res.json({ ok: true, license, trades: trades || [] });
});

app.get('/minha-conta/dados', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: 'email obrigatorio' });

  const { data: license } = await supabase
    .from('aurum_licenses')
    .select('*')
    .eq('email', email.toLowerCase().trim())
    .eq('active', true)
    .single();

  if (!license) return res.status(404).json({ error: 'nao encontrado' });

  const { data: trades } = await supabase
    .from('aurum_trades')
    .select('*')
    .eq('mt5_account', license.mt5_account)
    .gte('closed_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false })
    .limit(20);

  return res.json({ ok: true, license, trades: trades || [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AURUM EA API rodando na porta ${PORT}`));