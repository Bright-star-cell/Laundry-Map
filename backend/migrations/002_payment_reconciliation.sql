ALTER TABLE orders
  ADD COLUMN payment_reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN cancelled_at TIMESTAMPTZ;

ALTER TABLE payments DROP CONSTRAINT payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check
  CHECK (status IN ('INITIALIZED', 'SUCCESS', 'FAILED', 'RECONCILIATION_REQUIRED'));

CREATE TABLE payment_webhook_events (
  provider TEXT NOT NULL CHECK (provider IN ('PAYSTACK', 'FLUTTERWAVE')),
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  processing_result TEXT NOT NULL DEFAULT 'PROCESSING',
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE payment_reconciliation_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id UUID REFERENCES orders(id),
  payment_id UUID REFERENCES payments(id),
  provider TEXT NOT NULL CHECK (provider IN ('PAYSTACK', 'FLUTTERWAVE')),
  provider_reference TEXT NOT NULL,
  reason TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX payment_reconciliation_order_idx ON payment_reconciliation_events (order_id, created_at DESC);