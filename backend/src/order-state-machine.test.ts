import assert from 'node:assert/strict';
import test from 'node:test';
import { canTransitionOrder, orderStatuses } from './order-state-machine.js';

test('accepts each adjacent transition in the complete order lifecycle', () => {
  const lifecycle = [
    'CREATED',
    'DRIVER_ASSIGNED_FOR_PICKUP',
    'PICKED_UP',
    'AT_LAUNDROMAT',
    'PROCESSING',
    'READY_FOR_DELIVERY',
    'DRIVER_ASSIGNED_FOR_DROPOFF',
    'DELIVERED',
  ] as const;

  for (let index = 0; index < lifecycle.length - 1; index += 1) {
    assert.equal(canTransitionOrder(lifecycle[index], lifecycle[index + 1]), true);
  }
});

test('allows cancellation only before pickup and rejects terminal or skipped transitions', () => {
  for (const status of ['CREATED', 'DRIVER_ASSIGNED_FOR_PICKUP'] as const) {
    assert.equal(canTransitionOrder(status, 'CANCELLED'), true);
  }
  for (const status of orderStatuses.slice(2)) assert.equal(canTransitionOrder(status, 'CANCELLED'), false);
  assert.equal(canTransitionOrder('CREATED', 'PICKED_UP'), false);
  assert.equal(canTransitionOrder('DELIVERED', 'CANCELLED'), false);
  assert.equal(canTransitionOrder('CANCELLED', 'CREATED'), false);
});
