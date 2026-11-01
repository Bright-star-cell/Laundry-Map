INSERT INTO users (full_name, email, phone, password_hash, role)
VALUES
  ('Mararaba Wash Hub', 'hello@mararabawash.example', '+2348000000101', '$2a$12$4Gx8ovRK5ZP/5AKjKB07juHIwPz7ycfYbHnZHRe9v9icGyvTrN.Uq', 'VENDOR'),
  ('Karu Clean & Press', 'hello@karuclean.example', '+2348000000102', '$2a$12$4Gx8ovRK5ZP/5AKjKB07juHIwPz7ycfYbHnZHRe9v9icGyvTrN.Uq', 'VENDOR')
ON CONFLICT (email) DO NOTHING;

INSERT INTO vendors (user_id, business_name, address, location)
SELECT id, 'Mararaba Wash Hub', 'Mararaba Market Road, Mararaba', ST_SetSRID(ST_MakePoint(7.6031, 8.9912), 4326)::geography
FROM users WHERE email = 'hello@mararabawash.example'
ON CONFLICT (user_id) DO NOTHING;
INSERT INTO vendors (user_id, business_name, address, location)
SELECT id, 'Karu Clean & Press', 'Karu Central, Karu', ST_SetSRID(ST_MakePoint(7.5624, 9.0095), 4326)::geography
FROM users WHERE email = 'hello@karuclean.example'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO vendor_service_prices (vendor_id, service, price_kobo)
SELECT v.id, prices.service::laundry_service, prices.price_kobo
FROM vendors v
CROSS JOIN (VALUES ('WASH_AND_FOLD', 250000::BIGINT), ('DRY_CLEANING', 500000::BIGINT), ('IRONING', 150000::BIGINT)) AS prices(service, price_kobo)
ON CONFLICT (vendor_id, service) DO NOTHING;