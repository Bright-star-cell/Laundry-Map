import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { pool } from './db.js';

export type PaymentProvider = 'PAYSTACK' | 'FLUTTERWAVE';

export interface VerifiedPaymentEvent {
  eventId: string;
  eventType: string;
  reference: string | null;
  amountKobo: number | null;
  currency: string | null;
}

function safeEqual(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyPaystackSignature(rawBody: Buffer, signature: string | undefined, secret: string | undefined) {
  if (!secret || !signature || !/^[a-f\d]{128}$/i.test(signature)) return false;
  return safeEqual(createHmac('sha512', secret).update(rawBody).digest(), Buffer.from(signature, 'hex'));
}

export function verifyFlutterwaveSignature(
  rawBody: Buffer,
  signature: string | undefined,
  secretHash: string | undefined,
) {
  if (!secretHash || !signature) return false;
  const expected = createHmac('sha256', secretHash).update(rawBody).digest('base64');
  return safeEqual(Buffer.from(expected), Buffer.from(signature));
}

function amountToKobo(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const amount = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;
  const [whole, fraction = ''] = amount.split('.');
  const kobo = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(kobo) && kobo > 0 ? kobo : null;
}

export function parsePaymentEvent(provider: PaymentProvider, rawBody: Buffer): VerifiedPaymentEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const root = payload as Record<string, unknown>;
  const data = typeof root.data === 'object' && root.data !== null ? root.data as Record<string, unknown> : null;
  if (!data) return null;
  const eventType = typeof root.event === 'string' ? root.event : typeof root.type === 'string' ? root.type : '';
  const rawId = data.id;
  const eventId = typeof rawId === 'string' || (typeof rawId === 'number' && Number.isSafeInteger(rawId)) ? String(rawId) : '';
  if (!eventType || !eventId || eventId.length > 200) return null;
  const isSuccessful = provider === 'PAYSTACK' ? eventType === 'charge.success' : data.status === 'successful';
  const isFailure = provider === 'PAYSTACK' ? eventType === 'charge.failed' : data.status === 'failed' || data.status === 'cancelled';
  const referenceValue = provider === 'PAYSTACK' ? data.reference : data.tx_ref;
  const reference = typeof referenceValue === 'string' && referenceValue.length > 0 && referenceValue.length <= 200 ? referenceValue : null;
  const amountKobo = provider === 'PAYSTACK'
    ? typeof data.amount === 'number' && Number.isSafeInteger(data.amount) && data.amount > 0 ? data.amount : null
    : amountToKobo(data.amount);
  const currency = typeof data.currency === 'string' ? data.currency : null;
  return {
    eventId,
    eventType: isSuccessful ? 'payment.success' : isFailure ? 'payment.failed' : eventType,
    reference: isSuccessful || isFailure ? reference : null,
    amountKobo: isSuccessful || isFailure ? amountKobo : null,
    currency: isSuccessful || isFailure ? currency : null,
  };
}

