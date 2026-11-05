import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from './db.js';

const partnerSchema = z.object({
  PARTNER_ROLE: z.enum(['VENDOR', 'COURIER']),
  FULL_NAME: z.string().trim().min(2).max(120),
  EMAIL: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  PHONE: z.string().regex(/^\+234[0-9]{10}$/),
  PASSWORD: z.string().min(12).max(72),
  BUSINESS_NAME: z.string().trim().min(2).max(160).optional(),
  BUSINESS_ADDRESS: z.string().trim().min(5).max(500).optional(),
  LATITUDE: z.coerce.number().min(-90).max(90).optional(),
  LONGITUDE: z.coerce.number().min(-180).max(180).optional(),
  WASH_AND_FOLD_PRICE_NAIRA: z.coerce.number().positive().default(2500),
  DRY_CLEANING_PRICE_NAIRA: z.coerce.number().positive().default(5000),
  IRONING_PRICE_NAIRA: z.coerce.number().positive().default(1500),
}).superRefine((value, context) => {
  if (value.PARTNER_ROLE === 'VENDOR') {
    if (!value.BUSINESS_NAME) context.addIssue({ code: 'custom', path: ['BUSINESS_NAME'], message: 'Required for vendor accounts' });
    if (!value.BUSINESS_ADDRESS) context.addIssue({ code: 'custom', path: ['BUSINESS_ADDRESS'], message: 'Required for vendor accounts' });
    if (value.LATITUDE === undefined) context.addIssue({ code: 'custom', path: ['LATITUDE'], message: 'Required for vendor accounts' });
    if (value.LONGITUDE === undefined) context.addIssue({ code: 'custom', path: ['LONGITUDE'], message: 'Required for vendor accounts' });
  }
});

const parsed = partnerSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Partner provisioning environment is invalid:', parsed.error.flatten().fieldErrors);
  process.exitCode = 1;
} else {
  const data = parsed.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const passwordHash = await bcrypt.hash(data.PASSWORD, 12);
    const created = await client.query<{ id: string }>(
      `INSERT INTO users (full_name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [data.FULL_NAME, data.EMAIL, data.PHONE, passwordHash, data.PARTNER_ROLE],
    );
    const userId = created.rows[0].id;
    if (data.PARTNER_ROLE === 'VENDOR') {
      const vendor = await client.query<{ id: string }>(
        `INSERT INTO vendors (user_id, business_name, address, location)
         VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography)
         RETURNING id`,
        [userId, data.BUSINESS_NAME, data.BUSINESS_ADDRESS, data.LONGITUDE, data.LATITUDE],
      );
      const vendorId = vendor.rows[0].id;
      const prices = [
        ['WASH_AND_FOLD', data.WASH_AND_FOLD_PRICE_NAIRA],
        ['DRY_CLEANING', data.DRY_CLEANING_PRICE_NAIRA],
        ['IRONING', data.IRONING_PRICE_NAIRA],
      ] as const;
      for (const [service, priceNaira] of prices) {
        const priceKobo = Math.round(priceNaira * 100);
        if (!Number.isSafeInteger(priceKobo)) throw new Error(`Invalid ${service} price`);
        await client.query(
          'INSERT INTO vendor_service_prices (vendor_id, service, price_kobo) VALUES ($1, $2, $3)',
          [vendorId, service, priceKobo],
        );
      }
    }
    await client.query('COMMIT');
    console.info(`${data.PARTNER_ROLE} account provisioned: ${data.EMAIL}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Partner provisioning failed:', error instanceof Error ? error.message : 'Unknown error');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (!parsed.success) await pool.end();
