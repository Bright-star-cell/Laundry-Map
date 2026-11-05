import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgres://laundry:laundry@127.0.0.1:5432/laundry_map';
process.env.REDIS_URL = 'redis://127.0.0.1:6379';

const { parsePaymentEvent, verifyFlutterwaveSignature, verifyPaystackSignature } = await import('./payment-events.js');

const secret = 'a-provider-secret-long-enough-for-a-test';

test('verifies Paystack webhook signatures against the original request body', () => {
  const body = Buffer.from('{"event":"charge.success"}');
  const signature = createHmac('sha512', secret).update(body).digest('hex');
  assert.equal(verifyPaystackSignature(body, signature, secret), true);
  assert.equal(verifyPaystackSignature(Buffer.from('{}'), signature, secret), false);
  assert.equal(verifyPaystackSignature(body, 'bad', secret), false);
});

test('verifies Flutterwave HMAC signatures over the original request body', () => {
  const body = Buffer.from('{"event":"charge.completed"}');
  const signature = createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(verifyFlutterwaveSignature(body, signature, secret), true);
  assert.equal(verifyFlutterwaveSignature(Buffer.from('{}'), signature, secret), false);
  assert.equal(verifyFlutterwaveSignature(body, undefined, secret), false);
});

test('normalizes successful payment events and converts Flutterwave naira to integer kobo', () => {
  const flutterwave = parsePaymentEvent('FLUTTERWAVE', Buffer.from(JSON.stringify({
    event: 'charge.completed', data: { id: 44, tx_ref: 'lm_ref', amount: '1250.50', currency: 'NGN', status: 'successful' },
  })));
  assert.deepEqual(flutterwave, {
    eventId: '44', eventType: 'payment.success', reference: 'lm_ref', amountKobo: 125050, currency: 'NGN',
  });
  assert.equal(parsePaymentEvent('PAYSTACK', Buffer.from('not json')), null);
});

test('normalizes provider payment failures without treating them as successful charges', () => {
  const failed = parsePaymentEvent('PAYSTACK', Buffer.from(JSON.stringify({
    event: 'charge.failed', data: { id: 45, reference: 'lm_failed', amount: 125050, currency: 'NGN' },
  })));
  assert.equal(failed?.eventType, 'payment.failed');
  assert.equal(failed?.reference, 'lm_failed');
  assert.equal(failed?.amountKobo, 125050);
});