require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MercadoPagoConfig, Payment } = require('mercadopago');

const app = express();

// ── Mercado Pago Client ──────────────────────────────────────────────────────
const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 5000, idempotencyKey: 'abc' }
});

const payment = new Payment(client);

// ── Middlewares ──────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'SPC Backend rodando ✅' });
});

// ── POST /api/pagamento/cartao ───────────────────────────────────────────────
// Recebe o token do cartão gerado pelo SDK do frontend e processa a cobrança
app.post('/api/pagamento/cartao', async (req, res) => {
  const {
    token,          // token gerado pelo mp.createCardToken() no frontend
    cnpj,           // CNPJ consultado
    amount,         // valor total em reais (ex: 22.90)
    installments,   // parcelas (1, 2, 3...)
    paymentMethodId,// "visa", "master", "amex", etc — retornado pelo SDK
    email,          // e-mail do pagador
    cpf,            // CPF do pagador (obrigatório pelo MP)
    description     // descrição do produto
  } = req.body;

  // Validações básicas
  if (!token || !cnpj || !amount || !email || !cpf) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  try {
    const result = await payment.create({
      body: {
        transaction_amount: Number(amount),
        token,
        description: description || `Consulta PJ Essencial - CNPJ ${cnpj}`,
        installments: Number(installments) || 1,
        payment_method_id: paymentMethodId,
        payer: {
          email,
          identification: { type: 'CPF', number: cpf.replace(/\D/g, '') }
        },
        metadata: { cnpj_consultado: cnpj }
      },
      requestOptions: { idempotencyKey: `${cnpj}-${Date.now()}` }
    });

    const { status, status_detail, id } = result;

    if (status === 'approved') {
      // Aqui você dispararia a consulta SPC e enviaria o relatório por e-mail
      return res.json({
        status: 'approved',
        paymentId: id,
        message: 'Pagamento aprovado! Relatório enviado por e-mail.'
      });
    }

    // Pagamentos pendentes ou rejeitados
    return res.json({ status, status_detail, paymentId: id });

  } catch (err) {
    console.error('Erro cartão:', err);
    return res.status(500).json({ error: 'Erro ao processar pagamento.' });
  }
});

// ── POST /api/pagamento/pix ──────────────────────────────────────────────────
// Gera um QR Code e código copia-e-cola Pix
app.post('/api/pagamento/pix', async (req, res) => {
  const { cnpj, amount, email, cpf, description } = req.body;

  if (!cnpj || !amount || !email || !cpf) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  try {
    const result = await payment.create({
      body: {
        transaction_amount: Number(amount),
        description: description || `Consulta PJ Essencial - CNPJ ${cnpj}`,
        payment_method_id: 'pix',
        payer: {
          email,
          identification: { type: 'CPF', number: cpf.replace(/\D/g, '') }
        },
        metadata: { cnpj_consultado: cnpj }
      },
      requestOptions: { idempotencyKey: `pix-${cnpj}-${Date.now()}` }
    });

    const pixData = result.point_of_interaction?.transaction_data;

    return res.json({
      status: result.status,
      paymentId: result.id,
      qrCode: pixData?.qr_code,          // código copia-e-cola
      qrCodeBase64: pixData?.qr_code_base64, // imagem do QR em base64
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() // 30 min
    });

  } catch (err) {
    console.error('Erro Pix:', err);
    return res.status(500).json({ error: 'Erro ao gerar Pix.' });
  }
});

// ── POST /api/pagamento/boleto ───────────────────────────────────────────────
// Gera um boleto bancário com vencimento em 3 dias úteis
app.post('/api/pagamento/boleto', async (req, res) => {
  const { cnpj, amount, email, cpf, nome, description } = req.body;

  if (!cnpj || !amount || !email || !cpf || !nome) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  // Vencimento: 3 dias a partir de hoje
  const vencimento = new Date();
  vencimento.setDate(vencimento.getDate() + 3);

  try {
    const result = await payment.create({
      body: {
        transaction_amount: Number(amount),
        description: description || `Consulta PJ Essencial - CNPJ ${cnpj}`,
        payment_method_id: 'bolbradesco', // ou 'boletobacellar'
        payer: {
          email,
          first_name: nome.split(' ')[0],
          last_name: nome.split(' ').slice(1).join(' ') || '-',
          identification: { type: 'CPF', number: cpf.replace(/\D/g, '') },
          address: {
            zip_code: '01310100',  // substitua pelo CEP real do pagador
            street_name: 'Não informado',
            street_number: '0',
            neighborhood: 'Não informado',
            city: 'São Paulo',
            federal_unit: 'SP'
          }
        },
        date_of_expiration: vencimento.toISOString(),
        metadata: { cnpj_consultado: cnpj }
      },
      requestOptions: { idempotencyKey: `boleto-${cnpj}-${Date.now()}` }
    });

    return res.json({
      status: result.status,
      paymentId: result.id,
      boletoUrl: result.transaction_details?.external_resource_url, // link para imprimir
      barcode: result.barcode?.content, // linha digitável
      expiresAt: vencimento.toISOString()
    });

  } catch (err) {
    console.error('Erro boleto:', err);
    return res.status(500).json({ error: 'Erro ao gerar boleto.' });
  }
});

// ── POST /api/webhook ────────────────────────────────────────────────────────
// Recebe notificações do Mercado Pago (pagamento aprovado, cancelado, etc.)
// Configure a URL em: https://www.mercadopago.com.br/developers/panel/webhooks
app.post('/api/webhook', async (req, res) => {
  const { type, data } = req.body;

  if (type === 'payment') {
    try {
      const result = await payment.get({ id: data.id });
      const { status, metadata } = result;

      if (status === 'approved') {
        const cnpj = metadata?.cnpj_consultado;
        console.log(`✅ Pagamento aprovado para CNPJ: ${cnpj}`);
        // Aqui você dispara a consulta SPC e envia o relatório
        // Ex: await enviarRelatorio(cnpj, result.payer.email);
      }
    } catch (err) {
      console.error('Erro webhook:', err);
    }
  }

  // O MP exige resposta 200 imediata
  res.sendStatus(200);
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});
