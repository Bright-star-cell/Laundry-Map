import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { Redis } from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from './db.js';
import { acceptVendorOrder, completeDelivery, createOrder, getOrderForActor, listCustomerOrders, listVendorOrders, transitionOrder } from './orders.js';
import { isOrderStatus } from './order-state-machine.js';
import { login, registerCustomer } from './auth.js';
import { assignCourier, listCourierJobs, listVendors } from './orders.js';
import { config } from './config.js';
import { parsePaymentEvent, processPaymentEvent, verifyFlutterwaveSignature, verifyPaystackSignature } from './payment-events.js';

const app = express();
const httpServer = createServer(app);
const jwtSecret = config.JWT_SECRET;
const allowedOrigins = config.WEB_ORIGIN;
app.set('trust proxy', config.TRUST_PROXY);
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, credentials: true },
  transports: config.socketTransports,
  cookie: config.production ? { name: 'io', httpOnly: true, sameSite: 'none', secure: true } : false,
  allowRequest: (request, callback) => {
    const origin = request.headers.origin;
    callback(null, !origin || allowedOrigins.includes(origin));
  },
});
const isTestEnvironment = process.env.NODE_ENV === 'test';
const redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null, lazyConnect: isTestEnvironment });
const redisSub = redis.duplicate();
if (!isTestEnvironment) {
  await Promise.all([redis.ping(), redisSub.ping()]);
  io.adapter(createAdapter(redis, redisSub));
}

interface AuthenticatedRequest extends Request {
  user?: { id: string; role: 'CUSTOMER' | 'VENDOR' | 'COURIER' | 'ADMIN' };
}

function verifyToken(token: string) {
  const payload = jwt.verify(token, jwtSecret as string) as JwtPayload;
  if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') throw new Error('Invalid token');
  if (!['CUSTOMER', 'VENDOR', 'COURIER', 'ADMIN'].includes(payload.role)) throw new Error('Invalid role');
  return { id: payload.sub, role: payload.role as AuthenticatedRequest['user'] extends infer U ? U extends { role: infer R } ? R : never : never };
}

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (typeof token !== 'string') return next(new Error('Authentication required'));
    socket.data.user = verifyToken(token);
    next();
  } catch {
    next(new Error('Invalid authentication token'));
  }
});

