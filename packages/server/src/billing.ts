/** Integração de cobrança do Vox com o Checkout Pro do Mercado Pago. */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { database } from './sqlite.js';

export type PaidPlan =
  | '50-basic' | '50-bot'
  | '100-basic' | '100-bot'
  | '200-basic' | '200-bot'
  | '300-basic' | '300-bot'
  /** Chaves antigas mantidas apenas para ler pedidos já salvos. */
  | '254-basic' | '254-bot';
export type BillingOrderStatus = 'pending' | 'approved' | 'failed';
export type BillingOrderKind = 'initial' | 'renewal';

/** Cada pagamento aprovado libera 30 dias de uso. */
export const BILLING_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export interface BillingPlan {
  key: PaidPlan;
  label: string;
  title: string;
  slots: number;
  botEnabled: boolean;
  priceCents: number;
  enabled: boolean;
}

export interface BillingOrder {
  id: string;
  accountId: number;
  plan: PaidPlan;
  kind: BillingOrderKind;
  amountCents: number;
  serverName: string;
  serverSlug: string;
  serverPassword: string;
  status: BillingOrderStatus;
  preferenceId: string;
  paymentId: string;
  serverId: number | null;
  lastError: string;
  paidAt: number | null;
  expiresAt: number | null;
  paymentMethodId: string;
  paymentTypeId: string;
  statusDetail: string;
  createdAt: number;
  updatedAt: number;
}

export interface MercadoPagoPayment {
  id?: string | number;
  status?: string;
  transaction_amount?: number;
  currency_id?: string;
  external_reference?: string;
  payment_method_id?: string;
  payment_type_id?: string;
  date_approved?: string;
  status_detail?: string;
}

const plans: Record<Exclude<PaidPlan, '254-basic' | '254-bot'>, Omit<BillingPlan, 'priceCents' | 'enabled'> & { priceCents: number }> = {
  '50-basic': { key: '50-basic', label: '50 slots · sem bot', title: 'Vox 50', slots: 50, botEnabled: false, priceCents: config.mp50PriceCents },
  '50-bot': { key: '50-bot', label: '50 slots · com Rubinot (+R$ 80)', title: 'Vox 50 Rubinot', slots: 50, botEnabled: true, priceCents: config.mp50PriceCents + config.mpBotAddonPriceCents },
  '100-basic': { key: '100-basic', label: '100 slots · sem bot', title: 'Vox 100', slots: 100, botEnabled: false, priceCents: config.mp100PriceCents },
  '100-bot': { key: '100-bot', label: '100 slots · com Rubinot (+R$ 80)', title: 'Vox 100 Rubinot', slots: 100, botEnabled: true, priceCents: config.mp100PriceCents + config.mpBotAddonPriceCents },
  '200-basic': { key: '200-basic', label: '200 slots · sem bot', title: 'Vox 200', slots: 200, botEnabled: false, priceCents: config.mp200PriceCents },
  '200-bot': { key: '200-bot', label: '200 slots · com Rubinot (+R$ 80)', title: 'Vox 200 Rubinot', slots: 200, botEnabled: true, priceCents: config.mp200PriceCents + config.mpBotAddonPriceCents },
  '300-basic': { key: '300-basic', label: '300+ slots · sem bot', title: 'Vox 300+', slots: 300, botEnabled: false, priceCents: config.mp300PriceCents },
  '300-bot': { key: '300-bot', label: '300+ slots · com Rubinot (+R$ 80)', title: 'Vox 300+ Rubinot', slots: 300, botEnabled: true, priceCents: config.mp300PriceCents + config.mpBotAddonPriceCents },
};

const legacyAliases: Record<string, Exclude<PaidPlan, '254-basic' | '254-bot'>> = {
  private: '50-bot',
  war: '100-bot',
  '254-basic': '300-basic',
  '254-bot': '300-bot',
};

export function billingPlans(): BillingPlan[] {
  return Object.values(plans).map((plan) => ({
    ...plan,
    enabled: plan.priceCents > 0 && config.mpAccessToken !== '' && config.mpWebhookSecret !== '',
  }));
}

