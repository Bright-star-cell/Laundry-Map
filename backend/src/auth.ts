import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from './db.js';

const registrationSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  phone: z.string().regex(/^\+234[0-9]{10}$/),
  password: z.string().min(12).max(72),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(72),
});

export async function registerCustomer(input: unknown, secret: string, expiresIn: string) {
  const data = registrationSchema.parse(input);
  const passwordHash = await bcrypt.hash(data.password, 12);
  const result = await pool.query<{ id: string; full_name: string; email: string; role: string }>(
    `INSERT INTO users (full_name, email, phone, password_hash, role)
     VALUES ($1, $2, $3, $4, 'CUSTOMER')
     RETURNING id, full_name, email, role`,
    [data.fullName, data.email, data.phone, passwordHash],
  );
  const user = result.rows[0];
  return { user, token: jwt.sign({ role: user.role }, secret, { subject: user.id, expiresIn: expiresIn as jwt.SignOptions['expiresIn'] }) };
}

export async function login(input: unknown, secret: string, expiresIn: string) {
  const data = loginSchema.parse(input);
  const result = await pool.query<{ id: string; full_name: string; email: string; role: string; password_hash: string }>(
    'SELECT id, full_name, email, role, password_hash FROM users WHERE email = $1 AND is_active = TRUE',
    [data.email],
  );
  const user = result.rows[0];
  const valid = await bcrypt.compare(data.password, user?.password_hash ?? '$2a$12$4Gx8ovRK5ZP/5AKjKB07juHIwPz7ycfYbHnZHRe9v9icGyvTrN.Uq');
  if (!user || !valid) throw new Error('INVALID_CREDENTIALS');
  const { password_hash: _passwordHash, ...safeUser } = user;
  return { user: safeUser, token: jwt.sign({ role: user.role }, secret, { subject: user.id, expiresIn: expiresIn as jwt.SignOptions['expiresIn'] }) };
}