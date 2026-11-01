import type { PoolClient } from 'pg';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';
import { canTransitionOrder, type OrderStatus } from './order-state-machine.js';

export interface OrderItemInput {
  service: 'WASH_AND_FOLD' | 'DRY_CLEANING' | 'IRONING';
  quantity: number;
}

export interface CreateOrderInput {
  customerId: string;
  vendorId: string;
  pickupAddress: string;
  pickupLatitude: number;
  pickupLongitude: number;
  deliveryAddress: string;
  deliveryLatitude: number;
  deliveryLongitude: number;
  items: OrderItemInput[];
}

function deliveryOtpKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  return createHash('sha256').update('laundry-map-delivery-otp-v1:').update(secret).digest();
}

function encryptDeliveryOtp(otp: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deliveryOtpKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(otp, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decryptDeliveryOtp(value: string) {
  const [iv, authTag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
  if (!iv || !authTag || !ciphertext || iv.length !== 12 || authTag.length !== 16) throw new Error('Invalid encrypted delivery code');
  const decipher = createDecipheriv('aes-256-gcm', deliveryOtpKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function createOrder(input: CreateOrderInput) {
  const deliveryOtp = String(randomInt(100000, 1_000_000));
  const deliveryOtpHash = await bcrypt.hash(deliveryOtp, 12);
  const deliveryOtpEncrypted = encryptDeliveryOtp(deliveryOtp);
  return inTransaction(async (client) => {
    const vendor = await client.query<{ id: string; commission_basis_points: number }>(
      'SELECT id, commission_basis_points FROM vendors WHERE id = $1 AND is_active = TRUE FOR SHARE',
      [input.vendorId],
    );
    if (!vendor.rowCount) throw new Error('VENDOR_NOT_FOUND');

    const priceResult = await client.query<{ service: OrderItemInput['service']; price_kobo: string }>(
      'SELECT service, price_kobo FROM vendor_service_prices WHERE vendor_id = $1 AND service = ANY($2::laundry_service[])',
      [input.vendorId, input.items.map((item) => item.service)],
    );
    const prices = new Map(priceResult.rows.map((row) => [row.service, Number(row.price_kobo)]));
    if (input.items.some((item) => !prices.has(item.service))) throw new Error('SERVICE_UNAVAILABLE');
    const subtotalKobo = input.items.reduce((total, item) => total + item.quantity * prices.get(item.service)!, 0);
    if (!Number.isSafeInteger(subtotalKobo) || subtotalKobo <= 0) throw new Error('INVALID_ORDER_TOTAL');
    const commissionKobo = Math.round(subtotalKobo * vendor.rows[0].commission_basis_points / 10_000);

    const orderResult = await client.query<{ id: string }>(
      `INSERT INTO orders (
         customer_id, vendor_id, pickup_address, pickup_location,
         delivery_address, delivery_location, subtotal_kobo, commission_kobo,
         status, currency, delivery_otp_hash, delivery_otp_encrypted
       ) VALUES (
         $1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography,
         $6, ST_SetSRID(ST_MakePoint($7, $8), 4326)::geography, $9, $10,
         'CREATED', 'NGN', $11, $12
       ) RETURNING id`,
      [input.customerId, input.vendorId, input.pickupAddress, input.pickupLongitude,
        input.pickupLatitude, input.deliveryAddress, input.deliveryLongitude,
        input.deliveryLatitude, subtotalKobo, commissionKobo, deliveryOtpHash, deliveryOtpEncrypted],
    );
    const orderId = orderResult.rows[0].id;

    for (const item of input.items) {
      await client.query(
        `INSERT INTO order_items (order_id, service, quantity, unit_price_kobo)
         VALUES ($1, $2, $3, $4)`,
        [orderId, item.service, item.quantity, prices.get(item.service)],
      );
    }
    await client.query(
      `INSERT INTO order_status_history (order_id, status, changed_by)
       VALUES ($1, 'CREATED', $2)`,
      [orderId, input.customerId],
    );
    return { id: orderId, status: 'CREATED' as const, subtotalKobo, commissionKobo, currency: 'NGN', deliveryOtp };
  });
}

export async function transitionOrder(
  orderId: string,
  nextStatus: OrderStatus,
  actorId: string,
  actorRole: string,
) {
  return inTransaction(async (client) => {
    const result = await client.query<{ status: OrderStatus; customer_id: string; vendor_user_id: string; courier_id: string | null; payment_status: string }>(
      `SELECT o.status, o.customer_id, v.user_id AS vendor_user_id, o.courier_id, o.payment_status
       FROM orders o JOIN vendors v ON v.id = o.vendor_id WHERE o.id = $1 FOR UPDATE OF o`,
      [orderId],
    );
    const order = result.rows[0];
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (!canTransitionOrder(order.status, nextStatus)) throw new Error('INVALID_STATUS_TRANSITION');
    if (actorRole === 'CUSTOMER' && (order.customer_id !== actorId || nextStatus !== 'CANCELLED')) {
      throw new Error('FORBIDDEN');
    }
    if (actorRole === 'CUSTOMER' && order.payment_status === 'PAID') throw new Error('REFUND_REQUIRED');
    if (actorRole === 'VENDOR' && order.vendor_user_id !== actorId) throw new Error('FORBIDDEN');
    if (actorRole === 'COURIER' && order.courier_id !== actorId) throw new Error('FORBIDDEN');
    const allowedByRole: Record<string, OrderStatus[]> = {
      VENDOR: ['PROCESSING', 'READY_FOR_DELIVERY'],
      COURIER: ['PICKED_UP', 'AT_LAUNDROMAT', 'DRIVER_ASSIGNED_FOR_DROPOFF'],
      ADMIN: ['DRIVER_ASSIGNED_FOR_PICKUP', 'PICKED_UP', 'AT_LAUNDROMAT', 'PROCESSING', 'READY_FOR_DELIVERY', 'DRIVER_ASSIGNED_FOR_DROPOFF', 'DELIVERED', 'CANCELLED'],
    };
    if (actorRole !== 'CUSTOMER' && !allowedByRole[actorRole]?.includes(nextStatus)) throw new Error('FORBIDDEN');

    await client.query('UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1', [orderId, nextStatus]);
    await client.query(
      'INSERT INTO order_status_history (order_id, status, changed_by) VALUES ($1, $2, $3)',
      [orderId, nextStatus, actorId],
    );
    return { id: orderId, status: nextStatus, customerId: order.customer_id };
  });
}

export async function getOrderForActor(orderId: string, actorId: string, actorRole: string) {
  const result = await pool.query(
    `SELECT o.id, o.status, o.subtotal_kobo, o.commission_kobo, o.currency,
            o.pickup_address, o.delivery_address, o.created_at, o.updated_at,
            o.payment_status, o.vendor_accepted_at, o.vendor_response_deadline,
            COALESCE(json_agg(json_build_object(
              'service', i.service, 'quantity', i.quantity, 'unitPriceKobo', i.unit_price_kobo
            )) FILTER (WHERE i.id IS NOT NULL), '[]') AS items,
            COALESCE((SELECT json_agg(json_build_object('status', h.status, 'at', h.created_at) ORDER BY h.created_at)
                      FROM order_status_history h WHERE h.order_id = o.id), '[]') AS history
    FROM orders o JOIN vendors v ON v.id = o.vendor_id LEFT JOIN order_items i ON i.order_id = o.id
    WHERE o.id = $1 AND ($2 = 'ADMIN' OR o.customer_id = $3 OR v.user_id = $3 OR o.courier_id = $3)
     GROUP BY o.id`,
    [orderId, actorRole, actorId],
  );
  return result.rows[0] ?? null;
}

export async function listVendorOrders(vendorId: string) {
  const result = await pool.query(
    `SELECT o.id, o.status, o.subtotal_kobo, o.created_at, o.pickup_address,
            o.vendor_accepted_at, o.vendor_response_deadline,
            json_agg(json_build_object('service', i.service, 'quantity', i.quantity)) AS items
    FROM orders o JOIN vendors v ON v.id = o.vendor_id JOIN order_items i ON i.order_id = o.id
     WHERE v.user_id = $1 AND o.payment_status = 'PAID'
       AND o.status IN ('CREATED', 'AT_LAUNDROMAT', 'PROCESSING', 'READY_FOR_DELIVERY')
    GROUP BY o.id ORDER BY o.created_at ASC LIMIT 100`,
    [vendorId],
  );
  return result.rows;
}

export async function listCustomerOrders(customerId: string) {
  const result = await pool.query(
    `SELECT o.id, o.status, o.payment_status, o.subtotal_kobo, o.created_at, o.delivery_otp_encrypted,
            COALESCE(json_agg(json_build_object('service', i.service, 'quantity', i.quantity))
              FILTER (WHERE i.id IS NOT NULL), '[]') AS items,
            COALESCE((SELECT json_agg(json_build_object('status', h.status, 'at', h.created_at) ORDER BY h.created_at)
                      FROM order_status_history h WHERE h.order_id = o.id), '[]') AS history
     FROM orders o LEFT JOIN order_items i ON i.order_id = o.id
     WHERE o.customer_id = $1 GROUP BY o.id ORDER BY o.created_at DESC LIMIT 100`,
    [customerId],
  );
  return result.rows.map(({ delivery_otp_encrypted, ...order }) => ({
    ...order,
    deliveryOtp: delivery_otp_encrypted ? decryptDeliveryOtp(delivery_otp_encrypted) : null,
  }));
}

export async function acceptVendorOrder(orderId: string, vendorUserId: string) {
  return inTransaction(async (client) => {
    const result = await client.query<{ id: string; vendor_user_id: string; status: OrderStatus; payment_status: string; vendor_accepted_at: Date | null; vendor_response_deadline: Date }>(
      `SELECT o.id, v.user_id AS vendor_user_id, o.status, o.payment_status,
              o.vendor_accepted_at, o.vendor_response_deadline
       FROM orders o JOIN vendors v ON v.id = o.vendor_id WHERE o.id = $1 FOR UPDATE OF o`,
      [orderId],
    );
    const order = result.rows[0];
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (order.vendor_user_id !== vendorUserId) throw new Error('FORBIDDEN');
    if (order.status !== 'CREATED' || order.payment_status !== 'PAID' || order.vendor_accepted_at) {
      throw new Error('ORDER_UNAVAILABLE');
    }
    if (order.vendor_response_deadline.getTime() <= Date.now()) throw new Error('ACCEPTANCE_EXPIRED');
    await client.query('UPDATE orders SET vendor_accepted_at = NOW(), updated_at = NOW() WHERE id = $1', [orderId]);
    return { id: order.id, status: order.status };
  });
}

export async function listCourierJobs(courierId: string) {
  const result = await pool.query(
    `SELECT o.id, o.status, o.pickup_address, o.delivery_address, o.created_at,
            (o.courier_id = $1) AS assigned_to_me,
           ST_Y(o.pickup_location::geometry) AS pickup_latitude,
           ST_X(o.pickup_location::geometry) AS pickup_longitude,
           ST_Y(o.delivery_location::geometry) AS delivery_latitude,
           ST_X(o.delivery_location::geometry) AS delivery_longitude,
            v.business_name, ST_Y(v.location::geometry) AS vendor_latitude,
            ST_X(v.location::geometry) AS vendor_longitude
     FROM orders o JOIN vendors v ON v.id = o.vendor_id
     WHERE o.payment_status = 'PAID' AND o.vendor_accepted_at IS NOT NULL
       AND ((o.courier_id IS NULL AND o.status IN ('CREATED', 'READY_FOR_DELIVERY'))
         OR (o.courier_id = $1 AND o.status IN ('DRIVER_ASSIGNED_FOR_PICKUP', 'PICKED_UP', 'AT_LAUNDROMAT', 'READY_FOR_DELIVERY', 'DRIVER_ASSIGNED_FOR_DROPOFF')))
     ORDER BY o.created_at ASC LIMIT 100`,
    [courierId],
  );
  return result.rows;
}

export async function assignCourier(orderId: string, courierId: string) {
  return inTransaction(async (client) => {
    const result = await client.query<{ status: OrderStatus; customer_id: string; courier_id: string | null; payment_status: string; vendor_accepted_at: Date | null }>(
      'SELECT status, customer_id, courier_id, payment_status, vendor_accepted_at FROM orders WHERE id = $1 FOR UPDATE',
      [orderId],
    );
    const order = result.rows[0];
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (order.courier_id || order.payment_status !== 'PAID' || !order.vendor_accepted_at || !['CREATED', 'READY_FOR_DELIVERY'].includes(order.status)) throw new Error('JOB_UNAVAILABLE');
    const courier = await client.query("SELECT id FROM users WHERE id = $1 AND role = 'COURIER' AND is_active = TRUE", [courierId]);
    if (!courier.rowCount) throw new Error('COURIER_NOT_FOUND');
    const nextStatus: OrderStatus = order.status === 'CREATED' ? 'DRIVER_ASSIGNED_FOR_PICKUP' : 'DRIVER_ASSIGNED_FOR_DROPOFF';
    await client.query('UPDATE orders SET courier_id = $2, status = $3, updated_at = NOW() WHERE id = $1', [orderId, courierId, nextStatus]);
    await client.query('INSERT INTO order_status_history (order_id, status, changed_by) VALUES ($1, $2, $3)', [orderId, nextStatus, courierId]);
    return { id: orderId, status: nextStatus, customerId: order.customer_id, courierId };
  });
}

export async function completeDelivery(orderId: string, courierId: string, otp: string) {
  return inTransaction(async (client) => {
    const result = await client.query<{ status: OrderStatus; customer_id: string; courier_id: string | null; delivery_otp_hash: string | null }>(
      'SELECT status, customer_id, courier_id, delivery_otp_hash FROM orders WHERE id = $1 FOR UPDATE',
      [orderId],
    );
    const order = result.rows[0];
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (order.courier_id !== courierId) throw new Error('FORBIDDEN');
    if (order.status !== 'DRIVER_ASSIGNED_FOR_DROPOFF' || !order.delivery_otp_hash) throw new Error('ORDER_NOT_READY');
    if (!/^\d{6}$/.test(otp) || !(await bcrypt.compare(otp, order.delivery_otp_hash))) throw new Error('INVALID_OTP');
    await client.query('UPDATE orders SET status = \'DELIVERED\', delivery_otp_hash = NULL, delivery_otp_encrypted = NULL, updated_at = NOW() WHERE id = $1', [orderId]);
    await client.query("INSERT INTO order_status_history (order_id, status, changed_by) VALUES ($1, 'DELIVERED', $2)", [orderId, courierId]);
    await client.query('DELETE FROM courier_locations WHERE order_id = $1', [orderId]);
    return { id: orderId, status: 'DELIVERED' as const, customerId: order.customer_id };
  });
}

export async function listVendors(latitude: number, longitude: number) {
  const result = await pool.query(
    `SELECT v.id, v.business_name, v.address,
            ST_Y(v.location::geometry) AS latitude, ST_X(v.location::geometry) AS longitude,
            ROUND(ST_Distance(v.location, ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography)) AS distance_meters,
            json_agg(json_build_object('service', p.service, 'priceKobo', p.price_kobo) ORDER BY p.service) AS services
     FROM vendors v JOIN vendor_service_prices p ON p.vendor_id = v.id
     WHERE v.is_active = TRUE
     GROUP BY v.id
     ORDER BY v.location <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
     LIMIT 30`,
    [latitude, longitude],
  );
  return result.rows;
}