import 'dotenv/config';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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

const app = express();
const httpServer = createServer(app);
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

const allowedOrigins = (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(',');
const io = new Server(httpServer, { cors: { origin: allowedOrigins, credentials: true } });
const isTestEnvironment = process.env.NODE_ENV === 'test';
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null, lazyConnect: isTestEnvironment });
const redisSub = redis.duplicate();
if (!isTestEnvironment) {
  await Promise.all([redis.ping(), redisSub.ping()]);
  io.adapter(createAdapter(redis, redisSub));
}

async function confirmPayment(provider: 'PAYSTACK' | 'FLUTTERWAVE', reference: string, amountKobo: number) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ order_id: string; customer_id: string; vendor_user_id: string; amount_kobo: string; status: string }>(
      `SELECT p.order_id, o.customer_id, v.user_id AS vendor_user_id, p.amount_kobo, p.status
       FROM payments p JOIN orders o ON o.id = p.order_id JOIN vendors v ON v.id = o.vendor_id
       WHERE p.provider = $1 AND p.provider_reference = $2 FOR UPDATE OF p, o`,
      [provider, reference],
    );
    const payment = result.rows[0];
    if (!payment || Number(payment.amount_kobo) !== amountKobo || payment.status !== 'INITIALIZED') {
      await client.query('COMMIT');
      return null;
    }
    await client.query("UPDATE payments SET status = 'SUCCESS', updated_at = NOW() WHERE provider = $1 AND provider_reference = $2", [provider, reference]);
    await client.query("UPDATE orders SET payment_status = 'PAID', vendor_response_deadline = NOW() + INTERVAL '2 minutes', updated_at = NOW() WHERE id = $1", [payment.order_id]);
    await client.query('COMMIT');
    return { orderId: payment.order_id, customerId: payment.customer_id, vendorUserId: payment.vendor_user_id };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
app.post('/api/payments/paystack/webhook', express.raw({ type: 'application/json', limit: '128kb' }), asyncHandler(async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  const signature = req.header('x-paystack-signature');
  if (!secret || !signature || !Buffer.isBuffer(req.body)) return res.sendStatus(401);
  const expected = createHmac('sha512', secret).update(req.body).digest();
  const supplied = Buffer.from(signature, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.sendStatus(401);
  try {
    const event = JSON.parse(req.body.toString()) as { event?: string; data?: { reference?: string; amount?: number; currency?: string } };
    if (event.event === 'charge.success' && event.data?.reference && typeof event.data.amount === 'number' && event.data.currency === 'NGN') {
      const confirmed = await confirmPayment('PAYSTACK', event.data.reference, event.data.amount);
      if (confirmed) {
        const order = await getOrderForActor(confirmed.orderId, confirmed.customerId, 'CUSTOMER');
        io.to(`user:${confirmed.customerId}`).emit('order:status', { id: confirmed.orderId, paymentStatus: 'PAID' });
        io.to(`user:${confirmed.vendorUserId}`).emit('order:created', order);
      }
    }
    return res.sendStatus(200);
  } catch {
    return res.sendStatus(400);
  }
}));
app.post('/api/payments/flutterwave/webhook', express.raw({ type: 'application/json', limit: '128kb' }), asyncHandler(async (req, res) => {
  const expected = process.env.FLUTTERWAVE_SECRET_HASH;
  const supplied = req.header('verif-hash');
  if (!expected || !supplied) return res.sendStatus(401);
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.sendStatus(401);
  try {
    const event = JSON.parse(req.body.toString()) as { event?: string; data?: { tx_ref?: string; amount?: number; status?: string; currency?: string } };
    if (event.data?.status === 'successful' && event.data.tx_ref && typeof event.data.amount === 'number' && event.data.currency === 'NGN') {
      const amountKobo = Math.round(event.data.amount * 100);
      const confirmed = await confirmPayment('FLUTTERWAVE', event.data.tx_ref, amountKobo);
      if (confirmed) {
        const order = await getOrderForActor(confirmed.orderId, confirmed.customerId, 'CUSTOMER');
        io.to(`user:${confirmed.customerId}`).emit('order:status', { id: confirmed.orderId, paymentStatus: 'PAID' });
        io.to(`user:${confirmed.vendorUserId}`).emit('order:created', order);
      }
    }
    return res.sendStatus(200);
  } catch {
    return res.sendStatus(400);
  }
}));
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
  const order = await getOrderForActor(parsed.data.orderId, req.user.id, req.user.role);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (!process.env.PAYSTACK_SECRET_KEY) return res.status(503).json({ error: 'Paystack is not configured' });
  const reference = `lm_${randomUUID().replaceAll('-', '')}`;
  const amountKobo = Number(order.subtotal_kobo);
  const customer = await pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [req.user.id]);
  if (!customer.rowCount) return res.status(404).json({ error: 'Customer account not found' });
  await pool.query(
    `INSERT INTO payments (order_id, provider, provider_reference, amount_kobo, status)
     VALUES ($1, 'PAYSTACK', $2, $3, 'INITIALIZED')`,
    [parsed.data.orderId, reference, amountKobo],
  );
  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: customer.rows[0].email, amount: amountKobo, reference, currency: 'NGN', callback_url: `${allowedOrigins[0]}/?order_id=${parsed.data.orderId}` }),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json() as { status?: boolean; data?: { authorization_url?: string } };
  if (!response.ok || !result.status || !result.data?.authorization_url) {
    await pool.query("UPDATE payments SET status = 'FAILED', updated_at = NOW() WHERE provider_reference = $1", [reference]);
    return res.status(502).json({ error: 'Unable to initialize payment' });
  }
  return res.json({ authorizationUrl: result.data.authorization_url, reference });
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
  console.error('Request failed', error);
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