io.on('connection', (socket) => {
  const user = socket.data.user as { id: string; role: string };
  socket.join(`user:${user.id}`);
  socket.join(`role:${user.role}`);
  socket.on('health:ping', (acknowledge?: (result: { timestamp: number }) => void) => {
    acknowledge?.({ timestamp: Date.now() });
  });
  socket.on('order:subscribe', async (orderId: unknown, acknowledge?: (result: { ok: boolean }) => void) => {
    if (typeof orderId !== 'string' || orderId.length > 64) return acknowledge?.({ ok: false });
    const order = await getOrderForActor(orderId, user.id, user.role);
    if (!order) return acknowledge?.({ ok: false });
    socket.join(`order:${orderId}`);
    acknowledge?.({ ok: true });
  });
  socket.on('driver:location', async (payload: unknown) => {
    if (user.role !== 'COURIER' || typeof payload !== 'object' || payload === null) return;
    const parsed = z.object({ orderId: z.string().uuid(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).safeParse(payload);
    if (!parsed.success) return;
    const order = await getOrderForActor(parsed.data.orderId, user.id, user.role);
    if (!order) return;
    await pool.query(
      `INSERT INTO courier_locations (courier_id, order_id, location, recorded_at)
        VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, NOW())
        ON CONFLICT (courier_id, order_id) DO UPDATE
        SET location = EXCLUDED.location, recorded_at = NOW()`,
      [user.id, parsed.data.orderId, parsed.data.longitude, parsed.data.latitude],
    );
    socket.to(`order:${parsed.data.orderId}`).emit('driver:location', parsed.data);
  });
});

app.use(helmet());
app.use(cors({ origin: allowedOrigins, credentials: true }));
async function receivePaymentWebhook(provider: 'PAYSTACK' | 'FLUTTERWAVE', req: Request, res: Response) {
  if (!Buffer.isBuffer(req.body)) return res.sendStatus(400);
  const verified = provider === 'PAYSTACK'
    ? verifyPaystackSignature(req.body, req.header('x-paystack-signature'), process.env.PAYSTACK_SECRET_KEY)
    : verifyFlutterwaveSignature(req.body, req.header('flutterwave-signature'), process.env.FLUTTERWAVE_SECRET_HASH);
  if (!verified) return res.sendStatus(401);
  const event = parsePaymentEvent(provider, req.body);
  if (!event) return res.status(400).json({ error: 'Invalid payment event' });
  const processed = await processPaymentEvent(provider, event, req.body);
  if (processed.result === 'confirmed' && processed.orderId && processed.customerId && processed.vendorUserId) {
    const order = await getOrderForActor(processed.orderId, processed.customerId, 'CUSTOMER');
    io.to(`user:${processed.customerId}`).emit('order:status', { id: processed.orderId, paymentStatus: 'PAID' });
    io.to(`user:${processed.vendorUserId}`).emit('order:created', order);
  } else if (processed.customerId && processed.orderId && processed.result === 'failed') {
    io.to(`user:${processed.customerId}`).emit('order:status', { id: processed.orderId, paymentStatus: 'FAILED' });
  } else if (processed.customerId && processed.orderId && processed.result === 'reconciliation_required') {
    io.to(`user:${processed.customerId}`).emit('order:status', { id: processed.orderId, paymentReconciliationRequired: true });
  }
  return res.sendStatus(200);
}

const paymentWebhookLimit = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
app.post('/api/payments/paystack/webhook', paymentWebhookLimit, express.raw({ type: 'application/json', limit: '128kb' }), asyncHandler(async (req, res) => receivePaymentWebhook('PAYSTACK', req, res)));
app.post('/api/payments/flutterwave/webhook', paymentWebhookLimit, express.raw({ type: 'application/json', limit: '128kb' }), asyncHandler(async (req, res) => receivePaymentWebhook('FLUTTERWAVE', req, res)));
app.use(express.json({ limit: '32kb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));

function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const authorization = req.header('authorization');
    if (!authorization?.startsWith('Bearer ')) return res.status(401).json({ error: 'Authentication required' });
    req.user = verifyToken(authorization.slice(7));
    next();
  } catch {
    res.status(401).json({ error: 'Invalid authentication token' });
  }
}

function asyncHandler<T extends Request = Request>(handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req as T, res, next).catch(next);
  };
}

app.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', asyncHandler(async (_req, res) => {
  try {
    await Promise.all([pool.query('SELECT 1'), redis.ping()]);
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
}));

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  try {
    const result = await registerCustomer(req.body, jwtSecret as string, process.env.JWT_EXPIRES_IN ?? '12h');
    return res.status(201).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid registration', details: error.flatten() });
    if (error instanceof Error && 'code' in error && error.code === '23505') return res.status(409).json({ error: 'Email or phone already registered' });
    throw error;
  }
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  try {
    return res.json(await login(req.body, jwtSecret as string, process.env.JWT_EXPIRES_IN ?? '12h'));
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: 'Invalid login details' });
    if (error instanceof Error && error.message === 'INVALID_CREDENTIALS') return res.status(401).json({ error: 'Email or password is incorrect' });
    throw error;
  }
}));

app.get('/api/vendors', asyncHandler(async (req, res) => {
  const parsed = z.object({ latitude: z.coerce.number().min(-90).max(90).default(8.9912), longitude: z.coerce.number().min(-180).max(180).default(7.6031) }).safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid coordinates' });
  res.json(await listVendors(parsed.data.latitude, parsed.data.longitude));
}));

