CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('CUSTOMER', 'VENDOR', 'COURIER', 'ADMIN');
CREATE TYPE order_status AS ENUM (
  'CREATED', 'DRIVER_ASSIGNED_FOR_PICKUP', 'PICKED_UP', 'AT_LAUNDROMAT',
  'PROCESSING', 'READY_FOR_DELIVERY', 'DRIVER_ASSIGNED_FOR_DROPOFF', 'DELIVERED', 'CANCELLED'
);
CREATE TYPE laundry_service AS ENUM ('WASH_AND_FOLD', 'DRY_CLEANING', 'IRONING');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL CHECK (char_length(full_name) BETWEEN 2 AND 120),
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id),
  business_name TEXT NOT NULL,
  address TEXT NOT NULL,
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  commission_basis_points INTEGER NOT NULL DEFAULT 1500 CHECK (commission_basis_points BETWEEN 0 AND 5000),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX vendors_location_gix ON vendors USING GIST (location);

CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES users(id),
  vendor_id UUID NOT NULL REFERENCES vendors(id),
  courier_id UUID REFERENCES users(id),
  pickup_address TEXT NOT NULL,
  pickup_location GEOGRAPHY(POINT, 4326) NOT NULL,
  delivery_address TEXT NOT NULL,
  delivery_location GEOGRAPHY(POINT, 4326) NOT NULL,
  subtotal_kobo BIGINT NOT NULL CHECK (subtotal_kobo > 0),
  commission_kobo BIGINT NOT NULL CHECK (commission_kobo >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status order_status NOT NULL DEFAULT 'CREATED',
  payment_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (payment_status IN ('PENDING', 'PAID', 'FAILED', 'REFUNDED')),
  vendor_accepted_at TIMESTAMPTZ,
  vendor_response_deadline TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '2 minutes'),
  delivery_otp_hash TEXT,
  delivery_otp_encrypted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_vendor_status_created_idx ON orders (vendor_id, status, created_at);
CREATE INDEX orders_courier_status_idx ON orders (courier_id, status);

CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  service laundry_service NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  unit_price_kobo BIGINT NOT NULL CHECK (unit_price_kobo > 0)
);

CREATE TABLE order_status_history (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status order_status NOT NULL,
  changed_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, created_at);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id),
  provider TEXT NOT NULL CHECK (provider IN ('PAYSTACK', 'FLUTTERWAVE')),
  provider_reference TEXT NOT NULL,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  status TEXT NOT NULL CHECK (status IN ('INITIALIZED', 'SUCCESS', 'FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_reference)
);
CREATE INDEX payments_order_idx ON payments (order_id, created_at DESC);

CREATE TABLE courier_locations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  courier_id UUID NOT NULL REFERENCES users(id),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (courier_id, order_id)
);
CREATE INDEX courier_locations_order_time_idx ON courier_locations (order_id, recorded_at DESC);
CREATE INDEX courier_locations_location_gix ON courier_locations USING GIST (location);

CREATE TABLE vendor_service_prices (
  vendor_id UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  service laundry_service NOT NULL,
  price_kobo BIGINT NOT NULL CHECK (price_kobo > 0),
  PRIMARY KEY (vendor_id, service)
);