export async function processPaymentEvent(
  provider: PaymentProvider,
  event: VerifiedPaymentEvent,
  rawBody: Buffer,
) {
  const client = await pool.connect();
  const payloadHash = createHash('sha256').update(rawBody).digest('hex');
  try {
    await client.query('BEGIN');
    const insertedEvent = await client.query<{ event_id: string }>(
      `INSERT INTO payment_webhook_events (provider, event_id, event_type, payload_sha256)
       VALUES ($1, $2, $3, $4) ON CONFLICT (provider, event_id) DO NOTHING RETURNING event_id`,
      [provider, event.eventId, event.eventType, payloadHash],
    );
    if (!insertedEvent.rowCount) {
      const prior = await client.query<{ payload_sha256: string }>(
        'SELECT payload_sha256 FROM payment_webhook_events WHERE provider = $1 AND event_id = $2',
        [provider, event.eventId],
      );
      if (prior.rows[0]?.payload_sha256.trim() !== payloadHash) {
        console.error(JSON.stringify({ event: 'payment_webhook_event_id_reused', provider, eventId: event.eventId }));
      }
      await client.query('COMMIT');
      return { result: 'duplicate' as const, orderId: null, customerId: null, vendorUserId: null };
    }

    if (event.eventType === 'payment.failed') {
      const failedPaymentKey = event.reference ? await client.query<{ id: string; order_id: string }>(
        'SELECT id, order_id FROM payments WHERE provider = $1 AND provider_reference = $2',
        [provider, event.reference],
      ) : null;
      let payment: { id: string; order_id: string; customer_id: string; vendor_user_id: string; payment_status: string; order_payment_status: string } | undefined;
      if (failedPaymentKey?.rows[0]) {
        await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [failedPaymentKey.rows[0].order_id]);
        const lockedPayment = await client.query<NonNullable<typeof payment>>(
          `SELECT p.id, p.order_id, o.customer_id, v.user_id AS vendor_user_id,
                  p.status AS payment_status, o.payment_status AS order_payment_status
           FROM payments p JOIN orders o ON o.id = p.order_id JOIN vendors v ON v.id = o.vendor_id
           WHERE p.id = $1 FOR UPDATE OF p`,
          [failedPaymentKey.rows[0].id],
        );
        payment = lockedPayment.rows[0];
      }
      const failureResult = !payment ? 'unknown_reference' : payment.payment_status === 'INITIALIZED' && payment.order_payment_status === 'PENDING' ? 'failed' : 'reconciliation_required';
      if (payment && failureResult === 'failed') {
        await client.query("UPDATE payments SET status = 'FAILED', updated_at = NOW() WHERE id = $1", [payment.id]);
        await client.query("UPDATE orders SET payment_status = 'FAILED', updated_at = NOW() WHERE id = $1", [payment.order_id]);
      } else if (payment) {
        await client.query('UPDATE orders SET payment_reconciliation_required = TRUE, updated_at = NOW() WHERE id = $1', [payment.order_id]);
        await client.query(
          `INSERT INTO payment_reconciliation_events
            (order_id, payment_id, provider, provider_reference, reason, details)
           VALUES ($1, $2, $3, $4, 'PROVIDER_FAILURE_AFTER_ORDER_STATE_CHANGE', $5::JSONB)`,
          [payment.order_id, payment.id, provider, event.reference, JSON.stringify({ eventId: event.eventId, paymentStatus: payment.payment_status, orderPaymentStatus: payment.order_payment_status })],
        );
      }
      await client.query(
        'UPDATE payment_webhook_events SET processing_result = $3, processed_at = NOW() WHERE provider = $1 AND event_id = $2',
        [provider, event.eventId, failureResult],
      );
      await client.query('COMMIT');
      if (failureResult !== 'failed') console.warn(JSON.stringify({ event: 'payment_webhook_reconciliation', provider, eventId: event.eventId, reference: event.reference, result: failureResult }));
      return {
        result: failureResult,
        orderId: payment?.order_id ?? null,
        customerId: payment?.customer_id ?? null,
        vendorUserId: payment?.vendor_user_id ?? null,
      };
    }

    if (event.eventType !== 'payment.success') {
      await client.query(
        "UPDATE payment_webhook_events SET processing_result = 'ignored', processed_at = NOW() WHERE provider = $1 AND event_id = $2",
        [provider, event.eventId],
      );
      await client.query('COMMIT');
      return { result: 'ignored' as const, orderId: null, customerId: null, vendorUserId: null };
    }

    const paymentKey = event.reference ? await client.query<{ id: string; order_id: string }>(
      'SELECT id, order_id FROM payments WHERE provider = $1 AND provider_reference = $2',
      [provider, event.reference],
    ) : null;
    let matched: {
      id: string;
      order_id: string;
      customer_id: string;
      vendor_user_id: string;
      amount_kobo: string;
      payment_status: string;
      order_status: string;
      order_payment_status: string;
    } | undefined;
    if (paymentKey?.rows[0]) {
      await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [paymentKey.rows[0].order_id]);
      const lockedPayment = await client.query<NonNullable<typeof matched>>(
        `SELECT p.id, p.order_id, o.customer_id, v.user_id AS vendor_user_id, p.amount_kobo,
                p.status AS payment_status, o.status AS order_status, o.payment_status AS order_payment_status
         FROM payments p JOIN orders o ON o.id = p.order_id JOIN vendors v ON v.id = o.vendor_id
         WHERE p.id = $1 FOR UPDATE OF p`,
        [paymentKey.rows[0].id],
      );
      matched = lockedPayment.rows[0];
    }
    let result: 'confirmed' | 'reconciliation_required' | 'unknown_reference' = 'unknown_reference';

    if (matched) {
      const mismatch = event.currency !== 'NGN' || event.amountKobo === null || Number(matched.amount_kobo) !== event.amountKobo;
      const cancelled = matched.order_status === 'CANCELLED';
      if (mismatch || cancelled || matched.payment_status === 'RECONCILIATION_REQUIRED') {
        const reason = mismatch ? 'PROVIDER_AMOUNT_OR_CURRENCY_MISMATCH' : 'PAYMENT_RECEIVED_AFTER_ORDER_CANCELLATION';
        await client.query(
          `UPDATE payments SET status = CASE WHEN status = 'SUCCESS' THEN status ELSE 'RECONCILIATION_REQUIRED' END,
             updated_at = NOW() WHERE id = $1`,
          [matched.id],
        );
        await client.query('UPDATE orders SET payment_reconciliation_required = TRUE, updated_at = NOW() WHERE id = $1', [matched.order_id]);
        await client.query(
          `INSERT INTO payment_reconciliation_events
            (order_id, payment_id, provider, provider_reference, reason, details)
           VALUES ($1, $2, $3, $4, $5, $6::JSONB)`,
          [matched.order_id, matched.id, provider, event.reference, reason, JSON.stringify({ eventId: event.eventId, amountKobo: event.amountKobo, currency: event.currency })],
        );
        result = 'reconciliation_required';
      } else if (matched.payment_status === 'INITIALIZED' && matched.order_payment_status === 'PENDING') {
        await client.query("UPDATE payments SET status = 'SUCCESS', updated_at = NOW() WHERE id = $1", [matched.id]);
        await client.query(
          `UPDATE orders SET payment_status = 'PAID', vendor_response_deadline = NOW() + INTERVAL '2 minutes', updated_at = NOW()
           WHERE id = $1`,
          [matched.order_id],
        );
        result = 'confirmed';
      } else if (matched.payment_status === 'SUCCESS') {
        result = 'confirmed';
      } else {
        await client.query('UPDATE orders SET payment_reconciliation_required = TRUE, updated_at = NOW() WHERE id = $1', [matched.order_id]);
        await client.query(
          `INSERT INTO payment_reconciliation_events
            (order_id, payment_id, provider, provider_reference, reason, details)
           VALUES ($1, $2, $3, $4, 'PAYMENT_STATUS_NOT_INITIALIZED', $5::JSONB)`,
          [matched.order_id, matched.id, provider, event.reference, JSON.stringify({ eventId: event.eventId, paymentStatus: matched.payment_status })],
        );
        result = 'reconciliation_required';
      }
    }

    await client.query(
      'UPDATE payment_webhook_events SET processing_result = $3, processed_at = NOW() WHERE provider = $1 AND event_id = $2',
      [provider, event.eventId, result],
    );
    await client.query('COMMIT');
    if (result === 'unknown_reference' || result === 'reconciliation_required') {
      console.warn(JSON.stringify({ event: 'payment_webhook_reconciliation', provider, eventId: event.eventId, reference: event.reference, result }));
    }
    return {
      result,
      orderId: matched?.order_id ?? null,
      customerId: matched?.customer_id ?? null,
      vendorUserId: matched?.vendor_user_id ?? null,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}