app.post('/api/payments/initialize', authenticate, asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (req.user?.role !== 'CUSTOMER') return res.status(403).json({ error: 'Customer account required' });
  const parsed = z.object({ orderId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid order id' });
  const provider = z.enum(['PAYSTACK', 'FLUTTERWAVE']).default('PAYSTACK').safeParse(req.body?.provider);
  if (!provider.success) return res.status(400).json({ error: 'Unsupported payment provider' });
  const providerSecret = provider.data === 'PAYSTACK' ? process.env.PAYSTACK_SECRET_KEY : process.env.FLUTTERWAVE_SECRET_KEY;
  if (!providerSecret) return res.status(503).json({ error: `${provider.data === 'PAYSTACK' ? 'Paystack' : 'Flutterwave'} is not configured` });
  const reference = `lm_${randomUUID().replaceAll('-', '')}`;
  let amountKobo: number;
  let customerEmail: string;
  const checkout = await pool.connect();
  try {
    await checkout.query('BEGIN');
    const lockedOrder = await checkout.query<{ status: string; payment_status: string; subtotal_kobo: string }>(
      'SELECT status, payment_status, subtotal_kobo FROM orders WHERE id = $1 AND customer_id = $2 FOR UPDATE',
      [parsed.data.orderId, req.user.id],
    );
    if (!lockedOrder.rows[0]) {
      await checkout.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }
    if (lockedOrder.rows[0].status !== 'CREATED' || !['PENDING', 'FAILED'].includes(lockedOrder.rows[0].payment_status)) {
      await checkout.query('ROLLBACK');
      return res.status(409).json({ error: 'Order is not available for payment' });
    }
    const activePayment = await checkout.query('SELECT 1 FROM payments WHERE order_id = $1 AND status = \'INITIALIZED\' LIMIT 1', [parsed.data.orderId]);
    if (activePayment.rows.length) {
      await checkout.query('ROLLBACK');
      return res.status(409).json({ error: 'A checkout is already active for this order' });
    }
    const customer = await checkout.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [req.user.id]);
    if (!customer.rows[0]) {
      await checkout.query('ROLLBACK');
      return res.status(404).json({ error: 'Customer account not found' });
    }
    customerEmail = customer.rows[0].email;
    amountKobo = Number(lockedOrder.rows[0].subtotal_kobo);
    await checkout.query(
      `INSERT INTO payments (order_id, provider, provider_reference, amount_kobo, status)
       VALUES ($1, $2, $3, $4, 'INITIALIZED')`,
      [parsed.data.orderId, provider.data, reference, amountKobo],
    );
    await checkout.query("UPDATE orders SET payment_status = 'PENDING', updated_at = NOW() WHERE id = $1", [parsed.data.orderId]);
    await checkout.query('COMMIT');
  } catch (error) {
    await checkout.query('ROLLBACK');
    throw error;
  } finally {
    checkout.release();
  }
  const isPaystack = provider.data === 'PAYSTACK';
  const endpoint = isPaystack ? 'https://api.paystack.co/transaction/initialize' : 'https://api.flutterwave.com/v3/payments';
  const payload = isPaystack
    ? { email: customerEmail, amount: amountKobo, reference, currency: 'NGN', callback_url: `${allowedOrigins[0]}/?order_id=${parsed.data.orderId}` }
    : { tx_ref: reference, amount: amountKobo / 100, currency: 'NGN', redirect_url: `${allowedOrigins[0]}/?order_id=${parsed.data.orderId}`, customer: { email: customerEmail }, customizations: { title: 'Laundry Map', description: `Laundry order ${parsed.data.orderId}` } };
  let response: globalThis.Response;
  let result: { status?: boolean | string; data?: { authorization_url?: string; link?: string } };
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${providerSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    result = await response.json() as typeof result;
  } catch (error) {
    await pool.query("UPDATE payments SET status = 'FAILED', updated_at = NOW() WHERE provider = $1 AND provider_reference = $2", [provider.data, reference]);
    console.error(JSON.stringify({ event: 'payment_checkout_initialization_failed', provider: provider.data, reference, error: error instanceof Error ? error.name : 'unknown' }));
    return res.status(502).json({ error: 'Unable to initialize payment' });
  }
  const authorizationUrl = isPaystack ? result.data?.authorization_url : result.data?.link;
  const providerAccepted = isPaystack ? result.status === true : result.status === 'success';
  if (!response.ok || !providerAccepted || !authorizationUrl) {
    await pool.query("UPDATE payments SET status = 'FAILED', updated_at = NOW() WHERE provider = $1 AND provider_reference = $2", [provider.data, reference]);
    console.error(JSON.stringify({ event: 'payment_checkout_rejected', provider: provider.data, reference, httpStatus: response.status }));
    return res.status(502).json({ error: 'Unable to initialize payment' });
  }
  return res.json({ authorizationUrl, reference, provider: provider.data });
}));