export function getBillingPlan(value: string): BillingPlan | undefined {
  const plan = plans[legacyAliases[value] ?? value as Exclude<PaidPlan, '254-basic' | '254-bot'>];
  if (!plan) return undefined;
  return {
    ...plan,
    enabled: plan.priceCents > 0 && config.mpAccessToken !== '' && config.mpWebhookSecret !== '',
  };
}

export function createOrder(input: {
  accountId: number;
  plan: PaidPlan;
  kind?: BillingOrderKind;
  amountCents: number;
  serverName: string;
  serverSlug: string;
  serverPassword: string;
  serverId?: number | null;
}): BillingOrder {
  const now = Date.now();
  const order: BillingOrder = {
    id: `vox-${randomBytes(12).toString('hex')}`,
    accountId: input.accountId,
    plan: input.plan,
    kind: input.kind ?? 'initial',
    amountCents: input.amountCents,
    serverName: input.serverName,
    serverSlug: input.serverSlug,
    serverPassword: input.serverPassword,
    status: 'pending',
    preferenceId: '',
    paymentId: '',
    serverId: input.serverId ?? null,
    lastError: '',
    paidAt: null,
    expiresAt: null,
    paymentMethodId: '',
    paymentTypeId: '',
    statusDetail: '',
    createdAt: now,
    updatedAt: now,
  };
  database.prepare(`
    INSERT INTO payment_orders (
      id, account_id, plan, amount_cents, server_name, server_slug,
      server_password, status, preference_id, payment_id, server_id,
      last_error, created_at, updated_at, kind, paid_at, expires_at,
      payment_method_id, payment_type_id, status_detail
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.id,
    order.accountId,
    order.plan,
    order.amountCents,
    order.serverName,
    order.serverSlug,
    order.serverPassword,
    order.status,
    order.preferenceId,
    order.paymentId,
    order.serverId,
    order.lastError,
    order.createdAt,
    order.updatedAt,
    order.kind,
    order.paidAt,
    order.expiresAt,
    order.paymentMethodId,
    order.paymentTypeId,
    order.statusDetail,
  );
  return order;
}

export function findOrder(id: string): BillingOrder | undefined {
  const row = database.prepare('SELECT * FROM payment_orders WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? fromRow(row) : undefined;
}

export function listOrders(accountId: number): BillingOrder[] {
  const rows = database.prepare('SELECT * FROM payment_orders WHERE account_id = ? ORDER BY created_at DESC').all(accountId) as Record<string, unknown>[];
  return rows.map(fromRow);
}

export function findLatestApprovedOrderForServer(accountId: number, serverId: number): BillingOrder | undefined {
  const row = database.prepare(`
    SELECT * FROM payment_orders
    WHERE account_id = ? AND server_id = ? AND status = 'approved'
    ORDER BY COALESCE(expires_at, 0) DESC, updated_at DESC
    LIMIT 1
  `).get(accountId, serverId) as Record<string, unknown> | undefined;
  return row ? fromRow(row) : undefined;
}

export function updateOrder(id: string, update: Partial<Pick<BillingOrder, 'status' | 'preferenceId' | 'paymentId' | 'serverId' | 'lastError' | 'paidAt' | 'expiresAt' | 'paymentMethodId' | 'paymentTypeId' | 'statusDetail'>>): BillingOrder | undefined {
  const current = findOrder(id);
  if (!current) return undefined;
  const next = { ...current, ...update, updatedAt: Date.now() };
  database.prepare(`
    UPDATE payment_orders SET status = ?, preference_id = ?, payment_id = ?,
      server_id = ?, last_error = ?, paid_at = ?, expires_at = ?,
      payment_method_id = ?, payment_type_id = ?, status_detail = ?,
      updated_at = ? WHERE id = ?
  `).run(
    next.status,
    next.preferenceId,
    next.paymentId,
    next.serverId,
    next.lastError,
    next.paidAt,
    next.expiresAt,
    next.paymentMethodId,
    next.paymentTypeId,
    next.statusDetail,
    next.updatedAt,
    next.id,
  );
  return next;
}

export async function createMercadoPagoPreference(order: BillingOrder, email: string): Promise<{ initPoint: string; preferenceId: string }> {
  if (!config.mpAccessToken) throw new Error('Mercado Pago sem Access Token de produção');
  const response = await fetch('https://api.mercadopago.com/checkout/preferences', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.mpAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      items: [{
        id: order.plan,
        title: `Vox · ${getBillingPlan(order.plan)?.title ?? order.plan}`,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: order.amountCents / 100,
      }],
      payer: { email },
      external_reference: order.id,
      notification_url: config.mpWebhookUrl,
      back_urls: {
        success: `${config.publicOrigin}/contratar?plan=${order.plan}&order=${order.id}&status=success`,
        pending: `${config.publicOrigin}/contratar?plan=${order.plan}&order=${order.id}&status=pending`,
        failure: `${config.publicOrigin}/contratar?plan=${order.plan}&order=${order.id}&status=failure`,
      },
      auto_return: 'approved',
    }),
  });
  if (!response.ok) {
    console.error(`[vox] Mercado Pago recusou a preferência (${response.status})`);
    throw new Error('não foi possível iniciar o pagamento no Mercado Pago');
  }
  const body = await response.json() as { id?: string; init_point?: string };
  if (!body.id || !body.init_point) throw new Error('Mercado Pago não retornou o link de pagamento');
  updateOrder(order.id, { preferenceId: body.id });
  return { preferenceId: body.id, initPoint: body.init_point };
}

export async function getMercadoPagoPayment(paymentId: string): Promise<MercadoPagoPayment> {
  if (!config.mpAccessToken) throw new Error('Mercado Pago sem Access Token de produção');
  const response = await fetch(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { authorization: `Bearer ${config.mpAccessToken}` },
  });
  if (!response.ok) {
    console.error(`[vox] não foi possível consultar o pagamento Mercado Pago (${response.status})`);
    throw new Error('não foi possível consultar o pagamento');
  }
  return await response.json() as MercadoPagoPayment;
}

/** Valida x-signature usando a chave gerada na tela Webhooks do Mercado Pago. */
export function validWebhookSignature(signature: string, requestId: string, dataId: string): boolean {
  if (!config.mpWebhookSecret || !signature || !requestId || !dataId) return false;
  const parts = new Map(signature.split(',').map((part) => {
    const separator = part.indexOf('=');
    return separator > 0 ? [part.slice(0, separator).trim(), part.slice(separator + 1).trim()] as const : ['', ''];
  }));
  const ts = parts.get('ts');
  const received = parts.get('v1');
  if (!ts || !received) return false;
  const manifest = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = createHmac('sha256', config.mpWebhookSecret).update(manifest).digest('hex');
  const actualBuffer = Buffer.from(received, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function fromRow(row: Record<string, unknown>): BillingOrder {
  const status = String(row.status);
  return {
    id: String(row.id),
    accountId: Number(row.account_id),
    plan: String(row.plan) as PaidPlan,
    kind: row.kind === 'renewal' ? 'renewal' : 'initial',
    amountCents: Number(row.amount_cents),
    serverName: String(row.server_name),
    serverSlug: String(row.server_slug),
    serverPassword: String(row.server_password),
    status: status === 'approved' || status === 'failed' ? status : 'pending',
    preferenceId: String(row.preference_id ?? ''),
    paymentId: String(row.payment_id ?? ''),
    serverId: row.server_id === null ? null : Number(row.server_id),
    lastError: String(row.last_error ?? ''),
    paidAt: row.paid_at === null || row.paid_at === undefined ? null : Number(row.paid_at),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    paymentMethodId: String(row.payment_method_id ?? ''),
    paymentTypeId: String(row.payment_type_id ?? ''),
    statusDetail: String(row.status_detail ?? ''),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