app.post('/api/orders', authenticate, asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (req.user?.role !== 'CUSTOMER') return res.status(403).json({ error: 'Customer account required' });
  const schema = z.object({
    vendorId: z.string().uuid(),
    pickupAddress: z.string().min(5).max(500),
    pickupLatitude: z.number().min(-90).max(90),
    pickupLongitude: z.number().min(-180).max(180),
    deliveryAddress: z.string().min(5).max(500),
    deliveryLatitude: z.number().min(-90).max(90),
    deliveryLongitude: z.number().min(-180).max(180),
    items: z.array(z.object({ service: z.enum(['WASH_AND_FOLD', 'DRY_CLEANING', 'IRONING']), quantity: z.number().int().min(1).max(100) })).min(1).max(20),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid order', details: parsed.error.flatten() });
  try {
    const order = await createOrder({ ...parsed.data, customerId: req.user.id });
    io.to(`user:${req.user.id}`).emit('order:created', order);
    return res.status(201).json(order);
  } catch (error) {
    if (error instanceof Error && error.message === 'VENDOR_NOT_FOUND') return res.status(404).json({ error: 'Vendor not found' });
    if (error instanceof Error && error.message === 'SERVICE_UNAVAILABLE') return res.status(409).json({ error: 'One or more selected services are no longer available' });
    if (error instanceof Error && error.message === 'INVALID_ORDER_TOTAL') return res.status(400).json({ error: 'Order total is invalid' });
    throw error;
  }
}));

app.get('/api/orders/:id', authenticate, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const order = await getOrderForActor(String(req.params.id), req.user!.id, req.user!.role);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  return res.json(order);
}));

app.get('/api/orders', authenticate, asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (req.user?.role !== 'CUSTOMER') return res.status(403).json({ error: 'Customer account required' });
  return res.json(await listCustomerOrders(req.user.id));
}));

app.patch('/api/orders/:id/status', authenticate, asyncHandler(async (req: AuthenticatedRequest, res) => {
  const status = req.body?.status;
  if (typeof status !== 'string' || !isOrderStatus(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const result = await transitionOrder(String(req.params.id), status, req.user!.id, req.user!.role);
    io.to(`order:${result.id}`).emit('order:status', { id: result.id, status: result.status });
    io.to(`user:${result.customerId}`).emit('order:status', { id: result.id, status: result.status });
    return res.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'ORDER_NOT_FOUND') return res.status(404).json({ error: 'Order not found' });
    if (error instanceof Error && error.message === 'FORBIDDEN') return res.status(403).json({ error: 'Not permitted to update this order' });
    if (error instanceof Error && error.message === 'INVALID_STATUS_TRANSITION') return res.status(409).json({ error: 'Invalid order status transition' });
    if (error instanceof Error && error.message === 'REFUND_REQUIRED') return res.status(409).json({ error: 'Paid orders require an operations-managed refund before cancellation' });
    throw error;
  }
}));

app.get('/api/vendor/orders', authenticate, asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (req.user?.role !== 'VENDOR') return res.status(403).json({ error: 'Vendor account required' });
  res.json(await listVendorOrders(req.user.id));
}));

app.post('/api/vendor/orders/:id/accept', authenticate, asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (req.user?.role !== 'VENDOR') return res.status(403).json({ error: 'Vendor account required' });
  try {
    const result = await acceptVendorOrder(String(req.params.id), req.user.id);
    io.to(`order:${result.id}`).emit('vendor:accepted', result);
    io.to('role:COURIER').emit('dispatch:available');
    return res.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'ORDER_NOT_FOUND') return res.status(404).json({ error: 'Order not found' });
    if (error instanceof Error && error.message === 'FORBIDDEN') return res.status(403).json({ error: 'Not permitted to accept this order' });
    if (error instanceof Error && (error.message === 'ORDER_UNAVAILABLE' || error.message === 'ACCEPTANCE_EXPIRED')) return res.status(409).json({ error: 'The acceptance window has closed' });
    throw error;
  }
}));

app.get('/api/courier/jobs', authenticate, asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (req.user?.role !== 'COURIER') return res.status(403).json({ error: 'Courier account required' });
  res.json(await listCourierJobs(req.user.id));
}));

app.post('/api/courier/jobs/:id/complete', authenticate, asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (req.user?.role !== 'COURIER') return res.status(403).json({ error: 'Courier account required' });
  const parsed = z.object({ otp: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter the six-digit delivery code' });
  try {
    const result = await completeDelivery(String(req.params.id), req.user.id, parsed.data.otp);
    io.to(`order:${result.id}`).emit('order:status', { id: result.id, status: result.status });
    io.to(`user:${result.customerId}`).emit('order:status', { id: result.id, status: result.status });
    return res.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'ORDER_NOT_FOUND') return res.status(404).json({ error: 'Order not found' });
    if (error instanceof Error && error.message === 'FORBIDDEN') return res.status(403).json({ error: 'This dispatch is assigned to another courier' });
    if (error instanceof Error && error.message === 'INVALID_OTP') return res.status(400).json({ error: 'The delivery code does not match' });
    if (error instanceof Error && error.message === 'ORDER_NOT_READY') return res.status(409).json({ error: 'This order is not ready for delivery confirmation' });
    throw error;
  }
}));

app.post('/api/courier/jobs/:id/accept', authenticate, asyncHandler(async (req: AuthenticatedRequest, res) => {
  if (req.user?.role !== 'COURIER') return res.status(403).json({ error: 'Courier account required' });
  try {
    const result = await assignCourier(String(req.params.id), req.user.id);
    io.to(`order:${result.id}`).emit('order:status', { id: result.id, status: result.status });
    io.to(`user:${result.customerId}`).emit('order:status', { id: result.id, status: result.status });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'ORDER_NOT_FOUND') return res.status(404).json({ error: 'Order not found' });
    if (error instanceof Error && error.message === 'JOB_UNAVAILABLE') return res.status(409).json({ error: 'Job is no longer available' });
    if (error instanceof Error && error.message === 'COURIER_NOT_FOUND') return res.status(403).json({ error: 'Courier account is inactive' });
    throw error;
  }
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(JSON.stringify({ event: 'http_request_failed', error: error instanceof Error ? error.name : 'unknown' }));
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

if (!isTestEnvironment) {
  const port = Number(process.env.PORT ?? 4000);
  httpServer.listen(port, '0.0.0.0', () => console.log(`Laundry Map API listening on ${port}`));
}

async function shutdown() {
  httpServer.close();
  await Promise.all([pool.end(), redis.quit(), redisSub.quit()]);
  process.exit(0);
}

if (!isTestEnvironment) {
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

export { app, httpServer };